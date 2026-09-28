const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const text = require('../src/engine/formats/text');

// ---------------------------------------------------------------------------
// #54 -- text in a legacy single-byte encoding is read and written back in
//        it; binaries are refused, not "masked"; a file too large to hold in
//        memory is refused with exit 2 instead of killing the process.
// All values are synthetic.
// ---------------------------------------------------------------------------

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');

/** Encode with a single-byte encoding's own table (TextEncoder only does UTF-8). */
function encodeWith(encoding, s) {
  const dec = new TextDecoder(encoding);
  const back = new Map();
  for (let i = 0; i < 256; i++) back.set(dec.decode(Uint8Array.of(i)), i);
  return Buffer.from([...s].map((ch) => {
    const b = back.get(ch);
    if (b === undefined) throw new Error(`${encoding} cannot hold ${ch}`);
    return b;
  }));
}

async function runTextLegacyTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-text-legacy-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const cli = (args, env = {}, input) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', input, env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });

  const arabic = 'الاسم,البريد,المدينة\nمحمد عبدالله,m.abdullah@example.com,دبي\nفاطمة الزهراء,f.zahra@example.com,أبوظبي\n';
  const latin = 'Full Name,Email,City\nJosé García,j.garcia@example.com,Málaga\nFrançois Müller,f.muller@example.com,Zürich\n';

  await check('#54 a Windows-1256 Arabic CSV is read, masked and written back in Windows-1256', () => {
    const src = path.join(dir, 'arabic.csv');
    fs.writeFileSync(src, encodeWith('windows-1256', arabic));
    assert.strictEqual(text.detectEncoding(fs.readFileSync(src)).encoding, 'windows-1256');
    const scan = cli(['scan', src]);
    assert.strictEqual(scan.status, 1, scan.stderr);
    const out = path.join(dir, 'masked_arabic.csv');
    const r = cli(['mask', src, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    const back = new TextDecoder('windows-1256').decode(fs.readFileSync(out));
    assert(!back.includes('�'), 'replacement characters in the output');
    assert(!back.includes('محمد عبدالله') && !back.includes('m.abdullah@example.com'), back);
    // Everything that was not masked is byte-for-byte what it was.
    assert(back.startsWith('الاسم,البريد,المدينة\n') && back.includes(',دبي\n') && back.includes(',أبوظبي\n'), back);
  });

  await check('#54 a Latin-1 CSV keeps its accents, and its bytes', () => {
    const src = path.join(dir, 'latin.csv');
    fs.writeFileSync(src, encodeWith('windows-1252', latin));
    assert.strictEqual(text.detectEncoding(fs.readFileSync(src)).encoding, 'windows-1252');
    const out = path.join(dir, 'masked_latin.csv');
    const r = cli(['mask', src, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    const bytes = fs.readFileSync(out);
    assert(bytes.includes(encodeWith('windows-1252', ',Málaga\n')) && bytes.includes(encodeWith('windows-1252', ',Zürich\n')));
    const back = new TextDecoder('windows-1252').decode(bytes);
    assert(!back.includes('José García') && !back.includes('j.garcia@example.com'), back);
  });

  await check('#54 KAKASHI_TEXT_ENCODING chooses the encoding', () => {
    const buf = encodeWith('windows-1252', 'Café crème');
    const saved = process.env.KAKASHI_TEXT_ENCODING;
    process.env.KAKASHI_TEXT_ENCODING = 'iso-8859-1';
    try {
      assert.strictEqual(text.detectEncoding(buf).encoding, 'iso-8859-1');
    } finally {
      if (saved === undefined) delete process.env.KAKASHI_TEXT_ENCODING; else process.env.KAKASHI_TEXT_ENCODING = saved;
    }
  });

  await check('#54 a replacement the encoding cannot hold is refused, not written as ?', () => {
    assert.throws(() => text.encodeText('نص', { encoding: 'windows-1252' }), /cannot hold/);
    const buf = text.encodeText('[EMAIL_1] é', { encoding: 'windows-1252' });
    assert.deepStrictEqual(buf, encodeWith('windows-1252', '[EMAIL_1] é'));
  });

  await check('#54 UTF-8 files are unchanged: strict decode, BOM kept', () => {
    const src = path.join(dir, 'utf8.txt');
    fs.writeFileSync(src, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('مرحبا a.hassan@example.com\n')]));
    const out = path.join(dir, 'masked_utf8.txt');
    assert.strictEqual(cli(['mask', src, '-o', out]).status, 0);
    const bytes = fs.readFileSync(out);
    assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.strictEqual(bytes.toString('utf8').slice(1), 'مرحبا [EMAIL_1]\n');
  });

  await check('#54 a binary file is refused (exit 2), never "masked" into a bigger copy', () => {
    const bin = path.join(dir, 'blob.txt');
    // Random bytes without NULs, which the old check relied on.
    fs.writeFileSync(bin, Buffer.from([...crypto.randomBytes(6000)].map((b) => b || 1)));
    for (const cmd of ['scan', 'mask']) {
      const r = cli([cmd, bin]);
      assert.strictEqual(r.status, 2, `${cmd}: exit ${r.status}`);
      assert(/binary/.test(r.stderr), r.stderr);
    }
    assert(!fs.existsSync(path.join(dir, 'masked_blob.txt')), 'a masked copy was written');
  });

  await check('#54 a file over the size limit is refused with exit 2, before it is read', () => {
    const big = path.join(dir, 'big.log');
    fs.writeFileSync(big, 'contact a.hassan@example.com\n'.repeat(80000)); // 2.3 MB
    const env = { KAKASHI_MAX_FILE_MB: '1' };
    for (const args of [['scan', big], ['mask', big], ['guard', big, '--json', '--no-audit']]) {
      const r = cli(args, env);
      assert.strictEqual(r.status, 2, `${args[0]}: exit ${r.status}`);
      assert(/larger than the 1\.0 MB Kakashi reads at once/.test(r.stderr + r.stdout), `${args[0]}: ${r.stderr}${r.stdout}`);
    }
    let r = cli(['mask', '--stdin'], env, fs.readFileSync(big));
    assert.strictEqual(r.status, 2, 'stdin');
    // scan-dir lists it as unread, so the folder is not reported clean.
    const folder = path.join(dir, 'folder');
    fs.mkdirSync(folder);
    fs.copyFileSync(big, path.join(folder, 'big.log'));
    r = cli(['scan-dir', folder, '-f', 'json'], env);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.strictEqual(cli(['scan', big]).status, 1, 'the default limit refused a 2.3 MB file');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`text-legacy.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runTextLegacyTests };

if (require.main === module) {
  runTextLegacyTests().then((ok) => process.exit(ok ? 0 : 1));
}
