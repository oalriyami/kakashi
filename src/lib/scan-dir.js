/**
 * Directory scanner — walks a tree, scans every supported file, aggregates
 * findings with PDPL enrichment.
 *
 * Notes on parallelism:
 *   We use an async concurrency pool (default 8) rather than worker_threads.
 *   For I/O-bound file reads this gives most of the wall-clock benefit of
 *   true parallelism without the overhead of spinning up worker processes or
 *   sending large buffers over MessageChannel. worker_threads-based
 *   parallelism is tracked as a v1.2 upgrade for CPU-bound XLSX/PDF workloads.
 *
 * .gitignore / .kakashiignore:
 *   Honoured with .gitignore semantics, in the root and in every folder below
 *   it -- see lib/discover.js, which mask-dir shares (#51).
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');
const { discoverFiles, exclusions, globIgnore } = require('./discover');
const { maskText } = require('../engine/masker');
const formats = require('../engine/formats');
const { summarize } = require('./pdpl-mapping');

/**
 * Async concurrency pool — process an iterable with at most N in flight.
 * @param {Iterable} items
 * @param {number} concurrency
 * @param {function(any): Promise} worker
 */
async function pool(items, concurrency, worker) {
  const iterator = items[Symbol.iterator]();
  const results = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const next = iterator.next();
      if (next.done) return;
      results.push(await worker(next.value));
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {string} rootPath
 * @param {object} options
 * @param {number} [options.concurrency=8]
 * @param {boolean} [options.respectGitignore=true]
 * @param {string[]} [options.extraIgnore=[]]
 * @param {function(string, number, number): void} [options.onFile] — progress callback
 * @returns {Promise<{ rootPath, scannedAt, durationMs, files, summary }>}
 */
async function scanDirectory(rootPath, options = {}) {
  const {
    concurrency = 8,
    respectGitignore = true,
    extraIgnore = [],
    onFile,
  } = options;

  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }

  const started = Date.now();
  const pattern = formats.globPatterns(true);

  // --exclude patterns are added to the defaults, never in place of them.
  const { files: allFiles, skippedByIgnoreFile } = await discoverFiles(rootPath, pattern, {
    ignoreFiles: respectGitignore,
    exclude: extraIgnore,
    // Honouring .gitignore is deliberate, but it is silent, and `.env` is in
    // almost every .gitignore -- exactly the file most likely to hold a live
    // credential. Left unsaid, a report reading "0 credentials" is
    // indistinguishable from one that simply never looked. So count what the
    // ignore FILES excluded and let the caller surface it.
    countIgnored: true,
  });

  const fileResults = [];
  let processed = 0;

  await pool(allFiles, concurrency, async (filePath) => {
    try {
      const data = await formats.readFile(filePath);
      const { findings } = maskText(data.text);
      fileResults.push({
        path: path.relative(rootPath, filePath),
        findings, // raw findings — enrichment happens once at the end
        // Parts of the file that could not be read (an OLE object, a scanned
        // PDF page): the file's count covers only the rest.
        ...(data.unscanned && data.unscanned.length ? { unscanned: data.unscanned } : {}),
      });
    } catch (err) {
      fileResults.push({
        path: path.relative(rootPath, filePath),
        findings: [],
        errors: [err.message],
      });
    } finally {
      processed++;
      if (onFile) onFile(filePath, processed, allFiles.length);
    }
  });

  // Enrich once at the end (PDPL articles, severity, checksum badges).
  const allFindings = fileResults.flatMap((f) => f.findings);
  const { findings: enrichedAll, summary } = summarize(allFindings);

  // Redistribute enriched findings back to per-file buckets in original order.
  let cursor = 0;
  const enrichedFiles = fileResults.map((f) => {
    const slice = enrichedAll.slice(cursor, cursor + f.findings.length);
    cursor += f.findings.length;
    return {
      path: f.path,
      findings: slice,
      ...(f.errors ? { errors: f.errors } : {}),
      ...(f.unscanned ? { unscanned: f.unscanned } : {}),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  // Everything else in the tree -- images, archives, binaries, formats the
  // engine does not read. Not a failure, but a report must say it did not
  // look at them rather than let "0 findings" suggest it did (#36).
  const ex = exclusions(rootPath, { ignoreFiles: respectGitignore, exclude: extraIgnore });
  const everything = await glob('**/*', {
    cwd: rootPath,
    absolute: true,
    nodir: true,
    dot: true,
    ignore: globIgnore(ex),
  });
  const seen = new Set(allFiles);
  const byExtension = {};
  let otherFiles = 0;
  for (const f of everything) {
    if (seen.has(f)) continue;
    otherFiles++;
    const ext = path.extname(f).toLowerCase() || '(none)';
    byExtension[ext] = (byExtension[ext] || 0) + 1;
  }

  return {
    rootPath,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    files: enrichedFiles,
    summary,
    skippedByIgnoreFile,
    // Files that could not be read at all. A report with any of these is
    // incomplete, and the CLI exits 2.
    failedFiles: enrichedFiles.filter((f) => f.errors).length,
    // Files read only in part.
    partiallyCheckedFiles: enrichedFiles.filter((f) => f.unscanned).length,
    notScanned: {
      total: otherFiles,
      byExtension: Object.fromEntries(Object.entries(byExtension).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    },
  };
}

module.exports = { scanDirectory, pool };
