/**
 * Occurrence finding for the format writers.
 *
 * The xlsx, docx and pptx writers patch the original file by searching each
 * cell or paragraph for every masked value. A plain substring search is right
 * for secrets -- a key glued to other text is still the key -- but wrong for
 * names: masking `Ali` must not turn `Alignment` into `[FULL_NAME_1]gnment`.
 *
 * So a value that is purely a name (letters, marks, spaces, apostrophes,
 * hyphens, dots) only matches where it is not glued to another letter or digit
 * on a side that begins or ends with a letter. Anything containing a digit or a
 * symbol keeps plain substring matching, exactly as before.
 */

const NAME_LIKE = /^[\p{L}\p{M}'’. -]+$/u;
const LETTER = /^\p{L}/u;
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

/**
 * Start offsets of every usable occurrence of `key` in `text`.
 * @param {string} text
 * @param {string} key
 * @returns {number[]}
 */
function occurrences(text, key) {
  const out = [];
  if (!key) return out;
  const guard = NAME_LIKE.test(key);
  const guardStart = guard && LETTER.test(key);
  const guardEnd = guard && LETTER.test(key[key.length - 1]);
  let from = 0;
  for (;;) {
    const at = text.indexOf(key, from);
    if (at === -1) break;
    const end = at + key.length;
    const gluedBefore = guardStart && at > 0 && WORD_CHAR.test(text[at - 1]);
    const gluedAfter = guardEnd && end < text.length && WORD_CHAR.test(text[end]);
    if (!gluedBefore && !gluedAfter) out.push(at);
    from = at + 1;
  }
  return out;
}

/**
 * Replace every usable occurrence of `key` with `replacement`.
 * @param {string} text
 * @param {string} key
 * @param {string} replacement
 */
function replaceOccurrences(text, key, replacement) {
  const hits = occurrences(text, key);
  if (hits.length === 0) return text;
  let out = '';
  let last = 0;
  for (const at of hits) {
    if (at < last) continue; // overlapping repeat of the same key
    out += text.slice(last, at) + replacement;
    last = at + key.length;
  }
  return out + text.slice(last);
}

module.exports = { occurrences, replaceOccurrences };
