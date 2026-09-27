const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');

// ---------------------------------------------------------------------------
// #35 -- originals are never overwritten unless asked, and asking is explicit.
// #36 -- a folder scan never reports "clean" for what it could not read.
// All values are synthetic.
// ---------------------------------------------------------------------------

const KEY = `sk-proj-${'a1B2'.repeat(12)}`;
const SECRET = `API_KEY=${KEY}\n`;

/** Run the CLI with stdin that is NOT a terminal, as an agent does. */
function cli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', ...opts });
}

async function runCoverageTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-coverage-'));
  const file = (name, content) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };

  // =========================================================================
  // #35
  // =========================================================================

  await check('#35 mask -o <the input> is refused and the original is untouched', () => {
    const src = file('self.env', SECRET);
    for (const out of [src, path.join(dir, '.', 'x', '..', 'self.env')]) {
      const r = cli(['mask', src, '-o', out]);
      assert.strictEqual(r.status, 2, `exit ${r.status} for ${out}`);
      assert.ok(/the output is the input file/.test(r.stderr), r.stderr);
    }
    assert.strictEqual(fs.readFileSync(src, 'utf8'), SECRET);
  });

  await check('#35 a hard link to the input counts as the input', () => {
    const src = file('hard.env', SECRET);
    const link = path.join(dir, 'hard-link.env');
    try { fs.linkSync(src, link); } catch { return; } // no hard links here
    assert.strictEqual(cli(['mask', src, '-o', link]).status, 2);
    assert.strictEqual(fs.readFileSync(src, 'utf8'), SECRET);
  });

  await check('#35 --overwrite without a terminal needs --yes (exit 2, nothing written)', () => {
    const src = file('ow.env', SECRET);
    const r = cli(['mask', src, '--overwrite']);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.ok(/--yes/.test(r.stderr), r.stderr);
    assert.strictEqual(fs.readFileSync(src, 'utf8'), SECRET);
  });

  await check('#35 --overwrite --yes replaces the original', () => {
    const src = file('ow-yes.env', SECRET);
    const r = cli(['mask', src, '--overwrite', '--yes']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.readFileSync(src, 'utf8').includes(KEY));
  });

  await check('#35 --overwrite with a different -o is an ordinary mask', () => {
    const src = file('ow-other.env', SECRET);
    const out = path.join(dir, 'ow-other.out.env');
    assert.strictEqual(cli(['mask', src, '--overwrite', '-o', out]).status, 0);
    assert.strictEqual(fs.readFileSync(src, 'utf8'), SECRET);
    assert.ok(!fs.readFileSync(out, 'utf8').includes(KEY));
  });

  await check('#35 db-mask -o <the SQLite file it reads> is refused', () => {
    let Database;
    let db;
    const dbPath = path.join(dir, 'people.db');
    try {
      Database = require('better-sqlite3');
      db = new Database(dbPath); // the native module loads here, not at require
    } catch {
      return; // driver not usable on this Node version
    }
    db.exec("CREATE TABLE t (email TEXT); INSERT INTO t VALUES ('a.b@example.org')");
    db.close();
    for (const out of [dbPath, path.join(dir, '.', 'people.db')]) {
      const r = cli(['db-mask', dbPath, '-q', 'SELECT * FROM t', '-o', out]);
      assert.strictEqual(r.status, 2, `exit ${r.status}: ${r.stderr}`);
    }
    const check2 = new Database(dbPath, { readonly: true });
    assert.strictEqual(check2.prepare('SELECT count(*) AS n FROM t').get().n, 1);
    check2.close();
  });

  await check('#35 scan-dir -o <a scanned file> is refused', () => {
    const folder = path.join(dir, 'report-over');
    const target = file('report-over/.env', SECRET);
    const r = cli(['scan-dir', folder, '-f', 'md', '-o', target]);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), SECRET);
  });

  // =========================================================================
  // #36
  // =========================================================================

  const estate = path.join(dir, 'estate');
  file('estate/.ssh/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----\n');
  file('estate/.npmrc', '//registry.npmjs.org/:_authToken=npm_abcdefghijABCDEFGHIJ0123456789abcdef\n');
  file('estate/infra/terraform.tfstate', `{"outputs":{"api_key":{"value":"${KEY}"}}}`);
  file('estate/infra/terraform.tfstate.backup', `{"outputs":{"api_key":{"value":"${KEY}"}}}`);
  file('estate/tls/server.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq1vKmCnRZ6YJbWkKq3ERVtVQwIIGZ9yDbXwv0T0vD0xg\n-----END RSA PRIVATE KEY-----\n');
  file('estate/.aws/credentials', `[default]\naws_access_key_id = AKIAQ3EGUXYZ7ABCD123\n`);
  file('estate/dump.sql', Buffer.from('SQLite format 3\0\0binary pages'));
  file('estate/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));

  const scanJson = () => JSON.parse(cli(['scan-dir', estate, '-f', 'json']).stdout);

  await check('#36 key and credential files are scanned, not skipped', () => {
    const report = scanJson();
    const byPath = Object.fromEntries(report.files.map((f) => [f.path.split(path.sep).join('/'), f]));
    for (const p of ['.ssh/id_rsa', '.npmrc', 'infra/terraform.tfstate', 'infra/terraform.tfstate.backup', 'tls/server.pem', '.aws/credentials']) {
      assert.ok(byPath[p], `${p} was not scanned`);
      assert.ok(byPath[p].findings.length > 0, `${p} scanned but nothing found`);
    }
  });

  await check('#36 a file that cannot be read is listed, and scan-dir exits 2', () => {
    const r = cli(['scan-dir', estate, '-f', 'json']);
    assert.strictEqual(r.status, 2, 'an incomplete scan exited as if complete');
    const report = JSON.parse(r.stdout);
    assert.strictEqual(report.failedFiles, 1);
    const bad = report.files.find((f) => f.path === 'dump.sql');
    assert.ok(bad && /binary/.test(bad.errors[0]), JSON.stringify(bad));
    assert.ok(/Could not be read: 1 file/.test(r.stderr), r.stderr);
  });

  await check('#36 the Markdown and HTML reports list what was not read', () => {
    const md = cli(['scan-dir', estate, '-f', 'md']).stdout;
    assert.ok(/\*\*Could not be read:\*\* 1 file/.test(md), 'md summary');
    assert.ok(/## Files that could not be read[\s\S]*`dump\.sql`/.test(md), 'md list');
    assert.ok(/\*\*Other files:\*\* 1 file\(s\) in formats Kakashi does not read \(\.png ×1\)/.test(md), 'md other files');
    const html = cli(['scan-dir', estate, '-f', 'html']).stdout;
    assert.ok(/Files that could not be read \(1\)/.test(html) && html.includes('dump.sql'), 'html list');
    const ar = cli(['--lang', 'ar', 'scan-dir', estate, '-f', 'html']).stdout;
    assert.ok(ar.includes('ملفات تعذرت قراءتها'), 'Arabic html');
  });

  await check('#36 content read only in part is reported per file', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>');
    zip.file('word/embeddings/oleObject1.bin', 'opaque');
    const folder = path.join(dir, 'partial');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'memo.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
    const r = cli(['scan-dir', folder, '-f', 'md']);
    assert.strictEqual(r.status, 0, 'a partly checked file is not a failure');
    assert.ok(/\*\*Partly checked:\*\* 1 file/.test(r.stdout), r.stdout);
    assert.ok(/`memo\.docx` — not checked: word\/embeddings\/oleObject1\.bin/.test(r.stdout), r.stdout);
  });

  await check('#36 --parallel must be a positive whole number', () => {
    for (const bad of ['-1', '0', 'abc', '1.5']) {
      const r = cli(['scan-dir', estate, `--parallel=${bad}`]);
      assert.strictEqual(r.status, 2, `--parallel ${bad} -> ${r.status}`);
    }
  });

  await check('#36 mask-dir exits 2 when a file failed, 0 when all succeeded', () => {
    const r = cli(['mask-dir', estate, '-r']);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.ok(/\[fail\] dump\.sql/.test(r.stdout) && /1 file\(s\) failed and were NOT masked/.test(r.stdout), r.stdout);
    const clean = path.join(dir, 'all-good');
    file('all-good/a.env', SECRET);
    assert.strictEqual(cli(['mask-dir', clean]).status, 0);
  });

  await check('#36 a binary file is refused by scan, not scanned as noise', () => {
    const bin = file('renamed.txt', Buffer.from('MZ\0\0\0binary executable'));
    const r = cli(['scan', bin]);
    assert.strictEqual(r.status, 2);
    assert.ok(/binary/.test(r.stderr), r.stderr);
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`coverage.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runCoverageTests };

if (require.main === module) {
  runCoverageTests().then((ok) => process.exit(ok ? 0 : 1));
}
