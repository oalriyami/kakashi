/**
 * Legacy workbooks -- binary .xls (BIFF) and .xlsb -- through SheetJS (#46).
 *
 * .xlsx and .xlsm are read and masked by Kakashi's own OOXML code (./xlsx.js):
 * SheetJS 0.18.5, the last version on npm, parses untrusted files with known
 * prototype-pollution and ReDoS flaws, and fixed versions are published only
 * on the SheetJS CDN. It is therefore an optional peer dependency, loaded only
 * for these formats.
 */
const JSZip = require('jszip');
const pkg = require('./package');
const { matcherFor, orderKeys } = require('./replace');

let XLSX = null;
/** SheetJS, or a clear error saying how to install it. */
function sheetjs() {
  if (XLSX) return XLSX;
  try {
    XLSX = require('xlsx');
  } catch (_) {
    throw new Error('Legacy .xls and .xlsb workbooks need SheetJS, which is not installed. Install it next to '
      + 'Kakashi: npm install -g https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz -- or save the workbook as .xlsx, '
      + 'which Kakashi reads without it.');
  }
  return XLSX;
}

/**
 * Cells within a row are joined with this separator for detection. No pattern
 * can match across it (none allows `|` between the parts of a value), so every
 * finding stays inside one cell and the per-cell write below can apply it. It
 * also lets the person-field detector read the first row as column headers, so
 * a `Full Name` column is known to hold names whatever their case.
 */
const CELL_SEPARATOR = ' | ';

/** Characters Excel does not allow in a sheet name, and its length limit. */
const SHEET_NAME_ILLEGAL = /[[\]:*?/\\]/g;
const SHEET_NAME_MAX = 31;

const isZip = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

/** Cell text, one row per line, one blank line between sheets. */
function cellText(wb) {
  const cells = {};
  const sheetTexts = [];
  for (const sheetName of wb.SheetNames) {
    cells[sheetName] = {};
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;
    const range = sheetjs().utils.decode_range(sheet['!ref']);
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = sheetjs().utils.encode_cell({ r, c });
        const cell = sheet[addr];
        const val = cell && cell.v != null ? String(cell.v) : '';
        if (val) cells[sheetName][addr] = val;
        // Empty cells stay as empty fields so every row keeps its columns.
        row.push(val);
      }
      if (row.some(Boolean)) rows.push(row.join(CELL_SEPARATOR));
    }
    if (rows.length) sheetTexts.push(rows.join('\n'));
  }
  // A blank line between sheets, so each sheet's first row is its own header.
  return { text: sheetTexts.join('\n\n'), cells };
}

const STRING_PROPS = (props) => Object.entries(props || {})
  .filter(([, v]) => typeof v === 'string')
  .map(([k]) => k);

/**
 * Everything outside the cells, from the SheetJS model. Used for legacy .xls
 * workbooks, which are not zip packages; for .xlsx the package reader in
 * ./package.js covers the same ground and more.
 */
function modelText(wb) {
  const lines = [...wb.SheetNames];
  for (const k of STRING_PROPS(wb.Props)) lines.push(wb.Props[k]);
  for (const k of STRING_PROPS(wb.Custprops)) lines.push(wb.Custprops[k]);
  for (const n of (wb.Workbook && wb.Workbook.Names) || []) if (n.Ref) lines.push(n.Ref);
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName] || {};
    for (const [addr, cell] of Object.entries(sheet)) {
      if (addr[0] === '!' || !cell) continue;
      if (cell.f) lines.push(cell.f);
      if (cell.l) lines.push(cell.l.Target || '', cell.l.Tooltip || '');
      for (const c of cell.c || []) lines.push(c.a || '', c.t || '');
    }
  }
  return lines.filter((l) => l && l.trim()).join('\n');
}

/**
 * Read a workbook: its cells, plus every other part that carries text
 * (comments, formulas, sheet names, drawings, properties, link targets...).
 * @param {Buffer} buf
 */
async function readXlsxBuffer(buf) {
  const wb = sheetjs().read(buf, { type: 'buffer' });
  const { text: cells_, cells } = cellText(wb);
  let rest = { text: modelText(wb), unscanned: [] };
  if (isZip(buf)) rest = await pkg.readPackage(buf, 'xlsx');
  const text = [cells_, rest.text].filter(Boolean).join('\n\n');
  return { text, wb, cells, unscanned: rest.unscanned };
}

function makeMasker(replMap) {
  // Longest first, so a short value that is a substring of a longer one cannot
  // claim the text before the longer match fires.
  const matcher = matcherFor(replMap, { keys: orderKeys(replMap) });
  return (s) => {
    if (typeof s !== 'string' || !s) return s;
    return matcher.replace(s, replMap);
  };
}

const quoteSheet = (name) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rename every sheet whose name holds a detected value.
 *
 * A token like `[EMAIL_1]` is not a legal sheet name (Excel forbids `[ ] : * ?
 * / \` and more than 31 characters), and a sheet name is also referenced from
 * formulas and defined names, so it cannot simply be substituted in the XML.
 * The replacement is made legal, kept unique, and every reference is updated.
 *
 * @returns {Map<string,string>} old name -> new name
 */
function renameSheets(wb, mask) {
  const renames = new Map();
  const taken = new Set(wb.SheetNames);
  wb.SheetNames.forEach((name, i) => {
    const masked = mask(name);
    if (masked === name) return;
    const base = masked.replace(SHEET_NAME_ILLEGAL, '').replace(/^'+|'+$/g, '').trim().slice(0, SHEET_NAME_MAX) || `Sheet${i + 1}`;
    let next = base;
    for (let n = 2; taken.has(next); n++) next = `${base.slice(0, SHEET_NAME_MAX - 4)} (${n})`;
    taken.add(next);
    renames.set(name, next);
  });
  if (renames.size === 0) return renames;

  wb.SheetNames = wb.SheetNames.map((n) => renames.get(n) || n);
  for (const [from, to] of renames) {
    wb.Sheets[to] = wb.Sheets[from];
    delete wb.Sheets[from];
  }
  for (const s of (wb.Workbook && wb.Workbook.Sheets) || []) {
    if (s.name && renames.has(s.name)) s.name = renames.get(s.name);
  }
  return renames;
}

/** Point `'Old Name'!A1` and `Old!A1` at the renamed sheet. */
function retarget(formula, renames) {
  let out = formula;
  for (const [from, to] of renames) {
    out = out.split(`'${from.replace(/'/g, "''")}'!`).join(`${quoteSheet(to)}!`);
    out = out.replace(new RegExp(`(?<![\\w.'])${escRx(from)}!`, 'g'), `${quoteSheet(to)}!`);
  }
  return out;
}

/** Apply the replacement map to everything in the model that holds text. */
function maskWorkbook(wb, replMap) {
  const mask = makeMasker(replMap);
  const renames = renameSheets(wb, mask);

  for (const k of STRING_PROPS(wb.Props)) wb.Props[k] = mask(wb.Props[k]);
  for (const k of STRING_PROPS(wb.Custprops)) wb.Custprops[k] = mask(wb.Custprops[k]);
  for (const n of (wb.Workbook && wb.Workbook.Names) || []) {
    if (n.Ref) n.Ref = mask(retarget(n.Ref, renames));
  }

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    for (const [addr, cell] of Object.entries(sheet)) {
      if (addr[0] === '!' || !cell) continue;
      // Per-cell substring substitution: catches secrets embedded in
      // narrative text (e.g. "Customer email: alice@example.com -- follow up"),
      // not just cells whose entire value equals a captured secret.
      if (cell.v != null) {
        const original = String(cell.v);
        const masked = mask(original);
        if (masked !== original) {
          cell.v = masked;
          cell.w = masked;
          // Force string type so a number-typed cell (e.g. a phone stored as a
          // numeric value) doesn't render as NaN once a token is written into it.
          cell.t = 's';
          // Rich-text and HTML renderings still hold the original.
          delete cell.r;
          delete cell.h;
        }
      }
      if (cell.f) cell.f = mask(retarget(cell.f, renames));
      if (cell.l) {
        cell.l.Target = mask(cell.l.Target);
        if (cell.l.Tooltip) cell.l.Tooltip = mask(cell.l.Tooltip);
        if (cell.l.Rel && cell.l.Rel.Target) cell.l.Rel.Target = mask(cell.l.Rel.Target);
      }
      for (const c of cell.c || []) {
        c.a = mask(c.a);
        c.t = mask(c.t);
        delete c.r;
        delete c.h;
      }
    }
  }
}

/**
 * Mask a workbook held in memory and return the new file, verified.
 *
 * SheetJS rebuilds the package from its model, so parts it does not model
 * (drawings, charts, pivot caches, connections) are not carried over. What it
 * does write is then run through the same package masker as .docx and .pptx,
 * and the result is checked before it is returned.
 *
 * @param {Buffer} buf
 * @param {object} replMap
 * @param {string} bookType - 'xlsx', 'xlsm', 'biff8', ...
 * @returns {Promise<Buffer>}
 * @throws {pkg.MaskVerificationError}
 */
async function maskXlsxBuffer(buf, replMap, bookType = 'xlsx') {
  const wb = sheetjs().read(buf, { type: 'buffer' });
  maskWorkbook(wb, replMap);
  const out = sheetjs().write(wb, { type: 'buffer', bookType });

  if (isZip(out)) {
    const zip = await JSZip.loadAsync(out);
    await pkg.maskZip(zip, 'xlsx', replMap);
    return pkg.finishPackage(zip, 'xlsx', replMap);
  }

  // Legacy binary workbooks cannot be inspected part by part; read the result
  // back through SheetJS and check what it sees.
  const { text } = await readXlsxBuffer(out);
  const left = [...matcherFor(replMap, { keys: orderKeys(replMap) }).keysIn(text)];
  if (left.length > 0) throw new pkg.MaskVerificationError([{ part: 'workbook', count: left.length }]);
  return out;
}

module.exports = { readXlsxBuffer, maskXlsxBuffer, retarget, quoteSheet, SHEET_NAME_ILLEGAL, SHEET_NAME_MAX };
