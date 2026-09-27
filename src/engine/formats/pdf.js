const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

/**
 * PDF reading (#31).
 *
 * pdf-parse's default renderer glued every text item on a line together with
 * no separator, so a table row read as `1Rajesh Kumar0501234567411111…`: no
 * pattern matched, `scan` reported 0 findings and Guardian released the file.
 * It also read nothing but the page text, so form field values, sticky notes
 * and the document's author were never checked, and a scanned page -- an image
 * with no text layer -- silently counted as clean.
 *
 * This reader keeps pdf.js's content order but separates items by the gap
 * between them: nothing for touching items (a word split by kerning), a space
 * for a word gap, a tab for a column gap. It then adds every form value, note
 * and alternative text on the page, and the document properties. A page that
 * paints images but carries almost no text is listed in `unscanned`, so
 * callers never call it clean.
 */

/**
 * The pdf.js build pdf-parse uses (the same module instance, so settings made
 * here apply to it), and the operator codes that paint an image.
 *
 * Asking pdf.js for a page's operator list makes it load the page's fonts, and
 * this build loads fonts into a browser DOM. In Node that throws OUTSIDE the
 * promise chain and kills the process. `disableFontFace` turns the loading
 * off; nothing here renders, so nothing is lost.
 *
 * If the build cannot be found (a different pdf-parse layout), operator lists
 * are not requested at all, and a page with no text is treated as a scan.
 */
let PDFJS_STATE = null;
function pdfjs() {
  if (PDFJS_STATE) return PDFJS_STATE;
  PDFJS_STATE = { imageOps: null };
  try {
    const build = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
    if (global.PDFJS && build.OPS) {
      global.PDFJS.disableFontFace = true;
      const names = ['paintJpegXObject', 'paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintImageXObject',
        'paintInlineImageXObject', 'paintInlineImageXObjectGroup', 'paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat'];
      PDFJS_STATE.imageOps = new Set(names.map((n) => build.OPS[n]).filter((v) => v !== undefined));
    }
  } catch (_) { /* no operator lists; see above */ }
  return PDFJS_STATE;
}

/**
 * pdf.js reports malformed files with `console.log('Warning: …')`, from a
 * worker module whose verbosity cannot be set when it runs in-process. On
 * stdout those lines break `guard --json` and `scan-dir -f json`. While a PDF
 * is being read, exactly those lines are dropped; everything else passes
 * through. Reference-counted, so concurrent reads share one filter.
 */
let quietDepth = 0;
let realLog = null;
function quietPdfjs() {
  if (quietDepth++ === 0) {
    realLog = console.log;
    console.log = (...args) => {
      if (typeof args[0] === 'string' && /^(Warning|Info): /.test(args[0])) return;
      realLog(...args);
    };
  }
  return () => {
    if (--quietDepth === 0) {
      console.log = realLog;
      realLog = null;
    }
  };
}

/** Below this many non-space characters, a page with images is treated as a scan. */
const MIN_TEXT_CHARS = 20;

/** Font size of a text item, from its transform matrix. */
const sizeOf = (item) => Math.hypot(item.transform[2], item.transform[3]) || Math.abs(item.transform[0]) || 10;

/**
 * Join a page's text items.
 * @param {Array<{ str, transform, width }>} items
 */
function layoutText(items) {
  let out = '';
  let prev = null;
  for (const item of items) {
    const x = item.transform[4];
    const y = item.transform[5];
    if (prev) {
      const size = Math.max(sizeOf(prev), sizeOf(item));
      const sameLine = Math.abs(y - prev.y) <= size * 0.4;
      const gap = x - prev.end;
      if (!sameLine || gap < -size * 0.5) {
        // A new line -- or an item that starts back over the previous one on
        // the same baseline, which is a different text flow (two footers
        // drawn in the same place, the next column of a table read early).
        out += '\n';
      } else {
        const spaced = /\s$/.test(out) || /^\s/.test(item.str);
        if (gap > size * 1.2) out += '\t';
        else if (gap > size * 0.15 && !spaced) out += ' ';
      }
    }
    out += item.str;
    prev = { x, y, end: x + (item.width || 0), transform: item.transform };
  }
  return out;
}

/** Form values, note text and authors, alternative text: one per line. */
function annotationText(annotations) {
  const lines = [];
  for (const a of annotations) {
    const values = [a.contents, a.title, a.alternativeText];
    if (Array.isArray(a.fieldValue)) values.push(...a.fieldValue);
    else values.push(a.fieldValue);
    for (const v of values) if (typeof v === 'string' && v.trim()) lines.push(v.trim());
  }
  return lines;
}

/** Document properties that hold people and content, not software names. */
const INFO_FIELDS = ['Title', 'Author', 'Subject', 'Keywords'];

async function readPdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const { imageOps } = pdfjs();
  const pages = [];
  // A Uint8Array, not a Buffer: pdf.js mis-reads the cross-reference table of
  // some small files when handed a Node Buffer ("bad XRef entry"). Images are
  // never decoded: only the fact that a page paints one matters.
  const source = {
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length),
    disableFontFace: true,
    nativeImageDecoderSupport: 'none',
  };
  // One page: its laid-out text, then its form values and notes.
  const renderPage = async (page) => {
    const [content, annotations, ops] = await Promise.all([
      page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }),
      page.getAnnotations().catch(() => []),
      imageOps ? page.getOperatorList().catch(() => ({ fnArray: [] })) : null,
    ]);
    const text = layoutText(content.items);
    const chars = text.replace(/\s/g, '').length;
    // Without operator lists, only an entirely textless page can be called a scan.
    const hasImages = ops ? ops.fnArray.some((op) => imageOps.has(op)) : chars === 0;
    pages.push({
      number: page.pageNumber || pages.length + 1,
      noTextLayer: hasImages && chars < MIN_TEXT_CHARS,
    });
    return [text, ...annotationText(annotations)].filter(Boolean).join('\n');
  };

  const restore = quietPdfjs();
  let result;
  try {
    result = await pdfParse(source, { pagerender: renderPage });
  } finally {
    restore();
  }

  const info = result.info || {};
  const props = INFO_FIELDS.map((k) => info[k]).filter((v) => typeof v === 'string' && v.trim());
  const text = [result.text || '', ...props].filter(Boolean).join('\n\n');
  const unscanned = pages.filter((p) => p.noTextLayer).map((p) => `page ${p.number} (no text layer)`);
  return { text, unscanned, pages: pages.length };
}

/**
 * Write the masked extract. The header says what actually happened: how many
 * values were replaced, and which pages could not be read at all.
 *
 * @param {object} [summary] - { replaced: number, unscanned: string[] }
 */
function writePdf(filePath, outputPath, maskedText, summary = {}) {
  const base = path.basename(filePath);
  const outExt = path.extname(outputPath).slice(1).toLowerCase();
  const replaced = summary.replaced || 0;
  const unscanned = summary.unscanned || [];
  const what = replaced > 0
    ? `${replaced} distinct sensitive value${replaced === 1 ? ' was' : 's were'} replaced with stable tokens (\`[EMAIL_1]\`, \`[OPENAI_KEY_2]\`, ...).`
    : 'No sensitive values were detected in the extracted text.';
  const missed = unscanned.length > 0
    ? `Not checked: ${unscanned.join(', ')}. Those pages are images; review them by hand.`
    : null;
  // For .md output (the default for PDF inputs), wrap the extracted text with
  // a small markdown header so the file renders cleanly when pasted into an
  // AI agent or a docs viewer. For .txt or anything else, fall back to a plain
  // ASCII header.
  let header;
  if (outExt === 'md') {
    header =
      `# Masked extract from \`${base}\`\n\n` +
      '> Text extracted from the PDF and masked locally with Kakashi.\n' +
      `> ${what}\n` +
      (missed ? `> ${missed}\n` : '') +
      '\n---\n\n';
  } else {
    header = `[Kakashi: extracted and masked from ${base}. ${what.replace(/`/g, '')}${missed ? ` ${missed}` : ''}]\n\n`;
  }
  fs.writeFileSync(outputPath, header + maskedText, 'utf8');
  return outputPath;
}

module.exports = { readPdf, writePdf, layoutText };
