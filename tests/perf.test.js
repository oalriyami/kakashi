const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { maskText } = require('../src/engine/masker');
const ooxml = require('../src/engine/formats/ooxml');

// ---------------------------------------------------------------------------
// #38 -- no input of a few tens of kilobytes may take seconds.
//
// Each input below used to take from 2 s to well over a minute: an unbounded
// quantifier, a lookbehind over `\s+`, or a per-match scan to the start or end
// of the line turned the work quadratic. Most are 64 KB; the few that only
// blow up further are larger. Now every one runs in well under 200 ms, so the
// bound is generous and still catches any of them coming back.
// ---------------------------------------------------------------------------

const SIZE = 64 * 1024;
const BOUND_MS = 2000;

const rep = (s, n = SIZE) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

/** Meeting notes naming a different person on every line, from the name list. */
function distinctNames(n) {
  const data = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'engine', 'data', 'names-wikidata.json.br'))).toString());
  const given = data.given.filter((w) => /^[a-z]{4,9}$/.test(w));
  const family = data.family.filter((w) => /^[a-z]{5,10}$/.test(w));
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  let s = '';
  for (let k = 0; s.length < n; k++) {
    s += `Meeting notes: ${cap(given[(k * 7919) % given.length])} ${cap(family[(k * 104729) % family.length])} reviewed the figures.\n`;
  }
  return s;
}

const TEXT_INPUTS = {
  'spaces (sql_password)': rep(' '),
  'tabs (sql_password)': rep('\t'),
  'newlines (every pattern)': rep('\n'),
  'CRLF line ends': rep('\r\n'),
  'PASSWORD then spaces': `PASSWORD${rep(' ', SIZE - 8)}`,
  'a.a.a. (email)': rep('a.'),
  'a+a+a+ (email)': rep('a+'),
  '1.1.1. (email)': rep('1.'),
  'x@a.a.a. (email)': `x@${rep('a.', SIZE - 2)}`,
  'a-a-a- (env_secret)': rep('a-'),
  'Ab-Ab-Ab- (title words)': rep('Ab-'),
  'hi hi hi (greetings)': rep('hi '),
  'Dear Dear (greetings)': rep('Dear '),
  'Dr Dr Dr (greetings)': rep('Dr '),
  'thanks thanks (greetings)': rep('thanks '),
  'Hello Sarah, repeated': rep('Hello Sarah '),
  'one line of SHA-1s (hash context)': `{"h":[${rep('"da39a3ee5e6b4b0d3255bfef95601890afd80709",', 8 * SIZE)}]}`,
  'many distinct names (repeats)': distinctNames(4 * SIZE),
  'unterminated PEM blocks': rep('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n', 16 * SIZE),
};

const XML_INPUTS = {
  'unclosed <w:p': rep('<w:p ', 4 * SIZE),
  'unclosed <w:t': rep('<w:t ', 4 * SIZE),
  'unclosed <w:t a="/"': rep('<w:t a="/"/', 4 * SIZE),
  'unclosed <w:br': rep('<w:br ', 4 * SIZE),
};

const kb = (s) => `${Math.round(s.length / 1024)} KB`;

function timed(fn) {
  const t0 = Date.now();
  fn();
  return Date.now() - t0;
}

async function runPerfTests() {
  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`FAIL ${name}: ${err.message}`);
      failed++;
    }
  }

  maskText('warm up the name lists'); // loaded once, not counted below

  for (const [name, text] of Object.entries(TEXT_INPUTS)) {
    await check(`#38 ${kb(text)} of ${name} is scanned in under ${BOUND_MS} ms`, () => {
      const ms = timed(() => maskText(text));
      assert(ms < BOUND_MS, `took ${ms} ms`);
    });
  }

  for (const [name, xml] of Object.entries(XML_INPUTS)) {
    await check(`#38 ${kb(xml)} of ${name} is tokenised in under ${BOUND_MS} ms`, () => {
      const ms = timed(() => ooxml.findRuns(xml, ooxml.WORD));
      assert(ms < BOUND_MS, `took ${ms} ms`);
    });
  }

  await check('#38 doubling a long line no more than about doubles the time', () => {
    // Quadratic work shows as 4x per doubling; allow noise, not that.
    const small = rep('hi ', 256 * 1024);
    const large = rep('hi ', 512 * 1024);
    maskText(small);
    const a = Math.max(timed(() => maskText(small)), 20);
    const b = timed(() => maskText(large));
    assert(b < a * 3.2, `256 KB ${a} ms, 512 KB ${b} ms`);
  });

  // Bounding the patterns must not change what they find.
  await check('#38 sql_password masks only the quoted value, whatever the spacing', () => {
    const r = maskText("ALTER USER app IDENTIFIED   BY  'S3cret!Pw';\nCREATE ROLE r WITH PASSWORD \"An0ther!\";");
    const sql = r.findings.filter((f) => f.id === 'sql_password').map((f) => f.original);
    assert.deepStrictEqual(sql, ["'S3cret!Pw'", '"An0ther!"']);
    assert(r.masked.includes('IDENTIFIED   BY  '), 'the keyword must stay');
  });

  await check('#38 bounded email still finds ordinary and long addresses', () => {
    const local = 'first.last+tag';
    const host = `${'sub.'.repeat(10)}example.org`;
    const r = maskText(`mail ${local}@${host} or a.b@c.io`);
    const emails = r.findings.filter((f) => f.id === 'email').map((f) => f.original);
    assert.deepStrictEqual(emails, [`${local}@${host}`, 'a.b@c.io']);
  });

  await check('#38 a greeting still finds the name after it', () => {
    const r = maskText('Dear Rajesh Kumar,\nThanks for the update.');
    assert(r.findings.some((f) => f.original === 'Rajesh Kumar'), JSON.stringify(r.findings.map((f) => f.original)));
  });

  console.log(`perf.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runPerfTests, TEXT_INPUTS, XML_INPUTS };

if (require.main === module) {
  runPerfTests().then((ok) => process.exit(ok ? 0 : 1));
}
