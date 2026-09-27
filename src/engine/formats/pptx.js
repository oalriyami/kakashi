const fs = require('fs');
const ooxml = require('./ooxml');
const pkg = require('./package');
const { writeFileSafe } = require('../../lib/safe-write');

/**
 * Text of one DrawingML part. Runs concatenate with no separator, for the
 * same reason as .docx -- see src/engine/formats/ooxml.js.
 */
function extractTextFromXml(xml) {
  return ooxml.extractText(xml, ooxml.DRAWING);
}

/**
 * Read every part of the deck that carries text -- slides, notes, masters and
 * layouts, charts, comments, properties, link targets and embedded files. The
 * coverage table is in ./package.js.
 */
async function readPptx(filePath) {
  return pkg.readPackage(fs.readFileSync(filePath), 'pptx');
}

/**
 * Mask every covered part and verify the result before writing it. Throws
 * `MaskVerificationError` (and writes nothing) if a detected value survived.
 */
async function writePptx(filePath, outputPath, data, replMap) {
  const out = await pkg.maskPackage(fs.readFileSync(filePath), 'pptx', replMap);
  writeFileSafe(outputPath, out);
}

module.exports = { readPptx, writePptx, extractTextFromXml };
