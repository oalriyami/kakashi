const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const formats = require('../src/engine/formats');
const { maskText } = require('../src/engine/masker');
const { detectEncoding, decodeText, encodeText } = require('../src/engine/formats/text');

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');

// ---------------------------------------------------------------------------
// #30 -- UTF-16 text files.
//
// Every text file used to be read as UTF-8. A UTF-16 file (Excel's "Unicode
// Text" export, Windows PowerShell 5's `>` and Out-File) then read as a string
// with a NUL between every character: no pattern matched, `scan` reported 0
// findings, and `mask` wrote a mangled copy that still held every value.
// All values below are synthetic.
// ---------------------------------------------------------------------------

const SAMPLE = 'Name: Rajesh Kumar\r\nEmail: r.kumar@example.org\r\nالاسم: فاطمة الكعبي\r\nKey AKIAQ3EGUXYZ7ABCD123\r\n';
const VALUES = ['r.kumar@example.org', 'AKIAQ3EGUXYZ7ABCD123'];

const le = (t) => Buffer.from(t, 'utf16le');
const be = (t) => {
  const b = Buffer.from(t, 'utf16le');
  b.swap16();
  return b;
};
const VARIANTS = {
  'utf-16le with BOM': { bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), le(SAMPLE)]), encoding: 'utf-16le', bom: true },
  'utf-16le without BOM': { bytes: le(SAMPLE), encoding: 'utf-16le', bom: false },
  'utf-16be with BOM': { bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), be(SAMPLE)]), encoding: 'utf-16be', bom: true },
};

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

async function runTextEncodingTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-enc-'));

  for (const [label, v] of Object.entries(VARIANTS)) {
    await check(`#30 ${label}: detected and decoded`, () => {
      assert.deepStrictEqual(detectEncoding(v.bytes), { encoding: v.encoding, bom: v.bom });
      assert.strictEqual(decodeText(v.bytes).text, SAMPLE);
    });

    await check(`#30 ${label}: scan finds the values`, async () => {
      const f = path.join(dir, `${v.encoding}-${v.bom}.txt`);
      fs.writeFileSync(f, v.bytes);
      const { text } = await formats.readFile(f);
      const found = maskText(text).findings.map((x) => x.original);
      for (const value of VALUES) assert.ok(found.includes(value), `${value} not detected`);
    });

    await check(`#30 ${label}: masked copy is written in the same encoding and holds no value`, () => {
      const f = path.join(dir, `m-${v.encoding}-${v.bom}.txt`);
      const out = path.join(dir, `out-${v.encoding}-${v.bom}.txt`);
      fs.writeFileSync(f, v.bytes);
      const r = cli(['mask', f, '-o', out]);
      assert.strictEqual(r.status, 0, r.stderr);
      const bytes = fs.readFileSync(out);
      assert.deepStrictEqual(detectEncoding(bytes), { encoding: v.encoding, bom: v.bom }, 'encoding or BOM changed');
      const text = decodeText(bytes).text;
      for (const value of VALUES) assert.ok(!text.includes(value), `${value} survived`);
      assert.ok(text.includes('\r\n') && text.includes('الاسم'), 'line endings or Arabic text lost');
      // And not merely hidden by the decoding: the raw bytes do not hold them either.
      for (const value of VALUES) {
        assert.ok(!bytes.includes(Buffer.from(value, 'utf16le')) && !bytes.includes(be(value)), `${value} bytes survived`);
      }
    });
  }

  await check('#30 UTF-8 with a BOM keeps its BOM and stays UTF-8', () => {
    const f = path.join(dir, 'u8bom.txt');
    const out = path.join(dir, 'u8bom-out.txt');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE)]));
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    const bytes = fs.readFileSync(out);
    assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(!bytes.toString('utf8').includes('r.kumar@example.org'));
  });

  await check('#30 plain UTF-8 and ASCII files are unchanged in handling', () => {
    assert.deepStrictEqual(detectEncoding(Buffer.from('a=1\nb=2\n')), { encoding: 'utf-8', bom: false });
    assert.deepStrictEqual(detectEncoding(Buffer.from('')), { encoding: 'utf-8', bom: false });
    assert.deepStrictEqual(encodeText('x'), Buffer.from('x'));
  });

  await check('#30 a truncated UTF-16 file is refused with exit 2', () => {
    const f = path.join(dir, 'odd.txt');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), le('Email r.kumar@example.org'), Buffer.from([0x41])]));
    const r = cli(['scan', f]);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.ok(/odd number of bytes/.test(r.stderr), r.stderr);
  });

  await check('#30 UTF-32 is refused with exit 2 rather than read as UTF-16', () => {
    const f = path.join(dir, 'u32.txt');
    fs.writeFileSync(f, Buffer.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]));
    const r = cli(['mask', f]);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.ok(/UTF-32/.test(r.stderr), r.stderr);
  });

  await check('#30 a broken surrogate pair is refused, not silently replaced', () => {
    const bad = Buffer.concat([Buffer.from([0xff, 0xfe]), le('ok '), Buffer.from([0x00, 0xd8]), le(' end')]);
    assert.throws(() => decodeText(bad), /not valid UTF-16LE/);
  });

  // --- #29: every text output is read back before it is kept ----------------

  await check('#29 a text output that does not read back as written is removed', async () => {
    // A lone surrogate cannot be encoded as UTF-8: it is written as U+FFFD, so
    // the file on disk differs from the masked text. Nothing can produce one
    // from a decoded file today; this pins the safety net itself.
    const src = path.join(dir, 'rt.txt');
    const out = path.join(dir, 'rt-out.txt');
    fs.writeFileSync(src, 'x');
    await assert.rejects(
      formats.writeMasked(src, out, { format: 'text', encoding: 'utf-8' }, {}, 'bad \ud800 text'),
      /did not read back as written/,
    );
    assert.ok(!fs.existsSync(out), 'the bad output was kept');
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`text-encoding.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runTextEncodingTests };

if (require.main === module) {
  runTextEncodingTests().then((ok) => process.exit(ok ? 0 : 1));
}
