const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanDirectory } = require('../src/lib/scan-dir');

// ---------------------------------------------------------------------------
// #51 -- scan-dir and mask-dir look at the same files: .gitignore and
//        .kakashiignore with git's semantics, .git and node_modules never,
//        and --exclude added to the defaults. All values are synthetic.
// ---------------------------------------------------------------------------

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');
const SECRET = `API_KEY=sk-proj-${'a1B2'.repeat(10)}\n`;

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-discover-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

function listMasked(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith('masked_')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

async function runDiscoverTests() {
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

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-discover-home-'));
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  const layout = {
    '.kakashiignore': 'b/\n*.log\n!keep.log\n/top-only.env\n',
    'b/app.env': SECRET,
    'nested/b/deep.env': SECRET,
    'logs/x.log': SECRET,
    'keep.log': SECRET,
    'top-only.env': SECRET,
    'sub/top-only.env': SECRET,
    'sub/.gitignore': 'private.env\n',
    'sub/private.env': SECRET,
    'sub/public.env': SECRET,
    '.git/hooks/pre-push.sh': `#!/bin/sh\n${SECRET}`,
    'node_modules/pkg/config.env': SECRET,
    'app.env': SECRET,
  };
  const expected = ['app.env', 'keep.log', 'sub/.gitignore', 'sub/public.env', 'sub/top-only.env'];

  await check('#51 scan-dir reads .kakashiignore with git semantics, nested ignore files too', async () => {
    const root = tree(layout);
    const report = await scanDirectory(root);
    const paths = report.files.map((f) => f.path.split(path.sep).join('/')).sort();
    assert.deepStrictEqual(paths, expected);
    // b/app.env, nested/b/deep.env, logs/x.log, top-only.env, sub/private.env
    assert.strictEqual(report.skippedByIgnoreFile, 5);
  });

  await check('#51 mask-dir skips .git and node_modules and honours the ignore files', () => {
    const root = tree(layout);
    const r = cli(['mask-dir', root, '-r']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(listMasked(root), ['masked_app.env', 'masked_keep.log', 'sub/masked_public.env', 'sub/masked_top-only.env']);
    assert(!fs.existsSync(path.join(root, '.git', 'hooks', 'masked_pre-push.sh')), 'mask-dir wrote into .git');
  });

  await check('#51 mask-dir --no-gitignore masks what the ignore files hid, never .git', () => {
    const root = tree(layout);
    const r = cli(['mask-dir', root, '-r', '--no-gitignore']);
    assert.strictEqual(r.status, 0, r.stderr);
    const masked = listMasked(root);
    assert(masked.includes('b/masked_app.env') && masked.includes('logs/masked_x.log'), masked.join(' '));
    assert(!masked.some((m) => m.startsWith('.git/') || m.startsWith('node_modules/')), masked.join(' '));
  });

  await check('#51 --exclude adds to the defaults instead of replacing them', async () => {
    const root = tree(layout);
    fs.writeFileSync(path.join(root, 'masked_old.env'), SECRET);
    const r = cli(['mask-dir', root, '-r', '--exclude', 'keep.log,sub/']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(listMasked(root), ['masked_app.env', 'masked_old.env']);
    assert(!fs.existsSync(path.join(root, 'node_modules', 'pkg', 'masked_config.env')), '--exclude brought node_modules back');
    assert(!fs.existsSync(path.join(root, 'masked_masked_old.env')), '--exclude brought masked_ copies back');
    const report = await scanDirectory(root, { extraIgnore: ['*.env'] });
    const paths = report.files.map((f) => f.path.split(path.sep).join('/')).sort();
    assert.deepStrictEqual(paths, ['keep.log', 'sub/.gitignore']);
  });

  await check('#51 a re-included file inside an excluded folder stays excluded, as in git', async () => {
    const root = tree({ '.gitignore': 'secret/\n!secret/ok.env\n', 'secret/ok.env': SECRET, 'x.env': SECRET });
    const report = await scanDirectory(root);
    assert.deepStrictEqual(report.files.map((f) => f.path), ['.gitignore', 'x.env']);
  });

  console.log(`discover.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runDiscoverTests };

if (require.main === module) {
  runDiscoverTests().then((ok) => process.exit(ok ? 0 : 1));
}
