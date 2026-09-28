const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');

// ---------------------------------------------------------------------------
// #46 -- no dependency with open advisories on the default path, and no
//        database driver pulled in by a plain install.
// All values are synthetic.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kakashi.js');
const pkg = require('../package.json');
const DRIVERS = ['pg', 'mysql2', 'mongodb', 'snowflake-sdk', '@databricks/sql', 'better-sqlite3'];

async function runDepsTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-deps-'));
  // Load the CLI with `require('xlsx')` failing, as on a machine without SheetJS.
  const blocker = path.join(dir, 'no-sheetjs.js');
  fs.writeFileSync(blocker, `
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'xlsx' || ${JSON.stringify(DRIVERS)}.includes(request)) {
        const err = new Error("Cannot find module '" + request + "'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return load.call(this, request, ...rest);
    };
  `);
  const cli = (args) => spawnSync(process.execPath, ['--require', blocker, CLI, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, HOME: dir },
  });

  await check('#46 SheetJS and the database drivers are optional peers, not dependencies', () => {
    assert(!pkg.dependencies.xlsx, 'xlsx is still a dependency');
    assert.strictEqual(pkg.optionalDependencies, undefined, 'optionalDependencies are installed by default');
    for (const name of ['xlsx', ...DRIVERS]) {
      assert(pkg.peerDependencies[name], `${name} is not a peer dependency`);
      assert.strictEqual(pkg.peerDependenciesMeta[name].optional, true, `${name} peer is not optional`);
      assert(!pkg.dependencies[name], `${name} is a dependency`);
    }
  });

  // A workbook with a chart part SheetJS does not model.
  const XLSX = require('xlsx'); // devDependency: builds the fixtures only
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Full Name', 'Phone', 'Email'],
    ['Ahmed Hassan', 971501234567, 'a.hassan@example.com'],
  ]), 'Staff');
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  zip.file('xl/charts/chart1.xml', '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart/></c:chartSpace>');
  const types = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>',
    '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'));
  const xlsxPath = path.join(dir, 'staff.xlsx');
  fs.writeFileSync(xlsxPath, await zip.generateAsync({ type: 'nodebuffer' }));

  await check('#46 .xlsx is scanned and masked without SheetJS', async () => {
    const scan = cli(['scan', xlsxPath]);
    assert.strictEqual(scan.status, 1, scan.stderr);
    const out = path.join(dir, 'masked_staff.xlsx');
    const r = cli(['mask', xlsxPath, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    const back = await JSZip.loadAsync(fs.readFileSync(out));
    const all = (await Promise.all(Object.values(back.files).map((f) => f.async('string')))).join('\n');
    for (const v of ['Ahmed Hassan', '971501234567', 'a.hassan@example.com']) assert(!all.includes(v), `${v} survived`);
    // Parts SheetJS did not model used to be dropped when it rebuilt the file.
    assert(back.file('xl/charts/chart1.xml'), 'the chart part was dropped');
    // A masked number becomes an inline string, and the workbook still reads.
    const cells = XLSX.read(fs.readFileSync(out)).Sheets.Staff;
    assert.strictEqual(cells.B2.v, '[INTL_PHONE_1]');
    assert.strictEqual(cells.A1.v, 'Full Name');
  });

  await check('#46 a legacy .xls without SheetJS says how to install it (exit 2)', () => {
    const xls = path.join(dir, 'legacy.xls');
    XLSX.writeFile(wb, xls, { bookType: 'biff8' });
    const r = cli(['scan', xls]);
    assert.strictEqual(r.status, 2, r.stdout);
    assert(/need SheetJS/.test(r.stderr) && /cdn\.sheetjs\.com/.test(r.stderr), r.stderr);
  });

  await check('#46 a missing database driver names the package to install', () => {
    const r = cli(['db-scan', 'postgres://u:p@127.0.0.1:1/x', '-q', 'select 1']);
    assert.strictEqual(r.status, 2, r.stdout);
    assert(/PostgreSQL driver is not installed/.test(r.stderr) && /npm install -g pg/.test(r.stderr), r.stderr);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`deps.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runDepsTests };

if (require.main === module) {
  runDepsTests().then((ok) => process.exit(ok ? 0 : 1));
}
