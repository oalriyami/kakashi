const path = require('path');
const fs = require('fs');
const { isTextFile, readText, writeText, decodeText, CODE_EXTS, SPECIAL_FILENAMES } = require('./text');
const { structureOf, brokenStructure } = require('./structure');

let xlsxHandler;
let docxHandler;
let pptxHandler;
let pdfHandler;

function loadHandlers() {
  if (!xlsxHandler) xlsxHandler = require('./xlsx');
  if (!docxHandler) docxHandler = require('./docx');
  if (!pptxHandler) pptxHandler = require('./pptx');
  if (!pdfHandler) pdfHandler = require('./pdf');
}

function getFormat(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf') return 'pdf';
  if (isTextFile(filePath)) return 'text';
  return null;
}

/**
 * The largest file read whole, in bytes. Detection holds the file, its text
 * and every finding in memory at once -- about 60 times the file's size -- so
 * a 200 MB file needed 4 GB and killed the process (exit 134, not 2) once the
 * heap ran out (#54). Past this size a file is refused with a clear error.
 * KAKASHI_MAX_FILE_MB raises or lowers it.
 */
function maxFileBytes() {
  const mb = Number(process.env.KAKASHI_MAX_FILE_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 32) * 1024 * 1024;
}

class FileTooLargeError extends Error {
  constructor(size, limit) {
    const mb = (n) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    super(`the file is ${mb(size)}, larger than the ${mb(limit)} Kakashi reads at once (it needs about 60 times the file's size in memory). `
      + 'Split the file, or set KAKASHI_MAX_FILE_MB if this machine has the memory.');
    this.name = 'FileTooLargeError';
    this.code = 'KAKASHI_TOO_LARGE';
  }
}

/** Throw FileTooLargeError when `size` bytes is over the limit. */
function assertReadableSize(size) {
  const limit = maxFileBytes();
  if (size > limit) throw new FileTooLargeError(size, limit);
}

async function readFile(filePath) {
  const format = getFormat(filePath);
  if (!format) {
    throw new Error(`Unsupported file format: ${path.extname(filePath) || path.basename(filePath)}`);
  }
  assertReadableSize(fs.statSync(filePath).size);
  loadHandlers();
  switch (format) {
    case 'text':
      return { format, ...(await Promise.resolve(readText(filePath))) };
    case 'xlsx':
      return { format, ...(await xlsxHandler.readXlsx(filePath)) };
    case 'docx':
      return { format, ...(await docxHandler.readDocx(filePath)) };
    case 'pptx':
      return { format, ...(await pptxHandler.readPptx(filePath)) };
    case 'pdf':
      return { format, ...(await pdfHandler.readPdf(filePath)) };
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

/**
 * Read a text output back and remove it unless it holds exactly what was meant
 * to be written.
 *
 * The Office writers check their own output value by value (./package.js). A
 * text output is simpler: the masked string is already known, so the only
 * thing that can go wrong is the write itself -- an encoding that cannot hold
 * the text, a file that decodes differently from how it was encoded. Comparing
 * the round trip catches all of it.
 */
function verifyRoundTrip(outputPath, expected, enc, { endsWith = false } = {}) {
  let back;
  try {
    back = decodeText(fs.readFileSync(outputPath), enc).text;
  } catch (_) {
    back = null;
  }
  const ok = back !== null && (endsWith ? back.endsWith(expected) : back === expected);
  if (!ok) {
    fs.rmSync(outputPath, { force: true });
    throw new Error('the masked file did not read back as written, so it was removed');
  }
}

async function writeMasked(filePath, outputPath, data, replMap, maskedText) {
  const format = data.format || getFormat(filePath);
  loadHandlers();
  switch (format) {
    case 'text': {
      // Fail closed rather than hand over a JSON file that no longer parses
      // (#43): nothing is written.
      const broken = brokenStructure(structureOf(filePath), data.text || '', maskedText);
      if (broken) throw new Error(`${broken}, so it was not written`);
      const enc = { encoding: data.encoding || 'utf-8', bom: Boolean(data.bom) };
      writeText(outputPath, maskedText, enc);
      verifyRoundTrip(outputPath, maskedText, enc);
      return outputPath;
    }
    case 'xlsx':
      await xlsxHandler.writeXlsx(filePath, outputPath, data, replMap);
      return outputPath;
    case 'docx':
      await docxHandler.writeDocx(filePath, outputPath, data, replMap);
      return outputPath;
    case 'pptx':
      await pptxHandler.writePptx(filePath, outputPath, data, replMap);
      return outputPath;
    case 'pdf':
      pdfHandler.writePdf(filePath, outputPath, maskedText, {
        replaced: Object.keys(replMap || {}).length,
        unscanned: data.unscanned || [],
      });
      // The extract is written after a short header.
      verifyRoundTrip(outputPath, maskedText, { encoding: 'utf-8', bom: false }, { endsWith: true });
      return outputPath;
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

function defaultOutputPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ext = path.extname(base).slice(1).toLowerCase();
  if (ext === 'pdf') {
    // PDF round-trip would require a heavy PDF rewriter (pdf-lib + content
    // stream patching). For v1.0 the masked output is the extracted text in
    // .md form -- still useful for sharing context with an AI agent, just
    // not a real PDF back. Override with `-o foo.txt` if you want plain text.
    return path.join(dir, base.replace(/\.pdf$/i, '_masked.md'));
  }
  return path.join(dir, `masked_${base}`);
}

// Binary/rich document formats, each with a dedicated handler above.
const DOC_EXTS = ['xlsx', 'xls', 'docx', 'pptx', 'pdf'];

// Every extension a directory walk should consider.
//
// This used to be a hand-written list of 17 entries while the text engine
// understood 80+. The two drifted apart, and the consequence was silent:
// `kakashi scan main.go` reported a leaked key, but `kakashi mask-dir -r` and
// `kakashi scan-dir` skipped Go, Terraform, Rust, Java and shell files
// entirely -- so a folder-level compliance report could come back clean with
// live credentials sitting in main.tf. Deriving it from CODE_EXTS keeps the
// single-file and whole-directory paths honest about covering the same files.
const SUPPORTED_EXTS = [...new Set([...CODE_EXTS, ...DOC_EXTS])].sort();

// Extensionless files the text engine recognises by name (Dockerfile, Makefile).
// A brace pattern like `*.{js,go}` can never match these, so directory walkers
// pass them as a second glob pattern -- with `nocase`, since these are stored
// lowercase here while the real files are `Dockerfile` and `Makefile`, and glob
// is case-sensitive on Linux where getExt() is not.
const SUPPORTED_FILENAMES = [...SPECIAL_FILENAMES].sort();

/**
 * Build the extension half of a walk pattern.
 *
 * A single-element brace list is NOT a brace expansion: glob treats `*.{py}`
 * as the literal characters `{py}` and matches nothing, which is why
 * `mask-dir --ext py` silently reported "No matching files found".
 */
function extGlob(exts, prefix) {
  return exts.length === 1
    ? `${prefix}*.${exts[0]}`
    : `${prefix}*.{${exts.join(',')}}`;
}

/**
 * Glob patterns covering every file a directory walk should consider.
 * @param {boolean} recursive - walk subdirectories.
 * @param {string[]} [exts] - restrict to these extensions (default: everything readable).
 * @param {boolean} [includeFilenames] - also match extensionless names (Dockerfile).
 * @returns {string[]}
 */
function globPatterns(recursive = false, exts = SUPPORTED_EXTS, includeFilenames = true) {
  const prefix = recursive ? '**/' : '';
  const patterns = [extGlob(exts, prefix)];
  if (includeFilenames) {
    patterns.push(`${prefix}{${SUPPORTED_FILENAMES.join(',')}}`);
    // Terraform's previous state, `terraform.tfstate.backup`: same secrets,
    // but an extension of its own.
    patterns.push(`${prefix}*.tfstate.backup`);
  }
  return patterns;
}

module.exports = {
  maxFileBytes,
  assertReadableSize,
  FileTooLargeError,
  structureOf,
  getFormat,
  readFile,
  writeMasked,
  defaultOutputPath,
  SUPPORTED_EXTS,
  SUPPORTED_FILENAMES,
  DOC_EXTS,
  globPatterns,
  extGlob,
  isTextFile,
};
