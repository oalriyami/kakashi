const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const formats = require('../src/engine/formats');
const { maskText } = require('../src/engine/masker');
const xlsx = require('../src/engine/formats/xlsx');

// ---------------------------------------------------------------------------
// #52 -- a masked workbook keeps its formatting, dates of birth are read as
//        the dates they show, formulas stay, and a blank row still separates
//        two tables. tests/fixtures/formatted.xlsx was made with openpyxl:
//        bold and filled headers, number and date formats, a column width,
//        frozen panes, a data validation, a conditional format, a chart, a
//        formula without a cached value, and a second table under a blank
//        row. All values are synthetic.
// ---------------------------------------------------------------------------

const FIXTURE = path.join(__dirname, 'fixtures', 'formatted.xlsx');

async function part(buf, name) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file(name);
  return f ? f.async('string') : null;
}

/** The <c> element for `ref` in a worksheet's XML. */
function cellXml(xml, ref) {
  const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(xml);
  return m ? m[0] : null;
}

async function runXlsxRoundtripTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-xlsx-rt-'));
  const src = path.join(dir, 'formatted.xlsx');
  fs.copyFileSync(FIXTURE, src);
  const data = await formats.readFile(src);
  const { masked, findings } = maskText(data.text, { structure: formats.structureOf(src) });
  const out = path.join(dir, 'masked_formatted.xlsx');
  const replMap = {};
  for (const f of findings) replMap[f.original] = f.replacement;
  await formats.writeMasked(src, out, { ...data, format: 'xlsx' }, replMap, masked);
  const before = fs.readFileSync(src);
  const after = fs.readFileSync(out);
  const sheetBefore = await part(before, 'xl/worksheets/sheet1.xml');
  const sheetAfter = await part(after, 'xl/worksheets/sheet1.xml');

  await check('#52 dates of birth are read as dates, not serial numbers', () => {
    const dobs = findings.filter((f) => f.id === 'dob').map((f) => f.original).sort();
    assert.deepStrictEqual(dobs, ['1979-11-30', '1985-07-15', '1990-03-02']);
    assert(!/\b31243\b/.test(data.text), 'a date was read as its serial');
    // A timestamp that is not a date of birth is read, and left alone.
    assert(data.text.includes('2026-09-01 09:30:00'), data.text.split('\n')[0]);
    assert(!findings.some((f) => f.original.startsWith('2026-09-01')));
  });

  await check('#52 a masked date is written as its token, never as the serial number', () => {
    for (const ref of ['B2', 'B3', 'B6']) {
      const c = cellXml(sheetAfter, ref);
      assert(/t="inlineStr"/.test(c) && /\[DOB_\d\]/.test(c), `${ref}: ${c}`);
    }
    // Its style (the date format) is kept on the cell.
    assert(/ s="3"/.test(cellXml(sheetAfter, 'B2')), cellXml(sheetAfter, 'B2'));
  });

  await check('#52 a blank row keeps two tables apart', () => {
    // Fused, "Customer" was a data row of the first table's Full Name column.
    assert(!findings.some((f) => f.original === 'Customer'), 'the second table\'s header was masked as a name');
    assert(findings.some((f) => f.original === 'Omar Khalid'));
    assert(/Fatima Ali[^\n]*\n\nCustomer/.test(data.text), 'no blank line between the tables');
  });

  await check('#52 formatting, validation, conditional formats and the chart are kept', async () => {
    assert.strictEqual(await part(after, 'xl/styles.xml'), await part(before, 'xl/styles.xml'));
    for (const piece of ['<cols>', '<pane ', '<conditionalFormatting', '<dataValidations', '<drawing ']) {
      assert(sheetAfter.includes(piece), `${piece} was dropped`);
    }
    const sliceOf = (xml, tag) => xml.slice(xml.indexOf(`<${tag}`), xml.indexOf(`</${tag}>`) + tag.length + 3);
    for (const tag of ['sheetViews', 'cols', 'conditionalFormatting', 'dataValidations']) {
      assert.strictEqual(sliceOf(sheetAfter, tag), sliceOf(sheetBefore, tag), `${tag} changed`);
    }
    assert.strictEqual(await part(after, 'xl/charts/chart1.xml'), await part(before, 'xl/charts/chart1.xml'));
    assert(await part(after, 'xl/drawings/drawing1.xml'));
    // Unmasked cells are untouched, style attributes included.
    for (const ref of ['A1', 'B1', 'C2', 'C3', 'D2', 'H1', 'A5', 'B5']) {
      assert.strictEqual(cellXml(sheetAfter, ref), cellXml(sheetBefore, ref), ref);
    }
  });

  await check('#52 formulas are kept; a literal in one is masked', () => {
    assert.strictEqual(cellXml(sheetAfter, 'F1'), cellXml(sheetBefore, 'F1'));
    assert(/<f>SUM\(C2:C3\)<\/f>/.test(cellXml(sheetAfter, 'F1')));
    const f2 = cellXml(sheetAfter, 'F2');
    assert(/<f>CONCATENATE\(/.test(f2) && !f2.includes('ops.lead@example.com') && f2.includes('[EMAIL_1]'), f2);
  });

  await check('#52 date formats and serials are read as Excel shows them', () => {
    const kinds = {
      'yyyy-mm-dd': 'date', 'dd/mm/yyyy': 'date', 'mmm-yy': 'date', '[$-409]mmmm d, yyyy': 'date',
      'm/d/yy h:mm': 'datetime', 'h:mm:ss': 'time', '[h]:mm': 'time', 'mm:ss': 'time',
      General: null, '0.00': null, '#,##0': null, '0.00E+00': null, '[Red]0.00': null, '@': null,
    };
    for (const [code, kind] of Object.entries(kinds)) assert.strictEqual(xlsx.dateKindOfCode(code), kind, code);
    assert.strictEqual(xlsx.serialToText(1, 'date', false), '1900-01-01');
    assert.strictEqual(xlsx.serialToText(61, 'date', false), '1900-03-01');
    assert.strictEqual(xlsx.serialToText(31243, 'date', false), '1985-07-15');
    assert.strictEqual(xlsx.serialToText(45000.5, 'datetime', false), '2023-03-15 12:00:00');
    assert.strictEqual(xlsx.serialToText(0, 'date', true), '1904-01-01');
    assert.strictEqual(xlsx.serialToText(-1, 'date', false), null);
  });

  await check('#52 a 1904 workbook reads its dates from 1904', async () => {
    const zip = await JSZip.loadAsync(before);
    const wb = await zip.file('xl/workbook.xml').async('string');
    zip.file('xl/workbook.xml', wb.includes('<workbookPr')
      ? wb.replace('<workbookPr', '<workbookPr date1904="1"')
      : wb.replace(/(<workbook\b[^>]*>)/, '$1<workbookPr date1904="1"/>'));
    const { text } = await xlsx.readXlsxBuffer(await zip.generateAsync({ type: 'nodebuffer' }));
    // 31243 days after 1904-01-01.
    assert(text.includes('1989-07-16'), text.split('\n')[1]);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`xlsx-roundtrip.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runXlsxRoundtripTests };

if (require.main === module) {
  runXlsxRoundtripTests().then((ok) => process.exit(ok ? 0 : 1));
}
