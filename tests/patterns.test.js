const assert = require('assert');
const { maskText } = require('../src/engine/masker');
const {
  PATTERNS,
  luhnCheck,
  isValidEmiratesId,
  isValidIban,
} = require('../src/engine/patterns');

const cases = [
  { id: 'national_id', input: 'ID: 784-1988-1234567-0', shouldMatch: true },
  { id: 'national_id', input: 'ref: 784-1234', shouldMatch: false },
  { id: 'intl_phone', input: '+971501234567', shouldMatch: true },
  { id: 'intl_phone', input: '971501234567', shouldMatch: true },
  { id: 'intl_phone', input: '0501234567', shouldMatch: true },
  { id: 'intl_phone', input: '+971 4 555 1234', shouldMatch: true }, // UAE landline
  { id: 'uae_iban', input: 'IBAN AE070331234567890123456', shouldMatch: true },
  { id: 'uae_iban', input: 'IBAN AE07 0331 2345 6789 0123 456', shouldMatch: true },
  { id: 'uae_iban', input: 'IBAN GB29NWBK60161331926819', shouldMatch: false }, // UK IBAN, not UAE
  // Credit cards need a Luhn check digit, and a bare digit run a network prefix (issue #6)
  { id: 'cc', input: 'card 4111 1111 1111 1111', shouldMatch: true },
  { id: 'cc', input: '4111111111111111', shouldMatch: true },
  { id: 'cc', input: 'Amex 3782 822463 10005', shouldMatch: true },
  { id: 'cc', input: 'card 4111-1111-1111-1112', shouldMatch: false }, // fails Luhn
  { id: 'cc', input: '{"created_at": 1727366400000}', shouldMatch: false }, // ms timestamp
  { id: 'cc', input: 'Order #4000123456789 shipped', shouldMatch: false },
  { id: 'cc', input: '784198812345670', shouldMatch: false }, // an Emirates ID, not a card
  // Emirates ID with spaces or no separator (issue #10)
  { id: 'national_id', input: 'EID 784 1990 1234567 1', shouldMatch: true },
  { id: 'national_id', input: 'EID 784199012345671', shouldMatch: true },
  { id: 'national_id', input: 'رقم الهوية: 784199012345671', shouldMatch: true },
  { id: 'national_id', input: 'ref 784198812345670', shouldMatch: true }, // passes the checksum
  { id: 'national_id', input: 'ref 784199012345671', shouldMatch: false }, // no checksum, no label
  { id: 'national_id', input: 'ref 784-1990 1234567-1', shouldMatch: false }, // mixed separators
  // IBANs from every other country (issue #9)
  { id: 'iban', input: 'IBAN SA0380000000608010167519', shouldMatch: true },
  { id: 'iban', input: 'IBAN GB29 NWBK 6016 1331 9268 19', shouldMatch: true },
  { id: 'iban', input: 'DE89 3704 0044 0532 0130 00', shouldMatch: true },
  { id: 'iban', input: 'FR14 2004 1010 0505 0001 3M02 606', shouldMatch: true },
  { id: 'iban', input: 'GB82WEST12345698765433', shouldMatch: false }, // bad checksum
  { id: 'iban', input: 'XX82WEST12345698765432', shouldMatch: false }, // not an IBAN country
  { id: 'iban', input: 'AE070331234567890123456', shouldMatch: false }, // left to uae_iban
  { id: 'non_latin_name', input: 'العميل محمد أحمد المنصوري', shouldMatch: true },
  { id: 'email', input: 'user@example.com', shouldMatch: true },
  { id: 'email', input: 'not an email', shouldMatch: false },
  { id: 'db_conn', input: 'postgresql://admin:pass123@prod.db.example.com/stats', shouldMatch: true },
  { id: 'db_conn', input: 'jdbc:databricks://acme.cloud.databricks.com:443/default;PWD=x', shouldMatch: true },
  { id: 'openai_key', input: 'sk-abc123defabc123defabc123defabc123def', shouldMatch: true },
  { id: 'openai_key', input: 'sk-proj-9pQrStUvWxYz1234567890abcdefABCDEF', shouldMatch: true },
  { id: 'openai_key', input: 'sk-svcacct-aBcDeFgHiJkLmNoPqRsTuVwXyZ12345', shouldMatch: true },
  { id: 'openai_key', input: 'sk-ant-api03-zYxWvUtSrQpOnMlKjIhGfEdCbA9876543210', shouldMatch: false },
  { id: 'phone', input: '+1-415-555-0188', shouldMatch: true },
  { id: 'phone', input: '+44-20-7946-0521', shouldMatch: true },
  { id: 'phone', input: '(415) 555-0188', shouldMatch: true },
  { id: 'phone', input: '415-555-0188', shouldMatch: true },
  // Embedded 8-digit substrings inside tokens MUST NOT match
  { id: 'phone', input: 'dapi1234567890abcdef1234567890abcdef12345678', shouldMatch: false },
  { id: 'phone', input: 'cluster-id 0125-123456-abcd1234', shouldMatch: false },
  { id: 'phone', input: 'acme-prod-9842.cloud.databricks.com', shouldMatch: false },
  { id: 'cc', input: '4111-1111-1111-1111', shouldMatch: true },
  { id: 'cc', input: '3782-822463-10005', shouldMatch: true }, // Amex 4-6-5
  { id: 'databricks_token', input: 'dapi1234567890abcdef1234567890abcdef12345678', shouldMatch: true },
  { id: 'databricks_token', input: 'random word', shouldMatch: false },
  { id: 'databricks_host', input: 'https://acme-prod-9842.cloud.databricks.com', shouldMatch: true },
  { id: 'databricks_host', input: 'https://example.azuredatabricks.net/api', shouldMatch: true },
  { id: 'databricks_host', input: 'https://example.com', shouldMatch: false },
  { id: 's3_uri', input: 's3://acme-attribution-prod-eu-west-1/h1-2026', shouldMatch: true },
  { id: 's3_uri', input: 'no s3 here', shouldMatch: false },
  // env_secret should now catch Python-style quoted assignments
  { id: 'env_secret', input: 'OPENAI_API_KEY=sk-proj-abc123', shouldMatch: true },
  { id: 'env_secret', input: 'OPENAI_API_KEY = "sk-proj-abc123"', shouldMatch: true },
  { id: 'env_secret', input: 'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', shouldMatch: true },
  { id: 'env_secret', input: "DATABRICKS_TOKEN = 'dapi1234567890abcdef1234567890abcdef12345678'", shouldMatch: true },
  { id: 'env_secret', input: 'COMPASS_AI_API_KEY = "cmp_live_abc123def456ghi789"', shouldMatch: true },
  { id: 'env_secret', input: 'DATABRICKS_HOST = "https://example.cloud.databricks.com"', shouldMatch: true },
  { id: 'env_secret', input: 'S3_EXPORT_BUCKET = "s3://example-bucket/path"', shouldMatch: true },
  // Common false positives that MUST NOT trigger env_secret
  { id: 'env_secret', input: 'PASSED = true', shouldMatch: false },
  { id: 'env_secret', input: 'AUTHOR_NAME = "Alice"', shouldMatch: false },
  // SQL DDL auth clauses (space-delimited — env_secret can't see these)
  { id: 'sql_password', input: "CREATE USER app IDENTIFIED BY 'S3cret!';", shouldMatch: true },
  { id: 'sql_password', input: "CREATE ROLE app WITH PASSWORD 'S3cret!';", shouldMatch: true },
  { id: 'sql_password', input: "CREATE USER app IDENTIFIED WITH mysql_native_password BY 'S3cret!';", shouldMatch: true },
  { id: 'sql_password', input: "ALTER USER app IDENTIFIED BY PASSWORD '*A1B2C3';", shouldMatch: true },
  { id: 'sql_password', input: 'ALTER USER app IDENTIFIED BY "double quoted";', shouldMatch: true },
  // The `=` form belongs to env_secret, NOT sql_password (no overlap)
  { id: 'sql_password', input: "ALTER LOGIN app WITH PASSWORD = 'S3cret!';", shouldMatch: false },
  { id: 'sql_password', input: 'SELECT name FROM users;', shouldMatch: false },
];

function runPatternTests() {
  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const pattern = PATTERNS.find((p) => p.id === tc.id);
    assert(pattern, `Pattern not found: ${tc.id}`);
    const { findings } = maskText(tc.input, { enabled: [tc.id] });
    const matched = findings.length > 0;
    if (matched === tc.shouldMatch) {
      passed++;
    } else {
      console.error(`FAIL pattern ${tc.id}: input="${tc.input}" expected match=${tc.shouldMatch} got=${matched}`);
      failed++;
    }
  }

  // An IBAN's span ends at its country's length, not at the next word (issue #9),
  // and a no-dash Emirates ID is classed as an ID, not as a card (issue #10).
  {
    const spans = [
      ['GB82 WEST 1234 5698 7654 32 USD', 'iban', 'GB82 WEST 1234 5698 7654 32'],
      ['pay GB82WEST12345698765432.', 'iban', 'GB82WEST12345698765432'],
      ['EID 784198812345670', 'national_id', '784198812345670'],
    ];
    for (const [text, id, want] of spans) {
      const got = maskText(text).findings.map((f) => `${f.id}:${f.original}`);
      if (got.length === 1 && got[0] === `${id}:${want}`) {
        passed++;
      } else {
        console.error(`FAIL span ${JSON.stringify(text)}: expected ${id}:${want}, got ${JSON.stringify(got)}`);
        failed++;
      }
    }
  }

  // Overlap test
  const overlap = maskText('john.5551234567@example.com', { enabled: ['email', 'phone'] });
  if (overlap.findings.length >= 1) {
    passed++;
  } else {
    console.error('FAIL overlap test');
    failed++;
  }

  // ---- Checksum helper tests (used by A5 PDPL reporter) -------------------
  const checksumCases = [
    // luhnCheck
    { fn: 'luhnCheck', input: '4532015112830366', expected: true },   // valid Visa
    { fn: 'luhnCheck', input: '4532015112830367', expected: false },  // off by one
    { fn: 'luhnCheck', input: 'abc', expected: false },
    // Emirates ID (Luhn on the 15 digits, prefix 784).
    // Luhn(784-2017-9999999-X): sum(undoubled) = X+45; sum(doubled) = 49;
    // total = X + 94 → check digit = 6 for validity.
    { fn: 'isValidEmiratesId', input: '784-2017-9999999-6', expected: true },
    { fn: 'isValidEmiratesId', input: '784-2017-9999999-3', expected: false },
    { fn: 'isValidEmiratesId', input: 'not-an-id', expected: false },
    { fn: 'isValidEmiratesId', input: '123-2017-9999999-6', expected: false }, // wrong prefix
    // IBAN mod-97 (real spec test vectors)
    { fn: 'isValidIban', input: 'GB82WEST12345698765432', expected: true },
    { fn: 'isValidIban', input: 'DE89370400440532013000', expected: true },
    { fn: 'isValidIban', input: 'GB82WEST12345698765433', expected: false },
    { fn: 'isValidIban', input: 'not-an-iban', expected: false },
  ];
  const helpers = { luhnCheck, isValidEmiratesId, isValidIban };
  for (const c of checksumCases) {
    const result = helpers[c.fn](c.input);
    if (result === c.expected) {
      passed++;
    } else {
      console.error(`FAIL checksum ${c.fn}("${c.input}") expected ${c.expected} got ${result}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // Line-boundary discipline.
  //
  // Patterns whose separator is intra-line whitespace must use `[ \t]`, never
  // `\s`. `\s` matches newlines, which caused two real bugs:
  //
  //   1. In spreadsheets, engine/formats/xlsx.js flattens every cell into one
  //      newline-joined string for detection and writes back per cell. A match
  //      spanning cells ("Dept\nAhmed Hassan") exists in no single cell, so the
  //      write silently did nothing and names survived masking entirely.
  //   2. In prose, "Notes\n\nNothing" matched `full_name` and masking replaced
  //      BOTH words with one token, destroying non-sensitive text.
  //
  // `ssh_key` is exempt: a PEM block is genuinely multi-line. Lookarounds are
  // exempt too -- they are zero-width, so `\s` inside one can never make the
  // MATCH itself span a line.
  // -------------------------------------------------------------------------
  const MULTILINE_BY_DESIGN = new Set(['ssh_key']);
  for (const p of PATTERNS) {
    if (MULTILINE_BY_DESIGN.has(p.id) || !p.rx) continue;
    // Strip character classes that legitimately contain \s as a NEGATED
    // terminator (e.g. [^\s"'<>]) and the env_secret leading lookbehind, which
    // must allow a newline before a KEY.
    const body = p.rx.source
      .replace(/\[\^[^\]]*\]/g, '')            // negated classes: [^\s"'<>]
      .replace(/\(\?<[=!][\s\S]*?\)(?=[^)]*$|[([])/g, '') // lookbehind
      .replace(/\(\?<[=!](?:[^()]|\([^()]*\))*\)/g, '');  // nested lookbehind
    if (/\\s/.test(body)) {
      console.error(`FAIL ${p.id} uses \\s outside a negated class — it will match across lines`);
      failed++;
    } else {
      passed++;
    }
  }

  const lineBoundaryCases = [
    // [name, text, patternId, shouldMatch]
    ['full_name does not span a line break', 'Notes\n\nNothing interesting', 'full_name', false],
    ['full_name still matches on one line', 'Contact Ahmed Hassan today', 'full_name', true],
    ['full_name does not span spreadsheet cells', 'Dept\nAhmed Hassan', 'full_name', true],
    ['arabic name does not span a line break', 'محمد\nأحمد', 'non_latin_name', false],
    ['arabic name still matches on one line', 'محمد أحمد', 'non_latin_name', true],
    ['credit card does not span cells', '4111\n1111\n1111\n1111', 'cc', false],
    ['credit card still matches spaced on one line', '4111 1111 1111 1111', 'cc', true],
    ['iban does not span cells', 'AE07\n0331\n2345\n6789\n0123456', 'uae_iban', false],
    ['iban still matches spaced on one line', 'AE07 0331 2345 6789 0123 456', 'uae_iban', true],
    ['uae phone does not span cells', '+971\n50 123 4567', 'intl_phone', false],
    ['uae phone still matches on one line', '+971 50 123 4567', 'intl_phone', true],
    ['po box does not span a line break', 'P.O.\nBox 12345', 'pobox', false],
    ['po box still matches on one line', 'P.O. Box 12345', 'pobox', true],
    ['bearer token does not span a line break', 'Bearer\nabc123def456ghi789jkl012', 'bearer', false],
    ['bearer token still matches on one line', 'Bearer abc123def456ghi789jkl012', 'bearer', true],
    ['env secret does not span a line break', 'API_KEY:\nsk-fake1234567890', 'env_secret', false],
    ['env secret matches a bare key', 'API_KEY=sk-fake1234567890', 'env_secret', true],
    ['env secret matches a prefixed key', 'DB_PASSWORD=hunter2', 'env_secret', true],
    ['env secret matches a key after a newline', 'x=1\nAPI_KEY=sk-fake1234567890', 'env_secret', true],
  ];
  for (const [name, text, id, shouldMatch] of lineBoundaryCases) {
    const { findings } = maskText(text, { enabled: [id] });
    const got = findings.length > 0;
    const spansLine = findings.some((f) => /[\r\n]/.test(f.original));
    if (got === shouldMatch && !spansLine) {
      passed++;
    } else {
      console.error(`FAIL ${name}: expected match=${shouldMatch}, got match=${got}`
        + (spansLine ? ' (match spans a line break)' : ''));
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // env_secret used to require at least one character before the trigger word,
  // so the commonest forms in a real .env file were silently missed: `PASSWORD=`,
  // `API_KEY=`, `TOKEN=`, `SECRET=` all failed while `DB_PASSWORD=` matched.
  // The pattern's own fakeValue was itself undetectable.
  // -------------------------------------------------------------------------
  const envSecretCases = [
    ['API_KEY=sk-fake1234567890', true],
    ['PASSWORD=hunter2', true],
    ['TOKEN=abc123xyz789', true],
    ['SECRET=s3cr3tvalue', true],
    ['ACCESS_KEY=AKIA123456', true],
    ['PRIVATE_KEY=abcdef', true],
    ['CREDENTIAL=zzz', true],
    ['DSN=postgres-dsn-value', true],
    ['password: hunter2', true],
    ['api_key = "abcdef"', true],
    ['MY_API_KEY=sk-fake1234567890', true],
    ['DB_PASSWORD=hunter2', true],
    // must NOT fire
    ['LOG_LEVEL=info', false],
    ['REGION=me-central-1', false],
    ['PASSWORDLESS_MODE', false],
    ['# PASSWORD is required', false],
    ['TOKENIZER=bpe', false],
    ['HF_TOKENIZER=gpt2', false],
    // Quoted keys, XML, PHP and command-line flags (issue #3). Each of these
    // used to be missed because the key had to follow whitespace or `,;({[`.
    ['{"password": "hunter2prod"}', true],
    ['{"db": {"password": "hunter2prod"}}', true],
    ['"password":"hunter2prod"', true],
    ["{'password': 'hunter2prod'}", true],
    ['  "client_secret": "abc123secretvalue",', true],
    ['<password>hunter2prod</password>', true],
    ['<Password>hunter2prod</Password>', true],
    ['<add key="ApiKey" value="abc123secretvalue"/>', true],
    ['<setting name="DbPassword" value="hunter2prod" />', true],
    ['$password = "hunter2prod";', true],
    ['mysql --password=hunter2prod -u root', true],
    ['echo "TOKEN=abc123xyz"', true],
    // ...without new false alarms
    ['{"password": ""}', false],
    ['{"password": null}', false],
    ['{"token": true}', false],
    ['{"passwordPolicy": {"minLength": 8}}', false],
    ['{"X-Signature": HMAC_SECRET}', false], // a variable reference in code
    ['<password></password>', false],
    ['<password>[ENV_SECRET_1]</password>', false], // already masked
    ['<add key="ApiKey" value="[ENV_SECRET_1]"/>', false],
  ];
  for (const [text, shouldMatch] of envSecretCases) {
    const { findings } = maskText(text, { enabled: ['env_secret'] });
    if ((findings.length > 0) === shouldMatch) {
      passed++;
    } else {
      console.error(`FAIL env_secret ${JSON.stringify(text)}: expected match=${shouldMatch}, got ${findings.length}`);
      failed++;
    }
  }

  // Only the value is replaced, and masking keeps the surrounding syntax valid.
  {
    const cases = [
      ['{"password": "hunter2prod"}', (m) => JSON.parse(m).password.startsWith('[ENV_SECRET_')],
      ['<password>hunter2prod</password>', (m) => /^<password>\[ENV_SECRET_\d+\]<\/password>$/.test(m)],
      ['echo "TOKEN=abc123xyz"', (m) => /^echo "TOKEN=\[ENV_SECRET_\d+\]"$/.test(m)],
      ['Set `API_KEY=abc123xyz` first', (m) => /`API_KEY=\[ENV_SECRET_\d+\]`/.test(m)],
    ];
    for (const [text, ok] of cases) {
      const { masked } = maskText(text, { enabled: ['env_secret'] });
      let good = false;
      try { good = ok(masked); } catch { good = false; }
      if (good) {
        passed++;
      } else {
        console.error(`FAIL env_secret masking broke syntax: ${JSON.stringify(text)} -> ${JSON.stringify(masked)}`);
        failed++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // hex_secret vs hashes (issue #4). A git commit is 40 hex characters and a
  // SHA-256 checksum 64, so every changelog, lockfile and CI log read as a
  // credential and the Guardian demanded approval for harmless files.
  // -------------------------------------------------------------------------
  const SHA1 = ['9fceb02d0ae598e9', '5dc970b74767f193', '72d61af8'].join('');
  const SHA256 = ['e3b0c44298fc1c149afbf4c8996fb924', '27ae41e4649b934ca495991b7852b855'].join('');
  const hexCases = [
    // hashes in hash context: not secrets
    [`- Fixed login redirect (${SHA1})`, false],
    [`commit ${SHA1}`, false],
    [`${SHA1} Merge pull request #3`, false],
    [`${SHA256}  dist/app.tar.gz`, false],
    [`image: node@sha256:${SHA256}`, false],
    [`sha256: ${SHA256}`, false],
    [`https://github.com/o/r/commit/${SHA1}`, false],
    [`see #${SHA1}`, false],
    // secrets: still flagged, even at hash lengths
    [`the signing secret is ${SHA1}`, true],
    [`token for commit ${SHA1}`, true],
    [`secret: (${SHA1})`, true],
    [`${SHA1}  # prod api key`, true],
    [SHA1, true],
    // non-standard lengths are not hash references
    [`commit ${SHA1}abcd`, true],
  ];
  for (const [text, shouldMatch] of hexCases) {
    const { findings } = maskText(text, { enabled: ['hex_secret'] });
    if ((findings.length > 0) === shouldMatch) {
      passed++;
    } else {
      console.error(`FAIL hex_secret ${JSON.stringify(text)}: expected match=${shouldMatch}, got ${findings.length}`);
      failed++;
    }
  }

  // `--mode fake` substitutes values from `fakeValues`. Those substitutions must
  // remain DETECTABLE by the full detector, because that is exactly what a
  // re-scan (and the Guardian's verifier) relies on: a fake that no pattern
  // recognises makes a still-sensitive-looking file report as clean.
  //
  // Four fakes used to be 18 characters where their own pattern demanded 20+,
  // so `--mode fake` on an Anthropic/HuggingFace/Stripe/Bearer credential
  // produced a key-shaped string that scanned clean.
  const FAKE_EXEMPT = {
    // A PEM body is deliberately inert -- the whole point is that it is no longer a key.
    ssh_key: 'redaction is intentional',
    // The match includes the surrounding SQL clause; the fake is only the quoted
    // value, which is correct for substitution but not self-detecting.
    sql_password: 'fake is the value only; the pattern needs its SQL context',
  };
  for (const p of PATTERNS) {
    if (!p.fakeValues || FAKE_EXEMPT[p.id]) { passed++; continue; }
    const undetectable = p.fakeValues.filter((v) => maskText(v).findings.length === 0);
    if (undetectable.length === 0) {
      passed++;
    } else {
      console.error(`FAIL ${p.id}: fakeValues undetectable by the full detector: ${JSON.stringify(undetectable)}`);
      failed++;
    }
  }

  // Masking must never destroy surrounding non-sensitive words.
  {
    const { masked } = maskText('Notes\n\nNothing interesting here.');
    if (masked.includes('Notes') && masked.includes('Nothing')) {
      passed++;
    } else {
      console.error(`FAIL masking destroyed non-sensitive prose: ${JSON.stringify(masked)}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // Name precision.
  //
  // `full_name` and `non_latin_name` are necessarily broad — a name is just
  // words — and used to fire on any two capitalised words and any two adjacent
  // Arabic words. That made every document heading a "person" and, worse, made
  // ALL Arabic prose a personal name: `تقرير امتثال` is "compliance report".
  //
  // The gate rejects a match only when EVERY token is an ordinary word of the
  // language, so one unfamiliar token — what a real name almost always
  // contributes — keeps it. The asymmetry is deliberate: a missed name is a
  // disclosure, a masked heading is an annoyance.
  //
  // RECALL CASES MATTER MOST HERE. If one of the `true` rows below ever starts
  // failing, the tool has begun leaking names, which is worse than every false
  // positive this gate was added to remove.
  // ---------------------------------------------------------------------------
  const namePrecisionCases = [
    // [text, patternId, shouldMatch, why]
    // --- recall: real names must survive ---
    ['Ahmed Hassan', 'full_name', true, 'ordinary two-word personal name'],
    ['Sara Al Nuaimi', 'full_name', true, 'three-part Gulf name'],
    ['Contact Ahmed Hassan today', 'full_name', true, 'name inside a sentence'],
    ['Name: Mark Price', 'full_name', true, 'name of ordinary words, rescued by the cue'],
    ['Customer: May Day', 'full_name', true, 'calendar words as a name, rescued by the cue'],
    ['محمد أحمد', 'non_latin_name', true, 'ordinary Arabic personal name'],
    ['محمد بن راشد', 'non_latin_name', true, 'nasab particle بن is decisive'],
    ['عبد الله', 'non_latin_name', true, 'theophoric name built from common words'],
    ['العميل محمد أحمد المنصوري', 'non_latin_name', true, 'name preceded by a common noun'],
    // --- precision: ordinary prose must not be a person ---
    ['Core Rule', 'full_name', false, 'heading, both words ordinary'],
    ['Database Connection', 'full_name', false, 'technical label'],
    ['Data Protection Officer', 'full_name', false, 'compliance vocabulary'],
    ['Quarterly Report', 'full_name', false, 'document title'],
    ['## Personal Data Protection', 'full_name', false, 'markdown heading'],
    ['تقرير امتثال', 'non_latin_name', false, 'Arabic for "compliance report"'],
    ['البيانات الشخصية', 'non_latin_name', false, 'Arabic for "personal data"'],
    ['حماية البيانات', 'non_latin_name', false, 'Arabic for "data protection"'],
  ];

  for (const [text, id, shouldMatch, why] of namePrecisionCases) {
    const hit = maskText(text).findings.some((f) => f.id === id);
    if (hit === shouldMatch) {
      passed++;
    } else {
      const verb = shouldMatch ? 'MISSED (recall regression — this leaks)' : 'over-matched';
      console.error(`FAIL name precision: ${verb} ${JSON.stringify(text)} [${id}] — ${why}`);
      failed++;
    }
  }

  // The gate must never reject on vocabulary alone when a cue is present, and
  // must never accept an all-ordinary match without one.
  {
    const { looksLikeName, COMMON_EN } = require('../src/engine/patterns');
    const cueText = 'Employee: Price Index';
    const plainText = 'Some Price Index';
    const cueOk = looksLikeName(['Price', 'Index'], COMMON_EN, cueText, cueText.indexOf('Price'));
    const plainOk = looksLikeName(['Price', 'Index'], COMMON_EN, plainText, plainText.indexOf('Price'));
    if (cueOk === true && plainOk === false) {
      passed++;
    } else {
      console.error(`FAIL looksLikeName cue override: cue=${cueOk} plain=${plainOk}`);
      failed++;
    }
  }

  console.log(`patterns.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runPatternTests };

if (require.main === module) {
  process.exit(runPatternTests() ? 0 : 1);
}
