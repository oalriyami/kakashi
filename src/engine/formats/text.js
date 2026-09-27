const fs = require('fs');
const path = require('path');

const CODE_EXTS = new Set([
  'txt', 'md', 'rst', 'log', 'py', 'pyw', 'ipynb',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'java', 'kt', 'scala', 'groovy',
  'go', 'rb', 'php', 'swift', 'rs', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp',
  'cs', 'dart', 'lua', 'r', 'jl', 'nim', 'zig', 'ex', 'exs', 'erl', 'elm',
  'clj', 'hs', 'ml', 'f90', 'pl',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1', 'cmd',
  'sql', 'plsql', 'hql', 'psql',
  'env', 'yaml', 'yml', 'toml', 'json', 'json5', 'jsonl', 'xml', 'fodp',
  'ini', 'cfg', 'conf', 'config', 'properties', 'dotenv',
  'tf', 'tfvars', 'hcl', 'proto', 'graphql', 'gql',
  'css', 'scss', 'sass', 'less', 'html', 'htm',
  'vue', 'svelte', 'astro',
  'csv', 'tsv',
  'dockerfile', 'makefile', 'vagrantfile', 'procfile',
  'gitignore', 'gitconfig', 'editorconfig',
  'lock', 'gradle', 'maven',
]);

const SPECIAL_FILENAMES = new Set([
  'dockerfile', 'makefile', 'vagrantfile', 'procfile',
  'gitignore', 'gitconfig', 'editorconfig',
]);

/**
 * Resolve the "extension" used to decide whether a file is maskable text.
 *
 * path.extname() is useless for dotfiles: it returns '' for `.env` and
 * `.gitignore` (a leading dot marks a hidden file, not an extension) and
 * '.local' for `.env.local`. That silently made the single most common secret
 * file in existence -- `.env` -- report as "Unsupported file format", while
 * `demo.env` worked fine. Dotfiles are resolved from the basename instead.
 */
function getExt(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (SPECIAL_FILENAMES.has(base)) return base;

  if (base.startsWith('.')) {
    const stripped = base.slice(1);               // '.env' -> 'env'
    if (SPECIAL_FILENAMES.has(stripped)) return stripped;   // '.gitignore'
    if (CODE_EXTS.has(stripped)) return stripped;           // '.env'
    const head = stripped.split('.')[0];          // '.env.production' -> 'env'
    if (CODE_EXTS.has(head)) return head;
    return '';
  }

  return path.extname(filePath).slice(1).toLowerCase();
}

function isTextFile(filePath) {
  return CODE_EXTS.has(getExt(filePath));
}

// ---------------------------------------------------------------------------
// Encodings.
//
// Every text file used to be read as UTF-8. A UTF-16 file -- what Excel writes
// for "Unicode Text", what Windows PowerShell 5 writes with `>` or Out-File --
// then read as a string with a NUL between every character, so no pattern
// matched: `scan` reported 0 findings, and `mask` wrote a mangled copy that
// still held every value (#30). The encoding is now detected, the file is
// decoded properly, and the masked copy is written back in the same encoding,
// byte order mark included.
// ---------------------------------------------------------------------------

const BOM = {
  'utf-16le': Buffer.from([0xff, 0xfe]),
  'utf-16be': Buffer.from([0xfe, 0xff]),
};

/**
 * Work out how a text file is encoded.
 *
 * A byte order mark decides. Without one, UTF-16 is recognised by its NUL
 * bytes: Latin text in UTF-16LE has a zero in every odd byte, in UTF-16BE in
 * every even byte, and genuine UTF-8 text has none. UTF-8 stays the default,
 * with any UTF-8 BOM kept in the text so it is written back unchanged.
 *
 * @param {Buffer} buf
 * @returns {{ encoding: 'utf-8'|'utf-16le'|'utf-16be'|'utf-32', bom: boolean }}
 */
function detectEncoding(buf) {
  if (buf.length >= 4
    && ((buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0)
      || (buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff))) {
    return { encoding: 'utf-32', bom: true };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf-16le', bom: true };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf-16be', bom: true };

  const n = Math.min(buf.length, 4096) & ~1;
  if (n >= 4) {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) {
        if (i % 2) odd++;
        else even++;
      }
    }
    const pairs = n / 2;
    if (odd / pairs > 0.3 && even / pairs < 0.05) return { encoding: 'utf-16le', bom: false };
    if (even / pairs > 0.3 && odd / pairs < 0.05) return { encoding: 'utf-16be', bom: false };
  }
  return { encoding: 'utf-8', bom: false };
}

/** Swap each pair of bytes: UTF-16BE <-> UTF-16LE. */
function swap16(buf) {
  const out = Buffer.from(buf);
  out.swap16();
  return out;
}

/**
 * Decode a text file's bytes.
 * @param {Buffer} buf
 * @param {{ encoding: string, bom: boolean }} [enc] - detected when omitted
 * @returns {{ text: string, encoding: string, bom: boolean }}
 * @throws when the bytes are not valid in that encoding
 */
function decodeText(buf, enc = detectEncoding(buf)) {
  const { encoding, bom } = enc;
  if (encoding === 'utf-32') {
    throw new Error('UTF-32 text is not supported; save the file as UTF-8 or UTF-16 and try again');
  }
  if (encoding === 'utf-8') return { text: buf.toString('utf8'), encoding, bom: false };

  let body = bom ? buf.subarray(2) : buf;
  if (body.length % 2 !== 0) {
    throw new Error(`the file looks like ${encoding.toUpperCase()} but has an odd number of bytes; it may be truncated`);
  }
  if (encoding === 'utf-16be') body = swap16(body);
  let text;
  try {
    // `fatal` so a broken surrogate pair is an error, not a silent U+FFFD.
    text = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(body);
  } catch (_) {
    throw new Error(`the file is not valid ${encoding.toUpperCase()} text`);
  }
  return { text, encoding, bom };
}

/** Encode text for writing, in the encoding (and with the BOM) it was read in. */
function encodeText(text, enc = { encoding: 'utf-8', bom: false }) {
  const { encoding, bom } = enc;
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    let body = Buffer.from(text, 'utf16le');
    if (encoding === 'utf-16be') body = swap16(body);
    return bom ? Buffer.concat([BOM[encoding], body]) : body;
  }
  return Buffer.from(text, 'utf8');
}

function readText(filePath) {
  return decodeText(fs.readFileSync(filePath));
}

/**
 * @param {string} filePath
 * @param {string} maskedText
 * @param {{ encoding?: string, bom?: boolean }} [enc] - from readText; UTF-8 when omitted
 */
function writeText(filePath, maskedText, enc) {
  const known = enc && enc.encoding ? { encoding: enc.encoding, bom: Boolean(enc.bom) } : undefined;
  fs.writeFileSync(filePath, encodeText(maskedText, known));
}

module.exports = {
  CODE_EXTS,
  SPECIAL_FILENAMES,
  getExt,
  isTextFile,
  readText,
  writeText,
  detectEncoding,
  decodeText,
  encodeText,
};
