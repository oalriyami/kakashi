/**
 * Fake values for `--mode fake`: one distinct value per distinct original.
 *
 * Fake mode used to cycle through each pattern's short `fakeValues` list --
 * usually two entries -- so the third email became the first email's fake and
 * two different people looked like one. Anything that counts, groups or joins
 * masked data then got wrong answers (issue #15).
 *
 * Now the n-th distinct original of a pattern gets the n-th fake:
 *   - the pattern's own `fakeValues` first, so existing output is unchanged
 *     for the first originals;
 *   - then a generated value in the same format.
 *
 * Generated values are deterministic (the same run always produces the same
 * fakes), stay detectable by their pattern where the format allows it -- the
 * Guardian's verifier relies on re-detecting synthesised values -- and, where a
 * format allows it, can never be live:
 *   Emirates ID  a deliberately wrong check digit
 *   card         the 411111 test range
 *   IBAN         bank codes that do not exist (ZZZZ, 000)
 *   SSN          group 00, which is never issued
 *   IP           the private 10.0.0.0/8 range
 *   email        the reserved example.com domain
 * Phone numbers and names cannot be guaranteed fictional; they come from the
 * +1 555 exchange, a `000` UAE block and synthetic name lists.
 */

const { PATTERNS, luhnCheck } = require('./patterns');

const BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));
const pad = (n, width) => String(n).padStart(width, '0');

/** The Luhn check digit that makes `body + digit` valid. */
function luhnDigit(body) {
  for (let d = 0; d < 10; d++) if (luhnCheck(`${body}${d}`)) return d;
  return 0;
}

/** Build an IBAN with valid mod-97 check digits. */
function ibanWithCheck(country, bban) {
  const numeric = `${bban}${country}00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = parseInt(`${remainder}${numeric.slice(i, i + 7)}`, 10) % 97;
  }
  return `${country}${pad(98 - remainder, 2)}${bban}`;
}

const FIRST = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Quinn', 'Rowan', 'Emery',
  'Dana', 'Kai', 'Reese', 'Sasha', 'Noel', 'Robin', 'Jamie', 'Skyler', 'Harper', 'Parker'];
const LAST = ['Carter', 'Hayes', 'Brooks', 'Ellis', 'Foster', 'Garrison', 'Hughes', 'Irving', 'Keller', 'Lawson',
  'Mercer', 'Nolan', 'Pembroke', 'Quincy', 'Ramsey', 'Sutton', 'Thornton', 'Vaughn', 'Whitaker', 'Yardley'];
const FIRST_AR = ['سالم', 'ريم', 'خالد', 'ليلى', 'عمر', 'هند', 'يوسف', 'سارة', 'حمد', 'نورة',
  'ماجد', 'منى', 'راشد', 'عائشة', 'سيف', 'مريم', 'زايد', 'شيخة', 'ناصر', 'لطيفة'];
const LAST_AR = ['السالمي', 'الخالدي', 'العمري', 'الراشدي', 'الحمدي', 'اليوسفي', 'الماجدي', 'السيفي', 'الناصري', 'الزايدي',
  'البلوشي', 'الحوسني', 'الكتبي', 'الريسي', 'الهاملي', 'الجنيبي', 'العامري', 'الشحي', 'المزروعي', 'القبيسي'];

/**
 * `First Last` from two lists, then `First Middle Last` (the middle name from
 * the first list), then a numbered suffix: distinct for every n, and
 * detectable as a name for the first 20 * 20 * 21 = 8,400.
 */
function combo(first, last, n) {
  const i = n - 1;
  const F = first.length;
  const L = last.length;
  if (i < F * L) return `${first[i % F]} ${last[Math.floor(i / F)]}`;
  const j = i - F * L;
  const name = `${first[j % F]} ${first[Math.floor(j / F) % F]} ${last[Math.floor(j / (F * F)) % L]}`;
  const round = Math.floor(j / (F * F * L));
  return round === 0 ? name : `${name} ${round + 1}`;
}

/**
 * Per-pattern generators, called with n = the index of the distinct original
 * (1-based). Each is injective in n over any realistic run.
 */
const GENERATORS = {
  national_id: (n) => {
    const seq = pad(n % 1e7, 7);
    const valid = luhnDigit(`7841900${seq}`);
    return `784-1900-${seq}-${(valid + 1) % 10}`; // wrong check digit: never a live ID
  },
  intl_phone: (n) => `+971 5${[0, 2, 4, 5, 6, 8][Math.floor(n / 1e4) % 6]} 000 ${pad(n % 1e4, 4)}`,
  passport: (n) => `ZZ${pad(n % 1e7, 7)}`,
  visa_id: (n) => `999/2000/${pad(n % 1e7, 7)}`,
  trade_lic: (n) => `DED-${pad(n % 1e6, 6)}`,
  pobox: (n) => `P.O. Box ${900000 + (n % 1e5)}`,
  non_latin_name: (n) => combo(FIRST_AR, LAST_AR, n),
  unified_id: (n) => `10${pad(n % 1e13, 13)}`,
  uae_iban: (n) => ibanWithCheck('AE', `000${pad(n % 1e16, 16)}`),
  iban: (n) => ibanWithCheck('GB', `ZZZZ000000${pad(n % 1e8, 8)}`),
  email: (n) => `user${n}@example.com`,
  phone: (n) => `+1-555-${100 + (Math.floor(n / 1e4) % 900)}-${pad(n % 1e4, 4)}`,
  ip: (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
  cc: (n) => {
    const body = `411111${pad(n % 1e9, 9)}`;
    const digits = `${body}${luhnDigit(body)}`;
    return digits.match(/.{4}/g).join('-');
  },
  ssn: (n) => `9${pad(Math.floor(n / 1e4) % 100, 2)}-00-${pad(n % 1e4, 4)}`, // group 00 is never issued
  dob: (n) => fakeDate(n),
  date: (n) => fakeDate(n),
  // Realistic for the first ~80, then still distinct (detectable up to 999).
  age: (n) => `age: ${17 + n}`,
  full_name: (n) => combo(FIRST, LAST, n),
  ssh_key: (n) => `-----BEGIN PRIVATE KEY-----\n[REDACTED ${n}]\n-----END PRIVATE KEY-----`,
  db_conn: (n) => `postgresql://user${n}:pass@localhost:5432/db`,
  sql_password: (n) => `'P@ssw0rd!${n}'`,
  databricks_host: (n) => `https://dbc-${pad(n % 1e6, 6)}.cloud.databricks.com`,
  s3_uri: (n) => `s3://example-bucket-${n}/path`,
  env_secret: (n) => (n === 1 ? 'fake_env_secret' : `fake_env_secret_${n}`),
};

/** dd/mm/yyyy, distinct for n below 28 * 12 * 70. */
function fakeDate(n) {
  const i = n - 1;
  return `${pad(1 + (i % 28), 2)}/${pad(1 + (Math.floor(i / 28) % 12), 2)}/${1950 + (Math.floor(i / 336) % 70)}`;
}

/**
 * Keep a token's shape and vary its tail: the last alphanumeric run's final
 * characters are overwritten with `n` in a fixed radix at a fixed width, so
 * values stay distinct. The radix is chosen ONCE per (pattern, base) -- the
 * one the tail already uses (hex stays hex, upper case stays upper case), or
 * decimal if the pattern would not detect that -- never per value, which could
 * map two different n to the same string.
 */
const tailPlans = new Map();

function tailPlan(pattern, base) {
  const key = `${pattern ? pattern.id : ''}\u0000${base}`;
  if (tailPlans.has(key)) return tailPlans.get(key);
  const runs = [...base.matchAll(/[A-Za-z0-9]+/g)];
  let plan = null;
  if (runs.length) {
    const run = runs[runs.length - 1];
    const width = Math.min(run[0].length, 6);
    const tail = run[0].slice(-width);
    const options = [];
    if (/^\d+$/.test(tail)) options.push([10, false]);
    else if (/^[0-9a-f]+$/.test(tail)) options.push([16, false]);
    else if (/^[0-9A-F]+$/.test(tail)) options.push([16, true]);
    else if (/^[0-9A-Z]+$/.test(tail)) options.push([36, true]);
    else options.push([36, false]);
    options.push([10, false]);
    const start = run.index + run[0].length - width;
    const build = (radix, upper, n) => {
      let repr = n.toString(radix);
      if (upper) repr = repr.toUpperCase();
      return `${base.slice(0, start)}${repr.padStart(width, '0')}${base.slice(start + width)}`;
    };
    // Probe with the widest value, which uses every digit the radix allows.
    const fits = ([radix, upper]) => !pattern || detects(pattern, build(radix, upper, radix ** width - 1));
    const [radix, upper] = options.find(fits) || options[0];
    plan = { width, radix, build: (n) => build(radix, upper, n), limit: radix ** width };
  }
  tailPlans.set(key, plan);
  return plan;
}

function varyTail(pattern, base, n) {
  const plan = tailPlan(pattern, base);
  return plan && n < plan.limit ? plan.build(n) : `${base}_${n}`;
}

/** Does `pattern` detect exactly `value`? */
function detects(pattern, value) {
  if (pattern.rx) {
    const m = new RegExp(pattern.rx.source, pattern.rx.flags.replace('g', '')).exec(value);
    if (m && m.index === 0 && m[0].length === value.length
      && (!pattern.validate || pattern.validate(value, value, 0))) return true;
  }
  return typeof pattern.detect === 'function'
    && pattern.detect(value).some((s) => s.start === 0 && s.original.length === value.length);
}

/**
 * The fake for the n-th distinct original of pattern `id` in this run.
 * @param {string} id
 * @param {number} n - 1-based
 * @param {string[]} [fakeValues] - the pattern's own list, used first
 */
function fakeValue(id, n, fakeValues) {
  const base = fakeValues && fakeValues.length ? fakeValues : null;
  if (base && n <= base.length) return base[n - 1];
  if (!base && n === 1 && !GENERATORS[id]) return `fake_${id}`;
  const value = GENERATORS[id] ? GENERATORS[id](n) : varyTail(BY_ID.get(id), base ? base[0] : `fake_${id}`, n);
  // Never hand out a listed fake a second time.
  return base && base.includes(value) ? `${value}_${n}` : value;
}

module.exports = { fakeValue, detects, GENERATORS };
