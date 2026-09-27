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
  // Noisy patterns need context (issue #8)
  { id: 'passport', input: 'Invoice IN20240115 paid', shouldMatch: false },
  { id: 'passport', input: 'Order PO12345678 shipped', shouldMatch: false },
  { id: 'passport', input: 'passport no. IN20240115', shouldMatch: true }, // a passport label wins
  { id: 'passport', input: 'Passport: AB1234567', shouldMatch: true },
  { id: 'trade_lic', input: 'region = cn-north-1', shouldMatch: false },
  { id: 'trade_lic', input: 'TL-ABCDEFG', shouldMatch: false }, // no digit
  { id: 'trade_lic', input: 'Licence CN-1234567', shouldMatch: true },
  { id: 'email', input: 'logo@2x.png', shouldMatch: false },
  { id: 'email', input: 'icon@3x.svg', shouldMatch: false },
  { id: 'email', input: 'x@company.md', shouldMatch: true }, // .md is Moldova's TLD
  { id: 'date', input: 'Invoice date 15/01/2024', shouldMatch: false },
  { id: 'date', input: 'Due: 01/02/2025', shouldMatch: false },
  { id: 'date', input: 'Invoice for patient born 15/03/1990', shouldMatch: true },
  { id: 'date', input: 'Joined 15/03/2019', shouldMatch: true }, // unlabelled dates stay flagged
  { id: 'intl_phone', input: 'SKU 8971501234567', shouldMatch: false },
  { id: 'intl_phone', input: '00971501234567', shouldMatch: true },
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
  // Patterns that MATCH a keyword as context but replace only a value group
  // that cannot cross a line. `sql_password` used to express its keyword as a
  // lookbehind (exempt above); a lookbehind with `\s+` is quadratic on long
  // whitespace (#38), so it now consumes the keyword and masks group 1, a
  // quoted string that excludes newlines.
  const CONTEXT_THEN_SINGLE_LINE_VALUE = new Set(['sql_password']);
  for (const id of CONTEXT_THEN_SINGLE_LINE_VALUE) {
    const p = PATTERNS.find((x) => x.id === id);
    const value = p && p.valueGroups ? new RegExp(p.rx.source, 'gi').exec("IDENTIFIED BY\n  'S3cret!'") : null;
    if (!value || value[1] !== "'S3cret!'" || /\n/.test(value[1])) {
      console.error(`FAIL ${id} must match multi-line SQL but mask only a single-line quoted value`);
      failed++;
    } else {
      passed++;
    }
  }
  for (const p of PATTERNS) {
    if (MULTILINE_BY_DESIGN.has(p.id) || CONTEXT_THEN_SINGLE_LINE_VALUE.has(p.id) || !p.rx) continue;
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
    // Properties of a secret, references and placeholders are not secrets (issue #7)
    ['max_tokens: 1024', false],
    ['maxTokens: 2048', false],
    ['token_type: bearer', false],
    ['PASSWORD_MIN_LENGTH=12', false],
    ['TOKEN_TTL=3600', false],
    ['password: ${DB_PASSWORD}', false],
    ['API_KEY=$API_KEY', false],
    ['token: {{ secrets.GH_TOKEN }}', false],
    ['password: <your-password>', false],
    ['OPENAI_API_KEY=sk-proj-...', false],
    ['SECRET_KEY=changeme', false],
    ['DB_HOST=localhost', false],
    ['DB_HOST=127.0.0.1:5432', false],
    // ...while real values stay flagged
    ['DB_PASSWORD=123456', true],
    ['password: password', true],
    ['DB_HOST=db.internal.acme.net', true],
    ['AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEAAa', true],
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
  // Token formats that used to pass through (issue #5), and phone numbers
  // without separators (issue #11). Each format has a positive case and a near
  // miss. Values are assembled at runtime so no provider-shaped token sits in
  // this file: secret scanners would block the push. The positives run the FULL
  // detector and check which pattern wins the span; the near misses check that
  // the target pattern stays silent.
  // -------------------------------------------------------------------------
  {
    const j = (...parts) => parts.join('');
    const r = (n) => 'aB3dE5fG7h'.repeat(Math.ceil(n / 10)).slice(0, n);
    const b64 = (s) => Buffer.from(s).toString('base64');
    const HEX32 = j('5d41402abc4b2a76', 'b9719d911017c592');
    const AWS_ID = j('AK', 'IA', 'ABCDEFGHIJKLMNOP');
    const AWS_SECRET = j('wJal', 'rXUtnFEMI/K7MDENG/bPxRfiCY', 'EXAMPLEKEY');
    const pem = (type) => `-----BEGIN ${type}-----\nMIIabc\n-----END ${type}-----`;
    // [text, pattern id, the span it must replace (null: must not match)]
    const formatCases = [
      [`token ${j('github', '_pat_', r(22), '_', r(59))}`, 'gh_token', j('github', '_pat_', r(22), '_', r(59))],
      [`token ${j('github', '_pat_', 'short')}`, 'gh_token', null],
      [`token ${j('gl', 'pat-', r(20))}`, 'gitlab_token', j('gl', 'pat-', r(20))],
      [`runner ${j('gl', 'rt-', r(24))}`, 'gitlab_token', j('gl', 'rt-', r(24))],
      [`see the ${j('gl', 'pat-', 'docs')} page`, 'gitlab_token', null],
      [`key=${j('AI', 'za', r(35))}&q=1`, 'google_api_key', j('AI', 'za', r(35))],
      [`key ${j('AI', 'za', r(36))}`, 'google_api_key', null], // one character too long
      [`x ${j('rk', '_live_', r(24))}`, 'stripe', j('rk', '_live_', r(24))],
      [`x ${j('wh', 'sec_', r(32))}`, 'stripe', j('wh', 'sec_', r(32))],
      [`x ${j('rk', '_live_', 'short')}`, 'stripe', null],
      [`x ${j('S', 'G.', r(22), '.', r(43))}`, 'sendgrid_key', j('S', 'G.', r(22), '.', r(43))],
      [`x ${j('S', 'G.', r(22), '.', r(40))}`, 'sendgrid_key', null],
      [`x ${j('np', 'm_', r(36))}`, 'npm_token', j('np', 'm_', r(36))],
      [`x ${j('np', 'm_', r(35))}`, 'npm_token', null],
      ['npm_config_cache_directory_setting_x', 'npm_token', null],
      [`post ${j('https://hooks.', 'slack.com/services/', 'T0ABCDEFG/B0ABCDEFG/', r(24))}`, 'slack_webhook',
        j('https://hooks.', 'slack.com/services/', 'T0ABCDEFG/B0ABCDEFG/', r(24))],
      ['see https://hooks.slack.com/ for setup', 'slack_webhook', null],
      [`AccountName=acct;${j('Account', 'Key=', r(86), '==')};EndpointSuffix=core.windows.net`, 'azure_storage_key', j(r(86), '==')],
      [`Endpoint=sb://x/;${j('SharedAccess', 'Key=', r(43), '=')}`, 'azure_storage_key', j(r(43), '=')],
      ['AccountName=acct;AccountKey=;', 'azure_storage_key', null],
      [`Authorization: Basic ${b64('admin:hunter22')}`, 'basic_auth', `Basic ${b64('admin:hunter22')}`],
      [`curl -H "authorization: basic ${b64('svc:pa55word')}"`, 'basic_auth', `basic ${b64('svc:pa55word')}`],
      ['Basic understanding of algorithms is required', 'basic_auth', null],
      [`Authorization: Basic ${b64('test')}`, 'basic_auth', null], // no user:password inside
      [`Access key ID,Secret access key\n${AWS_ID},${AWS_SECRET}`, 'aws_secret', AWS_SECRET],
      [`aws secret: ${AWS_SECRET}`, 'aws_secret', AWS_SECRET],
      [`value ${AWS_SECRET}`, 'aws_secret', null], // no key id or label nearby
      [`aws ${'a1b2c3d4e5'.repeat(4)}`, 'aws_secret', null], // no upper case: not base64 key material
      [pem('ENCRYPTED PRIVATE KEY'), 'ssh_key', pem('ENCRYPTED PRIVATE KEY')],
      [pem('DSA PRIVATE KEY'), 'ssh_key', pem('DSA PRIVATE KEY')],
      [pem('PGP PRIVATE KEY BLOCK'), 'ssh_key', pem('PGP PRIVATE KEY BLOCK')],
      [pem('PGP PUBLIC KEY BLOCK'), 'ssh_key', null],
      ['-----BEGIN DSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'ssh_key', null],
      [`api key: ${HEX32}`, 'hex_secret', HEX32],
      [`curl -H "X-Auth: ${HEX32}"`, 'hex_secret', HEX32],
      [`md5: ${HEX32}`, 'hex_secret', null],
      [`request id ${HEX32}`, 'hex_secret', null],
      [HEX32, 'hex_secret', null],
      // issue #11
      ['call +447946095812 now', 'phone', '+447946095812'],
      ['mobile +966501234567', 'phone', '+966501234567'],
      ['tel 020 7946 0958', 'phone', '020 7946 0958'],
      ['Phone: 0161 496 0000', 'phone', '0161 496 0000'],
      ['هاتف 020 7946 0958', 'phone', '020 7946 0958'],
      ['ref 020 7946 0958', 'phone', null], // national grouping without a phone label
      ['ts 1727366400000', 'phone', null],
      ['order 4000123456789', 'phone', null],
      ['x+447946095812', 'phone', null],
      ['offset +1234567', 'phone', null], // too short
      ['+971501234567', 'phone', null], // left to intl_phone
      // issue #40: passwords in URLs and the secret keys that were missed
      [`DATABASE_URL=postgresql+psycopg2://app:${j('Sup3r', 'S3cret')}@db:5432/app`, 'db_conn', `postgresql+psycopg2://app:${j('Sup3r', 'S3cret')}@db:5432/app`],
      [`BROKER=amqp://guest:${j('Gu3st', 'Pw0rd')}@rabbitmq:5672/`, 'db_conn', `amqp://guest:${j('Gu3st', 'Pw0rd')}@rabbitmq:5672/`],
      [`CACHE=rediss://:${j('R3dis', 'Pw0rd')}@cache:6380/0`, 'db_conn', `rediss://:${j('R3dis', 'Pw0rd')}@cache:6380/0`],
      [`MAIL_URL=smtp://mailer:${j('MailPass', '!22')}@smtp.example.com:587`, 'url_password', j('MailPass', '!22')],
      [`ftp://deploy:${j('Ftp', 'S3cret9')}@files.example.net/in`, 'url_password', j('Ftp', 'S3cret9')],
      [`smtp://mailer:${j('Pass', '22')}@smtp.example.com`, 'email', null], // the password is not an address
      ['https://user:password@host.example.com/', 'url_password', null], // a documentation example
      ['git clone https://ci:${GIT_TOKEN}@github.com/org/repo', 'url_password', null],
      [`DB_PASS=${j('hunter2', 'prod99')}`, 'env_secret', j('hunter2', 'prod99')],
      [`ENCRYPTION_KEY=${j('q8Zr2LmN', '4vX7pT1s')}`, 'env_secret', j('q8Zr2LmN', '4vX7pT1s')],
      [`APP_KEY=base64:${b64('laravel-app-key-0123456789abcd')}`, 'env_secret', `base64:${b64('laravel-app-key-0123456789abcd')}`],
      [`PASSWORD_SALT=${j('mZ8qL2', 'xV9nB4')}`, 'env_secret', j('mZ8qL2', 'xV9nB4')],
      [`WIFI_PSK=${j('c0ffee', 'Shop99')}`, 'env_secret', j('c0ffee', 'Shop99')],
      [`GET /login?user=bob&password=${j('Qw3rty', 'Pass1')} HTTP/1.1`, 'env_secret', j('Qw3rty', 'Pass1')],
      [`https://x/cb?token=${j('abc123', 'def456')}&redirect=/home`, 'env_secret', j('abc123', 'def456')],
      [`//registry.npmjs.org/:_authToken=${j('abcDEF123456', 'ghiJKL7890')}`, 'env_secret', j('abcDEF123456', 'ghiJKL7890')],
      [`define('DB_PASSWORD', '${j('Ph4p', 'S3cret!')}');`, 'env_secret', j('Ph4p', 'S3cret!')],
      [`- name: DB_PASSWORD\n  value: "${j('K8s', 'S3cretVal')}"`, 'env_secret', j('K8s', 'S3cretVal')],
      [`{"name": "DB_PASSWORD", "value": "${j('Ecs', 'Pass123')}"}`, 'env_secret', j('Ecs', 'Pass123')],
      [`user,password,role\nalice,${j('Al1ce', 'P4ss!')},admin`, 'env_secret', j('Al1ce', 'P4ss!')],
      [`| user | api_key |\n|---|---|\n| bob | ${j('k3y', 'Val99x')} |`, 'env_secret', j('k3y', 'Val99x')],
      [`password: ${j('Xk9#mQ2;', 'vL,7(pZ)]')}`, 'env_secret', j('Xk9#mQ2;', 'vL,7(pZ)]')],
      [`PASSWORD=${j('abc123', 'xyz')} # rotate monthly`, 'env_secret', j('abc123', 'xyz')],
      [`curl -u admin:${j('Curl3d', 'Passw0rd')} https://api.example.com`, 'env_secret', j('Curl3d', 'Passw0rd')],
      ['curl -u user:password https://api.example.com', 'env_secret', null], // a documentation example
      [`Cookie: sessionid=${j('8f3k2l1m0n', '9b8v7c6x5z')}; theme=dark`, 'session_cookie', j('8f3k2l1m0n', '9b8v7c6x5z')],
      [`Set-Cookie: sid=${j('abc123', 'def456ghi7')}; Path=/; HttpOnly`, 'session_cookie', j('abc123', 'def456ghi7')],
      ['Cookie: theme=dark; lang=en', 'session_cookie', null],
      [`Authorization: Token ${j('9f8e7d6c5b4a', '3928AbCdEf')}`, 'bearer', j('9f8e7d6c5b4a', '3928AbCdEf')],
      // ... and what must stay unmasked
      ['API_KEY_ID=12345', 'env_secret', null],
      ['PUBLIC_KEY_PATH=/etc/keys/pub.pem', 'env_secret', null],
      ['SESSION_TIMEOUT=30', 'env_secret', null],
      ['PASSPORT_NO=A1234567', 'env_secret', null],
      ['AUTHOR=jane', 'env_secret', null],
      ['AUTH_PROVIDER=google', 'env_secret', null],
      ['SESSION_DRIVER=redis', 'env_secret', null],
      ['PRIMARY_KEY=id', 'env_secret', null],
      ['RECAPTCHA_SITE_KEY=6LcXyzAbCdEf1234', 'env_secret', null],
      ['<div data-key="row-5">', 'env_secret', null],
      ["  ssh_key: 'CREDENTIAL',", 'env_secret', null],
      ['const session = await client.openSession();', 'env_secret', null],
      ['requests.post(url, auth=(user, password))', 'env_secret', null],
      ['// first pass: copy the runs', 'env_secret', null],
      ['new Client({ connectionString: conn })', 'env_secret', null],
      ["p('?password=', 'x')", 'env_secret', null],
    ];
    for (const [text, id, want] of formatCases) {
      const got = want === null
        ? maskText(text, { enabled: [id] }).findings.map((f) => f.original)
        : maskText(text).findings.filter((f) => f.original === want).map((f) => f.id);
      const ok = want === null ? got.length === 0 : got.length === 1 && got[0] === id;
      if (ok) {
        passed++;
      } else {
        console.error(`FAIL ${id} ${JSON.stringify(text.slice(0, 60))}: expected ${want === null ? 'no match' : 'a match'}, got ${JSON.stringify(got)}`);
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
    azure_storage_key: 'fake is the value only; the pattern needs its AccountKey= context',
    aws_secret: 'a bare 40-character key needs a key id or label nearby to count',
    url_password: 'fake is the password only; the pattern needs its scheme://user:…@host',
    session_cookie: 'fake is the cookie value only; the pattern needs its Cookie: line',
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
