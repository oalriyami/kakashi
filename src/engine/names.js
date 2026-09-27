/**
 * Name list -- evidence about the words themselves.
 *
 * Phase 1 found names by the structure around them (a `full_name` key, a
 * `Name:` label, a column header). What that cannot see -- a name in running
 * Arabic text, a single first name after "Thanks,", a lower-case name in a log
 * line -- needs to know which words are names. This module answers that from a
 * local list; nothing is looked up over the network.
 *
 * Two sources, merged at load time:
 *   data/names-wikidata.json.br  given and family names from Wikidata (CC0),
 *                                built by scripts/build-name-list.js, plus the
 *                                names that are also everyday English words
 *   data/names-supplement.json   a hand-kept regional supplement: Gulf, South
 *                                Asian and Filipino names Wikidata lacks,
 *                                spelling variants, and Arabic names that are
 *                                also everyday words
 *
 * Words are compared after normalisation: case-folded, accents dropped, and for
 * Arabic the hamza and alef forms, taa marbuta, alef maqsura, tatweel and
 * diacritics unified, so `Muḥammad`, `MUHAMMAD` and `muhammad` -- or `أحمد`
 * and `احمد` -- are the same key. Family names are also stored and looked up
 * without an `Al-` / `ال` prefix.
 *
 * An AMBIGUOUS name is also an everyday word (`Will`, `Hope`, `Grace` in lower
 * case; `أمل` "hope", `نور` "light"). Callers treat it as a name only with
 * other evidence: Title Case, a neighbouring unambiguous name, or a cue.
 *
 * Loaded lazily on first use and cached; about 30 ms and a few MB of memory.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, 'data');
const WIKIDATA_FILE = path.join(DATA_DIR, 'names-wikidata.json.br');
const SUPPLEMENT_FILE = path.join(DATA_DIR, 'names-supplement.json');

const ARABIC_RX = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

/** Latin key: `José` -> `jose`, `O'Brien` -> `obrien`, `MARIA` -> `maria`. */
function normalizeLatin(word) {
  return String(word)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
}

/**
 * Arabic key: diacritics and tatweel dropped; أ إ آ ٱ -> ا; ة -> ه; ى / ی -> ي;
 * ک -> ك. Persian and Urdu letter forms fold onto their Arabic twins so the
 * Wikidata labels in those languages still match.
 */
function normalizeArabic(word) {
  return String(word)
    .normalize('NFC')
    .replace(/[ً-ٰٟۖ-ۭ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ةۀ]/g, 'ه')
    .replace(/[ىی]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/^[^؀-ۿ]+|[^؀-ۿ]+$/g, '');
}

function isArabic(word) {
  return ARABIC_RX.test(word);
}

const keyCache = new Map();

/** The lookup key for one word, in whichever script it is written. */
function nameKey(word) {
  let k = keyCache.get(word);
  if (k === undefined) {
    k = isArabic(word) ? normalizeArabic(word) : normalizeLatin(word);
    if (keyCache.size > 50000) keyCache.clear();
    keyCache.set(word, k);
  }
  return k;
}

/**
 * The key without a family prefix: `Al-Kaabi` -> `kaabi`, `El-Sayed` ->
 * `sayed`, `الكعبي` -> `كعبي`. Returns null when there is no prefix to drop.
 */
function stripFamilyPrefix(key) {
  if (/^[؀-ۿ]/.test(key)) {
    const m = /^ال(.{2,})$/.exec(key);
    return m ? m[1] : null;
  }
  const m = /^(?:al|el)-?(.{3,})$/.exec(key);
  return m && key.includes('-') ? m[1] : null;
}

let cache = null;

function load() {
  if (cache) return cache;
  const sets = {
    given: new Set(),
    family: new Set(),
    ambiguous: new Set(),
  };
  const add = (set, words, familyForm) => {
    for (const w of words || []) {
      const k = nameKey(w);
      if (!k) continue;
      set.add(k);
      if (familyForm) {
        const bare = stripFamilyPrefix(k);
        if (bare) set.add(bare);
      }
    }
  };
  for (const file of [WIKIDATA_FILE, SUPPLEMENT_FILE]) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file);
    const json = JSON.parse(file.endsWith('.br') ? zlib.brotliDecompressSync(raw).toString('utf8') : raw.toString('utf8'));
    add(sets.given, json.given, false);
    add(sets.family, json.family, true);
    add(sets.ambiguous, json.ambiguous, false);
    // The supplement can also clear a word Wikidata lists as a name.
    for (const w of json.notNames || []) {
      const k = nameKey(w);
      sets.given.delete(k);
      sets.family.delete(k);
    }
  }
  cache = sets;
  return cache;
}

/** Is `word` a known given (first) name? */
function isGivenName(word) {
  const k = nameKey(word);
  return Boolean(k) && load().given.has(k);
}

/** Is `word` a known family name, with or without an `Al-` / `ال` prefix? */
function isFamilyName(word) {
  const k = nameKey(word);
  if (!k) return false;
  const { family } = load();
  if (family.has(k)) return true;
  const bare = stripFamilyPrefix(k);
  return Boolean(bare) && family.has(bare);
}

/** Is `word` any known name? */
function isKnownName(word) {
  return isGivenName(word) || isFamilyName(word);
}

/**
 * Is `word` a name that is also an everyday word (`will`, `hope`, `أمل`)?
 * Only meaningful for words that are names at all.
 */
function isAmbiguousName(word) {
  const k = nameKey(word);
  return Boolean(k) && load().ambiguous.has(k);
}

/** Counts, for tests and `list-patterns`-style diagnostics. */
function stats() {
  const { given, family, ambiguous } = load();
  return { given: given.size, family: family.size, ambiguous: ambiguous.size };
}

module.exports = {
  normalizeLatin,
  normalizeArabic,
  nameKey,
  stripFamilyPrefix,
  isArabic,
  isGivenName,
  isFamilyName,
  isKnownName,
  isAmbiguousName,
  stats,
  WIKIDATA_FILE,
  SUPPLEMENT_FILE,
};
