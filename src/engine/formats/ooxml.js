/**
 * Shared OOXML run handling for .docx, .pptx and the text-bearing parts of .xlsx.
 *
 * Word and DrawingML store a paragraph's text as a SEQUENCE OF RUNS -- `<w:t>`
 * inside `<w:p>` for Word, `<a:t>` inside `<a:p>` for PowerPoint, charts and
 * shapes -- and both split those runs for reasons that have nothing to do with
 * where a value starts or ends: a spellcheck mark, a language attribute, a
 * revision id, one bolded character. A single email address routinely lands in
 * the file as two or three runs.
 *
 * That makes the naive approach wrong in two ways at once, and this module
 * exists to fix both:
 *
 *   1. READING. Joining runs with a space (what this code used to do) inserts
 *      a separator that was never in the document. `sk-ant-` + `api03-...`
 *      became `sk-ant- api03-...`, which matches no credential pattern at all,
 *      so the scanner reported the file clean while a live key sat in it. Runs
 *      within one paragraph are now joined with NOTHING, which is what the
 *      format actually means -- real spaces are their own characters inside
 *      `<w:t xml:space="preserve"> </w:t>`. Paragraphs are still joined with a
 *      newline so unrelated blocks cannot fuse into a false positive.
 *
 *   2. WRITING. Literal substring replacement over the raw XML can only ever
 *      patch a value that sits inside ONE run, because a value spanning a run
 *      boundary has XML tags in the middle of it and never appears contiguously.
 *      Replacement here is OFFSET-BASED over the reassembled paragraph text, and
 *      the result is redistributed across the runs it covered: the run where the
 *      match begins receives the whole token, and the runs holding the rest of
 *      the match give up their share. Untouched runs keep their bytes exactly,
 *      so formatting elsewhere in the paragraph survives.
 *
 * Some characters are not text runs at all but ELEMENTS: a soft line break is
 * `<w:br/>` (or `<a:br/>`), a tab is `<w:tab/>`, a non-breaking hyphen is
 * `<w:noBreakHyphen/>`. Skipping them fused a signature block into one line --
 * `Rajesh Kumar` + break + `Mobile: +971…` read as `Rajesh KumarMobile: +971…`,
 * so the name, the phone and part of a card number were never detected, and a
 * token could swallow the label that followed. They are now READ-ONLY runs:
 * they contribute their character to the paragraph text, so offsets line up
 * with what a reader sees, and the writer never rewrites them.
 *
 * Entities are decoded on read and re-encoded on write, so a value containing
 * `&` is matched as `&` rather than as `&amp;`.
 */

const { occurrences, replaceOccurrences } = require('./replace');

/**
 * Run grammar for WordprocessingML (document body, headers, footers, notes,
 * comments, text boxes).
 *
 * `w:delText` is text removed under Track Changes and `w:instrText` is a field
 * code (a HYPERLINK field holds its `mailto:` target there). Neither is visible,
 * both are stored in the file and travel with it, so both are read and masked.
 */
const WORD = {
  paraTag: 'w:p',
  textTags: ['w:t', 'w:delText', 'w:instrText'],
  marks: [
    // `<w:br w:type="page"/>` is a break too. `<w:tab w:val=… w:pos=…/>` is a
    // tab STOP definition inside paragraph properties, not a tab character,
    // which is why only the attribute-less form counts.
    { rx: '<w:(?:br|cr)\\b[^<>]*?/>', text: '\n' },
    { rx: '<w:tab\\s*/>', text: '\t' },
    { rx: '<w:ptab\\b[^<>]*?/>', text: '\t' },
    { rx: '<w:noBreakHyphen\\s*/>', text: '-' },
  ],
};

/**
 * Run grammar for DrawingML text (slides, masters, layouts, notes, charts,
 * SmartArt, shapes and text boxes in spreadsheets). A tab is a literal `\t`
 * inside `<a:t>`; a line break is `<a:br/>` or `<a:br><a:rPr/></a:br>`.
 */
const DRAWING = {
  paraTag: 'a:p',
  textTags: ['a:t'],
  marks: [{ rx: '<a:br\\b[^<>]*?>', text: '\n' }],
};

const ENTITIES = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
];

/** Decode the five predefined XML entities. `&amp;` must be decoded last. */
function decodeXml(s) {
  let out = s;
  for (let i = ENTITIES.length - 1; i >= 0; i--) out = out.replace(ENTITIES[i][0], ENTITIES[i][1]);
  return out.replace(/&amp;/g, '&');
}

/** Encode text for an XML text node. `&` must be encoded first. */
function encodeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Encode text for a double-quoted XML attribute value. */
function encodeAttr(s) {
  return encodeXml(s).replace(/"/g, '&quot;');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Accept both the full grammar and the legacy `{ textTag, paraTag }` shape.
 * @returns {{ paraTag: string, textTags: string[], marks: object[] }}
 */
function normalizeSpec(spec) {
  if (spec.textTags) return { marks: [], ...spec };
  // A bare `{ textTag: 'w:t' }` gets the marks of the dialect it names, so a
  // caller that predates the marks still reads breaks correctly.
  const base = spec.textTag.startsWith('w:') ? WORD : spec.textTag.startsWith('a:') ? DRAWING : { marks: [] };
  return { paraTag: spec.paraTag, textTags: [spec.textTag], marks: base.marks };
}

const tokenizerCache = new Map();

/** One regex that walks paragraphs, text runs and marks in document order. */
function tokenizer(spec) {
  const key = JSON.stringify(spec);
  if (tokenizerCache.has(key)) return tokenizerCache.get(key);
  const p = esc(spec.paraTag);
  const alts = [
    // `<w:p>` and `<w:p …>` open a paragraph; `<w:pPr>` must not, hence the
    // lookahead. A self-closing `<w:p/>` is empty and opens nothing.
    // Attribute scans stop at `<`, which XML never allows inside a tag: with
    // `[^>]*` every unclosed `<w:p ` read to the end of the part, and a part
    // full of them took quadratic time (#38).
    `(?<popen><${p}(?=[\\s>/])[^<>]*?(?<pself>/?)>)`,
    `(?<pclose></${p}>)`,
    // Self-closing `<w:t/>` holds no text and has no inner range.
    `<(?<ttag>${spec.textTags.map(esc).join('|')})(?<tattr>\\s[^<>]*?)?(?<!/)>(?<ttext>[^<]*)</\\k<ttag>>`,
    ...spec.marks.map((m, i) => `(?<m${i}>${m.rx})`),
  ];
  const rx = new RegExp(alts.join('|'), 'g');
  tokenizerCache.set(key, rx);
  return rx;
}

/**
 * Locate every text run in one XML part, tagged with the paragraph it belongs to.
 *
 * Paragraphs nest: a text box is a whole `<w:txbxContent>` of paragraphs inside
 * a run of the outer paragraph. A stack keeps the outer paragraph's runs after
 * the text box attributed to the outer paragraph, not to the text box.
 *
 * @param {string} xml
 * @param {object} spec - WORD, DRAWING, or `{ textTag, paraTag }`
 * @returns {Array<{ tagStart, openEnd, innerStart, innerEnd, attrs, text, tag, para, readonly }>}
 *   Marks (`readonly: true`) carry their character in `text` and have no range.
 */
function findRuns(xml, spec) {
  const s = normalizeSpec(spec);
  const rx = tokenizer(s);
  rx.lastIndex = 0;
  const runs = [];
  const stack = [];
  let nextPara = 0;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const g = m.groups;
    if (g.popen !== undefined) {
      if (!g.pself) stack.push(nextPara++);
      continue;
    }
    if (g.pclose !== undefined) {
      stack.pop();
      continue;
    }
    // -1 groups any stray run that sits outside a paragraph into its own bucket.
    const para = stack.length ? stack[stack.length - 1] : -1;
    if (g.ttag !== undefined) {
      const openEnd = m.index + 1 + g.ttag.length + (g.tattr ? g.tattr.length : 0) + 1;
      runs.push({
        tagStart: m.index,
        openEnd,
        innerStart: openEnd,
        innerEnd: openEnd + g.ttext.length,
        attrs: g.tattr || '',
        text: decodeXml(g.ttext),
        tag: g.ttag,
        para,
        readonly: false,
      });
      continue;
    }
    const markIdx = s.marks.findIndex((_, i) => g[`m${i}`] !== undefined);
    runs.push({ text: s.marks[markIdx].text, tag: null, para, readonly: true });
  }
  return runs;
}

/**
 * Group runs into paragraphs, in the order the paragraphs open.
 *
 * Where a paragraph switches between KINDS of text -- visible text, deleted
 * text, a field code -- a read-only newline is inserted between them. Those
 * runs are adjacent in the XML but not in any sense a reader would join: a
 * deleted "Ahmed" followed by an inserted "Sara" must not read as "AhmedSara",
 * and a field code's `"mailto:…"` must not fuse with the display text after it.
 * Runs of the SAME kind still join with nothing, so a value split by formatting
 * stays whole.
 */
function groupByParagraph(runs) {
  const byPara = new Map();
  for (const run of runs) {
    if (!byPara.has(run.para)) byPara.set(run.para, { para: run.para, runs: [], lastTag: null });
    const group = byPara.get(run.para);
    if (!run.readonly) {
      if (group.lastTag && group.lastTag !== run.tag) {
        group.runs.push({ text: '\n', tag: null, para: run.para, readonly: true });
      }
      group.lastTag = run.tag;
    }
    group.runs.push(run);
  }
  return [...byPara.values()].map(({ para, runs: r }) => ({ para, runs: r }));
}

/**
 * Reassemble the readable text of one XML part.
 * Runs inside a paragraph concatenate with no separator; paragraphs are newline
 * separated.
 */
function extractText(xml, spec) {
  return groupByParagraph(findRuns(xml, spec))
    .map((g) => g.runs.map((r) => r.text).join(''))
    .filter((t) => t.trim().length > 0)
    .join('\n');
}

/**
 * Find where each replacement applies within a text.
 *
 * Longest key first, so a short secret that happens to be a substring of a
 * longer one cannot claim the span before the longer match is considered. An
 * occurrence overlapping a span already claimed is skipped. Claimed characters
 * are tracked in a bitmap, so the cost is linear in the matched text rather
 * than quadratic in the number of spans -- this runs over a whole part, and a
 * long document can have thousands.
 *
 * @returns {Array<{ start, end, replacement }>} sorted by start, non-overlapping
 */
function findSpans(text, orderedKeys, replMap) {
  const spans = [];
  const claimed = new Uint8Array(text.length);
  for (const key of orderedKeys) {
    if (!key) continue;
    // Whole words only for name-like values (see ./replace.js).
    for (const at of occurrences(text, key)) {
      const end = at + key.length;
      let clashes = false;
      for (let i = at; i < end; i++) {
        if (claimed[i]) { clashes = true; break; }
      }
      if (clashes) continue;
      claimed.fill(1, at, end);
      spans.push({ start: at, end, replacement: replMap[key] });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Apply replacement spans to a sequence of runs and hand each run its new text.
 *
 * A span that covers several runs is not duplicated into each of them: the
 * first WRITABLE run the span touches receives the replacement token, and the
 * runs covering the remainder contribute nothing for that stretch. That is what
 * lets a value split across three runs -- or across three paragraphs -- collapse
 * into one token without disturbing the text around it. Read-only runs (breaks,
 * tabs, paragraph separators) are never rewritten.
 *
 * Runs and spans are both in offset order, so one forward pass over each does.
 *
 * @returns {Map<run, string>} only for runs whose text changed
 */
function rewriteRuns(runs, spans) {
  const ranges = [];
  let cursor = 0; // offset of each run's start within the joined text
  for (const run of runs) {
    ranges.push([cursor, cursor + run.text.length]);
    cursor += run.text.length;
  }

  // The owner of a span is the first writable run it overlaps.
  const owner = new Map();
  let r = 0;
  for (const s of spans) {
    while (r < runs.length && ranges[r][1] <= s.start) r++;
    for (let k = r; k < runs.length && ranges[k][0] < s.end; k++) {
      if (!runs[k].readonly && ranges[k][1] > s.start) {
        owner.set(s, runs[k]);
        break;
      }
    }
  }

  const edits = new Map();
  let first = 0; // first span that can still overlap the current run
  runs.forEach((run, j) => {
    const [a, b] = ranges[j];
    while (first < spans.length && spans[first].end <= a) first++;
    if (run.readonly) return;

    let out = '';
    let pos = a;
    let touched = false;
    for (let k = first; k < spans.length && spans[k].start < b; k++) {
      const s = spans[k];
      touched = true;
      const from = Math.max(s.start, a);
      const to = Math.min(s.end, b);
      if (from > pos) out += run.text.slice(pos - a, from - a);
      if (owner.get(s) === run) out += s.replacement;
      pos = to;
    }
    if (!touched) return;
    if (pos < b) out += run.text.slice(pos - a);

    if (out !== run.text) edits.set(run, out);
  });
  return edits;
}

/** Longest key first; see findSpans. */
function orderKeys(replMap) {
  return Object.keys(replMap).filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Mask one XML part: reassemble its text, apply the replacement map across run
 * AND paragraph boundaries, and splice the results back into the XML.
 *
 * The text is built exactly as `extractText` builds it -- non-blank paragraphs
 * joined by a newline -- because that is the text the detector saw. A value it
 * found across several paragraphs (a private key pasted one line per paragraph,
 * an address block) is therefore found here too, and collapses into one token
 * in its first paragraph while the paragraphs after it are emptied. Matching
 * paragraph by paragraph could never see such a value, and the mask used to
 * report it as replaced while every line of it stayed in the file (#29).
 *
 * @param {string} xml
 * @param {object} replMap - original value -> replacement token
 * @param {object} spec - WORD, DRAWING, or `{ textTag, paraTag }`
 * @returns {string} updated XML
 */
function maskXml(xml, replMap, spec) {
  const orderedKeys = orderKeys(replMap);
  if (orderedKeys.length === 0) return xml;

  const sequence = [];
  for (const group of groupByParagraph(findRuns(xml, spec))) {
    if (!group.runs.map((r) => r.text).join('').trim()) continue;
    if (sequence.length > 0) sequence.push({ text: '\n', tag: null, readonly: true });
    sequence.push(...group.runs);
  }
  const text = sequence.map((r) => r.text).join('');
  const spans = findSpans(text, orderedKeys, replMap);
  if (spans.length === 0) return xml;

  const edits = [...rewriteRuns(sequence, spans)]
    .map(([run, value]) => ({ run, text: value }))
    .sort((x, y) => x.run.tagStart - y.run.tagStart);

  // One forward pass: copy the XML between edited runs, emit each edited run.
  const pieces = [];
  let copied = 0;
  for (const { run, text: value } of edits) {
    let openTag = xml.slice(run.tagStart, run.openEnd);
    // A run that now begins or ends with whitespace needs xml:space="preserve",
    // or Word and PowerPoint will silently trim it and join two words together.
    if (/^\s|\s$/.test(value) && !/xml:space=/.test(openTag)) {
      openTag = `${openTag.slice(0, -1)} xml:space="preserve">`;
    }
    pieces.push(xml.slice(copied, run.tagStart), openTag, encodeXml(value));
    copied = run.innerEnd;
  }
  pieces.push(xml.slice(copied));
  return pieces.join('');
}

// ---------------------------------------------------------------------------
// Simple text: element content and attribute values.
//
// Not everything worth reading is a run. A document's author is the text of
// `<dc:creator>`, a picture's alt text is a `descr="…"` attribute, a comment's
// author is `w:author="…"`, a hyperlink's `mailto:` target is the `Target` of a
// relationship. These have no run structure to preserve, so each value is read
// and rewritten whole.
// ---------------------------------------------------------------------------

/**
 * Every `<el …>text</el>` for the given element names, as { start, end, text }
 * over the inner (still-encoded) range.
 */
function findElements(xml, names) {
  if (!names || names.length === 0) return [];
  const rx = new RegExp(`<(${names.map(esc).join('|')})(\\s[^<>]*?)?(?<!/)>([^<]*)</\\1>`, 'g');
  const out = [];
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const start = m.index + m[0].length - m[1].length - 3 - m[3].length;
    out.push({ start, end: start + m[3].length, text: decodeXml(m[3]) });
  }
  return out;
}

/**
 * Every matching attribute value. A rule is `{ attr }` (on any element) or
 * `{ el, attr }` (only on that element), plus an optional `when` regex the
 * element's opening tag must match -- a relationship's `Target` counts only
 * when `TargetMode="External"`.
 */
function findAttributes(xml, rules) {
  if (!rules || rules.length === 0) return [];
  const out = [];
  const compiled = rules.map((rule) => ({
    ...rule,
    rx: new RegExp(`(?:^|\\s)${esc(rule.attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g'),
  }));
  const tagRx = /<([A-Za-z_][\w.:-]*)(\s[^<>]*?)\/?>/g;
  let t;
  while ((t = tagRx.exec(xml)) !== null) {
    const el = t[1];
    const attrs = t[2];
    const attrsStart = t.index + 1 + el.length;
    for (const rule of compiled) {
      if (rule.el && rule.el !== el) continue;
      if (rule.when && !rule.when.test(attrs)) continue;
      const arx = rule.rx;
      arx.lastIndex = 0;
      let a;
      while ((a = arx.exec(attrs)) !== null) {
        const value = a[1] !== undefined ? a[1] : a[2];
        const start = attrsStart + a.index + a[0].length - 1 - value.length;
        out.push({ start, end: start + value.length, text: decodeXml(value), attr: true });
      }
    }
  }
  return out;
}

/**
 * Text of one part under a coverage rule (see ./package.js): runs, element
 * content and attribute values, one paragraph or value per line.
 */
function extractPart(xml, rule) {
  const lines = [];
  for (const spec of rule.runs || []) {
    const t = extractText(xml, spec);
    if (t) lines.push(t);
  }
  for (const v of findElements(xml, rule.elements)) if (v.text.trim()) lines.push(v.text);
  for (const v of findAttributes(xml, rule.attrs)) if (v.text.trim()) lines.push(v.text);
  return lines.join('\n');
}

/**
 * Mask one part under a coverage rule. `maskOnlyElements` are rewritten but
 * never read for detection -- values that merely REPEAT text found elsewhere
 * (a sheet name listed again in docProps/app.xml) and that would only add noise
 * to a scan.
 */
function maskPart(xml, replMap, rule) {
  const orderedKeys = orderKeys(replMap);
  if (orderedKeys.length === 0) return xml;

  let out = xml;
  for (const spec of rule.runs || []) out = maskXml(out, replMap, spec);

  const values = [
    ...findElements(out, [...(rule.elements || []), ...(rule.maskOnlyElements || [])]),
    ...findAttributes(out, rule.attrs),
  ].sort((a, b) => b.start - a.start);

  for (const v of values) {
    let text = v.text;
    for (const key of orderedKeys) {
      if (text.includes(key)) text = replaceOccurrences(text, key, replMap[key]);
    }
    if (text === v.text) continue;
    out = out.slice(0, v.start) + (v.attr ? encodeAttr(text) : encodeXml(text)) + out.slice(v.end);
  }
  return out;
}

module.exports = {
  WORD,
  DRAWING,
  findRuns,
  groupByParagraph,
  extractText,
  findSpans,
  rewriteRuns,
  // Kept for callers written against the per-paragraph API.
  rewriteParagraph: rewriteRuns,
  maskXml,
  findElements,
  findAttributes,
  extractPart,
  maskPart,
  decodeXml,
  encodeXml,
  encodeAttr,
};
