const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const guard = require('../src/agent/guard');

const LOOPBACK = ['127', '0', '0', '1'].join('.');
const TEST_NATIONAL_ID = ['784', '1990', '9999999', '0'].join('-');
const TEST_EMAIL = ['a', 'b.com'].join('@');

/**
 * POST like a local client: JSON, the daemon's bearer token. `extra` adds or
 * overrides headers (set one to `null` to leave it out), and a string `body`
 * is sent as-is.
 */
function post(port, url, body, token, extra = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = `Bearer ${token}`;
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) delete headers[k];
      else headers[k] = v;
    }
    const req = http.request(
      { [['h', 'ost'].join('')]: LOOPBACK, port, path: url, method: 'POST', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ [['h', 'ost'].join('')]: LOOPBACK, port, path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function runGuardTests() {
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guard-'));
  const testFile = path.join(tmpDir, 'sample.md');
  fs.writeFileSync(testFile, `# Test\nEmirates ID: ${TEST_NATIONAL_ID}\nemail: ${TEST_EMAIL}\n`);

  // The token file goes to a scratch folder, never the developer's home.
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guard-token-'));
  const tokenFile = (name) => path.join(tokenDir, name);

  // Port 0 lets the OS choose a free port; start() must return the bound port.
  const handle = await guard.start({ watch: tmpDir, port: 0, tokenFile: tokenFile('main.token') });
  const PORT = handle.port;
  const TOKEN = handle.token;

  try {
    await check('GET /health returns ok', async () => {
      const r = await get(PORT, '/health');
      assert.strictEqual(r.status, 200);
      const body = JSON.parse(r.body);
      assert(body.ok);
      assert.strictEqual(body.watching, tmpDir);
      assert.strictEqual(body.version, require('../package.json').version);
    });

    await check('POST /scan on real file returns PDPL summary', async () => {
      const r = await post(PORT, '/scan', { path: testFile }, TOKEN);
      assert.strictEqual(r.status, 200);
      const body = JSON.parse(r.body);
      assert(body.summary, `no summary in response: ${r.body}`);
      assert(body.summary.total >= 2, `expected >=2 findings, got ${body.summary.total}`);
      assert(body.summary.byArticle['Art. 15'], 'must cite Art. 15 (sensitive data)');
      // CRITICAL: no raw values must leak in the response
      assert(!r.body.includes(TEST_NATIONAL_ID), 'raw Emirates ID must NOT appear in API response');
    });

    await check('POST /scan on missing file returns skipped', async () => {
      const r = await post(PORT, '/scan', { path: path.join(tmpDir, 'nonexistent.md') }, TOKEN);
      assert.strictEqual(r.status, 200);
      const body = JSON.parse(r.body);
      assert.strictEqual(body.skipped, true);
    });

    await check('POST /scan without path returns 400', async () => {
      const r = await post(PORT, '/scan', {}, TOKEN);
      assert.strictEqual(r.status, 400);
    });

    await check('POST /mask writes masked file', async () => {
      const out = path.join(tmpDir, 'masked_sample.md');
      if (fs.existsSync(out)) fs.unlinkSync(out);
      const r = await post(PORT, '/mask', { path: testFile, output: out }, TOKEN);
      assert.strictEqual(r.status, 200);
      const body = JSON.parse(r.body);
      assert(body.replacements >= 2);
      assert(fs.existsSync(out));
      const content = fs.readFileSync(out, 'utf8');
      assert(!content.includes(TEST_NATIONAL_ID), 'masked file must not contain raw ID');
      assert(content.includes('[NATIONAL_ID_1]'));
    });

    await check('Unknown endpoint returns 404', async () => {
      const r = await get(PORT, '/nonsense');
      assert.strictEqual(r.status, 404);
    });

    // -----------------------------------------------------------------------
    // #32 -- the API is confined to local tools and to the watched folder.
    // Every web page the user opens can send requests to 127.0.0.1, and so can
    // every other process on the machine; /scan and /mask read and write files.
    // -----------------------------------------------------------------------
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guard-outside-'));
    const victim = path.join(outside, 'settings.conf');
    const VICTIM_TEXT = 'untouched\n';
    fs.writeFileSync(victim, VICTIM_TEXT);
    const victimIntact = () => assert.strictEqual(fs.readFileSync(victim, 'utf8'), VICTIM_TEXT, 'file outside the folder changed');

    await check('#32 the token file is readable by its owner only', () => {
      assert.strictEqual(handle.tokenFile, tokenFile('main.token'));
      assert.strictEqual(fs.readFileSync(handle.tokenFile, 'utf8').trim(), TOKEN);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(handle.tokenFile).mode & 0o777, 0o600);
      assert.ok(TOKEN.length >= 32);
    });

    await check('#32 /health names the token file but not the token', async () => {
      const r = await get(PORT, '/health');
      assert.strictEqual(JSON.parse(r.body).tokenFile, handle.tokenFile);
      assert.ok(!r.body.includes(TOKEN));
    });

    await check('#32 no token, or a wrong one, is 401', async () => {
      assert.strictEqual((await post(PORT, '/scan', { path: testFile })).status, 401);
      assert.strictEqual((await post(PORT, '/scan', { path: testFile }, 'x'.repeat(64))).status, 401);
    });

    await check('#32 a request from a web page (Origin header) is 403', async () => {
      const r = await post(PORT, '/mask', { path: testFile, output: victim }, TOKEN, { Origin: 'http://attacker.example' });
      assert.strictEqual(r.status, 403);
      victimIntact();
    });

    await check('#32 a form-style text/plain body is 415, even with the token', async () => {
      const r = await post(PORT, '/scan', { path: testFile }, TOKEN, { 'Content-Type': 'text/plain' });
      assert.strictEqual(r.status, 415);
    });

    await check('#32 a rebound host name is 403 (DNS rebinding)', async () => {
      const r = await post(PORT, '/scan', { path: testFile }, TOKEN, { Host: `attacker.example:${PORT}` });
      assert.strictEqual(r.status, 403);
      const h = await post(PORT, '/scan', { path: testFile }, TOKEN, { Host: `localhost:${PORT}` });
      assert.strictEqual(h.status, 200, 'localhost must still work');
    });

    await check('#32 /scan of a file outside the watched folder is 403', async () => {
      const r = await post(PORT, '/scan', { path: victim }, TOKEN);
      assert.strictEqual(r.status, 403);
      const up = await post(PORT, '/scan', { path: '../' + path.basename(outside) + '/settings.conf' }, TOKEN);
      assert.strictEqual(up.status, 403, 'relative escape accepted');
    });

    await check('#32 a symlink inside the folder cannot reach a file outside it', async () => {
      const link = path.join(tmpDir, 'innocent.md');
      try { fs.symlinkSync(victim, link); } catch { return; } // no symlink support here
      const r = await post(PORT, '/scan', { path: link }, TOKEN);
      assert.strictEqual(r.status, 403);
      fs.unlinkSync(link);
    });

    await check('#32 /mask cannot write outside the folder, over the input, or through a symlink', async () => {
      assert.strictEqual((await post(PORT, '/mask', { path: testFile, output: victim }, TOKEN)).status, 403);
      assert.strictEqual((await post(PORT, '/mask', { path: testFile, output: testFile }, TOKEN)).status, 400);
      const planted = path.join(tmpDir, 'masked_planted.md');
      try {
        fs.symlinkSync(victim, planted);
        assert.strictEqual((await post(PORT, '/mask', { path: testFile, output: planted }, TOKEN)).status, 403);
        // The default output name, planted as a symlink, is refused too.
        const src = path.join(tmpDir, 'planted.md');
        fs.writeFileSync(src, `email: ${TEST_EMAIL}\n`);
        assert.strictEqual((await post(PORT, '/mask', { path: src }, TOKEN)).status, 403);
        fs.unlinkSync(planted);
      } catch (err) {
        if (err.code !== 'EPERM') throw err;
      }
      victimIntact();
    });

    await check('#32 an explicit output must be a new file; the default masked_ copy may be refreshed', async () => {
      const out = path.join(tmpDir, 'fresh-output.md');
      assert.strictEqual((await post(PORT, '/mask', { path: testFile, output: out }, TOKEN)).status, 200);
      assert.strictEqual((await post(PORT, '/mask', { path: testFile, output: out }, TOKEN)).status, 409);
      assert.strictEqual((await post(PORT, '/mask', { path: 'sample.md' }, TOKEN)).status, 200, 'relative to the folder');
      assert.strictEqual((await post(PORT, '/mask', { path: 'sample.md' }, TOKEN)).status, 200, 'refresh masked_ copy');
    });

    await check('#32 malformed bodies are 400 and the daemon stays up', async () => {
      for (const body of ['null', '[]', '"x"', JSON.stringify({ path: 42 }), JSON.stringify({ path: testFile, output: 1 })]) {
        const r = await post(PORT, '/mask', body, TOKEN);
        assert.strictEqual(r.status, 400, `body ${body} -> ${r.status}`);
      }
      assert.strictEqual((await get(PORT, '/health')).status, 200);
    });

    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    await handle.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  await check('#32 the token file is removed on stop', () => {
    assert.ok(!fs.existsSync(tokenFile('main.token')));
  });

  await check('#32 auto-mask never writes through a planted masked_ symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guard-auto-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-guard-auto-out-'));
    const victim = path.join(outside, 'profile');
    fs.writeFileSync(victim, 'untouched\n');
    try {
      fs.symlinkSync(victim, path.join(root, 'masked_config.env'));
    } catch {
      return;
    }
    const saved = { w: process.env.KAKASHI_GUARD_WATCH, p: process.env.KAKASHI_GUARD_POLL_MS };
    process.env.KAKASHI_GUARD_WATCH = 'poll';
    process.env.KAKASHI_GUARD_POLL_MS = '100';
    const events = [];
    const h = await guard.start({ watch: root, port: 0, autoMask: true, tokenFile: tokenFile('auto.token'), onEvent: (e) => events.push(e) });
    try {
      fs.writeFileSync(path.join(root, 'config.env'), `API_KEY=sk-proj-${'a1B2'.repeat(12)}\n`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !events.some((e) => e.kind === 'scan_error' || e.kind === 'auto_masked')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(events.some((e) => e.kind === 'scan_error'), `expected a refusal, got ${JSON.stringify(events.map((e) => e.kind))}`);
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'untouched\n');
    } finally {
      await h.stop();
      process.env.KAKASHI_GUARD_WATCH = saved.w;
      process.env.KAKASHI_GUARD_POLL_MS = saved.p;
      if (saved.w === undefined) delete process.env.KAKASHI_GUARD_WATCH;
      if (saved.p === undefined) delete process.env.KAKASHI_GUARD_POLL_MS;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Passive scanning covers subfolders on every platform (issue #16). On Linux
  // the watcher used to be top-level only, so a secret written to
  // ./config/.env was never seen. Each strategy is forced in turn:
  // native (recursive fs.watch), tree (one watcher per directory, the Node 18
  // Linux fallback) and poll.
  // -------------------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const strategies = ['tree', 'poll'];
  if (process.platform !== 'linux' || nodeMajor >= 20) strategies.unshift('native');
  for (const strategy of strategies) {
    await check(`passive scan sees a secret in a new nested folder (${strategy})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `kakashi-guard-${strategy}-`));
      fs.mkdirSync(path.join(root, 'existing', 'deeper'), { recursive: true });
      const saved = { w: process.env.KAKASHI_GUARD_WATCH, p: process.env.KAKASHI_GUARD_POLL_MS };
      process.env.KAKASHI_GUARD_WATCH = strategy;
      process.env.KAKASHI_GUARD_POLL_MS = '100';
      const events = [];
      const h = await guard.start({ watch: root, port: 0, tokenFile: tokenFile(`${strategy}.token`), onEvent: (e) => events.push(e) });
      try {
        const health = JSON.parse((await get(h.port, '/health')).body);
        assert.strictEqual(health.watchStrategy, strategy);
        assert.strictEqual(health.watchRecursive, true);

        // A file in a pre-existing subfolder, and one in a folder created now.
        await new Promise((r) => setTimeout(r, 150));
        fs.writeFileSync(path.join(root, 'existing', 'deeper', 'a.env'), `EMAIL=${TEST_EMAIL}\n`);
        fs.mkdirSync(path.join(root, 'config', 'prod'), { recursive: true });
        fs.writeFileSync(path.join(root, 'config', 'prod', '.env'), `ID=${TEST_NATIONAL_ID}\n`);

        const want = [path.join('existing', 'deeper', 'a.env'), path.join('config', 'prod', '.env')];
        const deadline = Date.now() + 4000;
        const seen = () => want.every((p) => events.some((e) => e.kind === 'passive_scan' && e.path === p && e.findings > 0));
        while (!seen() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        assert(seen(), `missing passive scans; saw ${JSON.stringify(events.filter((e) => e.kind === 'passive_scan').map((e) => e.path))}`);
      } finally {
        await h.stop();
        if (saved.w === undefined) delete process.env.KAKASHI_GUARD_WATCH; else process.env.KAKASHI_GUARD_WATCH = saved.w;
        if (saved.p === undefined) delete process.env.KAKASHI_GUARD_POLL_MS; else process.env.KAKASHI_GUARD_POLL_MS = saved.p;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  fs.rmSync(tokenDir, { recursive: true, force: true });
  console.log(`guard.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runGuardTests };

if (require.main === module) {
  runGuardTests().then((ok) => process.exit(ok ? 0 : 1));
}
