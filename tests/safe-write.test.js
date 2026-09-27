const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');

const { writeFileSafe, createWriteStreamSafe } = require('../src/lib/safe-write');

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');

// ---------------------------------------------------------------------------
// #33 -- output files are never written through a planted symbolic link.
//
// Git stores symlinks, so a repository can ship `masked_config.env ->
// ~/.bashrc`. Every writer used to follow it: `mask-dir -r` then wrote the
// masked copy of config.env into the user's shell start-up file. Here the
// "home" is a scratch folder and the planted file is a synthetic secret.
// ---------------------------------------------------------------------------

const SECRET = `API_KEY=sk-proj-${'a1B2'.repeat(12)}\n`;
const VICTIM_TEXT = 'export PATH=/usr/bin\n';

function cli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
}

async function runSafeWriteTests() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  async function check(name, fn) {
    try {
      const r = await fn();
      if (r === 'skip') {
        console.log(`SKIP ${name} -- symbolic links are not available here`);
        skipped++;
        return;
      }
      passed++;
    } catch (err) {
      console.error(`FAIL ${name}: ${err.message}`);
      failed++;
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-safewrite-'));
  const victim = path.join(dir, 'victimhome', '.bashrc');
  fs.mkdirSync(path.dirname(victim));
  const resetVictim = () => fs.writeFileSync(victim, VICTIM_TEXT);
  const victimIntact = () => assert.strictEqual(fs.readFileSync(victim, 'utf8'), VICTIM_TEXT, 'the link target was written');
  const noTemps = (folder) => assert.deepStrictEqual(fs.readdirSync(folder).filter((n) => n.endsWith('.tmp')), [], 'temporary file left behind');

  /** Plant `name` in `folder` as a link to the victim. Returns false without symlink support. */
  function plant(folder, name) {
    fs.mkdirSync(folder, { recursive: true });
    const link = path.join(folder, name);
    fs.rmSync(link, { force: true });
    try {
      fs.symlinkSync(victim, link);
      return link;
    } catch {
      return false;
    }
  }

  // --- the writer itself ------------------------------------------------------

  await check('#33 writeFileSafe refuses a symbolic link and leaves its target alone', () => {
    resetVictim();
    const link = plant(dir, 'out.txt');
    if (!link) return 'skip';
    assert.throws(() => writeFileSafe(link, 'masked'), /symbolic link/);
    victimIntact();
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link itself was replaced');
    noTemps(dir);
  });

  await check('#33 writeFileSafe refuses a directory or other non-file destination', () => {
    const sub = path.join(dir, 'a-folder');
    fs.mkdirSync(sub, { recursive: true });
    assert.throws(() => writeFileSafe(sub, 'x'), /not a regular file/);
  });

  await check('#33 writeFileSafe replaces a regular file and keeps its permissions', () => {
    const f = path.join(dir, 'keep-mode.txt');
    fs.writeFileSync(f, 'old');
    if (process.platform !== 'win32') fs.chmodSync(f, 0o640);
    writeFileSafe(f, 'new');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o640);
    noTemps(dir);
  });

  await check('#33 a link planted between the check and the write is replaced, not followed', () => {
    resetVictim();
    const target = path.join(dir, 'race.txt');
    fs.rmSync(target, { force: true });
    // Plant the link at the last moment: after the check has passed and while
    // the temporary file is being written.
    const realWrite = fs.writeFileSync;
    let planted = false;
    fs.writeFileSync = (file, ...rest) => {
      realWrite(file, ...rest);
      if (!planted && String(file).endsWith('.tmp')) {
        try { fs.symlinkSync(victim, target); planted = true; } catch { /* no symlinks */ }
      }
    };
    try {
      writeFileSafe(target, 'masked');
    } finally {
      fs.writeFileSync = realWrite;
    }
    if (!planted) return 'skip';
    victimIntact();
    assert.ok(!fs.lstatSync(target).isSymbolicLink(), 'the output is still a link');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'masked');
  });

  await check('#33 a write stream publishes nothing until finished, and nothing if aborted', async () => {
    const f = path.join(dir, 'stream.jsonl');
    const ok = createWriteStreamSafe(f);
    ok.stream.write('{"a":1}\n');
    assert.ok(!fs.existsSync(f), 'visible before finish');
    await ok.finish();
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}\n');

    const g = path.join(dir, 'aborted.jsonl');
    const bad = createWriteStreamSafe(g);
    bad.stream.write('partial');
    bad.abort();
    assert.ok(!fs.existsSync(g));
    noTemps(dir);
  });

  // --- every command that writes ------------------------------------------------

  await check('#33 mask-dir -r skips a planted masked_ link and leaves its target alone', () => {
    resetVictim();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'sub', 'config.env'), SECRET);
    if (!plant(path.join(repo, 'sub'), 'masked_config.env')) return 'skip';
    const r = cli(['mask-dir', repo, '-r']);
    assert.ok(/symbolic link/.test(r.stdout + r.stderr), r.stdout);
    victimIntact();
  });

  const commands = [
    ['mask -o', (link) => {
      const src = path.join(dir, 'plain.env');
      fs.writeFileSync(src, SECRET);
      return ['mask', src, '-o', link];
    }],
    ['mask of a .docx -o', async (link) => {
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
      zip.file('word/document.xml', `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${SECRET.trim()}</w:t></w:r></w:p></w:body></w:document>`);
      const src = path.join(dir, 'doc.docx');
      fs.writeFileSync(src, await zip.generateAsync({ type: 'nodebuffer' }));
      return ['mask', src, '-o', link];
    }],
    ['db-mask -o', (link) => ['db-mask', 'mock:customers', '-q', 'SELECT *', '-o', link]],
    ['scan-dir -o', (link) => {
      const folder = path.join(dir, 'scanme');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'a.env'), SECRET);
      return ['scan-dir', folder, '-f', 'json', '-o', link];
    }],
    ['impact --write', (link) => ['impact', '--write', link]],
  ];
  for (const [label, build] of commands) {
    await check(`#33 ${label} refuses a link at the output path (exit 2)`, async () => {
      resetVictim();
      const link = plant(path.join(dir, 'links'), `out-${label.replace(/\W+/g, '-')}`);
      if (!link) return 'skip';
      const r = cli(await build(link));
      assert.strictEqual(r.status, 2, `exit ${r.status}: ${r.stdout}${r.stderr}`);
      assert.ok(/symbolic link/.test(r.stderr), r.stderr);
      victimIntact();
      noTemps(path.join(dir, 'links'));
    });
  }

  fs.rmSync(dir, { recursive: true, force: true });

  const tail = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`safe-write.test.js: ${passed} passed, ${failed} failed${tail}`);
  return failed === 0;
}

module.exports = { runSafeWriteTests };

if (require.main === module) {
  runSafeWriteTests().then((ok) => process.exit(ok ? 0 : 1));
}
