const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');

const formats = require('../src/engine/formats');
const { maskText } = require('../src/engine/masker');
const ooxml = require('../src/engine/formats/ooxml');

// ---------------------------------------------------------------------------
// #53 -- Office outputs are compressed, the paragraph walk is linear, numeric
//        character references are read, and an encrypted or broken file says
//        what it is. All values are synthetic.
// ---------------------------------------------------------------------------

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function docx(file, paragraphs, { compress = true } = {}) {
  const body = paragraphs.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: compress ? 'DEFLATE' : 'STORE' }));
  return file;
}

async function mask(src, out) {
  const data = await formats.readFile(src);
  const { masked, findings } = maskText(data.text);
  const replMap = {};
  for (const f of findings) replMap[f.original] = f.replacement;
  await formats.writeMasked(src, out, data, replMap, masked);
  return findings;
}

/** A compound file (the container of legacy and of encrypted Office files). */
function compoundFile(encrypted) {
  const buf = Buffer.alloc(4096);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  Buffer.from(encrypted ? 'EncryptedPackage' : 'WordDocument', 'utf16le').copy(buf, 1024);
  Buffer.from('EncryptionInfo', 'utf16le').copy(buf, 1200);
  return buf;
}

async function runOoxmlHygieneTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-ooxml-hygiene-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  await check('#53 a masked .docx is compressed, not many times its input', async () => {
    const lines = [];
    for (let i = 0; i < 2000; i++) lines.push(`Line ${i}: contact a.hassan${i % 40}@example.com about the quarterly report and its figures.`);
    const src = await docx(path.join(dir, 'size.docx'), lines);
    const out = path.join(dir, 'masked_size.docx');
    await mask(src, out);
    const ratio = fs.statSync(out).size / fs.statSync(src).size;
    assert(ratio < 1.5, `output is ${ratio.toFixed(1)}x the input`);
  });

  await check('#53 the paragraph walk is linear in the number of paragraphs', () => {
    const xml = (n) => `<w:document xmlns:w="${W}"><w:body>${'<w:p><w:r><w:t>plain words here</w:t></w:r><w:r><w:t> and more</w:t></w:r></w:p>'.repeat(n)}</w:body></w:document>`;
    const time = (n) => {
      const x = xml(n);
      const s = process.hrtime.bigint();
      const runs = ooxml.findRuns(x, ooxml.WORD);
      ooxml.groupByParagraph(runs);
      assert.strictEqual(runs.length, 2 * n);
      return Number(process.hrtime.bigint() - s) / 1e6;
    };
    time(2000); // warm up
    const small = time(20000);
    const large = time(80000);
    // Quadratic would be 16x; allow generous noise over the linear 4x.
    assert(large / Math.max(small, 1) < 9, `20k paragraphs ${small.toFixed(0)} ms, 80k ${large.toFixed(0)} ms`);
    assert(large < 5000, `80k paragraphs took ${large.toFixed(0)} ms`);
  });

  await check('#53 masking with thousands of values is one pass, not one per value', () => {
    // 20,000 addresses in one part and a map of 20,000 keys: one indexOf pass
    // per key made this about five seconds.
    const n = 20000;
    const xml = `<w:document xmlns:w="${W}"><w:body>${Array.from({ length: n }, (_, i) => `<w:p><w:r><w:t>row ${i} u${i}@example.org</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
    const map = {};
    for (let i = 0; i < n; i++) map[`u${i}@example.org`] = `[EMAIL_${i + 1}]`;
    const t0 = Date.now();
    const out = ooxml.maskXml(xml, map, ooxml.WORD);
    const ms = Date.now() - t0;
    assert(!out.includes('@example.org'), 'an address survived');
    assert(out.includes('row 19999 [EMAIL_20000]'), 'tokens out of place');
    assert(ms < 2000, `took ${ms} ms`);
  });

  await check('#53 the shared matcher agrees with the per-key search', () => {
    const { KeyMatcher, occurrences } = require('../src/engine/formats/replace');
    const keys = ['Ali', 'Ali Hassan', 'a@b.co', 'b.co', 'x1', 'Hassan', ...Array.from({ length: 30 }, (_, i) => `k${i}z`)];
    const text = 'Ali Hassan wrote to a@b.co; Alignment k3z k30z x1x1 Hassani, Ali.';
    const m = new KeyMatcher(keys);
    const got = m.matches(text).map((x) => `${keys[x.idx]}@${x.at}`).sort();
    const want = keys.flatMap((k) => occurrences(text, k).map((a) => `${k}@${a}`)).sort();
    assert.deepStrictEqual(got, want);
    // Longest first, no overlaps: "Ali Hassan" wins over "Ali" and "Hassan".
    const map = Object.fromEntries(keys.map((k, i) => [k, `[K${i}]`]));
    assert.strictEqual(new KeyMatcher([...keys].sort((a, b) => b.length - a.length)).replace('Ali Hassan and Ali', map), '[K1] and [K0]');
  });

  await check('#53 numeric character references are read, and masked', async () => {
    const src = await docx(path.join(dir, 'refs.docx'), [
      'Write to a.hassan&#64;example.com today.',
      'Or b.smith&#x40;corp.example.com, &#x4A;ohn.',
      'Literal &amp;#64; stays literal.',
    ]);
    const data = await formats.readFile(src);
    assert(data.text.includes('a.hassan@example.com') && data.text.includes('b.smith@corp.example.com'), data.text);
    assert(data.text.includes('Literal &#64; stays'), data.text);
    const out = path.join(dir, 'masked_refs.docx');
    const findings = await mask(src, out);
    assert.strictEqual(findings.filter((f) => f.id === 'email').length, 2);
    const xml = await (await JSZip.loadAsync(fs.readFileSync(out))).file('word/document.xml').async('string');
    assert(!/hassan|b\.smith/.test(xml), xml);
    assert(xml.includes('Literal &amp;#64; stays'), 'the literal text changed');
  });

  await check('#53 decodeXml: one pass, invalid references kept, attributes escaped for either quote', () => {
    assert.strictEqual(ooxml.decodeXml('&amp;amp; &amp;lt; &#65;&#x42;'), '&amp; &lt; AB');
    assert.strictEqual(ooxml.decodeXml('&#0; &#xD800; &#1114112;'), '&#0; &#xD800; &#1114112;');
    assert.strictEqual(ooxml.encodeAttr(`it's "x"`), 'it&apos;s &quot;x&quot;');
  });

  await check('#53 an encrypted file says it is password-protected (exit 2), for every kind', () => {
    for (const ext of ['docx', 'pptx', 'xlsx']) {
      const f = path.join(dir, `locked.${ext}`);
      fs.writeFileSync(f, compoundFile(true));
      for (const cmd of ['scan', 'mask']) {
        const r = cli([cmd, f]);
        assert.strictEqual(r.status, 2, `${cmd} ${ext}: exit ${r.status}`);
        assert(/password-protected/.test(r.stderr) && !/is this a zip/i.test(r.stderr), `${cmd} ${ext}: ${r.stderr}`);
      }
    }
  });

  await check('#53 a legacy .doc or a non-zip file named .docx is named as such', () => {
    const legacy = path.join(dir, 'old.docx');
    fs.writeFileSync(legacy, compoundFile(false));
    let r = cli(['scan', legacy]);
    assert.strictEqual(r.status, 2);
    assert(/legacy binary Office file \(\.doc\)/.test(r.stderr), r.stderr);
    const text = path.join(dir, 'text.pptx');
    fs.writeFileSync(text, 'just some text');
    r = cli(['scan', text]);
    assert.strictEqual(r.status, 2);
    assert(/not a \.pptx package: it is not a zip file/.test(r.stderr), r.stderr);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`ooxml-hygiene.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runOoxmlHygieneTests };

if (require.main === module) {
  runOoxmlHygieneTests().then((ok) => process.exit(ok ? 0 : 1));
}
