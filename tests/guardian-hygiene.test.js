const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { runGuardian } = require('../src/guardian');
const { renderRun } = require('../src/guardian/render');

// ---------------------------------------------------------------------------
// #48 -- what the Guardian keeps and leaves behind: the task text, the file
//        name, an earlier run's artifact, scratch copies after a signal, the
//        human report and --json errors. All values are synthetic.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kakashi.js');
const FIX = path.join(__dirname, 'fixtures');

const TASK_VALUES = ['bob.smith@corp.example', 'AKIAIOSFODNN7EXAMPLE'];
const TASK = `summarise the rows for ${TASK_VALUES[0]} using key ${TASK_VALUES[1]}`;

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

async function runGuardianHygieneTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-hygiene-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
  const copy = (name, as = name) => {
    const to = path.join(dir, as);
    fs.copyFileSync(path.join(FIX, name), to);
    return to;
  };

  const env = copy('guardian_service.env', 'service.env');
  const employees = copy('guardian_employees.md', 'employees.md');

  await check('#48 values written into --task are masked in --json and the audit log', () => {
    const log = path.join(dir, 'audit-task.jsonl');
    const r = cli(['guard', employees, '--agent', 'claude', '--task', TASK, '--json', '--audit-log', log]);
    assert.strictEqual(r.status, 0, r.stderr);
    const kept = r.stdout + fs.readFileSync(log, 'utf8');
    for (const v of TASK_VALUES) assert(!kept.includes(v), `${v} was stored`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.task.task, 'summarise the rows for [EMAIL_1] using key [AWS_KEY_1]');
    assert.strictEqual(out.event.task, out.task.task);
    // The intent is still read from what was written.
    assert.strictEqual(out.task.intent, 'narrative');
  });

  await check('#48 a value cut by the length limit is not kept as a fragment', async () => {
    // Four long tokens that mask down to a few characters each, then an
    // address across the point where masking stops reading: after masking it
    // lands well inside the 500 characters that are kept.
    const b64 = (s) => Buffer.from(JSON.stringify({ sub: s, pad: 'p'.repeat(270) })).toString('base64url');
    const jwts = [1, 2, 3, 4].map((i) => `eyJhbGciOiJIUzI1NiJ9.${b64(`u${i}`)}.${'s'.repeat(40)}${i}`);
    let long = `${jwts.join(' ')} `;
    long += 'x '.repeat(Math.floor((1990 - long.length) / 2));
    long += 'bob.smith@corp.example.com and the rest';
    const at = long.indexOf('bob.smith');
    assert(at < 2000 && at + 26 > 2000, `the address is not across the limit (${at})`);
    const r = await runGuardian({ resource: employees, task: long, auditLog: false, output: path.join(dir, 'guarded_long.md') });
    const kept = r.auditEvent.task;
    assert(!kept.includes('bob.smith') && !kept.includes('eyJ'), kept.slice(-80));
    assert(kept.startsWith('[JWT_1] [JWT_2] [JWT_3] [JWT_4] x x'), kept.slice(0, 60));
  });

  await check('#48 a file name holding an email is masked in the event', async () => {
    const named = copy('guardian_employees.md', 'payroll_bob.smith@corp.example.com.md');
    const r = await runGuardian({ resource: named, auditLog: false });
    assert(!JSON.stringify(r.auditEvent).includes('bob.smith'), r.auditEvent.resourceName);
    assert(!JSON.stringify(r.observation).includes('bob.smith'));
    assert(/\[EMAIL_1\]/.test(r.auditEvent.resourceName), r.auditEvent.resourceName);
  });

  await check('#48 an earlier guarded_ copy is removed when the next run does not release it', () => {
    const artifact = path.join(dir, 'guarded_service.env');
    let r = cli(['guard', env, '--agent', 'claude', '--task', 'debug the config', '--approve', 'CREDENTIAL', '--json', '--no-audit']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).decision, 'ALLOW_WITH_TRANSFORMATION');
    assert(fs.existsSync(artifact), 'no artifact from the approved run');

    r = cli(['guard', env, '--agent', 'claude', '--task', 'debug the config', '--json', '--no-audit']);
    assert.strictEqual(r.status, 3, r.stdout);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.decision, 'REQUIRE_APPROVAL');
    assert.strictEqual(out.staleArtifactRemoved, true);
    assert(!fs.existsSync(artifact), 'the approved run\'s artifact is still beside a REQUIRE_APPROVAL');
  });

  await check('#48 ALLOW of the original also removes the earlier guarded_ copy', () => {
    const artifact = path.join(dir, 'guarded_employees.md');
    fs.writeFileSync(artifact, 'an earlier run\n');
    const r = cli(['guard', employees, '--destination', 'local', '--json', '--no-audit']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).decision, 'ALLOW');
    assert(!fs.existsSync(artifact));
  });

  await check('#48 an --output under another name is left alone, and reported', () => {
    const other = path.join(dir, 'share-me.env');
    fs.writeFileSync(other, 'kept\n');
    const r = cli(['guard', env, '--agent', 'claude', '--task', 'debug the config', '-o', other, '--json', '--no-audit']);
    assert.strictEqual(r.status, 3, r.stdout);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.staleOutputKept, true);
    assert.strictEqual(out.staleArtifactRemoved, false);
    assert.strictEqual(fs.readFileSync(other, 'utf8'), 'kept\n');
    const human = stripAnsi(cli(['guard', env, '--agent', 'claude', '--task', 'debug the config', '-o', other, '--no-audit']).stdout);
    assert(/still at the output path/.test(human), human);
  });

  await check('#48 the human report prints counts, not [object Object]', async () => {
    const staff = path.join(dir, 'staff.csv');
    fs.writeFileSync(staff, 'name,email,dept,salary\nAhmed Hassan,a.hassan@example.com,IT,5000\n');
    const r = await runGuardian({ resource: staff, agent: 'claude', task: 'calculate average salary by department', auditLog: false });
    assert.strictEqual(r.decision, 'ALLOW_WITH_TRANSFORMATION');
    const text = stripAnsi(renderRun(r, r.state.context));
    assert(!text.includes('[object Object]'), 'render printed [object Object]');
    assert(/Wrote scratch artifact with \d+ replacement\(s\)\.\s+\((\w+ x\d+(, )?)+\)/.test(text), text);
  });

  await check('#48 guard --json errors are JSON (exit 2)', () => {
    let r = cli(['guard', path.join(dir, 'missing.csv'), '--json']);
    assert.strictEqual(r.status, 2);
    let out = JSON.parse(r.stdout);
    assert.strictEqual(out.decision, null);
    assert.strictEqual(out.error.code, 'GUARDIAN_FAILED');
    assert.strictEqual(out.releasePath, null);
    r = cli(['guard', employees, '--max-iterations', '0', '--json']);
    assert.strictEqual(r.status, 2);
    out = JSON.parse(r.stdout);
    assert.strictEqual(out.error.code, 'INVALID_ARGUMENT');
  });

  await check('#48 a guard run that masks is counted in kakashi stats', () => {
    const statsFile = path.join(home, '.kakashi', 'stats.json');
    const before = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')).filesMasked : 0;
    const r = cli(['guard', employees, '--agent', 'claude', '--task', 'calculate average salary by department', '-o', path.join(dir, 'guarded_stats.md'), '--no-audit']);
    assert.strictEqual(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assert.strictEqual(after.filesMasked, before + 1);
    assert(after.byCategory.pii > 0, JSON.stringify(after.byCategory));
  });

  await check('#48 a finished run leaves no signal handlers behind', async () => {
    const count = () => ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((e) => process.listenerCount(e));
    const before = count();
    await runGuardian({ resource: employees, auditLog: false, output: path.join(dir, 'guarded_listeners.md') });
    assert.deepStrictEqual(count(), before);
  });

  if (process.platform !== 'win32') {
    await check('#48 SIGINT during a run removes the scratch copy', async () => {
      const tmp = path.join(dir, 'tmp');
      fs.mkdirSync(tmp);
      // Large enough that the run is still going when the signal lands.
      const big = path.join(dir, 'big.csv');
      const rows = ['name,email,phone'];
      for (let i = 0; i < 60000; i++) rows.push(`Ahmed Hassan,user${i}@example.com,+971 50 ${String(1000000 + i).slice(0, 3)} ${String(1000 + (i % 9000))}`);
      fs.writeFileSync(big, rows.join('\n'));
      const child = spawn(process.execPath, [CLI, 'guard', big, '--agent', 'claude', '--task', 'calculate totals', '--no-audit'], {
        env: { ...process.env, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
        stdio: 'ignore',
      });
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 20000;
      while (!fs.readdirSync(tmp).some((f) => f.startsWith('kakashi-guardian-')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert(fs.readdirSync(tmp).some((f) => f.startsWith('kakashi-guardian-')), 'the run never started');
      child.kill('SIGINT');
      const { signal } = await exited;
      assert.strictEqual(signal, 'SIGINT', 'the process did not end on the signal');
      const left = fs.readdirSync(tmp).filter((f) => f.startsWith('kakashi-guardian-'));
      assert.deepStrictEqual(left, [], 'scratch directory left behind');
    });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`guardian-hygiene.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runGuardianHygieneTests };

if (require.main === module) {
  runGuardianHygieneTests().then((ok) => process.exit(ok ? 0 : 1));
}
