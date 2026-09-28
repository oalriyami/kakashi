const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// #45 -- the installers and the uninstall command do what the README says.
// Every run uses a scratch HOME; nothing touches the developer's agents.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'bin', 'install.js');
const CLI = path.join(ROOT, 'bin', 'kakashi.js');
const { SLASH_CMDS } = require('../bin/install');

function scratchHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-install-home-'));
}

function run(file, args, home, extra = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    cwd: extra.cwd || home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ...(extra.env || {}) },
  });
}

const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);

async function runInstallTests() {
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

  await check('#45 an unknown option is refused and nothing is written (exit 2)', () => {
    const home = scratchHome();
    for (const args of [['--dryrun'], ['--only'], ['--all', '--yes-please']]) {
      const r = run(INSTALL, args, home);
      assert.strictEqual(r.status, 2, `${args.join(' ')}: exit ${r.status}`);
    }
    assert.deepStrictEqual(fs.readdirSync(home), []);
  });

  await check('#45 --dry-run writes nothing', () => {
    const home = scratchHome();
    const r = run(INSTALL, ['--all', '--dry-run'], home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert(/Would install: Claude Code/.test(r.stdout), r.stdout);
    assert.deepStrictEqual(fs.readdirSync(home), []);
  });

  await check('#45 kakashi install / uninstall reach the installer', () => {
    const home = scratchHome();
    let r = run(CLI, ['install', '--only', 'claude'], home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(count(path.join(home, '.claude', 'commands')), SLASH_CMDS.length);
    r = run(CLI, ['uninstall', '--only', 'claude'], home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(count(path.join(home, '.claude', 'commands')), 0);
    assert(!fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')), 'a CLAUDE.md holding only Kakashi should go');
  });

  await check('#45 --uninstall --only cursor leaves the other agents alone', () => {
    const home = scratchHome();
    run(INSTALL, ['--only', 'claude,cursor,codex'], home);
    const r = run(INSTALL, ['--uninstall', '--only', 'cursor'], home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(count(path.join(home, '.cursor', 'commands')), 0);
    assert(!fs.existsSync(path.join(home, '.cursor', 'rules', 'kakashi.mdc')));
    assert.strictEqual(count(path.join(home, '.claude', 'commands')), SLASH_CMDS.length);
    assert.strictEqual(count(path.join(home, '.codex', 'commands')), SLASH_CMDS.length);
  });

  await check('#45 re-running refreshes the rule block without --force, and keeps the user\'s text', () => {
    const home = scratchHome();
    const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.writeFileSync(claudeMd, '# My rules\n\nBe brief.\n\n<!-- kakashi-begin -->\nAn old Kakashi rule\n<!-- kakashi-end -->\n');
    run(INSTALL, ['--only', 'claude'], home);
    run(INSTALL, ['--only', 'claude'], home);
    const text = fs.readFileSync(claudeMd, 'utf8');
    assert(!text.includes('An old Kakashi rule'), 'stale block kept');
    assert(text.startsWith('# My rules\n\nBe brief.'), text.slice(0, 80));
    assert.strictEqual(text.split('<!-- kakashi-begin -->').length, 2, 'one block, not two');
    run(INSTALL, ['--uninstall', '--only', 'claude'], home);
    assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), '# My rules\n\nBe brief.\n');
  });

  await check('#45 Continue gets the whole rule, and uninstall removes it (old truncated note too)', () => {
    const home = scratchHome();
    const configPath = path.join(home, '.continue', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const rule = fs.readFileSync(path.join(ROOT, 'src', 'rules', 'kakashi-activate.md'), 'utf8');
    const legacy = `[Kakashi] ${rule.slice(0, 500)}...`;
    fs.writeFileSync(configPath, JSON.stringify({ systemMessage: `Be nice.\n\n${legacy}` }));
    run(INSTALL, ['--only', 'continue'], home);
    const msg = JSON.parse(fs.readFileSync(configPath, 'utf8')).systemMessage;
    assert(msg.includes(rule.trim().slice(-200)), 'the end of the rule is missing');
    assert(!msg.includes('[Kakashi] '), 'the old truncated note was kept');
    run(INSTALL, ['--uninstall', '--only', 'continue'], home);
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).systemMessage, 'Be nice.');
  });

  await check('#45 --with-init files in the repository are removed with --with-init', () => {
    const home = scratchHome();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-install-repo-'));
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Team notes\n');
    run(INSTALL, ['--only', 'cursor,codex,cline,copilot', '--with-init'], home, { cwd: repo });
    assert(fs.existsSync(path.join(repo, '.cursor', 'rules', 'kakashi.mdc')));
    assert(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8').includes('kakashi-begin'));
    const r = run(INSTALL, ['--uninstall', '--with-init'], home, { cwd: repo });
    assert.strictEqual(r.status, 0, r.stderr);
    assert(!fs.existsSync(path.join(repo, '.cursor', 'rules', 'kakashi.mdc')));
    assert(!fs.existsSync(path.join(repo, '.clinerules', 'kakashi.md')));
    assert(!fs.existsSync(path.join(repo, '.github', 'copilot-instructions.md')));
    assert.strictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), '# Team notes\n');
  });

  await check('#45 package.json exposes kakashi-install', () => {
    const pkg = require('../package.json');
    assert.strictEqual(pkg.bin['kakashi-install'], 'bin/install.js');
    assert(fs.readFileSync(INSTALL, 'utf8').startsWith('#!/usr/bin/env node'), 'no shebang');
  });

  // install.sh, piped as the README runs it. Only the paths that install
  // nothing globally run here; CI runs the real install (the installers job).
  if (process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0) {
    const pipe = (args, home, env = {}) => spawnSync('bash', ['-s', '--', ...args], {
      input: fs.readFileSync(path.join(ROOT, 'install.sh')),
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, ...env },
    });

    await check('#45 install.sh piped: a mistyped option stops it (exit 2)', () => {
      const home = scratchHome();
      const r = pipe(['--dryrun'], home);
      assert.strictEqual(r.status, 2, r.stdout + r.stderr);
      assert(!/BASH_SOURCE/.test(r.stderr), r.stderr);
    });

    await check('#45 install.sh piped: --dry-run installs and writes nothing', () => {
      const home = scratchHome();
      const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-install-pack-'));
      const packed = spawnSync('npm', ['pack', ROOT, '--pack-destination', packDir, '--silent'], { encoding: 'utf8' });
      if (packed.status !== 0) return; // npm unavailable here
      const tgz = path.join(packDir, fs.readdirSync(packDir).find((f) => f.endsWith('.tgz')));
      const prefix = path.join(packDir, 'prefix');
      const r = pipe(['--dry-run', '--all'], home, { KAKASHI_PACKAGE: tgz, NPM_CONFIG_PREFIX: prefix });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert(/Would install: Claude Code/.test(r.stdout), r.stdout);
      assert(!fs.existsSync(path.join(home, '.claude')), 'dry-run wrote agent files');
      assert(!fs.existsSync(path.join(prefix, 'lib', 'node_modules', '@muhammadatef')), 'dry-run installed the package');
    });
  }

  console.log(`install.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runInstallTests };

if (require.main === module) {
  runInstallTests().then((ok) => process.exit(ok ? 0 : 1));
}
