const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const formats = require('../src/engine/formats');
const { maskText } = require('../src/engine/masker');
const { layoutText } = require('../src/engine/formats/pdf');

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');

// ---------------------------------------------------------------------------
// #31 -- PDF reading.
//
// Table cells were glued together (`1Rajesh Kumar0501234567411111…`), so a
// table of IDs, phones and cards scanned as 0 findings. Form values, notes and
// document properties were never read. A scanned page counted as clean. And
// any PDF under about 4 KB failed with "bad XRef entry".
//
// The PDFs are built here, byte by byte, so the structure under test is
// visible and every file stays small. All values are synthetic.
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/([\\()])/g, '\\$1');

/**
 * A minimal PDF.
 * @param {object} spec
 * @param {Array} spec.pages - per page: text items as [x, y, text]; the string
 *   'image' for a page that only paints an image; or { text, image: true } for
 *   a page with both
 * @param {object} [spec.info] - document properties
 * @param {Array<object>} [spec.annots] - on page 1: { note, author } or { field, value }
 */
function buildPdf({ pages, info = {}, annots = [] }) {
  const objects = []; // index + 1 = object number
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const image = add(null);
  objects[image - 1] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u0080\nendstream';

  const annotRefs = annots.map((a) => add(a.note !== undefined
    ? `<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (${esc(a.note)}) /T (${esc(a.author || '')}) >>`
    : `<< /Type /Annot /Subtype /Widget /FT /Tx /Rect [10 40 200 60] /T (${esc(a.field)}) /V (${esc(a.value)}) >>`));
  const fields = annots.map((a, i) => (a.field ? annotRefs[i] : null)).filter(Boolean);

  const pageRefs = pages.map((items, i) => {
    const text = items === 'image' ? [] : (Array.isArray(items) ? items : items.text);
    const paintsImage = items === 'image' || Boolean(items.image);
    const content = [
      ...(paintsImage ? ['q 60 0 0 30 500 740 cm /Im1 Do Q'] : []),
      ...text.map(([x, y, t]) => `BT /F1 10 Tf ${x} ${y} Td (${esc(t)}) Tj ET`),
    ].join('\n');
    const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const annotsKey = i === 0 && annotRefs.length ? ` /Annots [${annotRefs.map((r) => `${r} 0 R`).join(' ')}]` : '';
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R`
      + ` /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >>${annotsKey} >>`);
  });

  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
  const acro = fields.length ? ` /AcroForm << /Fields [${fields.map((r) => `${r} 0 R`).join(' ')}] >>` : '';
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${acro} >>`;
  const infoObj = add(`<< ${Object.entries(info).map(([k, v]) => `/${k} (${esc(v)})`).join(' ')} >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A payroll table: header and two rows, one cell per column. */
const TABLE = [
  [72, 700, 'ID'], [110, 700, 'Name'], [230, 700, 'Mobile'], [330, 700, 'Card'],
  [72, 680, '1'], [110, 680, 'Rajesh Kumar'], [230, 680, '0501234567'], [330, 680, '4111111111111111'],
  [72, 660, '2'], [110, 660, 'Priya Sharma'], [230, 660, '0529876543'], [330, 660, '5555555555554444'],
];

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

async function runPdfTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-pdf-'));
  const write = (name, spec) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buildPdf(spec));
    return p;
  };

  await check('#31 a small PDF (under 4 KB) is read, not rejected', async () => {
    const f = write('small.pdf', { pages: [[[72, 700, 'Email r.kumar@example.org']]] });
    assert.ok(fs.statSync(f).size < 4096);
    const { text } = await formats.readFile(f);
    assert.ok(text.includes('r.kumar@example.org'), text);
  });

  await check('#31 table cells are separated, so every value in a row is found', async () => {
    const f = write('table.pdf', { pages: [TABLE] });
    const { text } = await formats.readFile(f);
    assert.ok(!/Kumar0501|0501234567411/.test(text), `cells glued: ${JSON.stringify(text)}`);
    const found = maskText(text).findings.map((x) => x.original);
    for (const v of ['Rajesh Kumar', '0501234567', '4111111111111111', 'Priya Sharma', '0529876543', '5555555555554444']) {
      assert.ok(found.includes(v), `${v} not detected in ${JSON.stringify(text)}`);
    }
  });

  await check('#31 layout: touching items join, word gaps get a space, column gaps a tab, overlaps a newline', () => {
    const item = (str, x, y, width) => ({ str, transform: [10, 0, 0, 10, x, y], width });
    assert.strictEqual(layoutText([item('sk-proj-', 10, 100, 40), item('abc', 50, 100, 15)]), 'sk-proj-abc');
    assert.strictEqual(layoutText([item('Rajesh', 10, 100, 30), item('Kumar', 43, 100, 25)]), 'Rajesh Kumar');
    assert.strictEqual(layoutText([item('Kumar', 10, 100, 25), item('0501234567', 100, 100, 50)]), 'Kumar\t0501234567');
    assert.strictEqual(layoutText([item('a.b@example.org', 10, 100, 80), item('Layout', 10, 100, 30)]), 'a.b@example.org\nLayout');
    assert.strictEqual(layoutText([item('line one', 10, 100, 40), item('line two', 10, 88, 40)]), 'line one\nline two');
  });

  await check('#31 form field values, notes, note authors and document properties are read', async () => {
    const f = write('form.pdf', {
      pages: [[[72, 700, 'Application form']]],
      annots: [{ field: 'email', value: 'field.value@example.org' }, { field: 'eid', value: '784-1990-1234567-4' },
        { note: 'Check with note.body@example.org', author: 'note.author@example.org' }],
      info: { Author: 'info.author@example.org', Title: 'Case 784-1990-1234567-4' },
    });
    const { text } = await formats.readFile(f);
    const found = maskText(text).findings.map((x) => x.original);
    for (const v of ['field.value@example.org', '784-1990-1234567-4', 'note.body@example.org', 'note.author@example.org', 'info.author@example.org']) {
      assert.ok(found.includes(v), `${v} not detected`);
    }
  });

  await check('#31 a page that is only an image is reported as not checked', async () => {
    const f = write('scan.pdf', { pages: [[[72, 700, 'Cover letter with enough text to count as a text page.']], 'image'] });
    const data = await formats.readFile(f);
    assert.deepStrictEqual(data.unscanned, ['page 2 (no text layer)']);
    const r = cli(['scan', f]);
    assert.ok(/could not be read and were not checked: page 2/.test(r.stdout), r.stdout);
  });

  await check('#31 a text page with a logo is not reported', async () => {
    const f = write('logo.pdf', { pages: [{ text: [[72, 700, 'Quarterly operations summary for the regional office.']], image: true }] });
    const data = await formats.readFile(f);
    assert.deepStrictEqual(data.unscanned, []);
  });

  await check('#31 guard: a scanned page needs approval before an external release', () => {
    const f = write('scan-guard.pdf', { pages: ['image'] });
    const r = cli(['guard', f, '-d', 'external_model', '--no-audit', '--json']);
    assert.strictEqual(r.status, 3, r.stdout);
    const d = JSON.parse(r.stdout);
    assert.strictEqual(d.reasonCode, 'UNSCANNED_CONTENT');
    assert.strictEqual(d.unscannedParts, 1);
  });

  await check('#31 guard: a table PDF is not released as the original', () => {
    const f = write('table-guard.pdf', { pages: [TABLE] });
    const r = cli(['guard', f, '-d', 'external_model', '--no-audit', '--json']);
    const d = JSON.parse(r.stdout);
    assert.notStrictEqual(d.decision, 'ALLOW', 'Guardian released the original table');
  });

  await check('#31 the masked extract says what was replaced and what was not checked', () => {
    const table = write('hdr.pdf', { pages: [TABLE, 'image'] });
    const r = cli(['mask', table]);
    assert.strictEqual(r.status, 0, r.stderr);
    const md = fs.readFileSync(path.join(dir, 'hdr_masked.md'), 'utf8');
    assert.ok(/> 6 distinct sensitive values were replaced/.test(md), md.slice(0, 400));
    assert.ok(/Not checked: page 2 \(no text layer\)/.test(md), md.slice(0, 400));
    for (const v of ['Rajesh Kumar', '0501234567', '4111111111111111']) assert.ok(!md.includes(v), `${v} survived`);

    const clean = write('clean.pdf', { pages: [[[72, 700, 'Nothing to see in this quarterly note.']]] });
    cli(['mask', clean]);
    const cleanMd = fs.readFileSync(path.join(dir, 'clean_masked.md'), 'utf8');
    assert.ok(/No sensitive values were detected/.test(cleanMd), cleanMd.slice(0, 300));
    assert.ok(!/were replaced/.test(cleanMd), 'header claims replacements that did not happen');
  });

  await check('#31 pdf.js warnings about a malformed file never reach JSON output', () => {
    // Turn the image object into a plain dictionary of the same length, so
    // the cross-reference offsets stay valid and pdf.js warns
    // "XObject should be a stream" while reading the page.
    const bytes = buildPdf({ pages: ['image'] }).toString('latin1');
    const img = bytes.match(/<< \/Type \/XObject[\s\S]*?endstream/)[0];
    const broken = bytes.replace(img, '<< /Type /Nothing >>'.padEnd(img.length, ' '));
    const f = path.join(dir, 'malformed.pdf');
    fs.writeFileSync(f, Buffer.from(broken, 'latin1'));
    const r = cli(['guard', f, '-d', 'local', '--no-audit', '--json']);
    assert.ok(!/Warning:/.test(r.stdout), `pdf.js warning on stdout: ${r.stdout.slice(0, 200)}`);
    JSON.parse(r.stdout);
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`pdf.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runPdfTests };

if (require.main === module) {
  runPdfTests().then((ok) => process.exit(ok ? 0 : 1));
}
