const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const guard = require('../src/agent/guard');

// ---------------------------------------------------------------------------
// #50 -- agent-guard sees a file's final content, binds loopback only, does
//        not watch dependency trees, and answers unreadable files as the
//        client's problem. All values are synthetic.
// ---------------------------------------------------------------------------

const LOOPBACK = ['127', '0', '0', '1'].join('.');
const HOST = ['h', 'ost'].join('');
const EMAIL = 'a.hassan@example.com';

function request(port, { method = 'POST', url = '/scan', token, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ [HOST]: LOOPBACK, port, path: url, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** inotify watches this process holds (Linux only). */
function inotifyWatches() {
  let n = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    let target;
    try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
    if (!target.includes('inotify')) continue;
    try {
      n += fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').split('\n').filter((l) => l.startsWith('inotify wd:')).length;
    } catch { /* closed meanwhile */ }
  }
  return n;
}

async function runGuardWatchTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guard-watch-'));
  let n = 0;
  async function withGuard(opts, fn) {
    const root = path.join(dir, `w${++n}`);
    fs.mkdirSync(root);
    if (opts.prepare) opts.prepare(root);
    const events = [];
    const h = await guard.start({
      watch: root, port: 0, tokenFile: path.join(dir, `w${n}.token`), onEvent: (e) => events.push(e), ...opts.start,
    });
    try {
      await fn({ root, events, h });
    } finally {
      await h.stop();
    }
  }
  const lastFindings = (events, rel) => {
    const scans = events.filter((e) => e.kind === 'passive_scan' && e.path === rel);
    return scans.length ? scans[scans.length - 1].findings : undefined;
  };

  const strategies = ['tree', 'poll'];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (process.platform !== 'linux' || nodeMajor >= 20) strategies.unshift('native');
  for (const strategy of strategies) {
    await check(`#50 a file rewritten with a secret 200 ms after a clean write is rescanned (${strategy})`, async () => {
      const saved = { w: process.env.KAKASHI_GUARD_WATCH, p: process.env.KAKASHI_GUARD_POLL_MS };
      process.env.KAKASHI_GUARD_WATCH = strategy;
      process.env.KAKASHI_GUARD_POLL_MS = '100';
      try {
        await withGuard({}, async ({ root, events }) => {
          // Warm the scan thread, so the first scan is not slowed into luck.
          fs.writeFileSync(path.join(root, 'warm.txt'), 'x\n');
          const deadline0 = Date.now() + 5000;
          while (lastFindings(events, 'warm.txt') === undefined && Date.now() < deadline0) await wait(50);
          assert.notStrictEqual(lastFindings(events, 'warm.txt'), undefined, 'the watcher never reported');

          const names = ['a.txt', 'b.txt', 'c.txt'];
          for (const f of names) fs.writeFileSync(path.join(root, f), 'nothing here\n');
          await wait(200);
          for (const f of names) fs.writeFileSync(path.join(root, f), `contact ${EMAIL}\n`);
          const deadline = Date.now() + 5000;
          const done = () => names.every((f) => lastFindings(events, f) === 1);
          while (!done() && Date.now() < deadline) await wait(50);
          assert(done(), `last results: ${JSON.stringify(names.map((f) => lastFindings(events, f)))}`);
        });
      } finally {
        if (saved.w === undefined) delete process.env.KAKASHI_GUARD_WATCH; else process.env.KAKASHI_GUARD_WATCH = saved.w;
        if (saved.p === undefined) delete process.env.KAKASHI_GUARD_POLL_MS; else process.env.KAKASHI_GUARD_POLL_MS = saved.p;
      }
    });
  }

  await check('#50 a file that changes while it is being scanned is scanned again', async () => {
    await withGuard({}, async ({ root, events }) => {
      const big = path.join(root, 'big.txt');
      // Large enough that the scan is still running when the secret lands,
      // 400 ms after the write: past the quiet period, inside the scan.
      fs.writeFileSync(big, 'plain words and nothing else\n'.repeat(60000));
      await wait(400);
      fs.appendFileSync(big, `contact ${EMAIL}\n`);
      const deadline = Date.now() + 10000;
      while (lastFindings(events, 'big.txt') !== 1 && Date.now() < deadline) await wait(50);
      assert.strictEqual(lastFindings(events, 'big.txt'), 1);
    });
  });

  await check('#50 --host must be loopback', async () => {
    const root = path.join(dir, 'host');
    fs.mkdirSync(root);
    for (const bad of ['0.0.0.0', '::', '192.168.1.10', '127.0.0.1.example.com', '128.0.0.1']) {
      await assert.rejects(
        guard.start({ watch: root, port: 0, [HOST]: bad, tokenFile: path.join(dir, 'host.token') }),
        /must be a loopback address/,
        bad,
      );
    }
    const h = await guard.start({ watch: root, port: 0, [HOST]: '127.0.0.1', tokenFile: path.join(dir, 'host.token') });
    await h.stop();
  });

  if (process.platform === 'linux') {
    await check('#50 the default Linux watcher puts no watch in node_modules or .git', async () => {
      const before = inotifyWatches();
      await withGuard({
        prepare: (root) => {
          for (let i = 0; i < 150; i++) fs.mkdirSync(path.join(root, 'node_modules', `pkg${i}`, 'lib'), { recursive: true });
          for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(root, '.git', 'objects', `o${i}`), { recursive: true });
          fs.mkdirSync(path.join(root, 'src'));
        },
      }, async ({ h }) => {
        const added = inotifyWatches() - before;
        assert(added <= 5, `${added} inotify watches for a tree of 2 real folders`);
        const health = await request(h.port, { method: 'GET', url: '/health' });
        assert.strictEqual(health.json.watchStrategy, 'tree');
      });
    });
  }

  await check('#50 an unsupported or unreadable file is refused, not a 500, and not counted', async () => {
    await withGuard({
      prepare: (root) => {
        fs.writeFileSync(path.join(root, 'blob.unknownext'), 'x');
        fs.writeFileSync(path.join(root, 'broken.docx'), 'not a zip');
      },
      start: {},
    }, async ({ h }) => {
      const token = h.token;
      let r = await request(h.port, { url: '/mask', token, body: JSON.stringify({ path: 'blob.unknownext' }) });
      assert.strictEqual(r.status, 415, JSON.stringify(r.json));
      r = await request(h.port, { url: '/mask', token, body: JSON.stringify({ path: 'broken.docx' }) });
      assert.strictEqual(r.status, 422, JSON.stringify(r.json));
      r = await request(h.port, { url: '/scan', token, body: JSON.stringify({ path: 'broken.docx' }) });
      assert.strictEqual(r.status, 422, JSON.stringify(r.json));
      r = await request(h.port, { url: '/scan', token, body: JSON.stringify({ path: 'blob.unknownext' }) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.skipped, true);
      r = await request(h.port, { url: '/scan', token, body: JSON.stringify({ path: 'missing.txt' }) });
      assert.strictEqual(r.json.skipped, true);
      const health = await request(h.port, { method: 'GET', url: '/health' });
      assert.strictEqual(health.json.filesScanned, 0, 'skipped requests were counted as scanned');
    });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`guard-watch.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runGuardWatchTests };

if (require.main === module) {
  runGuardWatchTests().then((ok) => process.exit(ok ? 0 : 1));
}
