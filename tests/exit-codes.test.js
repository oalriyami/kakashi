const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// #49 -- one exit-code contract: usage errors exit 2, never 1 (the "findings"
//        code); a missing output folder is refused before any work; --help
//        documents the codes. All values are synthetic.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kakashi.js');

async function runExitCodeTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-exit-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const file = path.join(dir, 'contact.txt');
  fs.writeFileSync(file, 'email a.hassan@example.com\n');
  const folder = path.join(dir, 'folder');
  fs.mkdirSync(folder);
  fs.copyFileSync(file, path.join(folder, 'contact.txt'));
  const missing = path.join(dir, 'no-such-folder', 'out');

  const cli = (args, extra = {}) => spawnSync(process.execPath, [...(extra.node || []), CLI, ...args], {
    encoding: 'utf8',
    cwd: dir,
    input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const noStack = (r) => assert(!/\n\s+at .+:\d+:\d+/.test(r.stderr), `stack trace printed:\n${r.stderr}`);

  await check('#49 usage errors exit 2, not the findings code 1', () => {
    for (const args of [
      ['--bogus'],
      ['frobnicate'],
      ['scan', '--bogus', file],
      ['db-scan', 'mock:customers'], // -q missing
      ['guard'], // file missing
      ['guard', file, '--bogus'],
      ['mask', file, '-m', 'bogus'],
      ['scan-dir', folder, '-f', 'bogus'],
      ['db-mask', 'mock:customers', '-q', 'x', '-f', 'bogus'],
      [],
    ]) {
      const r = cli(args);
      assert.strictEqual(r.status, 2, `${JSON.stringify(args)}: exit ${r.status}\n${r.stderr}`);
      noStack(r);
    }
  });

  await check('#49 an invalid --mode is refused and nothing is written', () => {
    const out = path.join(dir, 'masked_mode.txt');
    const r = cli(['mask', file, '-m', 'bogus', '-o', out]);
    assert.strictEqual(r.status, 2);
    assert(/Allowed choices are typed, redact, fake/.test(r.stderr), r.stderr);
    assert(!fs.existsSync(out), 'masked with an invalid mode');
  });

  await check('#49 guard --json usage errors are JSON on stdout (exit 2)', () => {
    const r = cli(['guard', file, '--json', '--bogus']);
    assert.strictEqual(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.decision, null);
    assert.strictEqual(out.error.code, 'INVALID_ARGUMENT');
  });

  await check('#49 a missing output folder is refused before any work (exit 2, no stack)', () => {
    for (const args of [
      ['mask', file, '-o', `${missing}.txt`],
      ['scan-dir', folder, '-f', 'md', '-o', `${missing}.md`],
      ['db-mask', 'mock:customers', '-q', 'SELECT * FROM customers', '-o', `${missing}.jsonl`],
      ['impact', '--write', `${missing}.json`],
    ]) {
      const r = cli(args);
      assert.strictEqual(r.status, 2, `${args[0]}: exit ${r.status}`);
      assert(/the output folder does not exist/.test(r.stderr), `${args[0]}: ${r.stderr}`);
      assert(!/\.tmp/.test(r.stderr), `${args[0]} named a temporary file: ${r.stderr}`);
      noStack(r);
    }
    // db-mask refused before the query ran, scan-dir before the scan.
    const db = cli(['db-mask', 'mock:customers', '-q', 'SELECT * FROM customers', '-o', `${missing}.jsonl`]);
    assert(!/row\(s\)/.test(db.stdout + db.stderr), 'the query ran first');
    const sd = cli(['scan-dir', folder, '-o', `${missing}.md`]);
    assert(!/Scanned/.test(sd.stderr), 'the folder was scanned first');
  });

  await check('#49 an unexpected error exits 2 with its message masked, no stack', () => {
    const preload = path.join(dir, 'break-stats.js');
    fs.writeFileSync(preload, `
      const stats = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'stats.js'))});
      stats.loadStats = () => { throw new Error('stats file for bob.smith@corp.example.com is damaged'); };
    `);
    const r = cli(['stats'], { node: ['--require', preload] });
    assert.strictEqual(r.status, 2, r.stderr);
    assert(/damaged/.test(r.stderr), r.stderr);
    assert(!r.stderr.includes('bob.smith@corp.example.com'), r.stderr);
    noStack(r);
  });

  await check('#49 --help documents the exit codes; help and --version exit 0', () => {
    let r = cli(['--help']);
    assert.strictEqual(r.status, 0);
    assert(/Exit codes:/.test(r.stdout) && /3 {2}guard: a human must approve/.test(r.stdout), r.stdout);
    r = cli(['guard', '--help']);
    assert.strictEqual(r.status, 0);
    assert(/3 REQUIRE_APPROVAL/.test(r.stdout) && /4 BLOCK/.test(r.stdout), r.stdout);
    r = cli(['scan', '--help']);
    assert(/1 sensitive data found/.test(r.stdout), r.stdout);
    r = cli(['help', 'mask']);
    assert.strictEqual(r.status, 0);
    assert(/Exit codes: 0 done/.test(r.stdout), r.stdout);
    r = cli(['--version']);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), require('../package.json').version);
  });

  await check('#49 results keep their codes: findings 1, clean 0', () => {
    assert.strictEqual(cli(['scan', file]).status, 1);
    const clean = path.join(dir, 'clean.txt');
    fs.writeFileSync(clean, 'nothing to see\n');
    assert.strictEqual(cli(['scan', clean]).status, 0);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`exit-codes.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runExitCodeTests };

if (require.main === module) {
  runExitCodeTests().then((ok) => process.exit(ok ? 0 : 1));
}
