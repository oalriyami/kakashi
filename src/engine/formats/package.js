/**
 * Whole-package coverage for .docx, .pptx and .xlsx.
 *
 * An Office file is a zip of XML parts, and the body text is only some of them.
 * Kakashi used to read `word/document.xml`, headers, footers and comments (or
 * slides and notes), and nothing else. Everything below was left out of the
 * scan AND out of the masked copy, so `scan` reported 0 findings and Guardian
 * released the original file unchanged while it still held credentials, IDs and
 * emails:
 *
 *   - footnotes, endnotes, tracked deletions, field codes, alt text, the
 *     author of every comment and tracked change (Word);
 *   - slide masters and layouts (their text renders on EVERY slide), charts,
 *     SmartArt, legacy and modern comments and their authors (PowerPoint);
 *   - cell comments, formulas, sheet names, defined names, drawings, charts,
 *     pivot caches, data connections (Excel);
 *   - document properties, custom properties, customXml data, the `mailto:` or
 *     `https://user:pass@…` target of every external link (all three);
 *   - Office files embedded in Office files (a chart's data workbook).
 *
 * Each package type has a COVERAGE TABLE: which parts carry human text, and
 * where in the part it sits (runs, element content, attribute values). The same
 * table drives reading, masking and verification, so the three cannot drift.
 *
 * Masking is then VERIFIED before anything is written: the masked package is
 * reloaded from its own bytes, and if any value the mask set out to replace is
 * still present, the write fails and nothing lands on disk. A value that only
 * the verifier would have caught (split across paragraphs, say) is reported as
 * an error rather than as "1 replacement made".
 *
 * What cannot be read at all -- an OLE object, an ActiveX control, a macro
 * project -- is listed in `unscanned`, so callers can refuse to call the file
 * clean. Guardian requires human approval before releasing such a file.
 */

const JSZip = require('jszip');
const ooxml = require('./ooxml');
const { matcherFor, orderKeys: orderKeysOf } = require('./replace');

const { WORD, DRAWING } = ooxml;

// Word/PowerPoint/Excel comments store rich text as `<t>` runs inside `<si>` or
// `<comment>`, with no line-break elements of their own.
const SPREADSHEET_COMMENT = { paraTag: 'comment', textTags: ['t'], marks: [] };
const SHARED_STRING = { paraTag: 'si', textTags: ['t'], marks: [] };

/**
 * Custom property names that hold machine identifiers, not content. SharePoint
 * stamps `ContentTypeId` (a 40+ character hex string that reads as a secret)
 * and sensitivity-label GUIDs onto every document it touches.
 */
const SYSTEM_CUSTOM_PROPERTY = /^(ContentTypeId|MSIP_Label_|MediaService|_)/;

function customPropertiesText(xml) {
  const lines = [];
  // Tag scans stop at `<` and a property's body at the next <property>, so an
  // unclosed one cannot make every later match read to the end (#38).
  const rx = /<property\b[^<>]*?\bname\s*=\s*"([^"]*)"[^<>]*>((?:(?!<\/?property\b)[\s\S])*)<\/property>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    if (SYSTEM_CUSTOM_PROPERTY.test(m[1])) continue;
    for (const v of ooxml.findElements(m[2], ['vt:lpwstr', 'vt:lpstr', 'vt:bstr'])) {
      if (v.text.trim()) lines.push(v.text);
    }
  }
  return lines.join('\n');
}

/** Every non-blank text node, for free-form data parts (customXml). */
function allTextNodes(xml) {
  const out = [];
  const rx = />([^<]+)</g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const text = ooxml.decodeXml(m[1]);
    if (text.trim()) out.push({ start: m.index + 1, end: m.index + 1 + m[1].length, text });
  }
  return out;
}

/** Parts every Office package can carry. */
const COMMON_RULES = [
  {
    // Author, last editor, title, subject, keywords. Created/modified dates are
    // deliberately excluded: they are timestamps, and rewriting one with a
    // token makes the package invalid.
    type: /core-properties\+xml$/,
    match: /^docProps\/core\.xml$/,
    elements: ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'dc:description',
      'cp:keywords', 'cp:category', 'cp:contentStatus', 'dc:identifier'],
  },
  {
    // TitlesOfParts repeats sheet names and slide titles. It is rewritten so a
    // masked name does not survive here, but not read: the originals are
    // scanned where they actually live.
    type: /extended-properties\+xml$/,
    match: /^docProps\/app\.xml$/,
    elements: ['Company', 'Manager', 'HyperlinkBase'],
    maskOnlyElements: ['vt:lpstr', 'vt:lpwstr'],
  },
  {
    type: /custom-properties\+xml$/,
    match: /^docProps\/custom\.xml$/,
    maskOnlyElements: ['vt:lpwstr', 'vt:lpstr', 'vt:bstr'],
    extract: customPropertiesText,
  },
  { match: /^customXml\/item\d+\.xml$/, textNodes: true },
  {
    // Internal targets are part names (`media/image1.png`); only external ones
    // can carry an address.
    type: /relationships\+xml$/,
    match: /(^|\/)_rels\/[^/]*\.rels$/,
    attrs: [{ el: 'Relationship', attr: 'Target', when: /TargetMode\s*=\s*["']External["']/ }],
  },
];

const ALT_TEXT = [{ attr: 'descr' }, { attr: 'title' }];

/** Charts and SmartArt, in whichever package they appear. */
const CHART_RULE = (prefix) => ({
  type: /drawingml\.(chart|diagramData)\+xml$|drawingml\.diagramDrawing\+xml$/,
  match: new RegExp(`^${prefix}/(charts/chart|diagrams/(data|drawing))\\d+\\.xml$`),
  runs: [DRAWING],
  elements: ['c:v'],
  attrs: ALT_TEXT,
});

const DOCX_RULES = [
  {
    type: /wordprocessingml\.(document\.main|template\.main|document\.glossary|header|footer|footnotes|endnotes|comments)\+xml$|ms-word\.(document|template)\.macroEnabled(Template)?\.main\+xml$/,
    match: /^word\/(document|comments|footnotes|endnotes|header\d*|footer\d*)\.xml$|^word\/glossary\/document\.xml$/,
    runs: [WORD],
    attrs: [
      ...ALT_TEXT,
      { attr: 'alt' },           // VML shapes
      { attr: 'w:author' },      // comments, tracked insertions and deletions
      { attr: 'w:initials' },
      { attr: 'w:instr' },       // simple fields, e.g. HYPERLINK "mailto:…"
      { attr: 'w:tooltip' },     // hyperlink screen tips
    ],
  },
  CHART_RULE('word'),
  { type: /\.people\+xml$/, match: /^word\/people\.xml$/, attrs: [{ attr: 'w15:author' }, { attr: 'w15:userId' }] },
  { type: /wordprocessingml\.settings\+xml$/, match: /^word\/settings\.xml$/, attrs: [{ el: 'w:docVar', attr: 'w:val' }] },
  ...COMMON_RULES,
];

/**
 * Placeholder types whose text on a master or layout is only a PROMPT ("Click
 * to edit Master title style", LibreOffice's "Second Outline Level"). A prompt
 * never renders on a slide, and read as prose it is a stream of Title Case
 * false positives on every deck. Footer, date and slide-number placeholders
 * are not in this list: their text does render.
 */
const PROMPT_PLACEHOLDER = /<p:ph\b(?![^<>]*\btype\s*=\s*"(?:dt|ftr|sldNum|hdr)")[^<>]*>/;

function withoutPrompts(xml) {
  return xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (sp) => (PROMPT_PLACEHOLDER.test(sp) ? '' : sp));
}

const PPTX_RULES = [
  {
    type: /presentationml\.(slide|notesSlide)\+xml$|ms-powerpoint\.comments\+xml$/,
    match: /^ppt\/(slides\/slide|notesSlides\/notesSlide|comments\/modernComment)[^/]*\.xml$/,
    runs: [DRAWING],
    attrs: [...ALT_TEXT, { attr: 'tooltip' }],
  },
  {
    // Masters and layouts render on every slide that uses them: a footer or a
    // text box placed there appears throughout the deck.
    type: /presentationml\.(slideMaster|slideLayout|notesMaster|handoutMaster)\+xml$/,
    match: /^ppt\/(slideMasters\/slideMaster|slideLayouts\/slideLayout|notesMasters\/notesMaster|handoutMasters\/handoutMaster)[^/]*\.xml$/,
    runs: [DRAWING],
    attrs: [...ALT_TEXT, { attr: 'tooltip' }],
    readFilter: withoutPrompts,
  },
  CHART_RULE('ppt'),
  { type: /presentationml\.comments\+xml$/, match: /^ppt\/comments\/comment\d+\.xml$/, elements: ['p:text'] },
  {
    type: /presentationml\.commentAuthors\+xml$/,
    match: /^ppt\/commentAuthors\.xml$/,     attrs: [{ el: 'p:cmAuthor', attr: 'name' }, { el: 'p:cmAuthor', attr: 'initials' }],
  },
  {
    type: /ms-powerpoint\.authors\+xml$/,
    match: /^ppt\/authors\.xml$/,
    attrs: [{ el: 'p188:author', attr: 'name' }, { el: 'p188:author', attr: 'initials' }, { el: 'p188:author', attr: 'userId' }],
  },
  ...COMMON_RULES,
];

/**
 * Excel. Cell values and sheet names are read and written by ./xlsx.js; these
 * rules cover everything around them. The `read: false, mask: false` rule and
 * the worksheet's `verifyElements` exist so the verifier also checks the cells.
 */
const XLSX_RULES = [
  { type: /spreadsheetml\.comments\+xml$/, match: /^xl\/comments(\/comment)?\d+\.xml$/, runs: [SPREADSHEET_COMMENT], elements: ['author'] },
  { type: /ms-excel\.threadedcomments\+xml$/i, match: /^xl\/threadedComments\/threadedComment\d+\.xml$/, elements: ['text'] },
  {
    type: /ms-excel\.person\+xml$/,
    match: /^xl\/persons\/person\.xml$/,
    attrs: [{ el: 'person', attr: 'displayName' }, { el: 'person', attr: 'userId' }],
  },
  // A sheet name is rewritten in the workbook model (xlsx.js), where every
  // formula that refers to it can be updated too; here it is only read.
  {
    type: /spreadsheetml\.(sheet|template)\.main\+xml$|ms-excel\.(sheet|template)\.macroEnabled(\.main)?\+xml$/,
    match: /^xl\/workbook\.xml$/,
    elements: ['definedName'], readOnlyAttrs: [{ el: 'sheet', attr: 'name' }],
  },
  {
    type: /spreadsheetml\.worksheet\+xml$/,
    match: /^xl\/worksheets\/sheet\d+\.xml$/,
    elements: ['f', 'oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter', 'formula1', 'formula2'],
    attrs: [{ el: 'hyperlink', attr: 'tooltip' }, { el: 'hyperlink', attr: 'display' }],
    verifyElements: ['v', 't'],
  },
  { type: /officedocument\.drawing\+xml$/, match: /^xl\/drawings\/drawing\d+\.xml$/, runs: [DRAWING], attrs: ALT_TEXT },
  CHART_RULE('xl'),
  {
    type: /spreadsheetml\.pivotCache(Definition|Records)\+xml$/,
    match: /^xl\/pivotCache\/pivotCache(Definition|Records)\d+\.xml$/,
    attrs: [{ el: 's', attr: 'v' }],
  },
  {
    type: /spreadsheetml\.connections\+xml$/,
    match: /^xl\/connections\.xml$/,
    attrs: [{ el: 'dbPr', attr: 'connection' }, { el: 'dbPr', attr: 'command' }, { el: 'webPr', attr: 'url' }],
  },
  { type: /spreadsheetml\.externalLink\+xml$/, match: /^xl\/externalLinks\/externalLink\d+\.xml$/, elements: ['v'] },
  { type: /spreadsheetml\.sharedStrings\+xml$/, match: /^xl\/sharedStrings\.xml$/, runs: [SHARED_STRING], read: false, mask: false },
  ...COMMON_RULES,
];

const RULES = { docx: DOCX_RULES, pptx: PPTX_RULES, xlsx: XLSX_RULES };

/** Office packages that can be opened and handled recursively when embedded. */
const EMBEDDED_KINDS = {
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  pptx: 'pptx', pptm: 'pptx', potx: 'pptx', ppsx: 'pptx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
};

/** Binary parts that can hold text Kakashi cannot read. */
const OPAQUE_PART = /(^|\/)(embeddings|activeX)\/|(^|\/)vbaProject\.bin$/;

/** A preview image of the first page or slide: it shows the original text. */
const THUMBNAIL_PART = /^docProps\/thumbnail\.[a-z]+$/i;

/**
 * The rule for one part. Part names are only a convention -- openpyxl writes a
 * comment part as `xl/comments/comment1.xml`, Excel as `xl/comments1.xml` -- so
 * the content type declared in `[Content_Types].xml` decides first, and the
 * conventional name is the fallback.
 */
function ruleFor(rules, name, types) {
  const type = types ? types.of(name) : null;
  if (type) {
    const byType = rules.find((r) => r.type && r.type.test(type));
    if (byType) return byType;
  }
  return rules.find((r) => r.match.test(name)) || null;
}

/** Parse `[Content_Types].xml` into a part-name -> content-type lookup. */
async function contentTypes(zip) {
  const file = zip.file('[Content_Types].xml');
  const overrides = new Map();
  const defaults = new Map();
  if (file) {
    const xml = await file.async('string');
    for (const m of xml.matchAll(/<Override\b[^<>]*>/g)) {
      const part = /PartName\s*=\s*"([^"]*)"/.exec(m[0]);
      const type = /ContentType\s*=\s*"([^"]*)"/.exec(m[0]);
      if (part && type) overrides.set(decodeURIComponent(part[1]).replace(/^\//, '').toLowerCase(), type[1]);
    }
    for (const m of xml.matchAll(/<Default\b[^<>]*>/g)) {
      const ext = /Extension\s*=\s*"([^"]*)"/.exec(m[0]);
      const type = /ContentType\s*=\s*"([^"]*)"/.exec(m[0]);
      if (ext && type) defaults.set(ext[1].toLowerCase(), type[1]);
    }
  }
  return {
    of(name) {
      return overrides.get(name.toLowerCase()) || defaults.get(name.split('.').pop().toLowerCase()) || null;
    },
  };
}

function embeddedKind(name) {
  if (!/(^|\/)embeddings\//.test(name)) return null;
  const ext = name.split('.').pop().toLowerCase();
  return EMBEDDED_KINDS[ext] || null;
}

/** Text of one part for detection. */
function readText(source, rule) {
  if (rule.read === false) return '';
  const xml = rule.readFilter ? rule.readFilter(source) : source;
  const parts = [];
  if (rule.extract) parts.push(rule.extract(xml));
  if (rule.textNodes) parts.push(allTextNodes(xml).map((v) => v.text).join('\n'));
  parts.push(ooxml.extractPart(xml, { ...rule, attrs: [...(rule.attrs || []), ...(rule.readOnlyAttrs || [])] }));
  return parts.filter(Boolean).join('\n');
}

/** Everything the verifier holds against a part: what was read, plus what was only masked. */
function verifyText(xml, rule) {
  const lines = [ooxml.extractPart(xml, {
    runs: rule.runs,
    elements: [...(rule.elements || []), ...(rule.maskOnlyElements || []), ...(rule.verifyElements || [])],
    attrs: [...(rule.attrs || []), ...(rule.readOnlyAttrs || [])],
  })];
  if (rule.textNodes) lines.push(allTextNodes(xml).map((v) => v.text).join('\n'));
  return lines.join('\n');
}

function maskText(xml, replMap, rule) {
  if (rule.mask === false) return xml;
  let out = ooxml.maskPart(xml, replMap, rule);
  if (rule.textNodes) {
    const matcher = matcherFor(replMap, { keys: orderKeys(replMap) });
    for (const v of allTextNodes(out).sort((a, b) => b.start - a.start)) {
      const text = matcher.replace(v.text, replMap);
      if (text !== v.text) out = out.slice(0, v.start) + ooxml.encodeXml(text) + out.slice(v.end);
    }
  }
  return out;
}

function orderKeys(replMap) {
  return orderKeysOf(replMap);
}

// ---------------------------------------------------------------------------
// Embedded packages. The xlsx handler lives in ./xlsx.js (it reads the cells
// itself); required lazily because it requires this module too.
// ---------------------------------------------------------------------------

async function readEmbedded(buf, kind) {
  if (kind === 'xlsx') return require('./xlsx').readXlsxBuffer(buf);
  return readPackage(buf, kind);
}

async function maskEmbedded(buf, kind, replMap) {
  if (kind === 'xlsx') return require('./xlsx').maskXlsxBuffer(buf, replMap, 'xlsx');
  return maskPackage(buf, kind, replMap);
}

// ---------------------------------------------------------------------------
// Opening a package. A password-protected Office file is not a zip at all but
// an OLE compound file holding an `EncryptedPackage` stream, and JSZip's
// "is this a zip file?" said nothing useful about it (#53).
// ---------------------------------------------------------------------------

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENCRYPTED_STREAM = Buffer.from('EncryptedPackage', 'utf16le');

/** A file the reader cannot open, said in terms the user can act on. */
class PackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageError';
  }
}

/** Is this an OLE compound file (a legacy Office file, or an encrypted one)? */
function isCompoundFile(buf) {
  return buf.length >= CFB_MAGIC.length && buf.subarray(0, CFB_MAGIC.length).equals(CFB_MAGIC);
}

/** Is this a password-protected (encrypted) Office file? */
function isEncryptedOffice(buf) {
  return isCompoundFile(buf) && buf.indexOf(ENCRYPTED_STREAM) !== -1;
}

const ENCRYPTED_MESSAGE = 'the file is password-protected (encrypted), so Kakashi cannot read it. '
  + 'Remove the password (File > Info > Protect > Encrypt with Password), save, and run Kakashi again.';

/**
 * Open a .docx / .pptx / .xlsx package, or say plainly why it cannot be.
 * @param {Buffer} buf
 * @param {'docx'|'pptx'|'xlsx'} kind
 * @returns {Promise<JSZip>}
 * @throws {PackageError}
 */
async function openPackage(buf, kind) {
  if (isEncryptedOffice(buf)) throw new PackageError(ENCRYPTED_MESSAGE);
  if (isCompoundFile(buf)) {
    const legacy = { docx: '.doc', pptx: '.ppt', xlsx: '.xls' }[kind];
    throw new PackageError(`the file is a legacy binary Office file (${legacy}), not a .${kind} package. Save it as .${kind} and run Kakashi again.`);
  }
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new PackageError(`the file is not a .${kind} package: it is not a zip file, whatever its name says`);
  }
  try {
    return await JSZip.loadAsync(buf);
  } catch (err) {
    throw new PackageError(`the file is not a valid .${kind} package: the zip is damaged or incomplete (${err.message.split(':')[0].trim()})`);
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Read every covered part of a package.
 * @param {Buffer} buf
 * @param {'docx'|'pptx'|'xlsx'} kind
 * @returns {Promise<{ text: string, unscanned: string[] }>}
 */
async function readPackage(buf, kind) {
  const zip = await openPackage(buf, kind);
  const rules = RULES[kind];
  const types = await contentTypes(zip);
  const texts = [];
  const unscanned = [];

  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const rule = ruleFor(rules, name, types);
    if (rule) {
      const t = readText(await file.async('string'), rule);
      if (t) texts.push(t);
      continue;
    }
    const sub = embeddedKind(name);
    if (sub) {
      try {
        const inner = await readEmbedded(await file.async('nodebuffer'), sub);
        if (inner.text) texts.push(inner.text);
        for (const u of inner.unscanned || []) unscanned.push(`${name}!/${u}`);
      } catch (_) {
        unscanned.push(name);
      }
      continue;
    }
    if (OPAQUE_PART.test(name)) unscanned.push(name);
  }
  return { text: texts.join('\n'), unscanned };
}

/**
 * Apply a replacement map to every covered part of an already-open package, in
 * place. Embedded Office files are masked recursively; the first-page
 * thumbnail is removed.
 * @param {JSZip} zip
 */
async function maskZip(zip, kind, replMap) {
  const rules = RULES[kind];
  const types = await contentTypes(zip);
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const rule = ruleFor(rules, name, types);
    if (rule) {
      const xml = await file.async('string');
      const out = maskText(xml, replMap, rule);
      if (out !== xml) zip.file(name, out);
      continue;
    }
    const sub = embeddedKind(name);
    if (sub) zip.file(name, await maskEmbedded(await file.async('nodebuffer'), sub, replMap));
  }
  await dropThumbnail(zip);
}

/**
 * The first-page thumbnail is a picture of the original, unmasked text. It is
 * optional, so removing it (and its relationship and content-type entry) keeps
 * the package valid.
 */
async function dropThumbnail(zip) {
  const thumbs = Object.keys(zip.files).filter((n) => THUMBNAIL_PART.test(n));
  if (thumbs.length === 0) return;
  for (const name of thumbs) zip.remove(name);
  const rels = zip.file('_rels/.rels');
  if (rels) {
    const xml = await rels.async('string');
    zip.file('_rels/.rels', xml.replace(/<Relationship\b[^<>]*Target="\/?docProps\/thumbnail\.[a-z]+"[^<>]*\/>/gi, ''));
  }
  const types = zip.file('[Content_Types].xml');
  if (types) {
    const xml = await types.async('string');
    zip.file('[Content_Types].xml', xml.replace(/<Override\b[^<>]*PartName="\/docProps\/thumbnail\.[a-z]+"[^<>]*\/>/gi, ''));
  }
}

/**
 * A value is "strong" when it is safe to look for anywhere in the package, not
 * only where the coverage table says text lives: nothing structural in an
 * Office file (a style name, a timestamp, a font) contains an `@` or a
 * 12-character run with digits. Names and short dates are only checked in the
 * covered text, because "Calibri Light" or "2026-09-27" can legitimately
 * appear in a theme or a timestamp.
 */
function isStrong(key) {
  return key.includes('@') || (key.length >= 12 && /\d/.test(key));
}

/**
 * Every value from the replacement map that is still present.
 * @param {JSZip} zip
 * @returns {Promise<Array<{ part: string, count: number }>>}
 */
async function findSurvivors(zip, kind, replMap, prefix = '') {
  const rules = RULES[kind];
  // A replacement that contains its own original (a synthetic value that
  // happens to equal the real one) cannot be told apart from a miss by looking
  // at the output. That is a property of the fake, not a failure to write it:
  // Guardian's verifier re-scans the artifact and escalates to a token, and
  // collisions in fake mode are the fake generator's to prevent.
  const keys = orderKeys(replMap).filter((k) => !String(replMap[k]).includes(k));
  const strong = keys.filter(isStrong);
  // One pass per part for all keys (#53), not one per key.
  const keyMatcher = matcherFor(replMap, { keys });
  const strongMatcher = matcherFor(replMap, { keys: strong, plain: true });
  const types = await contentTypes(zip);
  const survivors = [];

  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const sub = embeddedKind(name);
    if (sub) {
      try {
        const inner = await JSZip.loadAsync(await file.async('nodebuffer'));
        survivors.push(...await findSurvivors(inner, sub, replMap, `${prefix}${name}!/`));
      } catch (_) { /* not a package after all: listed as unscanned on read */ }
      continue;
    }
    if (!/\.(xml|rels|vml)$/i.test(name)) continue;
    const xml = await file.async('string');
    const found = new Set();
    const rule = ruleFor(rules, name, types);
    if (rule) {
      const text = verifyText(xml, rule);
      for (const key of keyMatcher.keysIn(text)) found.add(key);
    }
    const raw = ooxml.decodeXml(xml);
    for (const key of strongMatcher.keysIn(raw)) found.add(key);
    if (found.size > 0) survivors.push({ part: `${prefix}${name}`, count: found.size });
  }
  return survivors;
}

class MaskVerificationError extends Error {
  constructor(survivors) {
    const total = survivors.reduce((n, s) => n + s.count, 0);
    const where = survivors.map((s) => s.part).join(', ');
    super(`masked output still contains ${total} detected value(s) in ${where}; nothing was written`);
    this.name = 'MaskVerificationError';
    this.survivors = survivors;
  }
}

/** Serialise a package, reload it from those bytes, and refuse if anything survived. */
async function finishPackage(zip, kind, replMap) {
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const survivors = await findSurvivors(await JSZip.loadAsync(out), kind, replMap);
  if (survivors.length > 0) throw new MaskVerificationError(survivors);

  // A value the detector found ACROSS two parts -- a key that starts in the
  // body and ends in a footnote -- is in no single part, so the per-part check
  // above cannot see what is left of it. Read the package the way the scanner
  // does and look again.
  const { text } = await readPackage(out, kind);
  const acrossKeys = orderKeys(replMap).filter((k) => !String(replMap[k]).includes(k));
  const across = [...matcherFor(replMap, { keys: acrossKeys }).keysIn(text)];
  if (across.length > 0) throw new MaskVerificationError([{ part: 'text spanning several parts', count: across.length }]);
  return out;
}

/**
 * Mask a whole .docx or .pptx and verify the result.
 * @param {Buffer} buf
 * @param {'docx'|'pptx'} kind
 * @returns {Promise<Buffer>}
 * @throws {MaskVerificationError}
 */
async function maskPackage(buf, kind, replMap) {
  const zip = await openPackage(buf, kind);
  await maskZip(zip, kind, replMap);
  return finishPackage(zip, kind, replMap);
}

module.exports = {
  RULES,
  DOCX_RULES,
  PPTX_RULES,
  XLSX_RULES,
  readPackage,
  maskPackage,
  maskZip,
  finishPackage,
  findSurvivors,
  MaskVerificationError,
  PackageError,
  openPackage,
  isEncryptedOffice,
  ENCRYPTED_MESSAGE,
  isStrong,
};
