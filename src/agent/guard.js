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
 *      Any local agent can be wired to POST /scan before attaching a file
 *      body to its LLM context, and refuse the attach if findings > 0.
 *
 *      Loopback is not a trust boundary on its own: every web page the user
 *      opens can send requests to 127.0.0.1, and so can every other process
 *      and user on the machine. /scan and /mask read and write files, so they
 *      require, in order (#32):
 *
 *        - a Host header naming the loopback address or `localhost`, which
 *          defeats DNS rebinding (a rebound page sends its own host name);
 *        - no Origin header: browsers send one on every POST, local tools
 *          do not, so no web page can reach them;
 *        - `Content-Type: application/json`, which a page cannot send
 *          cross-origin without a CORS preflight this server never answers;
 *        - `Authorization: Bearer <token>`, a random token minted at start
 *          and written to a file only the user can read, which keeps out
 *          other users and processes on the machine;
 *        - a `path` inside the watched folder, after resolving symlinks, and
 *          an output that is a new file (or an earlier masked_ copy) inside
 *          it too, never a symlink.
 *
 *   3. Never opens outbound sockets. All state is in-memory + one local
 *      JSONL file. This preserves the "nothing leaves your machine"
 *      guarantee even while running as a long-lived daemon.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
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
  // A request body is a small JSON object naming a path. Anything larger is a
  // mistake or an attack: it used to be buffered whole (400 MB was accepted).
  maxBodyBytes: 64 * 1024,
  // The largest file the daemon will open. Every file is read whole into
  // memory, so the cap is what stops one request from exhausting it.
  maxFileBytes: Number(process.env.KAKASHI_GUARD_MAX_FILE_BYTES || 64 * 1024 * 1024),
  // How long one scan or mask may run before it is stopped and the file is
  // reported as NOT checked (#38).
  scanTimeoutMs: Number(process.env.KAKASHI_GUARD_TIMEOUT_MS || 60 * 1000),
};

/** A request the daemon refuses, with the HTTP status to refuse it with. */
class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A scan or mask stopped at the time limit: the file was not checked. */
class ScanTimeout extends Refusal {
  constructor(ms) {
    super(503, `the file was NOT checked: the scan took longer than ${ms} ms and was stopped`);
  }
}

/**
 * One worker thread that runs scan and mask jobs one at a time, each under a
 * time limit (#38).
 *
 * Detection used to run on the daemon's own thread, so one slow file stalled
 * every other request, /health included, for as long as it took. Here a job
 * that runs past the limit is rejected with ScanTimeout -- never reported as
 * clean -- and its thread is terminated and replaced. A mask stopped this way
 * leaves no output: files are written to a temporary file and renamed.
 */
function scanThread(timeoutMs) {
  let worker = null;
  let ready = false;
  let current = null;
  let closed = false;
  let nextId = 1;
  const queue = [];

  function finish() {
    const job = current;
    current = null;
    clearTimeout(job.timer);
    return job;
  }

  function fail(err) {
    const wasReady = ready;
    worker = null;
    ready = false;
    if (current) finish().reject(err);
    // A thread that dies before it is ready would die again; don't loop.
    if (!wasReady) while (queue.length) queue.shift().reject(err);
    pump();
  }

  function spawn() {
    const w = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData: { maxFileBytes: DEFAULTS.maxFileBytes } });
    w.unref(); // an idle thread must not keep the process alive by itself
    worker = w;
    ready = false;
    w.on('message', (msg) => {
      if (w !== worker) return;
      if (msg.ready) {
        ready = true;
        pump();
        return;
      }
      if (!current || msg.id !== current.id) return;
      const job = finish();
      if (!msg.error) job.resolve(msg.result);
      else job.reject(msg.error.status ? new Refusal(msg.error.status, msg.error.message) : new Error(msg.error.message));
      pump();
    });
    w.on('error', (err) => { if (w === worker) fail(new Error(`the scan thread failed: ${err.message}`)); });
    w.on('exit', (code) => { if (w === worker) fail(new Error(`the scan thread exited with code ${code}`)); });
  }

  function pump() {
    if (closed || current || !queue.length) return;
    if (!worker) {
      spawn();
      return;
    }
    if (!ready) return;
    current = queue.shift();
    // The clock starts when the job reaches a ready thread, so neither the
    // queue nor the thread's start-up counts against it.
    current.timer = setTimeout(() => {
      const job = finish();
      const w = worker;
      worker = null;
      ready = false;
      w.terminate().catch(() => {});
      job.reject(new ScanTimeout(timeoutMs));
      pump();
    }, timeoutMs);
    worker.postMessage({ id: current.id, op: current.op, input: current.input, output: current.output });
  }

  return {
    /** Run 'scan' or 'mask' on the thread; resolves with its summary. */
    run(op, input, output) {
      if (closed) return Promise.reject(new Error('agent-guard is stopping'));
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, op, input, output, resolve, reject });
        pump();
      });
    },
    close() {
      closed = true;
      const err = new Error('agent-guard is stopping');
      if (current) finish().reject(err);
      while (queue.length) queue.shift().reject(err);
      const w = worker;
      worker = null;
      return w ? w.terminate().then(() => {}, () => {}) : Promise.resolve();
    },
  };
}

/** Where the token for a daemon on `port` is written unless told otherwise. */
function defaultTokenFile(port) {
  return path.join(os.homedir(), '.kakashi', `agent-guard-${port}.token`);
}

/**
 * The per-launch token. `KAKASHI_GUARD_TOKEN` lets a script that starts the
 * daemon choose it (at least 32 characters); otherwise it is random.
 */
function makeToken() {
  const fromEnv = process.env.KAKASHI_GUARD_TOKEN;
  if (fromEnv !== undefined) {
    if (fromEnv.length < 32) throw new Error('agent-guard: KAKASHI_GUARD_TOKEN must be at least 32 characters');
    return fromEnv;
  }
  return crypto.randomBytes(32).toString('hex');
}

/** Write the token so only this user can read it. */
function writeToken(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Refuse to follow a symlink planted where the token goes.
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`agent-guard: refusing to write the token through a symlink: ${file}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Constant-time comparison of the presented token with the real one. */
function tokenMatches(header, token) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** Is `candidate` the root itself or somewhere beneath it? */
function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolve a requested input path against the watched folder. Relative paths
 * are relative to the folder, and the file must really live inside it once
 * symlinks are resolved.
 */
function confineInput(root, requested) {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new Refusal(400, '"path" must be a non-empty string');
  }
  const abs = path.resolve(root, requested);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // Missing files are reported by scanFile as { skipped, reason: not_found },
    // but only once we know the path would have been inside the folder.
    if (!isInside(root, abs)) throw new Refusal(403, 'path is outside the watched folder');
    return abs;
  }
  if (!isInside(root, real)) throw new Refusal(403, 'path is outside the watched folder');
  return real;
}

/**
 * Decide where a masked copy may be written.
 *
 * With no `output`, the copy goes next to the input as masked_<name>, and an
 * earlier copy of that name may be replaced. An explicit `output` must be a
 * NEW file. Either way it must sit inside the watched folder, must not be a
 * symlink, and must not be the input itself.
 */
function confineOutput(root, input, requested) {
  let target;
  let explicit = false;
  if (requested === undefined || requested === null) {
    target = formats.defaultOutputPath(input);
  } else {
    if (typeof requested !== 'string' || requested.length === 0) {
      throw new Refusal(400, '"output" must be a non-empty string');
    }
    target = path.resolve(root, requested);
    explicit = true;
  }
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(target));
  } catch {
    throw new Refusal(400, 'the output folder does not exist');
  }
  const real = path.join(parent, path.basename(target));
  if (!isInside(root, real)) throw new Refusal(403, 'output is outside the watched folder');
  if (real === input) throw new Refusal(400, 'output would overwrite the input');
  let st = null;
  try {
    st = fs.lstatSync(real);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) throw new Refusal(403, 'output exists and is not a regular file');
    if (explicit) throw new Refusal(409, 'output already exists; choose a new file name');
  }
  return real;
}

/** Is this Host header one of our own loopback names? */
function isLoopbackHost(host, port) {
  if (!host) return false;
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  return names.some((n) => host === n || host === `${n}:${port}`);
}

/**
 * Scan a single file and return an enriched summary.
 * Returns { skipped: true, reason } if the file cannot be scanned.
 */
/**
 * Why a path must not be opened, or null when it may be.
 *
 * Only regular files under the size cap are read (#37). A FIFO blocks the read
 * forever -- and with it the whole daemon -- and `/dev/zero` or a huge file is
 * read into memory until the process dies.
 */
function unreadable(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return 'not_found';
  }
  if (!stat.isFile()) return 'not_a_file';
  if (stat.size > DEFAULTS.maxFileBytes) return 'too_large';
  return null;
}

async function scanFile(filePath) {
  const reason = unreadable(filePath);
  if (reason) return { skipped: true, reason };
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
  const reason = unreadable(filePath);
  if (reason) {
    const why = { not_found: 'the file does not exist', not_a_file: 'not a regular file', too_large: 'the file is larger than the daemon will read' };
    throw new Refusal(reason === 'too_large' ? 413 : 400, why[reason]);
  }
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
 * @param {number} [options.scanTimeoutMs] — stop a scan or mask after this long
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
    scanTimeoutMs = DEFAULTS.scanTimeoutMs,
  } = options;

  if (!watch) throw new Error('agent-guard: --watch <dir> is required');
  if (!fs.existsSync(watch) || !fs.statSync(watch).isDirectory()) {
    throw new Error(`agent-guard: not a directory: ${watch}`);
  }

  if (!(Number.isInteger(scanTimeoutMs) && scanTimeoutMs > 0)) {
    throw new Error(`agent-guard: the scan time limit must be a positive whole number of milliseconds, not ${scanTimeoutMs}`);
  }

  // Everything the API touches is checked against the folder's real path.
  const root = fs.realpathSync(watch);
  const token = makeToken();
  let tokenFile = null;

  const state = {
    startedAt: Date.now(),
    findings: 0,
    files: 0,
    lastScanAt: new Map(), // path → ms timestamp (debounce)
    timedOut: 0,
  };
  const thread = scanThread(scanTimeoutMs);

  // Check the audit log can be written before anything starts: a log in a
  // missing folder used to kill the daemon on its first event (#37).
  if (log) {
    try {
      fs.appendFileSync(log, '');
    } catch (err) {
      throw new Error(`agent-guard: cannot write the log file ${log}: ${err.message}`);
    }
  }
  let logBroken = false;

  function emit(event) {
    if (log && !logBroken) {
      try {
        fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
      } catch (err) {
        // The folder was removed or the disk filled up. Say so once, keep
        // serving: a broken log is no reason to stop answering.
        logBroken = true;
        if (onEvent) onEvent({ kind: 'log_failed', error: err.message });
      }
    }
    if (onEvent) {
      try { onEvent(event); } catch { /* a listener's bug is not the daemon's */ }
    }
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
    const why = unreadable(full);
    if (why === 'too_large') {
      emit({ kind: 'passive_skipped', path: relative, reason: why });
      return;
    }
    if (why) return; // directories, FIFOs, deleted paths
    const now = Date.now();
    const last = state.lastScanAt.get(full) || 0;
    if (now - last < DEFAULTS.scanCooldownMs) return;
    state.lastScanAt.set(full, now);

    try {
      const result = await thread.run('scan', full);
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
        const masked = await thread.run('mask', full, confineOutput(root, fs.realpathSync(full)));
        emit({ kind: 'auto_masked', path: relative, output: masked.output, findings: masked.replacements });
      }
    } catch (err) {
      if (err instanceof ScanTimeout) {
        state.timedOut++;
        emit({ kind: 'scan_timeout', path: relative, timeoutMs: scanTimeoutMs });
      } else {
        emit({ kind: 'scan_error', path: relative, error: err.message });
      }
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
  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  /** Answer 413 and close the connection instead of reading the rest. */
  function tooLarge(req, res, message) {
    res.setHeader('Connection', 'close');
    send(res, 413, { error: message });
    res.on('finish', () => req.destroy());
  }

  const server = http.createServer((req, res) => {
    // A client that goes away mid-response is not an error worth dying for.
    res.on('error', () => {});
    handle(req, res).catch((err) => {
      // Nothing thrown while handling one request may take the daemon down.
      emit({ kind: 'request_error', error: err.message });
      if (!res.headersSent && !res.destroyed) {
        try { send(res, err instanceof Refusal ? err.status : 500, { error: err.message }); } catch { /* gone */ }
      } else {
        res.destroy();
      }
    });
  });
  // Malformed HTTP: answer 400 and close, as Node does by default, without
  // letting a socket error surface as an exception.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  async function handle(req, res) {
    // Refuse anything that isn't loopback. Belt-and-braces on top of the bind
    // address, in case a reverse proxy mistakenly forwards to us.
    const remote = req.socket.remoteAddress || '';
    if (!/^(127\.|::1|::ffff:127\.)/.test(remote)) {
      send(res, 403, { error: 'agent-guard binds loopback only' });
      return;
    }
    const boundPort = server.address() && server.address().port;
    if (!isLoopbackHost(req.headers.host, boundPort)) {
      send(res, 403, { error: 'Host must be 127.0.0.1, localhost or [::1]' });
      return;
    }
    if (req.headers.origin !== undefined) {
      send(res, 403, { error: 'requests from web pages are not accepted' });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, {
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
        // Where a client finds the token /scan and /mask require.
        tokenFile,
        // Scans run off this thread under a time limit; one that runs out is
        // answered 503 "NOT checked", never as clean.
        scanTimeoutMs,
        scansTimedOut: state.timedOut,
        version,
      });
      return;
    }

    if (req.method === 'POST' && (req.url === '/scan' || req.url === '/mask')) {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') {
        send(res, 415, { error: 'Content-Type must be application/json' });
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        send(res, 401, { error: 'Authorization: Bearer <token> required; the token is in the file /health names' });
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > DEFAULTS.maxBodyBytes) {
        tooLarge(req, res, `request body larger than ${DEFAULTS.maxBodyBytes} bytes`);
        return;
      }
      let body;
      try {
        body = await readBody(req, DEFAULTS.maxBodyBytes);
      } catch (err) {
        // The client went away mid-body, or sent too much. Neither may crash
        // the daemon (#37); only the second still has anyone to answer.
        if (err instanceof Refusal) tooLarge(req, res, err.message);
        else emit({ kind: 'request_aborted' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        send(res, 400, { error: 'Body must be JSON: {"path":"..."}' });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        send(res, 400, { error: 'Body must be a JSON object: {"path":"..."}' });
        return;
      }
      if (parsed.path === undefined) {
        send(res, 400, { error: 'Missing "path" field' });
        return;
      }
      let input;
      try {
        input = confineInput(root, parsed.path);
        if (req.url === '/scan') {
          const result = await thread.run('scan', input);
          state.files++;
          if (result.summary) state.findings += result.summary.total;
          emit({ kind: 'api_scan', path: path.relative(root, input), findings: result.summary?.total || 0 });
          // Return COUNTS + PDPL summary — never the raw finding values,
          // even over loopback.
          send(res, 200, result.skipped ? result : { path: result.path, summary: result.summary });
        } else {
          const output = confineOutput(root, input, parsed.output);
          const result = await thread.run('mask', input, output);
          emit({ kind: 'api_mask', path: path.relative(root, input), findings: result.replacements });
          send(res, 200, { output: result.output, replacements: result.replacements });
        }
      } catch (err) {
        if (err instanceof ScanTimeout) {
          state.timedOut++;
          emit({ kind: 'scan_timeout', path: path.relative(root, input), timeoutMs: scanTimeoutMs });
          send(res, err.status, { error: err.message, checked: false });
        } else if (err instanceof Refusal) {
          emit({ kind: 'api_refused', status: err.status, reason: err.message });
          send(res, err.status, { error: err.message });
        } else {
          send(res, 500, { error: err.message });
        }
      }
      return;
    }

    send(res, 404, { error: 'Not found. Try GET /health, POST /scan, POST /mask.' });
  }

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bindAddress, resolve);
  });

  // Port 0 asks the OS for any free ephemeral port. Return the actual bound
  // port so a local client never mistakes 0 for a usable endpoint.
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  // The token file is named after the bound port, so two daemons never share
  // one. It is written only after the port is known and removed on stop.
  try {
    tokenFile = options.tokenFile || defaultTokenFile(boundPort);
    writeToken(tokenFile, token);
  } catch (err) {
    server.close();
    try { watcher.close(); } catch { /* already closed */ }
    if (poller) clearInterval(poller);
    thread.close();
    throw err;
  }

  function stop() {
    // Best-effort teardown: any of these may already have been closed by an
    // earlier error path, so guard each with try/catch. The point of stop() is
    // to leave nothing running, not to prove nothing was running.
    try { watcher.close(); } catch { /* already closed */ }
    if (poller) { try { clearInterval(poller); } catch { /* already cleared */ } }
    try {
      if (fs.readFileSync(tokenFile, 'utf8').trim() === token) fs.rmSync(tokenFile, { force: true });
    } catch { /* already gone */ }
    const threadClosed = thread.close();
    return new Promise((resolve) => server.close(() => resolve())).then(() => threadClosed);
  }

  return { server, watcher, stop, port: boundPort, state, token, tokenFile };
}

/**
 * Read a request body of at most `limit` bytes.
 * Rejects with a 413 Refusal past the limit, and with an Error when the client
 * aborts -- which used to reject an unawaited promise and kill the process.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        done(reject, new Refusal(413, `request body larger than ${limit} bytes`));
        req.removeAllListeners('data');
        req.pause(); // read no more; the connection is closed after the 413
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('aborted', () => done(reject, new Error('request aborted')));
    req.on('error', (err) => done(reject, err));
    req.on('close', () => done(reject, new Error('request closed before its body ended')));
  });
}

module.exports = { start, scanFile, maskFile, DEFAULTS, defaultTokenFile };
