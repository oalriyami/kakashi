const fs = require('fs');
const ooxml = require('./ooxml');
const pkg = require('./package');
const { writeFileSafe } = require('../../lib/safe-write');

/**
 * Text of one Word XML part.
 *
 * Runs are concatenated WITHOUT a separator -- see src/engine/formats/ooxml.js
 * for why that is not a detail. Word splits a run wherever formatting changes,
 * so a single credential is regularly stored as two or three runs, and any
 * separator inserted here breaks the pattern that should have matched it.
 */
function extractTextFromXml(xml) {
  return ooxml.extractText(xml, ooxml.WORD);
}

/**
 * Read every part of the package that carries text -- the body, headers,
 * footers, notes, comments, properties, link targets and embedded files. The
 * coverage table is in ./package.js.
 */
async function readDocx(filePath) {
  return pkg.readPackage(fs.readFileSync(filePath), 'docx');
}

/**
 * Mask every covered part and verify the result before writing it. Throws
 * `MaskVerificationError` (and writes nothing) if a detected value survived.
 */
async function writeDocx(filePath, outputPath, data, replMap) {
  const out = await pkg.maskPackage(fs.readFileSync(filePath), 'docx', replMap);
  writeFileSafe(outputPath, out);
}

module.exports = { readDocx, writeDocx, extractTextFromXml };
