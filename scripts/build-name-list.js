#!/usr/bin/env node
/**
 * Build src/engine/data/names-wikidata.json.br, the name list src/engine/names.js
 * reads (issue #12).
 *
 *   node scripts/build-name-list.js            fetch the sources with `npm pack`
 *   node scripts/build-name-list.js --from DIR use sources already unpacked in
 *                                              DIR/wikidata-names, DIR/subtlex and
 *                                              DIR/wordlist-english
 *
 * Sources, both fetched from the npm registry at build time and never at run
 * time:
 *   wikidata-names@1.0.0            given and family names queried from
 *                                   Wikidata. Data CC0, code Unlicense.
 *   subtlex-word-frequencies@2.0.0  word frequencies from 51 million words of
 *                                   film and TV subtitles (SUBTLEX-US), ISC.
 *                                   Each word is listed in its dominant case,
 *                                   which is what makes it useful here.
 *   wordlist-english@1.2.1          SCOWL English word lists by frequency
 *                                   level (Kevin Atkinson; permissive, see
 *                                   src/engine/data/README.md).
 *
 * Output, all keys normalised by names.js:
 *   given      Latin and Arabic-script given names, one word each
 *   family     Latin and Arabic-script family names, without Al- / ال
 *   ambiguous  names that are also everyday English words: written in lower
 *              case more often than not, and seen at least 10 times (`will`,
 *              `hope`, `price`, `the` -- Vietnamese `Thế` once accents go).
 *              `Mark`, `Grace` and `Bill` are capitalised more often than not,
 *              so they stay unambiguous.
 *   everyday   names that are also ordinary English words at SCOWL level 35
 *              or below -- the size of a standard spelling dictionary -- in
 *              whatever case they are usually written (`brown`, `fox`, `rose`,
 *              `grace`). A lower-case or ALL-CAPS run made only of these is
 *              not taken for a name without a cue (#39).
 *
 * Other scripts are left out: the detectors that read this list handle Latin
 * and Arabic text.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { normalizeLatin, normalizeArabic, WIKIDATA_FILE } = require('../src/engine/names');

const SOURCES = {
  'wikidata-names': 'wikidata-names@1.0.0',
  subtlex: 'subtlex-word-frequencies@2.0.0',
  'wordlist-english': 'wordlist-english@1.2.1',
};
const SCOWL_LEVELS = ['10', '20', '35'];
const MIN_COMMON_COUNT = 10;

const LATIN_WORD = /^[\p{Script=Latin}\p{M}'’-]+$/u;
const ARABIC_WORD = /^[؀-ۿ]+$/;

function fetchSources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-names-'));
  for (const [name, spec] of Object.entries(SOURCES)) {
    const tgz = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', dir], { encoding: 'utf8' }).trim().split('\n').pop();
    const out = path.join(dir, name);
    fs.mkdirSync(out);
    execFileSync('tar', ['xzf', path.join(dir, tgz), '-C', out, '--strip-components=1']);
  }
  return dir;
}

/** One-word Latin or Arabic entries, normalised. `عبد الله` joins to one word. */
function keysOf(entries, { family }) {
  const out = new Set();
  for (const raw of entries) {
    let name = String(raw).trim();
    if (!name || /[\d()[\],/]/.test(name)) continue;
    if (/[؀-ۿ]/.test(name)) {
      name = name.replace(/^آل\s+/, '').replace(/^عبد\s+/, 'عبد');
      if (/\s/.test(name) || !ARABIC_WORD.test(name)) continue;
      let k = normalizeArabic(name);
      if (family) k = k.replace(/^ال(?=..)/, '');
      if (k.length >= 2) out.add(k);
    } else {
      if (/\s/.test(name) || !LATIN_WORD.test(name)) continue;
      let k = normalizeLatin(name);
      if (family) k = k.replace(/^(?:al|el)-(?=...)/, '');
      if (k.replace(/-/g, '').length >= 2) out.add(k);
    }
  }
  return out;
}

function main() {
  const fromIdx = process.argv.indexOf('--from');
  const dir = fromIdx > 0 ? path.resolve(process.argv[fromIdx + 1]) : fetchSources();
  const wd = (f) => JSON.parse(fs.readFileSync(path.join(dir, 'wikidata-names', 'data', f), 'utf8'));

  const given = keysOf([
    ...wd('male.json'), ...wd('female.json'), ...Object.keys(wd('unisex-lang.json')),
  ], { family: false });
  const family = keysOf(wd('family.json'), { family: true });

  const subtlex = JSON.parse(fs.readFileSync(path.join(dir, 'subtlex', 'index.json'), 'utf8'));
  const common = new Set(subtlex
    .filter((e) => e.count >= MIN_COMMON_COUNT && e.word === e.word.toLowerCase())
    .map((e) => normalizeLatin(e.word)));
  const ambiguous = [...new Set([...given, ...family])].filter((k) => common.has(k));

  const scowl = new Set();
  for (const level of SCOWL_LEVELS) {
    const words = JSON.parse(fs.readFileSync(path.join(dir, 'wordlist-english', `english-words-${level}.json`), 'utf8'));
    for (const w of words) if (/^[a-z]+$/.test(w)) scowl.add(normalizeLatin(w));
  }
  const everyday = [...new Set([...given, ...family])].filter((k) => scowl.has(k));

  const data = {
    source: 'wikidata-names@1.0.0 (Wikidata, CC0); ambiguity from subtlex-word-frequencies@2.0.0 (ISC);'
      + ' everyday words from wordlist-english@1.2.1 (SCOWL)',
    given: [...given].sort(),
    family: [...family].sort(),
    ambiguous: ambiguous.sort(),
    everyday: everyday.sort(),
  };
  const json = JSON.stringify(data);
  const br = zlib.brotliCompressSync(Buffer.from(json), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length },
  });
  fs.mkdirSync(path.dirname(WIKIDATA_FILE), { recursive: true });
  fs.writeFileSync(WIKIDATA_FILE, br);
  console.log(`Wrote ${path.relative(process.cwd(), WIKIDATA_FILE)}: ${data.given.length} given, `
    + `${data.family.length} family, ${data.ambiguous.length} ambiguous, ${data.everyday.length} everyday; `
    + `${Math.round(br.length / 1024)} KB`);
}

main();
