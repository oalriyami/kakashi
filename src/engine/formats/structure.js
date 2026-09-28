/**
 * Replacements that keep structured text valid (#43).
 *
 * The masker swaps a value for a token such as `[CC_1]`. Dropped into a JSON
 * number (`{"card": 4111…}`) that token made the file invalid JSON; as a YAML
 * plain scalar (`email: [EMAIL_1]`) it turned the value into a list; a name
 * matched across a tab merged two TSV columns; a fake PEM key put raw newlines
 * inside a JSON string. Here each replacement is fitted to where it lands:
 *
 *   inside a string literal   escaped for that string's quoting
 *   in a bare scalar          the whole scalar is quoted: `"[CC_1]"`,
 *                             `'[EMAIL_1]'`, a CSV field in double quotes
 *   across a TSV/CSV separator the separators are kept and each piece replaced
 *   in a comment              left as it is
 *
 * Pure: it only computes edits over the original text.
 */

const path = require('path');

/** File extensions and the structure their text has. */
const KINDS = {
  json: 'json', json5: 'json', geojson: 'json', ipynb: 'json', har: 'json', webmanifest: 'json',
  jsonl: 'jsonl', ndjson: 'jsonl',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  tsv: 'tsv', tab: 'tsv',
  csv: 'csv',
};

/** @param {string} filePath @returns {string|null} */
function structureOf(filePath) {
  return KINDS[path.extname(String(filePath)).slice(1).toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// Regions of the text
// ---------------------------------------------------------------------------

/**
 * String literals (their contents) and comments of JSON / JSONL / TOML text.
 * @returns {{ strings: Array<{start:number,end:number,quote:string}>, comments: Array<{start:number,end:number}> }}
 */
function scanLiterals(text, kind) {
  const strings = [];
  const comments = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (kind === 'toml' && c === '#') {
      const e = text.indexOf('\n', i);
      comments.push({ start: i, end: e === -1 ? n : e });
      i = e === -1 ? n : e;
    } else if (kind !== 'toml' && c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      comments.push({ start: i, end: e === -1 ? n : e });
      i = e === -1 ? n : e;
    } else if (kind !== 'toml' && c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      comments.push({ start: i, end: e === -1 ? n : e + 2 });
      i = e === -1 ? n : e + 2;
    } else if (kind === 'toml' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      let j = i + 3;
      while (j < n && !text.startsWith(q, j)) j += q === '"""' && text[j] === '\\' ? 2 : 1;
      strings.push({ start: i + 3, end: Math.min(j, n), quote: q });
      i = j + 3;
    } else if (c === '"' || (kind === 'toml' && c === "'")) {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += c === '"' && text[j] === '\\' ? 2 : 1;
      strings.push({ start: i + 1, end: Math.min(j, n), quote: c });
      i = j + 1;
    } else {
      i++;
    }
  }
  return { strings, comments };
}

/** The region of `regions` (sorted, disjoint) holding [start, end), or null. */
function regionAt(regions, start, end) {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid];
    if (r.end < start) lo = mid + 1;
    else if (r.start > start) hi = mid - 1;
    else return end <= r.end ? r : null;
  }
  return null;
}

/** Escape a replacement for the inside of a string with this quoting. */
function escapeFor(quote, rep) {
  if (quote === '"' || quote === '"""') return JSON.stringify(rep).slice(1, -1);
  // Literal strings have no escapes: keep them on one line and free of their quote.
  return rep.replace(/'/g, '’').replace(/\r?\n/g, ' ');
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/** Characters that may not start a YAML plain scalar. */
const YAML_INDICATOR_START = /^(?:[[\]{}!&*#|>'"%@`,]|[-?:](?:\s|$))/;

/**
 * Where each match sits in YAML text: a quoted scalar, a comment, a block
 * scalar's literal lines, or a plain scalar (a key, a value or a flow element)
 * whose extent is returned so it can be quoted whole.
 */
function yamlContexts(text, matches) {
  const out = new Map();
  let lineStart = 0;
  let blockIndent = -1; // inside a `|` / `>` block while lines are indented deeper
  let mi = 0;
  while (lineStart <= text.length && mi < matches.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    const indent = line.length - line.trimStart().length;
    const inBlock = blockIndent >= 0 && (line.trim() === '' || indent > blockIndent);
    if (!inBlock) blockIndent = -1;
    const lineMatches = [];
    while (mi < matches.length && matches[mi].start < lineEnd + 1) lineMatches.push(matches[mi++]);
    if (!inBlock) {
      const parts = yamlLine(line);
      if (parts.blockHeader) blockIndent = indent;
      for (const m of lineMatches) out.set(m, locateYaml(parts, m.start - lineStart, m.end - lineStart, lineStart));
    }
    lineStart = lineEnd + 1;
  }
  return out;
}

/** Split one YAML line into its key, value and comment, outside quotes. */
function yamlLine(line) {
  let i = line.length - line.trimStart().length;
  // List markers: `- `, `- - `.
  while (line[i] === '-' && (line[i + 1] === ' ' || line[i + 1] === undefined)) {
    i += 1;
    while (line[i] === ' ') i++;
  }
  const bodyStart = i;
  // Find `: ` (or a line-ending `:`) and ` #` outside quotes.
  let colon = -1;
  let comment = line.length;
  let q = null;
  const quotes = [];
  let qStart = -1;
  for (let k = bodyStart; k < line.length; k++) {
    const c = line[k];
    if (q) {
      if (q === '"' && c === '\\') { k++; continue; }
      if (c === q) {
        if (q === "'" && line[k + 1] === "'") { k++; continue; }
        quotes.push({ start: qStart + 1, end: k, quote: q });
        q = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && (k === bodyStart || /[\s:[{,]/.test(line[k - 1]))) { q = c; qStart = k; continue; }
    if (c === '#' && (k === 0 || /\s/.test(line[k - 1]))) { comment = k; break; }
    if (c === ':' && colon === -1 && (line[k + 1] === ' ' || line[k + 1] === undefined)) colon = k;
  }
  if (q) quotes.push({ start: qStart + 1, end: line.length, quote: q });
  const keyStart = bodyStart;
  const keyEnd = colon === -1 ? -1 : colon;
  let valueStart = colon === -1 ? bodyStart : colon + 1;
  while (line[valueStart] === ' ') valueStart++;
  let valueEnd = comment;
  while (valueEnd > valueStart && line[valueEnd - 1] === ' ') valueEnd--;
  const value = line.slice(valueStart, valueEnd);
  return {
    line, keyStart, keyEnd, valueStart, valueEnd, comment, quotes,
    flow: /^[[{]/.test(value),
    blockHeader: /^[|>][-+0-9]*$/.test(value),
  };
}

function locateYaml(p, s, e, offset) {
  if (s >= p.comment) return { type: 'free' };
  const quoted = p.quotes.find((r) => s >= r.start && e <= r.end);
  if (quoted) return { type: 'string', quote: quoted.quote === "'" ? "yaml'" : '"' };
  if (p.keyEnd !== -1 && s >= p.keyStart && e <= p.keyEnd) {
    return { type: 'region', start: offset + p.keyStart, end: offset + p.keyEnd, quoteWith: "'" };
  }
  if (s < p.valueStart) return { type: 'free' };
  if (p.flow) {
    // One element of a flow collection: between `[ ] { } ,` (and a `: `).
    let a = s;
    while (a > p.valueStart && !/[[\]{},]/.test(p.line[a - 1])) a--;
    let b = e;
    while (b < p.valueEnd && !/[[\]{},]/.test(p.line[b])) b++;
    const piece = p.line.slice(a, b);
    const colon = piece.indexOf(': ');
    if (colon !== -1 && s >= a + colon + 2) a += colon + 2;
    while (p.line[a] === ' ') a++;
    while (b > a && p.line[b - 1] === ' ') b--;
    return { type: 'region', start: offset + a, end: offset + b, quoteWith: "'" };
  }
  return { type: 'region', start: offset + p.valueStart, end: offset + p.valueEnd, quoteWith: "'" };
}

/** Does this plain YAML scalar need quotes to stay one plain string? */
function yamlNeedsQuotes(s) {
  return YAML_INDICATOR_START.test(s) || /: |\s#|^\s|\s$/.test(s);
}

// ---------------------------------------------------------------------------
// CSV fields
// ---------------------------------------------------------------------------

/** Quoted CSV field contents, across lines. */
function csvQuoted(text) {
  const out = [];
  let i = 0;
  let fieldStart = true;
  while (i < text.length) {
    const c = text[i];
    if (fieldStart && c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      out.push({ start: i + 1, end: j, quote: 'csv' });
      i = j + 1;
      fieldStart = false;
      continue;
    }
    fieldStart = c === ',' || c === '\n' || c === '\r';
    i++;
  }
  return out;
}

/** The unquoted CSV field around [s, e) on its line. */
function csvField(text, s, e) {
  let a = s;
  while (a > 0 && !/[,\n]/.test(text[a - 1])) a--;
  let b = e;
  while (b < text.length && !/[,\r\n]/.test(text[b])) b++;
  return { start: a, end: b };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** Replace every non-separator piece of `original` with `rep`, keeping the separators. */
function keepSeparators(original, rep, sepRx) {
  return original.split(sepRx).map((p, i) => (i % 2 ? p : (p ? rep : ''))).join('');
}

/**
 * Fit each replacement to the structure of `text`.
 * @param {string|null} kind - from structureOf()
 * @param {string} text - the original text
 * @param {Array<{start:number,end:number,original:string,replacement:string}>} matches - sorted, disjoint
 * @returns {Array<{start:number,end:number,text:string}>} sorted, disjoint edits
 */
function fitReplacements(kind, text, matches) {
  const plain = (m) => ({ start: m.start, end: m.end, text: m.replacement });
  if (!kind || matches.length === 0) return matches.map(plain);

  if (kind === 'tsv') {
    return matches.map((m) => ({
      start: m.start,
      end: m.end,
      text: /[\t\n]/.test(m.original) ? keepSeparators(m.original, m.replacement.replace(/\t/g, ' '), /(\t|\r?\n)/)
        : m.replacement.replace(/\t/g, ' '),
    }));
  }

  // Where each match lands.
  const where = new Map();
  if (kind === 'json' || kind === 'jsonl' || kind === 'toml') {
    const { strings, comments } = scanLiterals(text, kind);
    const bareStop = kind === 'toml' ? /[\s,[\]{}="'#]/ : /[\s,[\]{}:"]/;
    for (const m of matches) {
      const str = regionAt(strings, m.start, m.end);
      if (str) { where.set(m, { type: 'string', quote: str.quote }); continue; }
      if (regionAt(comments, m.start, m.end)) { where.set(m, { type: 'free' }); continue; }
      let a = m.start;
      while (a > 0 && !bareStop.test(text[a - 1])) a--;
      let b = m.end;
      while (b < text.length && !bareStop.test(text[b])) b++;
      where.set(m, { type: 'region', start: a, end: b, quoteWith: '"' });
    }
  } else if (kind === 'yaml') {
    for (const [m, ctx] of yamlContexts(text, matches)) where.set(m, ctx);
  } else if (kind === 'csv') {
    const quoted = csvQuoted(text);
    for (const m of matches) {
      if (regionAt(quoted, m.start, m.end)) { where.set(m, { type: 'string', quote: 'csv' }); continue; }
      if (/[,\n]/.test(m.original)) { where.set(m, { type: 'split' }); continue; }
      const f = csvField(text, m.start, m.end);
      where.set(m, { type: 'region', start: f.start, end: f.end, quoteWith: 'csv' });
    }
  }

  const edits = [];
  let i = 0;
  while (i < matches.length) {
    const m = matches[i];
    const ctx = where.get(m) || { type: 'free' };
    if (ctx.type === 'string') {
      const rep = ctx.quote === 'csv' ? m.replacement.replace(/"/g, '""')
        : ctx.quote === "yaml'" ? m.replacement.replace(/'/g, "''").replace(/\r?\n/g, ' ')
          : escapeFor(ctx.quote, m.replacement);
      edits.push({ start: m.start, end: m.end, text: rep });
      i++;
      continue;
    }
    if (ctx.type === 'split') {
      edits.push({ start: m.start, end: m.end, text: keepSeparators(m.original, m.replacement, /(,|\r?\n)/) });
      i++;
      continue;
    }
    if (ctx.type !== 'region') { edits.push(plain(m)); i++; continue; }

    // Every match in the same scalar, replaced together.
    const group = [m];
    let j = i + 1;
    while (j < matches.length && matches[j].start < ctx.end) {
      const next = where.get(matches[j]);
      if (!next || next.type !== 'region' || next.start !== ctx.start) break;
      group.push(matches[j]);
      j++;
    }
    let scalar = '';
    let at = ctx.start;
    for (const g of group) {
      scalar += text.slice(at, g.start) + g.replacement;
      at = g.end;
    }
    scalar += text.slice(at, ctx.end);
    const needs = ctx.quoteWith === "'" ? yamlNeedsQuotes(scalar)
      : ctx.quoteWith === 'csv' ? /[",\r\n]/.test(scalar) : true;
    if (!needs) {
      for (const g of group) edits.push(plain(g));
    } else if (ctx.quoteWith === "'") {
      edits.push({ start: ctx.start, end: ctx.end, text: `'${scalar.replace(/'/g, "''")}'` });
    } else if (ctx.quoteWith === 'csv') {
      edits.push({ start: ctx.start, end: ctx.end, text: `"${scalar.replace(/"/g, '""')}"` });
    } else {
      edits.push({ start: ctx.start, end: ctx.end, text: JSON.stringify(scalar) });
    }
    i = j;
  }
  return edits;
}

/**
 * Whether masked text still parses as its format, when the original did.
 * Only JSON and JSON Lines can be checked without a parser dependency.
 * @returns {string|null} why it does not, or null
 */
function brokenStructure(kind, original, masked) {
  const parses = (t) => {
    try { JSON.parse(t); return true; } catch { return false; }
  };
  if (kind === 'json') return parses(original) && !parses(masked) ? 'the masked file is no longer valid JSON' : null;
  if (kind === 'jsonl') {
    const a = original.split('\n');
    const b = masked.split('\n');
    if (a.length !== b.length) return 'the masked file has a different number of lines';
    for (let k = 0; k < a.length; k++) {
      if (a[k].trim() && parses(a[k]) && !parses(b[k])) return `line ${k + 1} of the masked file is no longer valid JSON`;
    }
  }
  return null;
}

module.exports = { structureOf, fitReplacements, brokenStructure, KINDS };
