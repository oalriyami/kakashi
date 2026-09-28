const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { maskText } = require('../src/engine/masker');
const formats = require('../src/engine/formats');
const { structureOf } = require('../src/engine/formats/structure');
const { maskRow, redactConnection } = require('../src/engine/db');

// ---------------------------------------------------------------------------
// #43 -- masking must leave JSON, YAML, TOML, CSV, TSV and database exports as
//        valid as it found them.
// #44 -- a database command never prints the connection string.
// All values are synthetic.
// ---------------------------------------------------------------------------

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');
const CARD = ['4111', '1111', '1111', '1111'].join('');
const EMAIL = ['a.b', 'example.com'].join('@');
const PHONE = ['971', '50', '1234567'].join('');

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', ...opts });
}

const masked = (text, kind, opts = {}) => maskText(text, { structure: kind, ...opts }).masked;

async function runStructureTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-structure-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-structure-home-'));
  const env = { ...process.env, HOME: home };

  // =========================================================================
  // #43 text formats
  // =========================================================================

  await check('#43 structureOf knows the structured extensions', () => {
    assert.deepStrictEqual(
      ['a.json', 'a.jsonl', 'a.yml', 'a.yaml', 'a.toml', 'a.tsv', 'a.csv', 'a.txt'].map(structureOf),
      ['json', 'jsonl', 'yaml', 'yaml', 'toml', 'tsv', 'csv', null],
    );
  });

  await check('#43 a token replacing a JSON number is a string, and the JSON parses', () => {
    const text = `{"card": ${CARD}, "phone": ${PHONE}, "tags": [${CARD}], "email": "${EMAIL}"}`;
    const out = JSON.parse(masked(text, 'json'));
    assert.deepStrictEqual(out, { card: '[CC_1]', phone: '[INTL_PHONE_1]', tags: ['[CC_1]'], email: '[EMAIL_1]' });
  });

  await check('#43 every line of JSON Lines still parses', () => {
    const text = `{"card": ${CARD}}\n{"email": "${EMAIL}"}\n`;
    for (const line of masked(text, 'jsonl').trim().split('\n')) JSON.parse(line);
  });

  await check('#43 a fake PEM key stays one escaped line inside a JSON string', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq1vKmCnRZ6YJbWkKq3ERVtVQwIIGZ9yDbXwv0T0vD0xg\n-----END RSA PRIVATE KEY-----';
    const text = JSON.stringify({ key: pem, id: 1 });
    const out = masked(text, 'json', { mode: 'fake' });
    assert(!out.includes('\n'), 'raw newline inside the JSON');
    assert.strictEqual(JSON.parse(out).id, 1);
    assert(!out.includes('MIIEowIBAAKCAQEA'), 'the key was not replaced');
  });

  await check('#43 YAML plain scalars that would start with [ are quoted', () => {
    const text = `email: ${EMAIL}\nphones: [+${PHONE}, 0501234567]\nlist:\n  - ${EMAIL}\nnote: call +${PHONE} now # ok\n`;
    assert.strictEqual(masked(text, 'yaml'), [
      "email: '[EMAIL_1]'",
      "phones: ['[INTL_PHONE_1]', '[INTL_PHONE_2]']",
      'list:',
      "  - '[EMAIL_1]'",
      'note: call [INTL_PHONE_1] now # ok',
      '',
    ].join('\n'));
  });

  await check('#43 YAML age and dob keys survive (only the values change)', () => {
    assert.strictEqual(masked('age: 38\ndob: 1985-03-14\n', 'yaml'), "age: '[AGE_1]'\ndob: '[DOB_1]'\n");
  });

  await check('#43 YAML quoted scalars are escaped, not requoted', () => {
    assert.strictEqual(masked(`a: "${EMAIL}"\nb: '${EMAIL}'\n`, 'yaml'), 'a: "[EMAIL_1]"\nb: \'[EMAIL_1]\'\n');
  });

  await check('#43 a TOML number becomes a string; strings and comments stay', () => {
    const text = `card = ${CARD}\nemail = "${EMAIL}"\nlit = '${EMAIL}'\n# ${EMAIL}\n`;
    assert.strictEqual(masked(text, 'toml'), 'card = "[CC_1]"\nemail = "[EMAIL_1]"\nlit = \'[EMAIL_1]\'\n# [EMAIL_1]\n');
  });

  await check('#43 TSV name columns keep their columns', () => {
    const out = masked('first\tlast\tdept\nAhmed\tHassan\tFinance\n', 'tsv');
    for (const line of out.trim().split('\n')) assert.strictEqual(line.split('\t').length, 3, out);
    assert(!/Ahmed|Hassan/.test(out), out);
  });

  await check('#43 CSV quoted fields stay quoted and aligned', () => {
    const text = `name,email,note\nAhmed Hassan,${EMAIL},"call +${PHONE}, now"\n`;
    const out = masked(text, 'csv');
    assert.strictEqual(out.split('\n')[1], '[FULL_NAME_1],[EMAIL_1],"call [INTL_PHONE_1], now"');
  });

  await check('#43 mask of a .json file writes JSON that parses', () => {
    const src = path.join(dir, 'cards.json');
    fs.writeFileSync(src, JSON.stringify({ card: Number(CARD), email: EMAIL }, null, 2));
    const r = cli(['mask', src], { env });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'masked_cards.json'), 'utf8'));
    assert.deepStrictEqual(out, { card: '[CC_1]', email: '[EMAIL_1]' });
  });

  await check('#43 a text writer refuses JSON that no longer parses, and writes nothing', async () => {
    const src = path.join(dir, 'ok.json');
    fs.writeFileSync(src, '{"a": 1}');
    const out = path.join(dir, 'broken.json');
    const data = await formats.readFile(src);
    await assert.rejects(formats.writeMasked(src, out, data, {}, '{"a": [X_1]}'), /no longer valid JSON/);
    assert(!fs.existsSync(out), 'a corrupt file was left behind');
  });

  // =========================================================================
  // #43 database exports
  // =========================================================================

  await check('#43 a database row is masked value by value, keeping types', () => {
    const { masked: row, findings } = maskRow({ id: 1, phone: Number(PHONE), card: Number(CARD), active: true, note: null }, {}, {}, {});
    assert.deepStrictEqual(row, { id: 1, phone: '[INTL_PHONE_1]', card: '[CC_1]', active: true, note: null });
    assert.deepStrictEqual(findings.map((f) => f.id).sort(), ['cc', 'intl_phone']);
  });

  await check('#43 db-mask keeps every row whole in JSONL, JSON and CSV', () => {
    for (const fmt of ['jsonl', 'json', 'csv']) {
      const out = path.join(dir, `typed.${fmt}`);
      const r = cli(['db-mask', 'mock:typed', '-q', 'x', '-f', fmt, '-o', out], { env });
      assert.strictEqual(r.status, 0, `${fmt}: ${r.stderr}`);
      const body = fs.readFileSync(out, 'utf8');
      assert(!body.includes('__masked_raw__'), `${fmt}: a row fell back to raw text`);
      assert(!body.includes(PHONE) && !body.includes(CARD), `${fmt}: a number was left unmasked`);
      if (fmt === 'jsonl') {
        const rows = body.trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual(rows.map((x) => x.id), [1, 2]);
      } else if (fmt === 'json') {
        assert.strictEqual(JSON.parse(body).length, 2);
      } else {
        // The carriage return is inside a quoted field, so there are 3 records.
        assert(body.includes('"first line\rsecond line"'), JSON.stringify(body));
        assert.strictEqual(body.replace(/"[^"]*"/g, '').trim().split('\n').length, 3);
      }
    }
  });

  await check('#43 an empty result written as JSON is []', () => {
    const out = path.join(dir, 'empty.json');
    const r = cli(['db-mask', 'mock:empty', '-q', 'x', '-f', 'json', '-o', out], { env });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), []);
  });

  // =========================================================================
  // #44
  // =========================================================================

  const PW = ['Top', 'Secret', 'Pw77'].join('');
  await check('#44 a connection string without a scheme is refused without echoing it (exit 2)', () => {
    for (const conn of [`user:${PW}@host:5432/db`, `Server=db;Password=${PW};`]) {
      const r = cli(['db-scan', conn, '-q', 'select 1'], { env });
      assert.strictEqual(r.status, 2, `${conn}: exit ${r.status}`);
      assert(!(r.stdout + r.stderr).includes(PW), `password printed: ${r.stderr}`);
      assert(!/\n\s+at /.test(r.stderr), `stack trace printed: ${r.stderr}`);
    }
  });

  await check('#44 an empty connection string (unset $DATABASE_URL) says so (exit 2)', () => {
    const r = cli(['db-mask', '', '-q', 'select 1'], { env });
    assert.strictEqual(r.status, 2);
    assert(/DATABASE_URL/.test(r.stderr), r.stderr);
    assert(!/\n\s+at /.test(r.stderr), r.stderr);
  });

  await check('#44 errors quoting the connection string or its password are redacted', () => {
    const conn = `postgres://app:${PW}@db.example/x`;
    const msg = redactConnection(`connect to ${conn} failed: bad password ${PW}`, conn);
    assert(!msg.includes(PW) && !msg.includes('db.example/x'), msg);
    assert.strictEqual(redactConnection(`rejected ${PW}`, `Server=db;Password=${PW};`), 'rejected ***');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });

  console.log(`structure.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runStructureTests };

if (require.main === module) {
  runStructureTests().then((ok) => process.exit(ok ? 0 : 1));
}
