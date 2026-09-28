#!/usr/bin/env node
/**
 * Install Kakashi's rules and slash commands into the AI agents on this
 * machine, or remove them.
 *
 *   kakashi install [--all | --only <ids>] [--with-init] [--dry-run]
 *   kakashi uninstall [--only <ids>] [--with-init] [--dry-run]
 *   kakashi-install ...            the same, as its own command
 *   node bin/install.js ...        from a clone
 *
 * Everything it writes is either a whole file it owns or a block between
 * `<!-- kakashi-begin -->` / `<!-- kakashi-end -->` markers, so re-running it
 * refreshes that block and uninstalling removes exactly it (#45).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MARKER_BEGIN = '<!-- kakashi-begin -->';
const MARKER_END = '<!-- kakashi-end -->';

const homeDir = os.homedir();

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
    shell: true,
  });
  return r.status === 0;
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

/** Wrap text in Kakashi's markers, unless it already carries them. */
function marked(content) {
  const body = content.trim();
  return body.includes(MARKER_BEGIN) ? body : `${MARKER_BEGIN}\n${body}\n${MARKER_END}`;
}

/**
 * Put Kakashi's block into a file, replacing the block an earlier install left
 * there. Re-running used to keep the stale block unless `--force` was given,
 * so an upgrade never reached the agents (#45).
 */
function appendMarkerBlock(filePath, blockContent) {
  const block = marked(blockContent);
  const existing = readFile(filePath) || '';
  const rest = stripMarkerBlock(existing).trimEnd();
  writeFile(filePath, (rest ? `${rest}\n\n` : '') + block + '\n');
  return !existing.includes(MARKER_BEGIN);
}

/** Remove Kakashi's block from a file; delete the file if nothing else is left. */
function removeMarkerBlock(filePath) {
  const content = readFile(filePath);
  if (content === null || !content.includes(MARKER_BEGIN)) return false;
  const rest = stripMarkerBlock(content).trim();
  if (rest) writeFile(filePath, rest + '\n');
  else fs.rmSync(filePath, { force: true });
  return true;
}

function removeFile(p) {
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

function stripMarkerBlock(content) {
  let out = content;
  for (;;) {
    const begin = out.indexOf(MARKER_BEGIN);
    const end = out.indexOf(MARKER_END, begin);
    if (begin === -1 || end === -1) return out;
    out = out.slice(0, begin).trimEnd() + '\n' + out.slice(end + MARKER_END.length).replace(/^\n+/, '\n');
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function loadActivateBlock() {
  return readFile(path.join(ROOT, 'CLAUDE.md')) ||
    readFile(path.join(ROOT, 'src', 'rules', 'kakashi-activate.md'));
}

function loadCursorRule() {
  const body = readFile(path.join(ROOT, 'src', 'rules', 'kakashi-activate.md')) || '';
  return `---
description: Kakashi PII masker
globs: ["**/*"]
alwaysApply: true
---

${body}
`;
}

let opts = {};

// Every slash command that ships in commands/ AND is safe to expose in the
// agent's `/` picker. Adding to this list is a two-step contract:
//   1. Ship the matching `commands/<name>.md` file (or `copySlashCommands`
//      silently skips it).
//   2. Add the id here. `tests/agent-rules.test.js` and
//      `tests/orchestrator.test.js` assert both lists stay in sync.
// The order below matches the order they should appear in the `/` picker.
const SLASH_CMDS = [
  'kakashi',              // smart orchestrator (picks the right tool from intent)
  'kakashi-scan',         // one file, counts
  'kakashi-mask',         // one file, writes masked_<name>
  'kakashi-scan-dir',     // folder / PDPL report (HTML | JSON | MD)
  'kakashi-mask-dir',     // batch mask (confirms on large trees)
  'kakashi-guard',        // release decision (Guardian; agent-safe --json)
  'kakashi-db-scan',      // DB query results, counts only
  'kakashi-db-mask',      // DB query results, safe local copy
  'kakashi-db-audit',     // DB query results, human-only (WARN in agent)
  'kakashi-audit',        // one file, human-only (WARN in agent)
  'kakashi-agent-guard',  // loopback HTTP sidecar for MCP-enabled clients
  'kakashi-stats',        // cumulative counters
  'kakashi-list',         // active detection patterns
  'kakashi-impact',       // value-free adoption snapshot
];

function copySlashCommands(targetDir) {
  for (const cmd of SLASH_CMDS) {
    const src = path.join(ROOT, 'commands', `${cmd}.md`);
    if (!fs.existsSync(src)) continue;
    copyFile(src, path.join(targetDir, `${cmd}.md`));
  }
}

function removeSlashCommands(targetDir) {
  let n = 0;
  for (const cmd of SLASH_CMDS) if (removeFile(path.join(targetDir, `${cmd}.md`))) n++;
  return n;
}

function installClaude() {
  const configDir = opts.configDir || path.join(homeDir, '.claude');
  const block = loadActivateBlock();
  if (!block) return;
  appendMarkerBlock(path.join(configDir, 'CLAUDE.md'), block);
  copySlashCommands(path.join(configDir, 'commands'));
  writeFile(path.join(configDir, 'kakashi-active'), 'full');
  console.log(`  [ok] Claude Code  (rule + ${SLASH_CMDS.length} slash commands)`);
}

function installCursor() {
  const rule = loadCursorRule();
  const globalDir = path.join(homeDir, '.cursor', 'rules');
  writeFile(path.join(globalDir, 'kakashi.mdc'), rule);
  copySlashCommands(path.join(homeDir, '.cursor', 'commands'));
  if (opts.withInit) {
    writeFile(path.join(process.cwd(), '.cursor', 'rules', 'kakashi.mdc'), rule);
    copySlashCommands(path.join(process.cwd(), '.cursor', 'commands'));
  }
  console.log(`  [ok] Cursor  (rule + ${SLASH_CMDS.length} slash commands)`);
}

function installCodex() {
  const block = loadActivateBlock();
  if (!block) return;
  const codexGlobal = path.join(homeDir, '.codex', 'AGENTS.md');
  appendMarkerBlock(codexGlobal, block);
  copySlashCommands(path.join(homeDir, '.codex', 'commands'));
  if (opts.withInit) {
    appendMarkerBlock(path.join(process.cwd(), 'AGENTS.md'), block);
    copySlashCommands(path.join(process.cwd(), '.codex', 'commands'));
  }
  console.log(`  [ok] Codex CLI  (rule + ${SLASH_CMDS.length} slash commands)`);
}

function installWindsurf() {
  const body = readFile(path.join(ROOT, 'src', 'rules', 'kakashi-activate.md')) || '';
  const rule = `# Kakashi\n\n${body}`;
  const globalDir = path.join(homeDir, '.windsurf', 'rules');
  if (!fs.existsSync(path.dirname(globalDir)) && !opts.withInit) {
    console.log('  [skip] Windsurf: ~/.windsurf not found. Open Windsurf once, or run inside a repository with --with-init.');
    return;
  }
  writeFile(path.join(globalDir, 'kakashi.md'), rule);
  copySlashCommands(path.join(homeDir, '.windsurf', 'commands'));
  if (opts.withInit) {
    writeFile(path.join(process.cwd(), '.windsurf', 'rules', 'kakashi.md'), rule);
    copySlashCommands(path.join(process.cwd(), '.windsurf', 'commands'));
  }
  console.log(`  [ok] Windsurf  (rule + ${SLASH_CMDS.length} slash commands)`);
}

function installCline() {
  if (!opts.withInit) {
    console.log('  [skip] Cline: rules live in the repository. Run inside it with --only cline --with-init.');
    return;
  }
  const body = readFile(path.join(ROOT, 'src', 'rules', 'kakashi-activate.md')) || '';
  writeFile(path.join(process.cwd(), '.clinerules', 'kakashi.md'), `# Kakashi\n\n${body}`);
  copySlashCommands(path.join(process.cwd(), '.clinerules', 'commands'));
  console.log('  [ok] Cline (repo rules + slash commands)');
}

function installCopilot() {
  if (!opts.withInit) {
    console.log('  [skip] GitHub Copilot: instructions live in the repository. Run inside it with --only copilot --with-init.');
    return;
  }
  const block = loadActivateBlock();
  if (!block) return;
  appendMarkerBlock(path.join(process.cwd(), '.github', 'copilot-instructions.md'), block);
  console.log('  [ok] GitHub Copilot (repo instructions)');
}

/**
 * Remove the unmarked `[Kakashi] …` note installs before #45 appended to
 * Continue's systemMessage: the first 500 characters of the rule and `...`.
 */
function stripLegacyContinueNote(message) {
  const at = message.indexOf('[Kakashi] ');
  if (at === -1) return message;
  const tail = message.slice(at);
  const end = tail.search(/\.\.\.(?=\s*$|\n\n)/);
  if (end === -1 || end > 600) return message;
  return (message.slice(0, at) + tail.slice(end + 3)).trim();
}

function installContinue() {
  const configPath = path.join(homeDir, '.continue', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log('  [skip] Continue: ~/.continue/config.json not found. Open Continue once so it creates its config.');
    return;
  }
  let config;
  try {
    config = JSON.parse(readFile(configPath));
  } catch {
    console.log('  [warn] Continue: ~/.continue/config.json is not valid JSON; left unchanged.');
    return;
  }
  // The whole rule, between markers: it used to be cut at 500 characters,
  // and without markers it could be neither refreshed nor removed (#45).
  const body = readFile(path.join(ROOT, 'src', 'rules', 'kakashi-activate.md')) || '';
  const rest = stripLegacyContinueNote(stripMarkerBlock(config.systemMessage || '')).trim();
  config.systemMessage = (rest ? `${rest}\n\n` : '') + marked(body);
  writeFile(configPath, JSON.stringify(config, null, 2));
  console.log('  [ok] Continue  (full rule in systemMessage)');
}

// ---- Uninstall, one agent at a time (#45) --------------------------------
// `--uninstall --only cursor` used to remove every agent's commands, Claude's
// included; Continue and the repository files --with-init writes were never
// removed. Each agent now removes exactly what its installer wrote.

function uninstallClaude() {
  const configDir = opts.configDir || path.join(homeDir, '.claude');
  const rule = removeMarkerBlock(path.join(configDir, 'CLAUDE.md'));
  const n = removeSlashCommands(path.join(configDir, 'commands'));
  removeFile(path.join(configDir, 'kakashi-active'));
  return rule || n > 0;
}

function uninstallFiles(ruleFile, commandsDir, repoRuleFile, repoCommandsDir) {
  let any = removeFile(path.join(homeDir, ruleFile)) | removeSlashCommands(path.join(homeDir, commandsDir));
  if (opts.withInit) {
    any |= removeFile(path.join(process.cwd(), repoRuleFile)) | removeSlashCommands(path.join(process.cwd(), repoCommandsDir));
  }
  return Boolean(any);
}

function uninstallCodex() {
  let any = removeMarkerBlock(path.join(homeDir, '.codex', 'AGENTS.md'))
    | removeSlashCommands(path.join(homeDir, '.codex', 'commands'));
  if (opts.withInit) {
    any |= removeMarkerBlock(path.join(process.cwd(), 'AGENTS.md'))
      | removeSlashCommands(path.join(process.cwd(), '.codex', 'commands'));
  }
  return Boolean(any);
}

function uninstallCline() {
  if (!opts.withInit) return false;
  return Boolean(removeFile(path.join(process.cwd(), '.clinerules', 'kakashi.md'))
    | removeSlashCommands(path.join(process.cwd(), '.clinerules', 'commands')));
}

function uninstallCopilot() {
  return opts.withInit && removeMarkerBlock(path.join(process.cwd(), '.github', 'copilot-instructions.md'));
}

function uninstallContinue() {
  const configPath = path.join(homeDir, '.continue', 'config.json');
  const raw = readFile(configPath);
  if (raw === null) return false;
  let config;
  try { config = JSON.parse(raw); } catch { return false; }
  const before = config.systemMessage || '';
  const after = stripLegacyContinueNote(stripMarkerBlock(before)).trim();
  if (after === before.trim()) return false;
  if (after) config.systemMessage = after;
  else delete config.systemMessage;
  writeFile(configPath, JSON.stringify(config, null, 2));
  return true;
}

const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    detect: () => which('claude') || fs.existsSync(path.join(homeDir, '.claude')),
    install: installClaude,
    uninstall: uninstallClaude,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detect: () => which('cursor') || fs.existsSync(path.join(homeDir, '.cursor')),
    install: installCursor,
    uninstall: () => uninstallFiles(path.join('.cursor', 'rules', 'kakashi.mdc'), path.join('.cursor', 'commands'),
      path.join('.cursor', 'rules', 'kakashi.mdc'), path.join('.cursor', 'commands')),
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    detect: () => which('codex') || fs.existsSync(path.join(homeDir, '.codex')),
    install: installCodex,
    uninstall: uninstallCodex,
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    detect: () => which('windsurf') || fs.existsSync(path.join(homeDir, '.windsurf')),
    install: installWindsurf,
    uninstall: () => uninstallFiles(path.join('.windsurf', 'rules', 'kakashi.md'), path.join('.windsurf', 'commands'),
      path.join('.windsurf', 'rules', 'kakashi.md'), path.join('.windsurf', 'commands')),
  },
  {
    id: 'cline',
    name: 'Cline',
    detect: () => opts.withInit,
    install: installCline,
    uninstall: uninstallCline,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    detect: () => which('gh') || opts.withInit,
    install: installCopilot,
    uninstall: uninstallCopilot,
  },
  {
    id: 'continue',
    name: 'Continue',
    detect: () => fs.existsSync(path.join(homeDir, '.continue')),
    install: installContinue,
    uninstall: uninstallContinue,
  },
];

function uninstall(targets) {
  console.log('\nKakashi — Uninstalling\n');
  if (opts.dryRun) console.log('[dry-run mode — no files changed]\n');
  for (const agent of targets) {
    if (opts.dryRun) {
      console.log(`  [dry-run] Would remove Kakashi from: ${agent.name}`);
      continue;
    }
    try {
      console.log(agent.uninstall() ? `  [ok] ${agent.name}: removed` : `  [--] ${agent.name}: nothing to remove`);
    } catch (err) {
      console.log(`  [fail] ${agent.name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(opts.withInit ? '\nDone.\n' : '\nDone. Repository files from --with-init are removed with --with-init too.\n');
}

function listAgents() {
  console.log('\nKakashi — Agent Matrix\n');
  for (const a of AGENTS) {
    const detected = a.detect();
    console.log(`  ${detected ? '●' : '○'} ${a.id.padEnd(12)} ${a.name}`);
  }
  console.log('');
}

const FLAGS = new Set([
  '--all', '--dry-run', '--with-init', '--minimal', '--uninstall', '--list', '--force',
  '--non-interactive', '--only', '--config-dir', '--help', '-h',
]);

/**
 * Parse the command line. An unknown flag is an error: `--dryrun` used to be
 * ignored and the install went ahead for real (#45).
 * @throws {Error}
 */
function parseArgs(argv) {
  const result = {
    all: false,
    only: [],
    dryRun: false,
    withInit: false,
    minimal: false,
    uninstall: false,
    list: false,
    force: false,
    nonInteractive: false,
    configDir: null,
    help: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!FLAGS.has(arg)) throw new Error(`Unknown option: ${arg}`);
    if (arg === '--all') result.all = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--with-init') result.withInit = true;
    else if (arg === '--minimal') result.minimal = true;
    else if (arg === '--uninstall') result.uninstall = true;
    else if (arg === '--list') result.list = true;
    else if (arg === '--force') result.force = true; // blocks are always refreshed now; kept for old scripts
    else if (arg === '--non-interactive') result.nonInteractive = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--only') result.only.push(...value(i++, arg).split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--config-dir') result.configDir = value(i++, arg).replace(/^~/, homeDir);
  }
  return result;
}

const USAGE = `Usage: kakashi install [options]      (or: kakashi-install, node bin/install.js)
       kakashi uninstall [options]

  --all              every supported agent, detected or not
  --only <ids>       comma-separated: ${'${IDS}'}
  --with-init        also write (or remove) the rule files in the current repository
  --dry-run          show what would be done; change nothing
  --list             show which agents are detected
  --uninstall        remove Kakashi's rules and commands (scoped by --only)
  --config-dir <dir> Claude Code's config directory (default ~/.claude)
`;

function main(argv = process.argv.slice(2)) {
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    console.error(USAGE.replace('${IDS}', AGENTS.map((a) => a.id).join(', ')));
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE.replace('${IDS}', AGENTS.map((a) => a.id).join(', ')));
    return;
  }

  if (opts.list) {
    listAgents();
    return;
  }

  // An unknown id used to install nothing and say only "No agents detected",
  // so a documented-looking command like `--only aider` silently did nothing.
  const unknown = opts.only.filter((id) => !AGENTS.some((a) => a.id === id));
  if (unknown.length) {
    console.error(`\nUnknown agent id: ${unknown.join(', ')}`);
    console.error(`Supported: ${AGENTS.map((a) => a.id).join(', ')}`);
    console.error('Other agents can use Kakashi through their own rules file: see "Other agents" in the README.\n');
    process.exitCode = 2;
    return;
  }

  if (opts.uninstall) {
    uninstall(opts.only.length ? AGENTS.filter((a) => opts.only.includes(a.id)) : AGENTS);
    return;
  }

  const targets = opts.only.length
    ? AGENTS.filter((a) => opts.only.includes(a.id))
    : opts.all
      ? AGENTS
      : AGENTS.filter((a) => a.detect());

  if (targets.length === 0) {
    console.log('\nNo agents detected. Use --all or --only <id>.\n');
    listAgents();
    return;
  }

  console.log('\nKakashi — Installing\n');
  if (opts.dryRun) console.log('[dry-run mode — no files written]\n');

  for (const agent of targets) {
    if (opts.dryRun) {
      console.log(`  [dry-run] Would install: ${agent.name}`);
    } else {
      try {
        agent.install();
      } catch (err) {
        console.log(`  [fail] ${agent.name}: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }

  console.log('\nDone. Run: kakashi scan <file>\n');
}

module.exports = { main, parseArgs, AGENTS, SLASH_CMDS };

if (require.main === module) main();
