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

// ---------------------------------------------------------------------------
// Many keys at once (#53).
//
// The writers used to search the text once per masked value: for every key,
// an indexOf pass over the whole part. A part with 20,000 addresses and a map
// of 20,000 keys cost 20,000 passes over 600 KB -- five seconds for one XML
// part, and again for every part and in every verification. An Aho-Corasick
// automaton finds every occurrence of every key in one pass over the text.
// ---------------------------------------------------------------------------

/** Below this many keys, one indexOf per key is faster than building an automaton. */
const SMALL = 16;

class KeyMatcher {
  /**
   * @param {string[]} keys - distinct, non-empty; their order is their rank
   * @param {object} [opts]
   * @param {boolean} [opts.plain=false] - substring matches only, no name guard
   */
  constructor(keys, { plain = false } = {}) {
    this.keys = keys.filter(Boolean);
    this.plain = plain;
    this.guards = this.keys.map((key) => {
      const guard = !plain && NAME_LIKE.test(key);
      return { start: guard && LETTER.test(key), end: guard && LETTER.test(key[key.length - 1]) };
    });
    if (this.keys.length > SMALL) this.build();
  }

  build() {
    // Trie over UTF-16 code units: edge (node, unit) -> child in one Map.
    this.next = new Map();
    this.children = [[]];
    this.out = [-1]; // key index ending at the node, or -1
    this.keys.forEach((key, idx) => {
      let node = 0;
      for (let i = 0; i < key.length; i++) {
        const edge = node * 65536 + key.charCodeAt(i);
        let child = this.next.get(edge);
        if (child === undefined) {
          child = this.out.length;
          this.next.set(edge, child);
          this.children[node].push(key.charCodeAt(i));
          this.children.push([]);
          this.out.push(-1);
        }
        node = child;
      }
      if (this.out[node] === -1) this.out[node] = idx;
    });
    // Failure links, and a link to the next node down the chain that ends a key.
    const n = this.out.length;
    this.fail = new Int32Array(n);
    this.dict = new Int32Array(n).fill(-1);
    const queue = [];
    for (const unit of this.children[0]) queue.push(this.next.get(unit));
    for (let h = 0; h < queue.length; h++) {
      const node = queue[h];
      for (const unit of this.children[node]) {
        const child = this.next.get(node * 65536 + unit);
        let f = this.fail[node];
        while (f !== 0 && !this.next.has(f * 65536 + unit)) f = this.fail[f];
        const to = this.next.get(f * 65536 + unit);
        this.fail[child] = to !== undefined && to !== child ? to : 0;
        this.dict[child] = this.out[this.fail[child]] !== -1 ? this.fail[child] : this.dict[this.fail[child]];
        queue.push(child);
      }
    }
  }

  usable(text, at, idx) {
    const g = this.guards[idx];
    const end = at + this.keys[idx].length;
    if (g.start && at > 0 && WORD_CHAR.test(text[at - 1])) return false;
    if (g.end && end < text.length && WORD_CHAR.test(text[end])) return false;
    return true;
  }

  /**
   * Every usable occurrence of every key.
   * @param {string} text
   * @returns {Array<{ at: number, idx: number }>} in no particular order
   */
  matches(text) {
    const found = [];
    if (!this.next) {
      this.keys.forEach((key, idx) => {
        for (let from = 0; ;) {
          const at = text.indexOf(key, from);
          if (at === -1) break;
          if (this.usable(text, at, idx)) found.push({ at, idx });
          from = at + 1;
        }
      });
      return found;
    }
    let node = 0;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      let to = this.next.get(node * 65536 + unit);
      while (to === undefined && node !== 0) {
        node = this.fail[node];
        to = this.next.get(node * 65536 + unit);
      }
      node = to === undefined ? 0 : to;
      for (let k = this.out[node] !== -1 ? node : this.dict[node]; k !== -1; k = this.dict[k]) {
        const idx = this.out[k];
        const at = i + 1 - this.keys[idx].length;
        if (this.usable(text, at, idx)) found.push({ at, idx });
      }
    }
    return found;
  }

  /** The keys that occur in `text`. */
  keysIn(text) {
    return new Set(this.matches(text).map((m) => this.keys[m.idx]));
  }

  /**
   * Non-overlapping spans: the longest key (lowest rank) claims its text
   * first, and an occurrence overlapping a claimed span is skipped.
   * @returns {Array<{ start, end, key }>} sorted by start
   */
  spans(text) {
    const all = this.matches(text).sort((a, b) => a.idx - b.idx || a.at - b.at);
    const claimed = new Uint8Array(text.length);
    const spans = [];
    for (const { at, idx } of all) {
      const end = at + this.keys[idx].length;
      let clashes = false;
      for (let i = at; i < end; i++) {
        if (claimed[i]) { clashes = true; break; }
      }
      if (clashes) continue;
      claimed.fill(1, at, end);
      spans.push({ start: at, end, key: this.keys[idx] });
    }
    return spans.sort((a, b) => a.start - b.start);
  }

  /** Replace every span with its value in `replMap`. */
  replace(text, replMap) {
    const spans = this.spans(text);
    if (spans.length === 0) return text;
    let out = '';
    let last = 0;
    for (const s of spans) {
      out += text.slice(last, s.start) + replMap[s.key];
      last = s.end;
    }
    return out + text.slice(last);
  }
}

/** Keys of a replacement map, longest first (ties keep the map's order). */
function orderKeys(replMap) {
  return Object.keys(replMap).filter(Boolean).sort((a, b) => b.length - a.length);
}

const matcherCache = new WeakMap();

/**
 * The matcher for a replacement map, longest key first. Built once per map:
 * a package's writer and verifier ask for it for every part.
 */
function matcherFor(replMap, { plain = false, keys } = {}) {
  let byMap = matcherCache.get(replMap);
  if (!byMap) {
    byMap = new Map();
    matcherCache.set(replMap, byMap);
  }
  const list = keys || orderKeys(replMap);
  const id = `${plain ? 'p' : 'g'}:${list.length}:${list.join('\u0000').length}`;
  const cached = byMap.get(id);
  if (cached && cached.keys.length === list.length && cached.keys.every((k, i) => k === list[i])) return cached;
  const m = new KeyMatcher(list, { plain });
  byMap.set(id, m);
  return m;
}

module.exports = { occurrences, replaceOccurrences, KeyMatcher, matcherFor, orderKeys };
