/**
 * Name spans found by the words themselves (issue #12, phase 2).
 *
 * Phase 1 (person-fields.js) reads the structure around a value. These
 * detectors use the name list (names.js) for what structure cannot show:
 *
 *   arabic      Arabic runs are segmented and a span must START at a known
 *               given name (or a nasab particle followed by a name), so
 *               `يرجى مراجعة التقرير المرفق` is prose while the name inside
 *               `يرجى إرسال العقد إلى محمد بن راشد قبل الخميس` is still found.
 *   caseless    lower-case and ALL-CAPS Latin names in running text
 *               (`ask rajesh kumar`, `PAY TO PRIYA NAIR`): two or more listed
 *               names, starting with a given name, none an everyday word.
 *   salutation  a single given name after a greeting or title
 *               (`Thanks, Fatima`, `Dear Anil`, `Dr Kumar`, `السيد راشد`).
 *   repeats     a given or family name that repeats part of a full name
 *               found elsewhere in the same text (`Maria Santos ... Maria`).
 *
 * Every span carries a confidence: 'high' when a cue says outright that a name
 * follows, 'medium' when the evidence is the name list. (Title Case alone, the
 * `full_name` regex, is 'low'; person fields are 'high'.)
 *
 * Pure and synchronous, like person-fields.js.
 */

const {
  isGivenName, isFamilyName, isAmbiguousName, isEverydayWord, normalizeArabic,
} = require('./names');

/**
 * Arabic LETTERS and marks: the Arabic block minus its punctuation and digits
 * (، ؛ ؟ ٪ ۔ ٠-٩ ۰-۹), which would otherwise glue onto a name (`محمد،`).
 */
const AR_LETTERS = '\\u0621-\\u065F\\u066E-\\u06D3\\u06D5-\\u06EF\\u06FA-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF';
const AR_WORD_RX = new RegExp(`[${AR_LETTERS}]+`, 'g');
const LATIN_WORD_RX = /[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*/g;

/** Lower-case connectors inside Latin names: `bin`, `al`, `dela`, `van`. */
const LATIN_PARTICLES = new Set([
  'bin', 'bint', 'ibn', 'al', 'el', 'de', 'del', 'dela', 'della', 'da', 'das',
  'dos', 'du', 'van', 'von', 'der', 'den', 'le', 'la', 'di', 'y',
]);

/** Greetings and sign-offs after which one given name is a person. */
const GREETINGS = ['hi', 'hello', 'hey', 'dear', 'thanks', 'thank you', 'thx', 'cheers',
  'regards', 'kind regards', 'best regards', 'best wishes', 'sincerely', 'bye', 'welcome', 'congrats',
  'congratulations'];
/** Titles, after which a family name alone is a person too. */
const TITLES = ['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'eng', 'sheikh', 'sheikha', 'attn'];
const SALUTATION_RX = new RegExp(
  `(?<![\\p{L}\\p{M}])(${[...GREETINGS, ...TITLES].map((w) => w.replace(' ', '[ \\t]{1,8}')).join('|')})`
  // Bounded gaps: two adjacent unbounded `[ \t]*` runs backtrack quadratically
  // over a long run of blanks after a greeting (#38).
  + '(?![\\p{L}\\p{M}])\\.?[ \\t]{0,8}[,:!]?[ \\t]{0,8}(?:\\r?\\n[ \\t]{0,8})?'
  + '(?=[A-Za-z\\u00C0-\\u024F])',
  'giu',
);

/** Arabic greetings and titles; the token after one may be a lone name. */
const AR_SALUTATIONS = new Set([
  'السيد', 'السيدة', 'الآنسة', 'الانسة', 'الأستاذ', 'الاستاذ', 'الأستاذة', 'الاستاذة',
  'الدكتور', 'الدكتورة', 'د', 'المهندس', 'المهندسة', 'م', 'الشيخ', 'الشيخة', 'سعادة', 'معالي',
  'سمو', 'الأخ', 'الاخ', 'الأخت', 'الاخت', 'عزيزي', 'عزيزتي', 'مرحبا', 'أهلا', 'اهلا', 'شكرا',
  'تحياتي', 'المرسل', 'المستلم',
].map(normalizeArabic));

const AR_NASAB = new Set(['بن', 'بنت', 'ابن'].map(normalizeArabic));
const AR_HEAD_PARTICLES = new Set(['عبد', 'أبو', 'ابو', 'أم', 'ام'].map(normalizeArabic));
/** Heads that also start places (أبو ظبي, أم القيوين): alone, not a name. */
const AR_PLACE_HEADS = new Set(['أبو', 'ابو', 'أم', 'ام'].map(normalizeArabic));
const AR_FAMILY_PARTICLES = new Set(['آل'].map(normalizeArabic));
/**
 * `ال…ي`: the nisba form most Gulf family names take (الكعبي, المنصوري).
 * Tested on the unfolded word: folding ى into ي made المستوى ("the level")
 * and every other `ال…ى` word look like one (#39).
 */
const AR_NISBA_RX = /^ال[؀-ۿ]{2,}ي$/;

/**
 * Words just before a lower-case or ALL-CAPS name that say a person follows:
 * `please ask grace hopper`, `reassigned to priya nair`, `PAY TO RAJESH KUMAR`.
 */
const CASELESS_CUE_RX = /(?:^|[^\p{L}])(?:ask|asked|tell|told|contact|call|called|email|emailed|ping|cc|meet|met|with|from|to|by|for|thanks|thank you|assigned|reassigned|user|agent|driver|dear|hi|hello|attn)[ \t]{0,8}[:,]?[ \t]{1,8}$/iu;

/**
 * Places and countries that are also names, which a lone repeated word must
 * not be taken for: `Jordan Carter … will fly to Jordan` (#39).
 */
const LONE_PLACE_NAMES = new Set([
  'jordan', 'chad', 'georgia', 'india', 'kenya', 'israel', 'oman', 'qatar', 'egypt', 'sudan',
  'lebanon', 'syria', 'iraq', 'iran', 'yemen', 'libya', 'morocco', 'tunisia', 'algeria',
  'kuwait', 'bahrain', 'pakistan', 'nepal', 'china', 'japan', 'korea', 'france', 'spain',
  'italy', 'germany', 'brazil', 'peru', 'chile', 'cuba', 'mali', 'niger', 'jamaica',
  'dubai', 'sharjah', 'ajman', 'fujairah', 'riyadh', 'jeddah', 'doha', 'muscat', 'amman',
  'cairo', 'beirut', 'paris', 'london', 'sydney', 'victoria', 'florence', 'austin',
  'dallas', 'houston', 'denver', 'phoenix', 'orlando', 'madison', 'lincoln', 'charlotte',
  'chelsea', 'aurora', 'savannah', 'sofia', 'valencia', 'medina', 'makkah', 'mecca',
]);

const RANK = { low: 0, medium: 1, high: 2 };

/**
 * @param {object} deps
 * @param {Set<string>} deps.commonEn - ordinary English words (lower case)
 * @param {Set<string>} deps.commonAr - ordinary Arabic words
 * @param {function(string[]):boolean} deps.isOrgOrPlace
 * @param {RegExp} deps.nameCueRx - a cue that a name follows, anchored at the end
 * @param {RegExp} deps.titleCaseRx - the `full_name` regex (global)
 * @param {function(string,string,number):boolean} deps.titleCaseValidate
 * @param {function(string,string,number):string} [deps.titleCaseConfidence]
 */
function createNameSpanDetectors({
  commonEn, commonAr, isOrgOrPlace, nameCueRx, titleCaseRx, titleCaseValidate, titleCaseConfidence = null,
}) {
  // Stop-words are compared WITHOUT the letter folding names get: folding ى
  // into ي would make the preposition على ("on") the name علي (Ali).
  const lightAr = (w) => w.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  const commonArLight = new Set([...commonAr].map(lightAr));
  const isCommonEn = (w) => commonEn.has(w.toLowerCase().replace(/['’]/g, ''));

  /** An unambiguous listed name that is not an everyday English word. */
  const strongLatin = (w, { family = true } = {}) => !isCommonEn(w) && !isAmbiguousName(w)
    && (isGivenName(w) || (family && isFamilyName(w)));

  const cueBefore = (text, idx) => nameCueRx.test(text.slice(Math.max(0, idx - 24), idx));
  const caselessCueBefore = (text, idx) => cueBefore(text, idx)
    || CASELESS_CUE_RX.test(text.slice(Math.max(0, idx - 24), idx));
  /** A word glued to a digit is part of a code, not a word: `JO94CBJO…` (#39). */
  const gluedToDigit = (text, start, end) => /\d/.test(text[start - 1] || '') || /\d/.test(text[end] || '');

  // -------------------------------------------------------------------------
  // Arabic
  // -------------------------------------------------------------------------

  function arTokens(text) {
    const runs = [];
    let run = null;
    AR_WORD_RX.lastIndex = 0;
    let m;
    while ((m = AR_WORD_RX.exec(text)) !== null) {
      const tok = { raw: m[0], norm: normalizeArabic(m[0]), light: lightAr(m[0]), start: m.index, end: m.index + m[0].length };
      if (run && /^[ \t]+$/.test(text.slice(run[run.length - 1].end, tok.start))) run.push(tok);
      else runs.push(run = [tok]);
    }
    return runs;
  }

  const arCommon = (t) => commonArLight.has(t.light || lightAr(t.raw));
  const arName = (t, { ambiguous = true } = {}) => !arCommon(t)
    && (isGivenName(t.raw) || isFamilyName(t.raw)) && (ambiguous || !isAmbiguousName(t.raw));
  const arGivenStrong = (t) => !arCommon(t) && isGivenName(t.raw) && !isAmbiguousName(t.raw);
  const arNisba = (t) => AR_NISBA_RX.test(t.light || lightAr(t.raw)) && !arCommon(t);

  /** Tokens [i, n) of `run` that continue a name, or 0. */
  function arUnit(run, i) {
    const t = run[i];
    const next = run[i + 1];
    if (!t) return 0;
    if ((AR_NASAB.has(t.norm) || AR_FAMILY_PARTICLES.has(t.norm)) && next
      && (arName(next) || arNisba(next) || AR_FAMILY_PARTICLES.has(t.norm))) return 2;
    if (AR_HEAD_PARTICLES.has(t.norm) && next && (arName(next) || next.norm.startsWith('ال'))) return 2;
    if (arName(t) || arNisba(t)) return 1;
    return 0;
  }

  function detectArabic(text) {
    const spans = [];
    for (const run of arTokens(text)) {
      let i = 0;
      while (i < run.length) {
        const t = run[i];
        const prev = run[i - 1];
        const cue = (prev && AR_SALUTATIONS.has(prev.norm)) || (i === 0 && cueBefore(text, t.start));
        // A span starts at a given name, or at a head particle followed by a
        // name (`عبد الله`, `أبو بكر`). An ambiguous given name (`أمل`, `نور`)
        // needs a cue or a strong next token.
        let head = 0;
        if (AR_HEAD_PARTICLES.has(t.norm)) {
          head = arUnit(run, i);
        } else if (!arCommon(t) && isGivenName(t.raw)) {
          const next = run[i + 1];
          const strongNext = next && (arGivenStrong(next) || (!arCommon(next) && isFamilyName(next.raw) && !isAmbiguousName(next.raw))
            || AR_NASAB.has(next.norm) || AR_FAMILY_PARTICLES.has(next.norm));
          if (cue || !isAmbiguousName(t.raw) || strongNext) head = 1;
        }
        if (!head) { i++; continue; }

        let j = i + head;
        while (j < run.length && j - i < 7) {
          const n = arUnit(run, j);
          if (!n) break;
          j += n;
        }
        const toks = run.slice(i, j);
        // `عبد الله` alone is a name; `أبو ظبي` alone is a place.
        const isHeadOnly = AR_PLACE_HEADS.has(t.norm) && j - i === head;
        const enough = cue ? toks.length >= 1 : toks.length >= 2 && !isHeadOnly;
        if (enough && !isOrgOrPlace(toks.map((x) => x.raw))) {
          const start = toks[0].start;
          const end = toks[toks.length - 1].end;
          spans.push({ start, end, original: text.slice(start, end), confidence: cue ? 'high' : 'medium' });
          i = j;
        } else {
          i++;
        }
      }
    }
    return spans.concat(repeats(text, spans, 'arabic'));
  }

  // -------------------------------------------------------------------------
  // Latin
  // -------------------------------------------------------------------------

  function latinWords(text) {
    const runs = [];
    let run = null;
    LATIN_WORD_RX.lastIndex = 0;
    let m;
    while ((m = LATIN_WORD_RX.exec(text)) !== null) {
      if (gluedToDigit(text, m.index, m.index + m[0].length)) { run = null; continue; }
      const w = { raw: m[0].replace(/['’-]+$/, ''), start: m.index };
      w.end = w.start + w.raw.length;
      if (run && /^[ \t]+$/.test(text.slice(run[run.length - 1].end, w.start))) run.push(w);
      else runs.push(run = [w]);
    }
    return runs;
  }

  /**
   * Up to `max` Latin words starting exactly at `at` and separated only by
   * spaces or tabs, with offsets relative to `at` (the shape latinWords gives).
   */
  function wordsAt(text, at, max) {
    const words = [];
    const rx = new RegExp(LATIN_WORD_RX.source, 'y');
    let pos = at;
    while (words.length < max) {
      rx.lastIndex = pos;
      const m = rx.exec(text);
      if (!m || gluedToDigit(text, m.index, m.index + m[0].length)) break;
      const raw = m[0].replace(/['’-]+$/, '');
      words.push({ raw, start: pos - at, end: pos - at + raw.length });
      // As in latinWords, the gap is measured from the end of the word with
      // its trailing apostrophes and hyphens removed.
      const gap = /[ \t]+/y;
      gap.lastIndex = pos + raw.length;
      if (!gap.test(text)) break;
      pos = gap.lastIndex;
    }
    return words;
  }

  const caseOf = (w) => {
    if (w === w.toLowerCase()) return 'lower';
    if (w === w.toUpperCase()) return 'upper';
    return 'title';
  };

  /**
   * From word i of `run`, the end index (exclusive) of a name made of listed
   * names and particles in one letter case, or i when there is none.
   */
  function extendLatin(run, i, wordCase) {
    let j = i;
    let names = 0;
    while (j < run.length && j - i < 5) {
      const w = run[j];
      if (wordCase && caseOf(w.raw) !== wordCase && !(w.raw.length === 1)) break;
      const lw = w.raw.toLowerCase();
      if (names > 0 && LATIN_PARTICLES.has(lw) && run[j + 1] && strongLatin(run[j + 1].raw)) { j += 1; continue; }
      if (!strongLatin(w.raw, { family: names > 0 })) break;
      names += 1;
      j += 1;
    }
    return names >= 1 ? j : i;
  }

  function detectCaseless(text) {
    const spans = [];
    for (const run of latinWords(text)) {
      let i = 0;
      while (i < run.length) {
        const w = run[i];
        const wc = caseOf(w.raw);
        if (wc === 'title' || !isGivenName(w.raw) || !strongLatin(w.raw, { family: false })) { i++; continue; }
        const j = extendLatin(run, i, wc);
        const toks = run.slice(i, j);
        const nameToks = toks.filter((t) => !LATIN_PARTICLES.has(t.raw.toLowerCase()));
        // Names that are all dictionary words need a cue: `the quick brown
        // fox` is not a person, `please ask grace hopper` is (#39).
        const everyday = nameToks.every((t) => isEverydayWord(t.raw));
        if (nameToks.length >= 2 && !(everyday && !caselessCueBefore(text, toks[0].start))
          && !isOrgOrPlace(toks.map((t) => t.raw))) {
          spans.push({ start: toks[0].start, end: toks[toks.length - 1].end, original: text.slice(toks[0].start, toks[toks.length - 1].end), confidence: 'medium' });
          i = j;
        } else {
          i++;
        }
      }
    }
    return spans;
  }

  function detectSalutations(text) {
    const spans = [];
    SALUTATION_RX.lastIndex = 0;
    let m;
    while ((m = SALUTATION_RX.exec(text)) !== null) {
      const word = m[1].toLowerCase().replace(/\s+/g, ' ');
      const isTitle = TITLES.includes(word);
      const at = m.index + m[0].length;
      // The name after the greeting is at most five words, read straight from
      // the text. Slicing and splitting the whole rest of the line for every
      // greeting was quadratic on a long line (#38).
      const run = wordsAt(text, at, 6);
      if (!run.length) continue;
      const first = run[0].raw;
      if (isCommonEn(first) || isAmbiguousName(first)) continue;
      if (!(isGivenName(first) || (isTitle && isFamilyName(first)))) continue;
      // Take following listed names too: `Dear Rajesh Kumar`.
      let j = 1;
      while (j < run.length && j < 5 && (strongLatin(run[j].raw)
        || (LATIN_PARTICLES.has(run[j].raw.toLowerCase()) && run[j + 1] && strongLatin(run[j + 1].raw)))) j++;
      const start = at + run[0].start;
      const end = at + run[j - 1].end;
      const toks = run.slice(0, j).map((t) => t.raw);
      if (isOrgOrPlace(toks)) continue;
      // The title and the word after the name belong to the veto too:
      // `Sheikh Zayed Road` is a road, not Mr Zayed (#39).
      const title = text.slice(m.index, m.index + m[1].length);
      if (run[j] && isOrgOrPlace([title, ...toks, run[j].raw])) continue;
      spans.push({ start, end, original: text.slice(start, end), confidence: 'medium' });
    }
    return spans;
  }

  /** Title Case names the `full_name` regex would keep, for repeats. */
  function titleCaseNames(text) {
    const rx = new RegExp(titleCaseRx.source, titleCaseRx.flags.includes('g') ? titleCaseRx.flags : `${titleCaseRx.flags}g`);
    const out = [];
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (!titleCaseValidate(m[0], text, m.index)) continue;
      const confidence = titleCaseConfidence ? titleCaseConfidence(m[0], text, m.index) : 'low';
      out.push({ start: m.index, end: m.index + m[0].length, original: m[0], confidence });
    }
    return out;
  }

  /**
   * A first or last name that repeats part of a full name found in the same
   * text: `Maria Santos joined in 2019. Maria leads the audit.`
   */
  function repeats(text, found, script) {
    // Each part keeps the confidence of the strongest full name it came from:
    // a repeat is no surer than its source (#39).
    const parts = new Map();
    const add = (part, confidence = 'medium') => {
      const had = parts.get(part);
      if (!had || RANK[confidence] > RANK[had]) parts.set(part, confidence);
    };
    for (const s of found) {
      const words = s.original.split(/[ \t]+/).filter(Boolean);
      if (words.length < 2) continue;
      const [first] = words;
      const last = words[words.length - 1];
      if (script === 'arabic') {
        const t = { raw: first, norm: normalizeArabic(first), light: lightAr(first) };
        if (arGivenStrong(t) && first.length >= 3) add(first, s.confidence);
      } else {
        // A lone repeated word that is also a place stays a place.
        const place = (w) => LONE_PLACE_NAMES.has(w.toLowerCase()) || isOrgOrPlace([w]);
        if (first.length >= 3 && isGivenName(first) && strongLatin(first) && !place(first)) add(first, s.confidence);
        if (last.length >= 3 && isFamilyName(last) && strongLatin(last) && !place(last)) add(last, s.confidence);
      }
    }
    const letter = script === 'arabic' ? AR_LETTERS : '\\p{L}\\p{M}';
    // Found spans sorted by start, for a binary-search overlap test: checking
    // every occurrence against every span was quadratic on long documents.
    const sorted = found.map((s) => [s.start, s.end]).sort((a, b) => a[0] - b[0]);
    let maxEnd = 0;
    const reach = sorted.map(([, e]) => (maxEnd = Math.max(maxEnd, e)));
    const covered = (start, end) => {
      let lo = 0;
      let hi = sorted.length - 1;
      let last = -1; // last span starting before `end`
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid][0] < end) { last = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return last >= 0 && reach[last] > start;
    };
    const spans = [];
    if (parts.size === 0) return spans;
    // One pass over the text. An occurrence counts only where it is not glued
    // to another letter, apostrophe or hyphen on either side -- which makes it
    // exactly a maximal run of those characters, so a Set lookup per run gives
    // the same answer one regex per part did, without scanning the text once
    // per distinct name (16,000 names in 810 KB took 36 s, #38).
    const runRx = new RegExp(`[${letter}'’-]+`, 'gu');
    let m;
    while ((m = runRx.exec(text)) !== null) {
      if (!parts.has(m[0])) continue;
      const start = m.index;
      const end = start + m[0].length;
      // Only occurrences OUTSIDE the full names they came from: inside one,
      // the full name already covers it (and a whitelisted full name must
      // not leak its first word).
      if (covered(start, end)) continue;
      spans.push({ start, end, original: m[0], confidence: parts.get(m[0]) });
    }
    return spans;
  }

  /** Every list-based Latin span, plus repeats of any Latin full name in the text. */
  function detectLatin(text, fieldSpans = []) {
    const caseless = detectCaseless(text);
    const salutations = detectSalutations(text);
    const found = [...titleCaseNames(text), ...caseless, ...salutations,
      ...fieldSpans.filter((s) => !/[؀-ۿ]/.test(s.original))];
    return [...caseless, ...salutations, ...repeats(text, found, 'latin')];
  }

  return { detectArabic, detectLatin, detectCaseless, detectSalutations };
}

/** Does `confidence` meet `min`? Spans without a confidence always pass. */
function meetsConfidence(confidence, min) {
  if (!min || !confidence) return true;
  return RANK[confidence] >= RANK[min];
}

module.exports = { createNameSpanDetectors, meetsConfidence, LATIN_PARTICLES, RANK };
