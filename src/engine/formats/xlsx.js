/**
 * Excel workbooks.
 *
 * .xlsx / .xlsm / .xltx / .xltm are zip packages of XML, read and masked here
 * with the same OOXML machinery as .docx and .pptx (#46). They used to go
 * through SheetJS 0.18.5 -- the last version on npm, with open prototype-
 * pollution and ReDoS advisories on exactly this job, parsing untrusted files
 * -- which also rebuilt the package from its own model and so dropped every
 * part it did not model (drawings, charts, pivot caches). Now the cells are
 * rewritten in place and every other part is kept.
 *
 * Legacy binary workbooks (.xls, .xlsb) still need SheetJS, an optional peer
 * dependency: see ./xlsx-legacy.js.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const pkg = require('./package');
const ooxml = require('./ooxml');
const legacy = require('./xlsx-legacy');
const { writeFileSafe } = require('../../lib/safe-write');
const { matcherFor, orderKeys } = require('./replace');

/**
 * Cells within a row are joined with this separator for detection. No pattern
 * can match across it (none allows `|` between the parts of a value), so every
 * finding stays inside one cell and the per-cell write below can apply it. It
 * also lets the person-field detector read the first row as column headers, so
 * a `Full Name` column is known to hold names whatever their case.
 */
const CELL_SEPARATOR = ' | ';

const { retarget, SHEET_NAME_ILLEGAL, SHEET_NAME_MAX } = legacy;

const isZip = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** Attributes of a start tag, by name. */
function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = ooxml.decodeXml(m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

/** The text of a shared-string item or an inline string: its <t> runs, not phonetic ones. */
function runsText(xml) {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) text += ooxml.decodeXml(m[1]);
  return text;
}

const tNode = (text) => `<t xml:space="preserve">${ooxml.encodeXml(text)}</t>`;

/** `B12` -> { r: 11, c: 1 }. */
function decodeRef(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref || '');
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

function encodeRef(r, c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `${s}${r + 1}`;
}

// ---------------------------------------------------------------------------
// The package: sheets, shared strings, cells
// ---------------------------------------------------------------------------

/** Sheets in workbook order: { name, path }. */
async function sheetsOf(zip) {
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  const rels = {};
  if (relsFile) {
    for (const m of (await relsFile.async('string')).matchAll(/<Relationship\b[^>]*>/g)) {
      const a = attrsOf(m[0]);
      if (a.Id && a.Target) rels[a.Id] = a.Target;
    }
  }
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrsOf(m[0]);
    // The relationship id attribute is `r:id` whatever prefix the file binds.
    const rid = a['r:id'] || Object.entries(a).find(([k]) => /:id$/.test(k))?.[1];
    const target = rels[rid];
    if (!target) continue;
    const p = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
    sheets.push({ name: a.name, path: p });
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// Dates. A date is stored as a serial number and shown through its cell's
// number format. Read as the number, a date of birth (`31240`) matched no
// date pattern and was never flagged (#52); it is read as the date it shows.
// ---------------------------------------------------------------------------

/** Built-in number formats that show a date, a time or both. */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
/** Built-in formats that show only a time of day. */
const BUILTIN_TIME_FORMATS = new Set([18, 19, 20, 21, 45, 46, 47]);

/** What a number-format code shows: 'date', 'datetime', 'time' or null. */
function dateKindOfCode(code) {
  // Quoted text, escaped characters and [colour]/[$-locale] sections are not
  // date tokens; [h] and [mm] (elapsed time) are.
  const bare = String(code || '').split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
  const hasDate = /[dy]/i.test(bare) || /(^|[^hs:])m{3,}/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare));
  const hasTime = /[hs]/i.test(bare);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

/**
 * Which cell styles show a date: style index -> 'date' | 'datetime' | 'time'.
 * @param {string|null} stylesXml - xl/styles.xml
 */
function dateStyles(stylesXml) {
  const out = new Map();
  if (!stylesXml) return out;
  const custom = new Map();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrsOf(m[0]);
    custom.set(Number(a.numFmtId), a.formatCode);
  }
  const xfs = (/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml) || [])[1] || '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(attrsOf(m[0].slice(0, m[0].indexOf('>') + 1)).numFmtId || 0);
    let kind = null;
    if (custom.has(id)) kind = dateKindOfCode(custom.get(id));
    else if (BUILTIN_TIME_FORMATS.has(id)) kind = 'time';
    else if (BUILTIN_DATE_FORMATS.has(id)) kind = id === 22 ? 'datetime' : 'date';
    if (kind) out.set(i, kind);
    i++;
  }
  return out;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * A serial date as ISO text: `1985-07-15`, `1985-07-15 08:30:00` or
 * `08:30:00`. `date1904` workbooks count from 1904-01-01. Returns null for a
 * number that is not a plausible date.
 */
function serialToText(serial, kind, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2958466) return null;
  const day = Math.floor(serial);
  const secs = Math.round((serial - day) * 86400);
  const time = `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
  if (kind === 'time') return time;
  let date;
  if (date1904) {
    date = new Date(Date.UTC(1904, 0, 1) + day * 86400000);
  } else if (day === 60) {
    // Excel's 29 February 1900, which never existed.
    return kind === 'datetime' ? `1900-02-29 ${time}` : '1900-02-29';
  } else {
    // Serial 1 is 1900-01-01; from 61 on, the phantom leap day shifts it by one.
    date = new Date(Date.UTC(1899, 11, day < 60 ? 31 : 30) + day * 86400000);
  }
  const iso = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return kind === 'datetime' ? `${iso} ${time}` : iso;
}

/** How cells show numbers: the date styles, and the workbook's date system. */
async function numberView(zip) {
  const stylesFile = zip.file('xl/styles.xml');
  const wb = zip.file('xl/workbook.xml') ? await zip.file('xl/workbook.xml').async('string') : '';
  return {
    dates: dateStyles(stylesFile ? await stylesFile.async('string') : null),
    date1904: /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/i.test(wb),
  };
}

/** Shared-string items: { start, end } of each <si> element and its text. */
function sharedStrings(xml) {
  const items = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    items.push({ start: m.index, end: m.index + m[0].length, text: m[1] ? runsText(m[1]) : '' });
  }
  return items;
}

/**
 * Every cell of a worksheet: position, type, value text, and where the element
 * sits in the XML. Cells without an `r` attribute take the next column of
 * their row, as Excel does.
 */
function cellsOf(xml, sst, view = { dates: new Map(), date1904: false }) {
  const cells = [];
  let row = -1;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrsOf(rm[1]);
    row = ra.r ? Number(ra.r) - 1 : row + 1;
    if (!rm[2]) continue;
    const base = rm.index + rm[0].indexOf('>') + 1;
    let col = -1;
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrsOf(cm[1]);
      const pos = decodeRef(a.r) || { r: row, c: col + 1 };
      col = pos.c;
      const inner = cm[2] || '';
      const v = /<v>([^<]*)<\/v>/.exec(inner);
      const raw = v ? ooxml.decodeXml(v[1]) : null;
      const type = a.t || 'n';
      let text = '';
      if (type === 's') text = raw !== null && sst[Number(raw)] ? sst[Number(raw)].text : '';
      else if (type === 'inlineStr') text = runsText((/<is>([\s\S]*?)<\/is>/.exec(inner) || [])[1] || '');
      else if (type === 'b') text = raw === null ? '' : (raw === '1' ? 'true' : 'false');
      else if (type === 'n') {
        const num = raw !== null && raw.trim() !== '' ? Number(raw) : NaN;
        const kind = view.dates.get(Number(a.s || 0));
        const shown = kind && Number.isFinite(num) ? serialToText(num, kind, view.date1904) : null;
        if (shown !== null) text = shown;
        else text = raw === null ? '' : (Number.isFinite(num) ? String(num) : raw);
      } else if (type === 'd') text = raw || ''; // an ISO date stored as text
      else text = raw || '';
      cells.push({
        r: pos.r, c: pos.c, type, text, raw, hasFormula: /<f\b/.test(inner),
        start: base + cm.index, end: base + cm.index + cm[0].length, attrs: cm[1], inner,
      });
    }
  }
  return cells;
}

/** One sheet's cells as text: a row per line, cells joined by CELL_SEPARATOR. */
function sheetText(cells) {
  const filled = cells.filter((x) => x.text !== '');
  if (filled.length === 0) return '';
  const minC = Math.min(...cells.map((x) => x.c));
  const maxC = Math.max(...filled.map((x) => x.c));
  const byRow = new Map();
  for (const x of filled) {
    if (!byRow.has(x.r)) byRow.set(x.r, new Map());
    byRow.get(x.r).set(x.c, x.text);
  }
  const lines = [];
  let prev = null;
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    // A blank row between two tables stays a blank line, so each table's
    // first row is read as its own header. Dropping it fused the tables (#52).
    if (prev !== null && r > prev + 1) lines.push('');
    prev = r;
    const row = byRow.get(r);
    const fields = [];
    // Empty cells stay as empty fields so every row keeps its columns.
    for (let c = minC; c <= maxC; c++) fields.push(row.get(c) || '');
    lines.push(fields.join(CELL_SEPARATOR));
  }
  return lines.join('\n');
}

/** Is this a workbook this module reads itself (an OOXML package with XML parts)? */
function isOoxmlWorkbook(zip) {
  return Boolean(zip.file('xl/workbook.xml'));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read a workbook: its cells, plus every other part that carries text
 * (comments, formulas, sheet names, drawings, properties, link targets...).
 * @param {Buffer} buf
 * @returns {Promise<{ text: string, cells: object, unscanned: string[] }>}
 */
async function readXlsxBuffer(buf) {
  // An encrypted workbook is a compound file too, but not a legacy .xls (#53).
  if (pkg.isEncryptedOffice(buf)) throw new pkg.PackageError(pkg.ENCRYPTED_MESSAGE);
  if (!isZip(buf)) return legacy.readXlsxBuffer(buf);
  const zip = await JSZip.loadAsync(buf);
  if (!isOoxmlWorkbook(zip)) return legacy.readXlsxBuffer(buf); // .xlsb: binary parts
  const sstFile = zip.file('xl/sharedStrings.xml');
  const sst = sstFile ? sharedStrings(await sstFile.async('string')) : [];
  const view = await numberView(zip);
  const cells = {};
  const texts = [];
  for (const sheet of await sheetsOf(zip)) {
    const file = zip.file(sheet.path);
    if (!file) continue;
    const list = cellsOf(await file.async('string'), sst, view);
    cells[sheet.name] = {};
    for (const x of list) if (x.text !== '') cells[sheet.name][encodeRef(x.r, x.c)] = x.text;
    const t = sheetText(list);
    if (t) texts.push(t);
  }
  const rest = await pkg.readPackage(buf, 'xlsx');
  // A blank line between sheets, so each sheet's first row is its own header.
  const text = [texts.join('\n\n'), rest.text].filter(Boolean).join('\n\n');
  return { text, cells, unscanned: rest.unscanned };
}

async function readXlsx(filePath) {
  return readXlsxBuffer(fs.readFileSync(filePath));
}

// ---------------------------------------------------------------------------
// Mask
// ---------------------------------------------------------------------------

function makeMasker(replMap) {
  // Longest first, so a short value that is a substring of a longer one cannot
  // claim the text before the longer match fires; one pass for all keys (#53).
  const matcher = matcherFor(replMap, { keys: orderKeys(replMap) });
  return (s) => {
    if (typeof s !== 'string' || !s) return s;
    return matcher.replace(s, replMap);
  };
}

/** Replace every match of `rx` in `xml` whose (decoded) text changes under `fn`. */
function rewriteTexts(xml, rx, fn) {
  return xml.replace(rx, (whole, open, body, close) => {
    const text = ooxml.decodeXml(body);
    const next = fn(text);
    return next === text ? whole : `${open}${ooxml.encodeXml(next)}${close}`;
  });
}

/**
 * Rename every sheet whose name holds a detected value, and point every
 * reference at the new name: formulas, defined names, chart series and pivot
 * sources. A token like `[EMAIL_1]` is not a legal sheet name (Excel forbids
 * `[ ] : * ? / \` and more than 31 characters), so the replacement is made
 * legal and unique first.
 */
async function renameSheets(zip, mask) {
  const wbFile = zip.file('xl/workbook.xml');
  let wbXml = await wbFile.async('string');
  const names = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => attrsOf(m[0]).name).filter(Boolean);
  const taken = new Set(names);
  const renames = new Map();
  names.forEach((name, i) => {
    const masked = mask(name);
    if (masked === name) return;
    const base = masked.replace(SHEET_NAME_ILLEGAL, '').replace(/^'+|'+$/g, '').trim().slice(0, SHEET_NAME_MAX) || `Sheet${i + 1}`;
    let next = base;
    for (let n = 2; taken.has(next); n++) next = `${base.slice(0, SHEET_NAME_MAX - 4)} (${n})`;
    taken.add(next);
    renames.set(name, next);
  });
  if (renames.size === 0) return renames;

  const retargetAll = (s) => retarget(s, renames);
  wbXml = wbXml.replace(/<sheet\b[^>]*>/g, (tag) => {
    const a = attrsOf(tag);
    if (!renames.has(a.name)) return tag;
    return tag.replace(/\bname\s*=\s*("[^"]*"|'[^']*')/, `name="${ooxml.encodeAttr(renames.get(a.name))}"`);
  });
  wbXml = rewriteTexts(wbXml, /(<definedName\b[^>]*>)([^<]*)(<\/definedName>)/g, retargetAll);
  zip.file('xl/workbook.xml', wbXml);

  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || !/^xl\/.*\.xml$/.test(name)) continue;
    let xml = await file.async('string');
    const before = xml;
    if (/^xl\/worksheets\//.test(name)) xml = rewriteTexts(xml, /(<f\b[^>]*>)([^<]*)(<\/f>)/g, retargetAll);
    if (/^xl\/charts\//.test(name)) xml = rewriteTexts(xml, /(<c:f>)([^<]*)(<\/c:f>)/g, retargetAll);
    if (/^xl\/pivotCache\//.test(name)) {
      xml = xml.replace(/(<worksheetSource\b[^>]*\bsheet\s*=\s*")([^"]*)(")/g, (w, a, s, b) => {
        const n = ooxml.decodeXml(s);
        return renames.has(n) ? `${a}${ooxml.encodeAttr(renames.get(n))}${b}` : w;
      });
    }
    if (xml !== before) zip.file(name, xml);
  }
  return renames;
}

/** Mask one worksheet's cells in place. Shared strings are masked separately. */
function maskSheet(xml, sst, mask, view) {
  const edits = [];
  for (const cell of cellsOf(xml, sst, view)) {
    if (cell.type === 's' || cell.type === 'b' || cell.type === 'e' || !cell.text) continue;
    const masked = mask(cell.text);
    if (masked === cell.text) continue;
    let inner;
    let type;
    if (cell.type === 'str' || cell.hasFormula) {
      // A formula's string result.
      type = 'str';
      inner = cell.inner.replace(/<v>[^<]*<\/v>/, '').replace(/<is>[\s\S]*?<\/is>/, '') + `<v>${ooxml.encodeXml(masked)}</v>`;
    } else {
      // A number, date or inline string becomes an inline string: a token in
      // a numeric cell would not read back as a number. A masked date is
      // replaced as the date it showed, never written back as its serial.
      type = 'inlineStr';
      inner = cell.inner.replace(/<v>[^<]*<\/v>/, '').replace(/<is>[\s\S]*?<\/is>/, '') + `<is>${tNode(masked)}</is>`;
    }
    const attrs = `${cell.attrs.replace(/\s+t\s*=\s*("[^"]*"|'[^']*')/, '')} t="${type}"`;
    edits.push({ start: cell.start, end: cell.end, text: `<c${attrs}>${inner}</c>` });
  }
  let out = '';
  let at = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    out += xml.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + xml.slice(at);
}

/**
 * Mask a workbook held in memory and return the new file, verified.
 * @param {Buffer} buf
 * @param {object} replMap
 * @param {string} [bookType] - 'xlsx' / 'xlsm' keep the package; 'biff8' / 'xlsb' need SheetJS
 * @returns {Promise<Buffer>}
 * @throws {pkg.MaskVerificationError}
 */
async function maskXlsxBuffer(buf, replMap, bookType = 'xlsx') {
  if (pkg.isEncryptedOffice(buf)) throw new pkg.PackageError(pkg.ENCRYPTED_MESSAGE);
  if (!isZip(buf) || (bookType !== 'xlsx' && bookType !== 'xlsm')) return legacy.maskXlsxBuffer(buf, replMap, bookType);
  const zip = await JSZip.loadAsync(buf);
  if (!isOoxmlWorkbook(zip)) return legacy.maskXlsxBuffer(buf, replMap, bookType);

  const mask = makeMasker(replMap);
  // Sheet names first, while formulas still hold the original names.
  await renameSheets(zip, mask);

  const sstFile = zip.file('xl/sharedStrings.xml');
  let sst = [];
  if (sstFile) {
    const xml = await sstFile.async('string');
    sst = sharedStrings(xml);
    let out = '';
    let at = 0;
    for (const item of sst) {
      const masked = mask(item.text);
      if (masked === item.text) continue;
      // Rich-text runs and phonetic hints of a masked string still held the original.
      out += xml.slice(at, item.start) + `<si>${tNode(masked)}</si>`;
      at = item.end;
    }
    if (at > 0) zip.file('xl/sharedStrings.xml', out + xml.slice(at));
  }
  const view = await numberView(zip);
  for (const sheet of await sheetsOf(zip)) {
    const file = zip.file(sheet.path);
    if (!file) continue;
    const xml = await file.async('string');
    const out = maskSheet(xml, sst, mask, view);
    if (out !== xml) zip.file(sheet.path, out);
  }

  // Everything else -- comments, formulas, drawings, charts, properties,
  // embedded files -- as for .docx and .pptx, then the package is verified.
  await pkg.maskZip(zip, 'xlsx', replMap);
  const out = await pkg.finishPackage(zip, 'xlsx', replMap);

  // And the cells, read back the way the scanner reads them.
  const { text } = await readXlsxBuffer(out);
  const checkKeys = orderKeys(replMap).filter((k) => !String(replMap[k]).includes(k));
  const left = [...matcherFor(replMap, { keys: checkKeys }).keysIn(text)];
  if (left.length > 0) throw new pkg.MaskVerificationError([{ part: 'workbook cells', count: left.length }]);
  return out;
}

const BOOK_TYPES = { xlsx: 'xlsx', xlsm: 'xlsm', xltx: 'xlsx', xltm: 'xlsm', xlsb: 'xlsb', xls: 'biff8' };

async function writeXlsx(filePath, outputPath, data, replMap) {
  const ext = path.extname(outputPath).slice(1).toLowerCase();
  const out = await maskXlsxBuffer(fs.readFileSync(filePath), replMap, BOOK_TYPES[ext] || 'xlsx');
  writeFileSafe(outputPath, out);
}

module.exports = {
  readXlsx, writeXlsx, readXlsxBuffer, maskXlsxBuffer, dateKindOfCode, serialToText,
};
