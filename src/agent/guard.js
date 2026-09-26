/**
 * kakashi agent-guard — a local privacy daemon for agentic AI.
 *
 * Concept
 * -------
 * Agent-guard is Kakashi's answer to a single question:
 *
 *   "How do you make agentic AI safe to deploy at scale?"
 *
 * The answer is to give every agent a *local privacy sidecar* it can
 * consult before it ships anything to an external LLM. Agent-guard is
 * exactly that sidecar. It:
 *
 *   1. Watches a working directory for changes and passively scans every
 *      file it sees, logging findings to a rolling JSONL audit trail. This
 *      is the passive "canary" — a Data Protection Officer can review the
 *      log at any time and see what sensitive data was present in the tree.
 *
 *   2. Exposes an HTTP API on the IPv4 loopback interface (never a
 *      public interface) with three endpoints that agents / IDEs / MCP
 *      servers can call synchronously:
 *
 *        GET  /health           → { ok, watching, uptimeMs, findings }
 *        POST /scan { path }    → { findings, summary }  (counts + PDPL)
 *        POST /mask { path }    → { output, findings }   (writes masked_)
 *
 *      Any MCP-enabled agent (Claude, Cursor, Copilot, ...) can be wired
 *      to POST /scan before attaching a file body to its LLM context, and
 *      refuse the attach if findings > 0.
 *
 *   3. Never opens outbound sockets. All state is in-memory + one local
 *      JSONL file. This preserves the "nothing leaves your machine"
 *      guarantee even while running as a long-lived daemon.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { maskText } = require('../engine/masker');
const formats = require('../engine/formats');
const { summarize } = require('../lib/pdpl-mapping');
const { version } = require('../../package.json');

const LOOPBACK = ['127', '0', '0', '1'].join('.');

/** Directories never worth watching: dependency trees and VCS internals. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv']);

/** Every directory under `root` (inclusive), skipping SKIP_DIRS and symlinks. */
function listDirs(root) {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    out.push(dir);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) queue.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Every regular file under `root`, skipping SKIP_DIRS and symlinks. */
function listFiles(root) {
  const out = [];
  for (const dir of listDirs(root)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isFile()) out.push(path.join(dir, e.name));
  }
  return out;
}

const DEFAULTS = {
  port: 8797,
  bindAddress: LOOPBACK,
  scanCooldownMs: 500, // debounce: don't re-scan a file more than 2×/sec
};

/**
 * Scan a single file and return an enriched summary.
 * Returns { skipped: true, reason } if the file cannot be scanned.
 */
async function scanFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { skipped: true, reason: 'not_found' };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { skipped: true, reason: 'not_a_file' };
  }
  if (formats.getFormat(filePath) === null) {
    return { skipped: true, reason: 'unsupported_format' };
  }
  const data = await formats.readFile(filePath);
  const { findings } = maskText(data.text);
  const { findings: enriched, summary } = summarize(findings);
  return { path: filePath, findings: enriched, summary };
}

/**
 * Mask a single file — same code path as `kakashi mask` but returned as
 * data rather than printed.
 */
async function maskFile(filePath, outputPath) {
  const data = await formats.readFile(filePath);
  const { masked, findings } = maskText(data.text);
  const out = outputPath || formats.defaultOutputPath(filePath);
  const replMap = {};
  for (const f of findings) replMap[f.original] = f.replacement;
  await formats.writeMasked(filePath, out, { ...data, format: formats.getFormat(filePath) }, replMap, masked);
  return { output: out, findings };
}

/**
 * Start the guard daemon.
 * @param {object} options
 * @param {string} options.watch — directory to watch
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.log] — path to JSONL audit log
 * @param {boolean} [options.autoMask] — write masked_ file when findings are detected
 * @param {function(object): void} [options.onEvent] — for tests
 * @returns {Promise<{ server, stop, watcher, port }>}
 */
async function start(options) {
  const bindAddress = options.host || DEFAULTS.bindAddress;
  const {
    watch,
    port = DEFAULTS.port,
    log,
    autoMask = false,
    onEvent,
  } = options;

  if (!watch) throw new Error('agent-guard: --watch <dir> is required');
  if (!fs.existsSync(watch) || !fs.statSync(watch).isDirectory()) {
    throw new Error(`agent-guard: not a directory: ${watch}`);
  }

  const state = {
    startedAt: Date.now(),
    findings: 0,
    files: 0,
    lastScanAt: new Map(), // path → ms timestamp (debounce)
  };

  function emit(event) {
    if (log) {
      fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
    }
    if (onEvent) onEvent(event);
  }

  // ---- Passive scanner ------------------------------------------------------
  //
  // fs.watch is best-effort across platforms:
  //   Linux   → inotify. `recursive: true` works from Node 20 (19.1); Node 18
  //             throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, and we then watch
  //             every directory of the tree ourselves. Before this, Linux only
  //             ever watched the top level, so a secret written to
  //             ./project/config/.env was never seen (issue #16).
  //   macOS   → FSEvents via recursive:true, reliable
  //   Windows → ReadDirectoryChangesW; on network drives, mapped drives (G:), or
  //             certain sandboxed paths it throws `UNKNOWN: unknown error, watch`
  //             and the daemon dies before ever answering /health. Users then
  //             believe the whole tool is broken when in fact the HTTP API is
  //             fine — the watcher just cannot start on that specific path.
  //
  // Strategy: try fs.watch first. If it throws synchronously (Windows UNKNOWN,
  // EPERM on network shares, ENOSPC on inotify-exhausted Linux), fall back to a
  // low-frequency polling scan so the HTTP surface keeps working. If polling is
  // undesirable too (KAKASHI_GUARD_NO_WATCH=1), skip passive scanning entirely
  // and rely solely on the loopback API.
  const NO_WATCH_ENV = process.env.KAKASHI_GUARD_NO_WATCH === '1';
  const POLL_INTERVAL_MS = Number(process.env.KAKASHI_GUARD_POLL_MS || 5000);
  // Force one strategy: native (recursive fs.watch), tree (one watcher per
  // directory) or poll. Unset: native, then tree, then poll.
  const FORCE_STRATEGY = process.env.KAKASHI_GUARD_WATCH || '';
  const MAX_WATCHED_DIRS = Number(process.env.KAKASHI_GUARD_MAX_DIRS || 4096);
  let watcher = { close: () => {} };
  let poller = null;
  let watchMode = 'off';
  let watchStrategy = null; // native | tree | poll

  async function onChangeCandidate(filename) {
    if (!filename) return;
    const full = path.isAbsolute(filename) ? filename : path.join(watch, filename);
    const relative = path.relative(watch, full);
    if (relative.split(path.sep).some((part) => SKIP_DIRS.has(part))) return;
    try {
      if (!fs.statSync(full).isFile()) return; // directories and deleted paths
    } catch {
      return;
    }
    const now = Date.now();
    const last = state.lastScanAt.get(full) || 0;
    if (now - last < DEFAULTS.scanCooldownMs) return;
    state.lastScanAt.set(full, now);

    try {
      const result = await scanFile(full);
      if (result.skipped) return;
      state.files++;
      state.findings += result.summary.total;
      emit({
        kind: 'passive_scan',
        path: relative,
        findings: result.summary.total,
        bySeverity: result.summary.bySeverity,
      });
      if (autoMask && result.summary.total > 0) {
        const masked = await maskFile(full);
        emit({ kind: 'auto_masked', path: relative, output: masked.output, findings: masked.findings.length });
      }
    } catch (err) {
      emit({ kind: 'scan_error', path: relative, error: err.message });
    }
  }

  function degradeToPolling(err) {
    if (err) emit({ kind: 'watch_failed', platform: process.platform, error: err.message });
    try { watcher.close(); } catch { /* already closed */ }
    watchMode = 'poll';
    watchStrategy = 'poll';
    poller = startPolling();
  }

  function startNativeWatch() {
    const w = fs.watch(watch, { recursive: true }, (_evt, filename) => {
      if (filename) onChangeCandidate(String(filename));
    });
    // Some Windows failures come as an emitted 'error' rather than a throw.
    w.on('error', (err) => degradeToPolling(err));
    return w;
  }

  /**
   * One fs.watch per directory, for Linux on Node 18. New subdirectories get
   * their own watcher as they appear, and files already inside them are
   * scanned, since they may have been written before the watcher attached.
   */
  function startTreeWatch() {
    const watchers = new Map(); // dir -> FSWatcher
    const close = () => {
      for (const w of watchers.values()) { try { w.close(); } catch { /* closed */ } }
      watchers.clear();
    };
    const add = (dir) => {
      if (watchers.has(dir)) return;
      if (watchers.size >= MAX_WATCHED_DIRS) {
        throw new Error(`more than ${MAX_WATCHED_DIRS} directories to watch (KAKASHI_GUARD_MAX_DIRS)`);
      }
      const w = fs.watch(dir, (_evt, name) => {
        if (!name) return;
        const full = path.join(dir, String(name));
        let stat;
        try { stat = fs.statSync(full); } catch { return; }
        if (!stat.isDirectory()) {
          onChangeCandidate(full);
          return;
        }
        if (SKIP_DIRS.has(path.basename(full))) return;
        try {
          for (const d of listDirs(full)) add(d);
          for (const f of listFiles(full)) onChangeCandidate(f);
        } catch (err) {
          emit({ kind: 'watch_failed', platform: process.platform, error: err.message });
        }
      });
      w.on('error', () => {
        try { w.close(); } catch { /* closed */ }
        watchers.delete(dir);
      });
      watchers.set(dir, w);
    };
    try {
      for (const d of listDirs(watch)) add(d);
    } catch (err) {
      close();
      throw err;
    }
    return { close, get size() { return watchers.size; } };
  }

  if (NO_WATCH_ENV) {
    emit({ kind: 'watch_disabled', reason: 'KAKASHI_GUARD_NO_WATCH' });
  } else if (FORCE_STRATEGY === 'poll') {
    degradeToPolling(null);
  } else {
    try {
      if (FORCE_STRATEGY === 'tree') throw Object.assign(new Error('tree watching forced'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
      watcher = startNativeWatch();
      watchMode = 'watch';
      watchStrategy = 'native';
    } catch (err) {
      if (err && err.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        // Recursive watching isn't available here (Linux on Node 18): watch
        // each directory instead, and poll only if that fails too.
        try {
          watcher = startTreeWatch();
          watchMode = 'watch';
          watchStrategy = 'tree';
        } catch (treeErr) {
          degradeToPolling(treeErr);
        }
      } else {
        // Synchronous throw (UNKNOWN on Windows / EPERM on network share / etc.).
        // Degrade to polling; keep the HTTP API alive.
        degradeToPolling(err);
      }
    }
  }

  /**
   * Poor-man's watcher: every POLL_INTERVAL_MS, walk the tree and diff
   * modification times against the last snapshot. Detects new + modified files
   * at any depth; respects the same debounce as fs.watch, so a rapid save loop
   * doesn't hammer the scanner.
   */
  function startPolling() {
    const known = new Map(); // path → mtimeMs
    const snapshot = () => {
      const seen = new Map();
      for (const full of listFiles(watch)) {
        try { seen.set(full, fs.statSync(full).mtimeMs); } catch { /* vanished */ }
      }
      return seen;
    };
    const tick = async () => {
      let seen;
      try {
        seen = snapshot();
      } catch (err) {
        emit({ kind: 'poll_error', error: err.message });
        return;
      }
      for (const [full, mtime] of seen) {
        if (known.get(full) !== mtime) {
          known.set(full, mtime);
          onChangeCandidate(full);
        }
      }
    };
    // Seed the snapshot on start so we don't fire a "changed" event for every
    // pre-existing file the first time round.
    try {
      for (const [full, mtime] of snapshot()) known.set(full, mtime);
    } catch { /* the poller will report on next tick */ }
    return setInterval(tick, POLL_INTERVAL_MS);
  }

  // ---- HTTP API (loopback only) --------------------------------------------
  const server = http.createServer(async (req, res) => {
    // Refuse anything that isn't loopback. Belt-and-braces on top of
    // The server still guards the peer address in case an upstream
    // reverse proxies mistakenly forwarding to us.
    const remote = req.socket.remoteAddress || '';
    if (!/^(127\.|::1|::ffff:127\.)/.test(remote)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent-guard binds loopback only' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        watching: watch,
        uptimeMs: Date.now() - state.startedAt,
        filesScanned: state.files,
        totalFindings: state.findings,
        // `watchMode` reveals whether the OS-level watcher survived startup or
        // we degraded to polling. Useful for the Windows UNKNOWN case where
        // the daemon looked dead but is actually serving on loopback.
        watchMode,
        // How the tree is watched: native (recursive fs.watch), tree (one
        // watcher per directory, Linux on Node 18) or poll. Every strategy
        // covers subdirectories; watchRecursive says so explicitly.
        watchStrategy,
        watchRecursive: watchMode !== 'off',
        version,
      }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/scan' || req.url === '/mask')) {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Body must be JSON: {"path":"..."}' }));
        return;
      }
      if (!parsed.path) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "path" field' }));
        return;
      }
      try {
        if (req.url === '/scan') {
          const result = await scanFile(parsed.path);
          state.files++;
          if (result.summary) state.findings += result.summary.total;
          emit({ kind: 'api_scan', path: parsed.path, findings: result.summary?.total || 0 });
          // Return COUNTS + PDPL summary — never the raw finding values,
          // even over loopback. Agents that need the full mapping must call
          // /audit (not implemented here — you'd want a permission gate for
          // that in a v1.2 release).
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.skipped ? result : {
            path: result.path,
            summary: result.summary,
          }));
        } else {
          const result = await maskFile(parsed.path, parsed.output);
          emit({ kind: 'api_mask', path: parsed.path, findings: result.findings.length });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ output: result.output, replacements: result.findings.length }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Try GET /health, POST /scan, POST /mask.' }));
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bindAddress, resolve);
  });

  function stop() {
    // Best-effort teardown: any of these may already have been closed by an
    // earlier error path, so guard each with try/catch. The point of stop() is
    // to leave nothing running, not to prove nothing was running.
    try { watcher.close(); } catch { /* already closed */ }
    if (poller) { try { clearInterval(poller); } catch { /* already cleared */ } }
    return new Promise((resolve) => server.close(() => resolve()));
  }

  // Port 0 asks the OS for any free ephemeral port. Return the actual bound
  // port so a local client never mistakes 0 for a usable endpoint.
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return { server, watcher, stop, port: boundPort, state };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { start, scanFile, maskFile, DEFAULTS };
