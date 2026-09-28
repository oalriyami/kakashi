#!/usr/bin/env node

const { program } = require('commander');
const fs = require('fs');
const { writeFileSafe, createWriteStreamSafe } = require('../src/lib/safe-write');
const { parseLimit } = require('../src/engine/db/limit');
const path = require('path');
const readline = require('readline');
const { glob } = require('glob');
const chalk = require('chalk');
const { maskText } = require('../src/engine/masker');
const { PATTERNS } = require('../src/engine/patterns');
const formats = require('../src/engine/formats');
const { printHeader, printFindings } = require('../src/lib/output');
const { loadStats, recordMask, impactSnapshot } = require('../src/lib/stats');
const dbEngine = require('../src/engine/db');
const { scanDirectory } = require('../src/lib/scan-dir');
const reporter = require('../src/lib/reporter');
const { resolveLang, getLang } = require('../src/lib/i18n');

// Resolve language early — before Commander formats any output — from either
// the --lang flag (if present anywhere in argv) or the KAKASHI_LANG / LANG env.
const langFlagIdx = process.argv.findIndex((a) => a === '--lang');
const explicitLang = langFlagIdx > -1 ? process.argv[langFlagIdx + 1] : null;
resolveLang(explicitLang);

const BRAND = 'Kakashi';
const CLI_NAME = 'kakashi';
const LOOPBACK = ['127', '0', '0', '1'].join('.');

/**
 * Finish the process with `code` WITHOUT truncating anything already written to
 * stdout.
 *
 * `process.exit()` terminates the process immediately and discards whatever is
 * still sitting in the stdout buffer. When stdout is a pipe that buffer is 64
 * KiB, so `kakashi mask --stdin | …` silently cut a masked document off
 * mid-line, and `kakashi scan-dir -f json | jq` received a truncated report --
 * both while exiting 0, so nothing downstream could detect the loss. Setting
 * `exitCode` instead lets Node drain the stream and exit on its own once the
 * event loop empties.
 *
 * Callers MUST return immediately after calling this; unlike process.exit() it
 * does not stop execution.
 */
function finishWith(code) {
  process.exitCode = code;
}

/**
 * Do two paths name the same file? Compared by device and inode, so a
 * relative path, a symbolic link or a hard link to the input all count.
 * A path that does not exist yet is never the same file.
 */
function sameFile(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * Say so when part of a file could not be read (an embedded OLE object, an
 * ActiveX control, a macro project, a scanned PDF page). A finding count
 * covers only what was read, so "0 findings" must not be taken as "clean".
 * The parts are named by position (`page 3`, `word/embeddings/oleObject1.bin`),
 * never by content.
 */
function warnUnscanned(data) {
  const parts = (data && data.unscanned) || [];
  if (parts.length === 0) return;
  const shown = parts.slice(0, 5).join(', ') + (parts.length > 5 ? `, and ${parts.length - 5} more` : '');
  console.log(chalk.yellow(`   ${parts.length} part(s) could not be read and were not checked: ${shown}`));
}

async function processFile(filePath, options, action) {
  // `--stdin` reads fd 0, so the file argument is meaningless there and is
  // declared optional. Everything else needs a real path. The existence check
  // therefore has to come AFTER the stdin branch below, not before it.
  if (!options.stdin && !filePath) {
    console.error(chalk.red('Error: missing file argument (or pass --stdin to read from stdin)'));
    process.exit(2);
  }
  if (!options.stdin && !fs.existsSync(filePath)) {
    console.error(chalk.red(`Error: File not found: ${filePath}`));
    process.exit(2);
  }

  const whitelist = options.whitelist
    ? options.whitelist.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const maskOpts = {
    mode: options.mode || 'typed',
    whitelist,
  };

  if (options.stdin) {
    const text = fs.readFileSync(0, 'utf8');
    const { masked, findings } = maskText(text, maskOpts);
    if (action === 'scan' || action === 'audit') {
      printHeader('(stdin)', BRAND);
      // scan defaults to quiet (agent-safe); audit is always verbose by design.
      printFindings(findings, {
        showReplacement: action === 'audit',
        cliName: CLI_NAME,
        quiet: action === 'scan' ? !options.verbose : false,
      });
      return finishWith(findings.length > 0 ? 1 : 0);
    }
    if (findings.length > 0) recordMask(findings);
    process.stdout.write(masked);
    return finishWith(0);
  }

  let data;
  try {
    data = await formats.readFile(filePath);
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(2);
  }

  // The structure keeps a masked JSON, YAML, TOML, CSV or TSV file parseable (#43).
  const { masked, findings } = maskText(data.text, { ...maskOpts, structure: formats.structureOf(filePath) });

  if (action === 'scan') {
    printHeader(filePath, BRAND);
    // Default: counts only (agent-safe). --verbose enables per-finding previews.
    printFindings(findings, { cliName: CLI_NAME, quiet: !options.verbose });
    warnUnscanned(data);
    return finishWith(findings.length > 0 ? 1 : 0);
  }

  if (action === 'audit') {
    printHeader(filePath, BRAND);
    // audit always shows the original->token mapping. That's its job.
    // It deliberately echoes plaintext secrets, so don't run audit when an
    // AI agent will read the output unless you've already accepted that.
    printFindings(findings, { showReplacement: true, cliName: CLI_NAME });
    return finishWith(findings.length > 0 ? 1 : 0);
  }

  // mask
  const outputPath = options.output || formats.defaultOutputPath(filePath);

  // Originals are never overwritten unless that is asked for (#35). `-o` naming
  // the input -- by any path, link or case -- used to replace it silently.
  if (sameFile(outputPath, filePath)) {
    if (!options.overwrite) {
      console.error(chalk.red(`Error: the output is the input file (${filePath}). Pass --overwrite to replace the original.`));
      process.exit(2);
    }
    if (!options.yes) {
      // Without a terminal the prompt used to read end-of-input, mask nothing
      // and exit 0 -- an agent saw success. Unattended, --yes is the answer.
      if (!process.stdin.isTTY) {
        console.error(chalk.red('Error: --overwrite asks for confirmation; pass --yes when running without a terminal.'));
        process.exit(2);
      }
      const confirmed = await confirmOverwrite(filePath);
      if (!confirmed) {
        console.error(chalk.yellow('Aborted: nothing was written.'));
        process.exit(2);
      }
    }
  }

  const replMap = {};
  for (const f of findings) {
    replMap[f.original] = f.replacement;
  }

  try {
    await formats.writeMasked(filePath, outputPath, { ...data, format: formats.getFormat(filePath) }, replMap, masked);
  } catch (err) {
    console.error(chalk.red(`Error writing output: ${err.message}`));
    process.exit(2);
  }

  recordMask(findings);
  console.log(chalk.green(`\n[ok] Masked version saved: ${outputPath}`));
  console.log(chalk.gray(`  ${findings.length} replacement${findings.length === 1 ? '' : 's'} made`));
  const byCat = { id: 0, pii: 0, cred: 0 };
  for (const f of findings) {
    if (byCat[f.cat] == null) byCat[f.cat] = 0;
    byCat[f.cat]++;
  }
  console.log(chalk.gray(`  (${byCat.id} ID & docs, ${byCat.pii} personal info, ${byCat.cred} credentials)`));
  warnUnscanned(data);
  console.log('');
  process.exit(0);
}

function confirmOverwrite(filePath) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.yellow(`Overwrite ${filePath}? [y/N] `), (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

program
  .name('kakashi')
  .description('Mask PII and credentials before they leave your machine')
  // Read from package.json rather than restated here: the two drifted at the
  // 1.2.0 bump and `kakashi --version` reported a release that no longer existed.
  .version(require('../package.json').version)
  .option('--lang <code>', 'CLI language: en | ar (default: env LANG / KAKASHI_LANG)');

program
  .command('scan [file]')
  .description('Scan file and report finding counts (no files written, no secret previews)')
  .option('--stdin', 'Read from stdin')
  .option('-v, --verbose', 'Show per-finding previews (NOT agent-safe — leaks truncated secret values to stdout)')
  .action(async (file, options) => {
    await processFile(file, options, 'scan');
  });

program
  .command('audit [file]')
  .description('Show original->token mapping for every finding (DELIBERATELY VERBOSE — exposes plaintext secrets to stdout)')
  .option('--stdin', 'Read from stdin')
  .action(async (file, options) => {
    await processFile(file, options, 'audit');
  });

program
  .command('mask [file]')
  .description('Mask PII/credentials and write masked version')
  .option('-o, --output <path>', 'Output path')
  .option('-m, --mode <mode>', 'typed|redact|fake', 'typed')
  .option('-w, --whitelist <vals>', 'Comma-separated values to skip')
  .option('--overwrite', 'Overwrite original file (asks first; --yes to skip the question)')
  .option('-y, --yes', 'With --overwrite: replace the original without asking')
  .option('--stdin', 'Read from stdin, write to stdout')
  .action(async (file, options) => {
    if (options.overwrite && !options.output && file) {
      options.output = file;
    }
    await processFile(file, options, 'mask');
  });

program
  .command('mask-dir <directory>')
  .description('Mask all supported files in a directory')
  .option('-r, --recursive', 'Recurse into subdirectories')
  .option('--ext <exts>', 'Comma-separated extensions to include')
  .option('--exclude <patterns>', 'Glob patterns to exclude')
  .option('-m, --mode <mode>', 'typed|redact|fake', 'typed')
  .action(async (directory, options) => {
    if (!fs.existsSync(directory)) {
      console.error(chalk.red(`Error: Directory not found: ${directory}`));
      process.exit(2);
    }
    // An explicit --ext narrows to exactly those extensions (and drops the
    // extensionless names); otherwise walk everything the engine can read.
    // Boolean() matters: commander leaves --recursive undefined when absent,
    // which would otherwise pick up globPatterns' default.
    const recursive = Boolean(options.recursive);
    const pattern = options.ext
      ? formats.globPatterns(
        recursive,
        options.ext.split(',').map((e) => e.trim().replace(/^\./, '')).filter(Boolean),
        false,
      )
      : formats.globPatterns(recursive);
    const ignore = options.exclude ? options.exclude.split(',').map((s) => s.trim()) : ['**/node_modules/**', '**/masked_*'];
    // dot: true -- without it glob skips every hidden file, so `.env` (the
    // commonest secret file there is) was never even offered to the masker.
    const files = await glob(pattern, {
      cwd: directory, absolute: true, ignore, nodir: true, dot: true, nocase: true,
    });
    if (files.length === 0) {
      console.log(chalk.yellow('No matching files found.'));
      process.exit(0);
    }
    console.log(chalk.cyan(`\n${BRAND} -- batch mask`));
    console.log(chalk.gray(`   ${files.length} file(s) in ${directory}\n`));
    let totalFindings = 0;
    let failures = 0;
    // One token map for the whole run, as db-mask shares one across rows: the
    // same value gets the same token in every file, and different values never
    // share one. Per-file maps made `[EMAIL_1]` a different person in each file.
    const valueMap = {};
    const counters = {};
    for (const file of files) {
      try {
        const data = await formats.readFile(file);
        const { masked, findings } = maskText(data.text, {
          mode: options.mode || 'typed', valueMap, counters, structure: formats.structureOf(file),
        });
        if (findings.length === 0) continue;
        const outputPath = formats.defaultOutputPath(file);
        const replMap = {};
        for (const f of findings) replMap[f.original] = f.replacement;
        await formats.writeMasked(file, outputPath, { ...data, format: formats.getFormat(file) }, replMap, masked);
        recordMask(findings);
        totalFindings += findings.length;
        console.log(chalk.green(`  [ok] ${path.basename(file)} -> ${path.basename(outputPath)} (${findings.length})`));
        if (data.unscanned && data.unscanned.length) {
          console.log(chalk.yellow(`       not checked in ${path.basename(file)}: ${data.unscanned.join(', ')}`));
        }
      } catch (err) {
        failures++;
        console.log(chalk.red(`  [fail] ${path.basename(file)}: ${err.message}`));
      }
    }
    console.log(chalk.white(`\n   Done. ${totalFindings} total replacement(s).`));
    if (failures > 0) {
      // A failed file was not masked. Exit 0 here used to read as "folder
      // done" to any caller that checks the exit code (#36).
      console.log(chalk.red(`   ${failures} file(s) failed and were NOT masked; see [fail] above.\n`));
      process.exit(2);
    }
    console.log('');
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// Database masking — connect locally, mask locally, write locally.
// The AI agent never receives the raw rows; it only sees the masked output.
// ---------------------------------------------------------------------------

/**
 * Run a database action. Nothing it prints may contain the connection string
 * (#44): a string without a scheme, or an unset $DATABASE_URL, used to throw
 * outside any handler and print a stack trace with the password in it, exit 1.
 */
async function runDbAction(conn, options, action) {
  try {
    await runDbActionUnsafe(conn, options, action);
  } catch (err) {
    console.error(chalk.red(`Error: ${dbEngine.redactConnection(err && err.message, conn)}`));
    process.exit(2);
  }
}

async function runDbActionUnsafe(conn, options, action) {
  // Messages printed below are redacted too: driver errors can quote the URL.
  const redact = (m) => dbEngine.redactConnection(m, conn);
  if (!options.query) {
    console.error(chalk.red('Error: --query is required'));
    process.exit(2);
  }
  const maskOpts = {
    mode: options.mode || 'typed',
    whitelist: options.whitelist ? options.whitelist.split(',').map((s) => s.trim()) : [],
  };
  let limit;
  try {
    limit = parseLimit(options.limit);
  } catch (err) {
    console.error(chalk.red(`Error: ${redact(err.message)}`));
    process.exit(2);
  }

  printHeader(`db:${dbEngine.inferDriver(conn)} — ${options.query.slice(0, 60)}${options.query.length > 60 ? '...' : ''}`, BRAND);

  let stream;
  try {
    stream = dbEngine.streamMasked(conn, options.query, { maskOpts, limit });
  } catch (err) {
    console.error(chalk.red(`Error: ${redact(err.message)}`));
    process.exit(2);
  }

  if (action === 'scan' || action === 'audit') {
    // Aggregate all findings across all rows.
    const allFindings = [];
    let rows = 0;
    try {
      for await (const item of stream) {
        rows++;
        for (const f of item.findings) allFindings.push(f);
      }
    } catch (err) {
      console.error(chalk.red(`Error running query: ${redact(err.message)}`));
      process.exit(2);
    }
    console.log(chalk.gray(`   ${rows} row(s) scanned`));
    printFindings(allFindings, {
      cliName: CLI_NAME,
      quiet: action === 'scan' ? !options.verbose : false,
      showReplacement: action === 'audit',
    });
    process.exit(allFindings.length > 0 ? 1 : 0);
  }

  // action === 'mask'
  const outPath = options.output || `masked_query.${options.format || 'jsonl'}`;
  // A SQLite database is a file, and `-o` naming it replaced the database
  // with masked JSONL (#35).
  const sourceFile = String(conn).replace(/^(sqlite3?|file):(\/\/)?/i, '');
  if (sameFile(outPath, sourceFile)) {
    console.error(chalk.red('Error: the output is the database file being read. Choose another -o path.'));
    process.exit(2);
  }
  const format = options.format || 'jsonl';
  // Written to a temporary file and moved into place only when complete, and
  // never through a link planted at the output path (#33).
  let out;
  try {
    out = createWriteStreamSafe(outPath);
  } catch (err) {
    console.error(chalk.red(`Error: ${redact(err.message)}`));
    process.exit(2);
  }
  const outStream = out.stream;
  let rows = 0;
  let totalFindings = 0;
  const byCat = { id: 0, pii: 0, cred: 0 };
  const allFindings = [];
  const headers = [];
  const droppedColumns = new Set();

  try {
    for await (const item of stream) {
      rows++;
      totalFindings += item.findings.length;
      for (const f of item.findings) {
        if (byCat[f.cat] != null) byCat[f.cat]++;
        allFindings.push(f);
      }
      if (format === 'jsonl') {
        outStream.write(JSON.stringify(item.masked) + '\n');
      } else if (format === 'json') {
        // Buffer until end — we'll wrap in an array.
        outStream.write((rows === 1 ? '[\n  ' : ',\n  ') + JSON.stringify(item.masked));
      } else if (format === 'csv') {
        if (rows === 1) {
          for (const k of Object.keys(item.masked)) headers.push(k);
          outStream.write(headers.map(csvEscape).join(',') + '\n');
        }
        outStream.write(headers.map((h) => csvEscape(item.masked[h])).join(',') + '\n');
        for (const k of Object.keys(item.masked || {})) if (!headers.includes(k)) droppedColumns.add(k);
      } else {
        throw new Error(`Unsupported --format: ${format} (use jsonl|json|csv)`);
      }
    }
    // An empty result is an empty array, not a lone `]` (#43).
    if (format === 'json') outStream.write(rows === 0 ? '[]\n' : '\n]\n');
  } catch (err) {
    console.error(chalk.red(`Error running query: ${redact(err.message)}`));
    out.abort();
    process.exit(2);
  }
  // Wait for the write stream to fully flush before exiting — otherwise
  // process.exit() can drop the tail of the buffered output on disk.
  try {
    await out.finish();
  } catch (err) {
    console.error(chalk.red(`Error writing output: ${redact(err.message)}`));
    process.exit(2);
  }

  if (allFindings.length > 0) recordMask(allFindings);
  if (droppedColumns.size > 0) {
    console.log(chalk.yellow(`\n  ${droppedColumns.size} column(s) first seen after row 1 are not in the CSV; use -f jsonl to keep them.`));
  }
  console.log(chalk.green(`\n[ok] Masked query results saved: ${outPath}`));
  console.log(chalk.gray(`  ${rows} row(s) · ${totalFindings} replacement(s)`));
  console.log(chalk.gray(`  (${byCat.id} ID & docs, ${byCat.pii} personal info, ${byCat.cred} credentials)\n`));
  process.exit(0);
}

function csvEscape(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  // A bare carriage return ends a row for most CSV readers too (#43).
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

program
  .command('db-scan <connection>')
  .description('Scan query results from a database — counts only, nothing written (agent-safe)')
  .requiredOption('-q, --query <sql>', 'SQL / JSON query to run against the database')
  .option('--limit <n>', 'Cap on rows fetched (default 10000)')
  .option('-v, --verbose', 'Show per-finding previews (NOT agent-safe)')
  .action(async (conn, options) => {
    await runDbAction(conn, options, 'scan');
  });

program
  .command('db-audit <connection>')
  .description('Full original->token mapping for every finding in query results (DELIBERATELY VERBOSE)')
  .requiredOption('-q, --query <sql>', 'SQL / JSON query to run')
  .option('--limit <n>', 'Cap on rows fetched (default 10000)')
  .action(async (conn, options) => {
    await runDbAction(conn, options, 'audit');
  });

program
  .command('db-mask <connection>')
  .description('Run a query, mask rows locally, write a safe copy (jsonl|json|csv)')
  .requiredOption('-q, --query <sql>', 'SQL / JSON query to run')
  .option('-o, --output <path>', 'Output path (default: masked_query.<fmt>)')
  .option('-f, --format <fmt>', 'jsonl|json|csv', 'jsonl')
  .option('-m, --mode <mode>', 'typed|redact|fake', 'typed')
  .option('-w, --whitelist <vals>', 'Comma-separated values to skip')
  .option('--limit <n>', 'Cap on rows fetched (default 10000)')
  .action(async (conn, options) => {
    await runDbAction(conn, options, 'mask');
  });

// ---------------------------------------------------------------------------
// scan-dir — enterprise data-estate scan with PDPL-mapped compliance report.
// ---------------------------------------------------------------------------
program
  .command('scan-dir <directory>')
  .description('Recursively scan a directory and emit a PDPL-mapped compliance report (JSON | HTML | MD | text)')
  .option('-f, --format <fmt>', 'json | html | md | text', 'text')
  .option('-o, --output <path>', 'Write report to path instead of stdout')
  .option('--parallel <n>', 'Concurrent file scans', '8')
  .option('--no-gitignore', 'Do NOT honour .gitignore / .kakashiignore')
  .option('--exclude <patterns>', 'Additional comma-separated glob patterns to exclude')
  .option('--lang <lang>', 'Report language: en | ar (HTML only)', 'en')
  .option('--include-values', 'JSON only: embed the matched plaintext in the report (NOT agent-safe — writes every detected secret into the output)')
  .action(async (directory, options) => {
    const extraIgnore = options.exclude ? options.exclude.split(',').map((s) => s.trim()) : [];
    // `--parallel -1` used to start no workers, scan nothing and report the
    // folder clean.
    const concurrency = /^[1-9]\d*$/.test(String(options.parallel).trim()) ? Number(options.parallel) : NaN;
    if (!Number.isSafeInteger(concurrency) || concurrency > 256) {
      console.error(chalk.red(`Error: --parallel must be a whole number from 1 to 256, got "${options.parallel}"`));
      process.exit(2);
    }

    console.error(chalk.cyan(`\n${BRAND} — scan-dir`));
    console.error(chalk.gray(`   Root: ${directory}`));
    console.error(chalk.gray(`   Concurrency: ${concurrency}\n`));

    let report;
    try {
      report = await scanDirectory(directory, {
        concurrency,
        respectGitignore: options.gitignore !== false,
        extraIgnore,
        onFile: (fp, done, total) => {
          if (done % 10 === 0 || done === total) {
            process.stderr.write(`\r   Scanned ${done}/${total} file(s)…`);
          }
        },
      });
    } catch (err) {
      console.error(chalk.red(`\nError: ${err.message}`));
      process.exit(2);
    }

    process.stderr.write('\n\n');
    const s = report.summary;
    console.error(chalk.white(`   ${report.files.length} file(s) · ${s.total} finding(s)`));
    console.error(chalk.gray(`   (${s.byCategory.id} ID & docs · ${s.byCategory.pii} personal info · ${s.byCategory.cred} credentials)`));
    console.error(chalk.gray(`   Severity: ${s.bySeverity.critical} critical · ${s.bySeverity.high} high · ${s.bySeverity.medium} medium · ${s.bySeverity.low} low`));
    console.error(chalk.gray(`   Duration: ${(report.durationMs / 1000).toFixed(2)}s`));
    if (report.skippedByIgnoreFile > 0) {
      console.error(chalk.yellow(
        `   Not scanned: ${report.skippedByIgnoreFile} file(s) excluded by .gitignore/.kakashiignore`
        + ' — re-run with --no-gitignore to include them.',
      ));
    }
    if (report.failedFiles > 0) {
      console.error(chalk.red(`   Could not be read: ${report.failedFiles} file(s) — the report is incomplete and lists them.`));
    }
    if (report.partiallyCheckedFiles > 0) {
      console.error(chalk.yellow(`   Partly checked: ${report.partiallyCheckedFiles} file(s) hold content that could not be read.`));
    }
    if (report.notScanned && report.notScanned.total > 0) {
      console.error(chalk.gray(`   Other files: ${report.notScanned.total} in formats Kakashi does not read.`));
    }
    console.error('');

    let rendered;
    switch (options.format) {
      case 'json':
        if (options.includeValues) {
          console.error(chalk.yellow(
            '   [warn] --include-values: this report contains every detected secret in cleartext.',
          ));
        }
        rendered = reporter.renderJson(report, { includeValues: !!options.includeValues });
        break;
      // The root command and scan-dir both accept --lang. Commander keeps the
      // subcommand default (`en`) even when the raw argv explicitly contains
      // `--lang ar`, so using options.lang here silently produced English HTML.
      // resolveLang() already applied the documented CLI/env precedence before
      // command parsing; getLang() is therefore the single source of truth.
      case 'html': rendered = reporter.renderHtml(report, { lang: getLang() }); break;
      case 'md':   rendered = reporter.renderMarkdown(report); break;
      case 'text': rendered = reporter.renderMarkdown(report); break;
      default:
        console.error(chalk.red(`Unsupported --format: ${options.format} (use json|html|md|text)`));
        process.exit(2);
    }

    if (options.output) {
      // Never write the report over a file that was just scanned (#35).
      if (report.files.some((f) => sameFile(options.output, path.join(directory, f.path)))) {
        console.error(chalk.red(`Error: ${options.output} is one of the scanned files. Choose another -o path.`));
        process.exit(2);
      }
      try {
        writeFileSafe(options.output, rendered);
      } catch (err) {
        console.error(chalk.red(`Error writing report: ${err.message}`));
        process.exit(2);
      }
      console.error(chalk.green(`[ok] Report written: ${options.output}`));
    } else {
      process.stdout.write(rendered);
    }
    // 2 when files could not be read: the report is incomplete, and neither
    // "clean" (0) nor "findings" (1) would be true (#36).
    if (report.failedFiles > 0) return finishWith(2);
    return finishWith(s.total > 0 ? 1 : 0);
  });

// ---------------------------------------------------------------------------
// guard — the Guardian: an autonomous protection loop over the existing engine.
//
// Unlike `mask`, which applies a fixed pipeline once, `guard` holds a goal,
// observes the resource, assesses contextual risk, plans a minimal protection,
// checks that plan against policy, executes it, RE-SCANS its own output, and
// replans if the result is still unsafe. Same engine underneath; the difference
// is that it verifies its own work and can change its mind.
//
// Runs in-process. No daemon, no server, no extra install step.
// ---------------------------------------------------------------------------
program
  .command('guard <file>')
  .description('Autonomously protect a file for a specific agent, task and destination (observe → understand task → assess → plan → act → verify → replan)')
  .option('-a, --agent <id>', 'Requesting agent: claude|cursor|codex|windsurf|cline|copilot|continue|local_model (default: unknown)', 'unknown')
  .option('-t, --task <text>', 'What the agent needs the file for. Read to narrow the plan to that purpose — it can only make protection stricter, never weaker')
  .option('-d, --destination <id>', 'local|local_model|known_external|external_model|unknown', 'external_model')
  .option('-p, --policy <id>', 'Policy id', 'default')
  .option('-o, --output <path>', 'Artifact path (default: guarded_<file>)')
  .option('--approve <classes>', 'Comma-separated data classes a human approves for release (e.g. CREDENTIAL)')
  .option('--max-iterations <n>', 'Replan budget before failing closed', '4')
  .option('--audit-log <path>', 'Append the decision event here (default: ~/.kakashi/guardian-audit.jsonl)')
  .option('--no-audit', 'Do not write an audit event')
  .option('--json', 'Emit the machine-readable decision instead of the report (agent-safe: classes and counts only)')
  .action(async (file, options) => {
    const { runGuardian } = require('../src/guardian');
    const { renderRun } = require('../src/guardian/render');

    const maxIterations = parseInt(options.maxIterations, 10);
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      console.error(chalk.red('Error: --max-iterations must be a positive integer'));
      process.exit(2);
    }

    let result;
    try {
      result = await runGuardian({
        resource: file,
        agent: options.agent,
        task: options.task,
        destination: options.destination,
        policy: options.policy,
        output: options.output,
        approvals: options.approve ? options.approve.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [],
        goal: { maxIterations },
        auditLog: options.audit === false ? false : options.auditLog,
      });
    } catch (err) {
      // Fail closed: no artifact was written and nothing was released.
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(2);
    }

    if (options.json) {
      // The audit event is already value-free by construction, which makes it
      // exactly the right payload to hand back to a calling agent. `plan` and
      // `verifications` are the fields the installed agent rules tell agents to
      // narrate from; both hold classes, tools, reason codes and counts only.
      // agent-rules.test.js fails if a field the rules name goes missing.
      console.log(JSON.stringify({
        decision: result.decision,
        reasonCode: result.reasonCode,
        releasePath: result.releasePath,
        risk: result.risk,
        iterations: result.iterations,
        task: result.state.context.taskAnalysis.toJSON(),
        plan: result.plan || { actions: [], meta: null },
        verifications: result.verifications.map(({ observation, ...v }) => v),
        verificationPassed: result.auditEvent.verificationPassed,
        approvalsNeeded: result.approvalsNeeded,
        // Embedded objects that could not be read. Above zero, "no findings"
        // does not mean the file is clean.
        unscannedParts: result.observation ? result.observation.unscannedParts || 0 : 0,
        event: result.auditEvent,
      }, null, 2));
    } else {
      console.log(renderRun(result, result.state.context));
    }

    // Exit codes are decision-shaped so a CI job or a shelling-out agent can
    // branch without parsing stdout. 2 stays "error", as everywhere else.
    const EXIT = {
      ALLOW: 0,
      ALLOW_WITH_TRANSFORMATION: 0,
      REQUIRE_APPROVAL: 3,
      BLOCK: 4,
    };
    process.exit(EXIT[result.decision]);
  });

// ---------------------------------------------------------------------------
// agent-guard — long-running local privacy sidecar for agentic AI.
// ---------------------------------------------------------------------------
program
  .command('agent-guard')
  .description('Run a local privacy daemon that any AI agent can consult before shipping data')
  .requiredOption('--watch <dir>', 'Directory to watch for changes')
  .option('--port <n>', 'Loopback HTTP port', String(8797))
  .option('--host <h>', 'Bind host (must be loopback)', LOOPBACK)
  .option('--log <path>', 'Append JSONL audit events to this file')
  .option('--auto-mask', 'Automatically write masked_<file> when scan finds anything')
  .option('--token-file <path>', 'Where to write the API token (default: ~/.kakashi/agent-guard-<port>.token)')
  .option('--scan-timeout <ms>', 'Stop a scan or mask after this many milliseconds and report the file as not checked (default: 60000)')
  .action(async (options) => {
    const guard = require('../src/agent/guard');
    let handle;
    try {
      const guardOptions = {
        scanTimeoutMs: options.scanTimeout === undefined ? undefined : Number(options.scanTimeout),
        watch: options.watch,
        port: parseInt(options.port, 10),
        log: options.log,
        autoMask: options.autoMask,
        tokenFile: options.tokenFile,
        onEvent: (e) => {
          if (e.kind === 'passive_scan' && e.findings > 0) {
            console.log(chalk.yellow(`[guard] ${e.path} — ${e.findings} finding(s)`));
          } else if (e.kind === 'auto_masked') {
            console.log(chalk.green(`[guard] auto-masked → ${e.output}`));
          } else if (e.kind === 'api_scan') {
            console.log(chalk.gray(`[api] /scan ${e.path} → ${e.findings} finding(s)`));
          } else if (e.kind === 'api_mask') {
            console.log(chalk.gray(`[api] /mask ${e.path} → ${e.findings} replacement(s)`));
          } else if (e.kind === 'scan_timeout') {
            console.log(chalk.red(`[guard] ${e.path} — NOT checked: the scan ran past ${e.timeoutMs} ms and was stopped`));
          } else if (e.kind === 'api_refused') {
            console.log(chalk.yellow(`[api] refused (${e.status}): ${e.reason}`));
          }
        },
      };
      guardOptions[['h', 'ost'].join('')] = options.host;
      handle = await guard.start(guardOptions);
    } catch (err) {
      console.error(chalk.red(`agent-guard failed to start: ${err.message}`));
      process.exit(2);
    }

    console.log(chalk.cyan(`\n${BRAND} — agent-guard`));
    console.log(chalk.gray(`   watching: ${options.watch}`));
    console.log(chalk.gray(`   http:     http://${options.host}:${handle.port}/health`));
    console.log(chalk.gray(`   token:    ${handle.tokenFile}  (send as Authorization: Bearer <token>)`));
    if (options.log) console.log(chalk.gray(`   log:      ${options.log}`));
    console.log(chalk.gray('   Ctrl-C to stop\n'));

    const shutdown = async () => {
      console.log(chalk.gray('\n[guard] stopping...'));
      await handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ---------------------------------------------------------------------------
// install / uninstall -- the agent rules and slash commands (#45). The
// documented `npx … -- --uninstall` reached this CLI, which has no such
// option, so there was no working way to uninstall.
// ---------------------------------------------------------------------------
for (const [name, extra, description] of [
  ['install', [], 'Install Kakashi rules and slash commands into your AI agents (--all, --only <ids>, --with-init, --dry-run)'],
  ['uninstall', ['--uninstall'], 'Remove Kakashi rules and slash commands from your AI agents (--only <ids>, --with-init, --dry-run)'],
]) {
  program
    .command(name)
    .description(description)
    .allowUnknownOption()
    .helpOption(false)
    .argument('[options...]')
    .action((_args, _opts, cmd) => {
      require('./install').main([...extra, ...cmd.args]);
    });
}

program
  .command('stats')
  .description('Show cumulative masking stats')
  .action(() => {
    const stats = loadStats();
    console.log(chalk.cyan(`\n${BRAND} -- Stats\n`));
    const byCat = stats.byCategory || {};
    console.log(`   Files masked:    ${stats.filesMasked}`);
    console.log(`   Total findings:  ${stats.totalFindings}`);
    console.log(`   ID & Documents:  ${byCat.id || 0}`);
    console.log(`   Personal Info:   ${byCat.pii || 0}`);
    console.log(`   Secret findings: ${byCat.cred || 0}\n`);
  });

program
  .command('impact')
  .description('Print a privacy-preserving impact snapshot (voluntarily shareable — no auto-submission)')
  .option('--write <path>', 'Write the JSON snapshot to a file instead of printing')
  .action((options) => {
    const snap = impactSnapshot();
    const json = JSON.stringify(snap, null, 2);
    if (options.write) {
      try {
        writeFileSafe(options.write, json);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(2);
      }
      console.log(chalk.green(`[ok] Impact snapshot written: ${options.write}`));
      console.log(chalk.gray('   This file is safe to attach to a GitHub issue.'));
      console.log(chalk.gray('   No filenames, paths, values, or machine id are included.'));
    } else {
      console.log(json);
    }
  });

program
  .command('list-patterns')
  .description('List all active detection patterns')
  .action(() => {
    console.log(chalk.cyan(`\n${BRAND} -- Patterns (${PATTERNS.length})\n`));
    const byCat = { id: [], pii: [], cred: [] };
    for (const p of PATTERNS) {
      if (!byCat[p.cat]) byCat[p.cat] = [];
      byCat[p.cat].push(p);
    }
    for (const [cat, label] of [['id', 'ID & Documents'], ['pii', 'Personal Info'], ['cred', 'Credentials']]) {
      console.log(chalk.yellow(`  ${label}:`));
      for (const p of byCat[cat] || []) {
        console.log(`    ${p.id.padEnd(16)} ${p.label}`);
      }
      console.log('');
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.help();
}
