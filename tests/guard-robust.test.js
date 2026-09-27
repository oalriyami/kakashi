const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const guard = require('../src/agent/guard');

// ---------------------------------------------------------------------------
// #37 -- no request, however malformed, aborted or oversized, may crash or
//        hang agent-guard.
// #38 -- a slow file cannot stall the daemon, and one past the time limit is
//        reported as NOT checked, never as clean.
// All values are synthetic.
// ---------------------------------------------------------------------------

const LOOPBACK = ['127', '0', '0', '1'].join('.');
const HOST = ['h', 'ost'].join('');
const KEY = `sk-proj-${'a1B2'.repeat(12)}`;

function request(port, { method = 'POST', url = '/scan', token, body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    if (token) h.Authorization = `Bearer ${token}`;
    if (typeof body === 'string' && h['Content-Length'] === undefined && h['Transfer-Encoding'] === undefined) {
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ [HOST]: LOOPBACK, port, path: url, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (typeof body === 'function') body(req);
    else req.end(body);
  });
}

const health = (port) => request(port, { method: 'GET', url: '/health', headers: { 'Content-Type': undefined } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send raw bytes on a socket and return whatever comes back before it closes. */
function raw(port, data, { closeAfterMs } = {}) {
  return new Promise((resolve) => {
    let got = '';
    const s = net.connect(port, LOOPBACK, () => {
      s.write(data);
      if (closeAfterMs !== undefined) setTimeout(() => s.destroy(), closeAfterMs);
    });
    s.on('data', (d) => { got += d; });
    s.on('error', () => {});
    s.on('close', () => resolve(got));
  });
}

async function runGuardRobustTests() {
  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`FAIL ${name}: ${err.message}`);
      failed++;
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guard-robust-'));
  const watch = path.join(dir, 'watch');
  fs.mkdirSync(watch);
  fs.writeFileSync(path.join(watch, 'app.env'), `API_KEY=${KEY}\n`);
  // About a second of detection: long enough to overlap, and to time out.
  fs.writeFileSync(path.join(watch, 'slow.txt'), 'hi '.repeat(400 * 1024));
  const events = [];
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir);

  const h = await guard.start({
    watch,
    port: 0,
    tokenFile: path.join(dir, 'main.token'),
    log: path.join(logDir, 'guard.jsonl'),
    onEvent: (e) => events.push(e),
  });
  const P = h.port;
  const T = h.token;

  try {
    // =======================================================================
    // #37
    // =======================================================================

    await check('#37 a client that aborts mid-body does not kill the daemon', async () => {
      const head = `POST /scan HTTP/1.1\r\nHost: ${LOOPBACK}:${P}\r\nContent-Type: application/json\r\n`
        + `Authorization: Bearer ${T}\r\nContent-Length: 1000\r\n\r\n{"path":`;
      await raw(P, head, { closeAfterMs: 50 });
      await wait(100);
      assert.strictEqual((await health(P)).status, 200);
      assert(events.some((e) => e.kind === 'request_aborted'), 'the abort was not recorded');
    });

    await check('#37 a declared body over 64 KB is refused with 413 before it is read', async () => {
      const r = await request(P, { token: T, headers: { 'Content-Length': String(400 * 1024 * 1024) }, body: (req) => req.end() })
        .catch((err) => ({ status: err.code }));
      // The daemon answers 413 and closes; a client still writing may see a reset.
      assert(r.status === 413 || r.status === 'ECONNRESET' || r.status === 'EPIPE', `got ${r.status}`);
      assert.strictEqual((await health(P)).status, 200);
    });

    await check('#37 a streamed body over 64 KB is refused with 413', async () => {
      const r = await request(P, {
        token: T,
        headers: { 'Transfer-Encoding': 'chunked' },
        body: (req) => { req.write(`{"path":"${'a'.repeat(1024 * 1024)}`); req.end('"}'); },
      }).catch((err) => ({ status: err.code }));
      assert(r.status === 413 || r.status === 'ECONNRESET' || r.status === 'EPIPE', `got ${r.status}`);
      assert.strictEqual((await health(P)).status, 200);
    });

    await check('#37 a body that is JSON but not an object is 400', async () => {
      for (const body of ['[]', '"app.env"', 'null', '42', '{"path":42}', '{"path":""}', '{"path":["app.env"]}']) {
        const r = await request(P, { token: T, body });
        assert.strictEqual(r.status, 400, `${body} -> ${r.status} ${r.text}`);
      }
    });

    await check('#37 malformed HTTP is answered 400 and the daemon stays up', async () => {
      const got = await raw(P, 'NOT HTTP AT ALL\r\n\r\n');
      assert(/^HTTP\/1\.1 400/.test(got), JSON.stringify(got));
      assert.strictEqual((await health(P)).status, 200);
    });

    if (process.platform !== 'win32') {
      await check('#37 a FIFO is refused, not read forever', async () => {
        const fifo = path.join(watch, 'pipe.env');
        const made = spawnSync('mkfifo', [fifo]);
        if (made.status !== 0) return; // no mkfifo here
        const t0 = Date.now();
        const m = await request(P, { url: '/mask', token: T, body: JSON.stringify({ path: 'pipe.env' }) });
        assert.strictEqual(m.status, 400, m.text);
        assert(/not a regular file/.test(m.json.error), m.text);
        const s = await request(P, { token: T, body: JSON.stringify({ path: 'pipe.env' }) });
        assert.strictEqual(s.status, 200);
        assert.deepStrictEqual([s.json.skipped, s.json.reason], [true, 'not_a_file']);
        assert(Date.now() - t0 < 5000, 'took too long');
        fs.rmSync(fifo);
      });
    }

    await check('#37 a file over the size cap is refused, not read into memory', async () => {
      const big = await guard.start({
        watch, port: 0, tokenFile: path.join(dir, 'big.token'),
      });
      const saved = guard.DEFAULTS.maxFileBytes;
      try {
        guard.DEFAULTS.maxFileBytes = 1024; // the thread takes the cap when it starts
        const s = await request(big.port, { token: big.token, body: JSON.stringify({ path: 'slow.txt' }) });
        assert.deepStrictEqual([s.status, s.json.skipped, s.json.reason], [200, true, 'too_large']);
        const m = await request(big.port, { url: '/mask', token: big.token, body: JSON.stringify({ path: 'slow.txt' }) });
        assert.strictEqual(m.status, 413, m.text);
      } finally {
        guard.DEFAULTS.maxFileBytes = saved;
        await big.stop();
      }
    });

    await check('#37 a log folder that disappears is reported once; the daemon keeps serving', async () => {
      fs.rmSync(logDir, { recursive: true, force: true });
      const r = await request(P, { token: T, body: JSON.stringify({ path: 'app.env' }) });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.summary.total, 1);
      await request(P, { token: T, body: JSON.stringify({ path: 'app.env' }) });
      assert.strictEqual(events.filter((e) => e.kind === 'log_failed').length, 1);
      assert.strictEqual((await health(P)).status, 200);
    });

    await check('#37 a log file that cannot be written stops start-up with a clear message', async () => {
      await assert.rejects(
        guard.start({ watch, port: 0, tokenFile: path.join(dir, 'nolog.token'), log: path.join(dir, 'missing', 'guard.jsonl') }),
        /cannot write the log file/,
      );
    });

    // =======================================================================
    // #38
    // =======================================================================

    await check('#38 /health answers while a slow file is being scanned', async () => {
      const scan = request(P, { token: T, body: JSON.stringify({ path: 'slow.txt' }) });
      let scanned = false;
      scan.then(() => { scanned = true; });
      await wait(150);
      const t0 = Date.now();
      const hr = await health(P);
      const ms = Date.now() - t0;
      assert.strictEqual(hr.status, 200);
      assert(!scanned, 'the slow scan finished before /health was asked; the test proves nothing');
      assert(ms < 250, `/health took ${ms} ms during a scan`);
      assert.strictEqual((await scan).status, 200);
    });

    await check('#38 a scan past the time limit is 503 "NOT checked", and the next one works', async () => {
      const quick = await guard.start({
        watch, port: 0, tokenFile: path.join(dir, 'quick.token'), scanTimeoutMs: 300,
      });
      try {
        const r = await request(quick.port, { token: quick.token, body: JSON.stringify({ path: 'slow.txt' }) });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json.checked, false);
        assert(/NOT checked/.test(r.json.error), r.text);
        assert(!('summary' in r.json), 'a timed-out scan must not look like a result');
        const m = await request(quick.port, { url: '/mask', token: quick.token, body: JSON.stringify({ path: 'slow.txt' }) });
        assert.strictEqual(m.status, 503, m.text);
        assert(!fs.existsSync(path.join(watch, 'masked_slow.txt')), 'a stopped mask left output behind');
        const again = await request(quick.port, { token: quick.token, body: JSON.stringify({ path: 'app.env' }) });
        assert.strictEqual(again.status, 200, again.text);
        assert.strictEqual(again.json.summary.total, 1);
        const hb = (await health(quick.port)).json;
        assert.deepStrictEqual([hb.scanTimeoutMs, hb.scansTimedOut], [300, 2]);
      } finally {
        await quick.stop();
      }
    });

    await check('#38 the time limit must be a positive whole number', async () => {
      for (const bad of [0, -1, 1.5, NaN]) {
        await assert.rejects(
          guard.start({ watch, port: 0, tokenFile: path.join(dir, 'bad.token'), scanTimeoutMs: bad }),
          /time limit/,
          String(bad),
        );
      }
    });

    await check('#38 the scan thread never sends finding values back', async () => {
      const r = await request(P, { token: T, body: JSON.stringify({ path: 'app.env' }) });
      assert(!r.text.includes(KEY), 'the key reached the response');
    });
  } finally {
    await h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`guard-robust.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runGuardRobustTests };

if (require.main === module) {
  runGuardRobustTests().then((ok) => process.exit(ok ? 0 : 1));
}
