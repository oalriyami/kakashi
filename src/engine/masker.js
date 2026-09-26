const { PATTERNS } = require('./patterns');

function lineAtOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function getReplacement(match, mode, valueMap, counters) {
  const key = match.id;
  if (valueMap[key] && valueMap[key][match.original]) {
    return valueMap[key][match.original];
  }

  let replacement;
  if (mode === 'redact') {
    replacement = '[REDACTED]';
  } else if (mode === 'fake') {
    const fakes = match.fakeValues || [`fake_${key}`];
    counters[key] = (counters[key] || 0) + 1;
    replacement = fakes[(counters[key] - 1) % fakes.length];
  } else {
    counters[key] = (counters[key] || 0) + 1;
    replacement = `[${key.toUpperCase()}_${counters[key]}]`;
  }

  if (!valueMap[key]) valueMap[key] = {};
  valueMap[key][match.original] = replacement;
  return replacement;
}

/**
 * @param {string} text
 * @param {object} options
 * @param {object} [options.valueMap] - original->token map, shared across calls.
 * @param {object} [options.counters] - per-pattern token counters, shared across calls.
 *
 * `valueMap` and `counters` normally start empty, so a single call numbers its
 * tokens from 1 and gives the SAME original the SAME token throughout the text.
 * A caller that masks one logical dataset across MANY calls -- db/index.js masks
 * row by row -- must thread its own objects through every call, or each row
 * restarts at `_1` and two different people collapse onto one token.
 */
function maskText(text, options = {}) {
  const {
    enabled = null,
    mode = 'typed',
    whitelist = [],
    extraPatterns = [],
    patterns: patternOverride = null,
    valueMap = {},
    counters = {},
  } = options;

  const whitelistSet = new Set(whitelist.map(String));
  const activePatterns = patternOverride || [
    ...PATTERNS,
    ...extraPatterns,
  ].filter((p) => !enabled || enabled.includes(p.id));

  const matches = [];

  for (const pattern of activePatterns) {
    // A pattern may also find spans structurally rather than by regex --
    // `full_name` reads the field a value sits in. Its spans compete in the
    // same overlap resolution below as any regex match.
    if (typeof pattern.detect === 'function') {
      for (const span of pattern.detect(text)) {
        if (whitelistSet.has(span.original)) continue;
        matches.push({
          id: pattern.id,
          label: pattern.label,
          labelAr: pattern.labelAr,
          cat: pattern.cat,
          original: span.original,
          start: span.start,
          end: span.end,
          fakeValues: pattern.fakeValues,
        });
      }
    }

    // A detect-only pattern (`iban`) has no regex of its own.
    if (!pattern.rx) continue;

    // `d` (hasIndices) exposes each capture group's absolute offset, which is
    // how a pattern can match a wide context but replace only part of it.
    const flags = pattern.valueGroups && !pattern.rx.flags.includes('d')
      ? `${pattern.rx.flags}d`
      : pattern.rx.flags;
    const rx = new RegExp(pattern.rx.source, flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      const full = m[0];
      if (whitelistSet.has(full)) continue;
      // validate() always receives the WHOLE match. env_secret's stoplist needs
      // the key name, which sits outside the span it actually replaces.
      if (pattern.validate && !pattern.validate(full, text, m.index)) continue;

      let original = full;
      let start = m.index;
      let end = m.index + full.length;

      // A pattern that anchors on surrounding context (`API_KEY = "..."`) but
      // should only replace the secret itself declares the capture groups
      // holding that secret, most-specific first. Replacing the whole match
      // would destroy the key name -- which is exactly the context an agent
      // needs in order to reason about the masked file.
      if (pattern.valueGroups) {
        const g = pattern.valueGroups.find((i) => m[i] !== undefined);
        if (g === undefined || !m.indices || !m.indices[g]) continue;
        [start, end] = m.indices[g];
        original = m[g];
        if (whitelistSet.has(original)) continue;
      }

      matches.push({
        id: pattern.id,
        label: pattern.label,
        labelAr: pattern.labelAr,
        cat: pattern.cat,
        original,
        start,
        end,
        fakeValues: pattern.fakeValues,
      });
    }
  }

  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  const resolved = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start >= lastEnd) {
      resolved.push(match);
      lastEnd = match.end;
    }
  }

  // `resolved` is sorted by offset and non-overlapping, so one forward pass
  // both numbers the lines and assembles the output. Doing either per finding
  // -- recounting newlines from the start of the text, or rebuilding the whole
  // string for each replacement -- made masking quadratic in file size: 8,000
  // JSON lines took ~6 s with a single pattern enabled (issue #13).
  const findings = [];
  const parts = [];
  let line = 1;
  let nextNewline = text.indexOf('\n'); // first newline not yet counted
  let copied = 0;                       // text is copied into `parts` up to here
  for (const match of resolved) {
    const replacement = getReplacement(match, mode, valueMap, counters);
    while (nextNewline !== -1 && nextNewline < match.start) {
      line++;
      nextNewline = text.indexOf('\n', nextNewline + 1);
    }
    findings.push({
      id: match.id,
      label: match.label,
      labelAr: match.labelAr,
      cat: match.cat,
      original: match.original,
      replacement,
      line,
      offset: match.start,
    });
    parts.push(text.slice(copied, match.start), replacement);
    copied = match.start + match.original.length;
  }
  parts.push(text.slice(copied));
  const masked = parts.join('');

  return { masked, findings };
}

module.exports = { maskText, lineAtOffset };
