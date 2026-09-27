const XLSX = require('xlsx');
const { replaceOccurrences } = require('./replace');

/**
 * Cells within a row are joined with this separator for detection. No pattern
 * can match across it (none allows `|` between the parts of a value), so every
 * finding stays inside one cell and the per-cell write below can apply it. It
 * also lets the person-field detector read the first row as column headers, so
 * a `Full Name` column is known to hold names whatever their case.
 */
const CELL_SEPARATOR = ' | ';

async function readXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const cells = {};
  const sheetTexts = [];

  for (const sheetName of wb.SheetNames) {
    cells[sheetName] = {};
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
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
  return { text: sheetTexts.join('\n\n'), wb, cells };
}

async function writeXlsx(filePath, outputPath, data, replMap) {
  const wb = data.wb;
  // Sort replacement keys longest-first so we don't replace a substring of
  // another secret before the longer match has a chance to fire (e.g. an
  // email "alice@db.example.com" must replace before the phone-shaped "...com"
  // sub-fragment if any).
  const orderedKeys = Object.keys(replMap).sort((a, b) => b.length - a.length);

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const sheetCells = data.cells[sheetName] || {};
    for (const [addr, original] of Object.entries(sheetCells)) {
      // Per-cell substring substitution: catches secrets embedded in
      // narrative text (e.g. "Customer email: alice@example.com -- follow up"),
      // not just cells whose entire value equals a captured secret.
      let masked = original;
      for (const key of orderedKeys) {
        if (key && masked.includes(key)) {
          masked = replaceOccurrences(masked, key, replMap[key]);
        }
      }
      if (sheet[addr] && masked !== original) {
        sheet[addr].v = masked;
        sheet[addr].w = masked;
        // Force string type so a number-typed cell (e.g. a phone stored as a
        // numeric value) doesn't render as NaN once a token is written into it.
        sheet[addr].t = 's';
      }
    }
  }
  XLSX.writeFile(wb, outputPath);
}

module.exports = { readXlsx, writeXlsx };
