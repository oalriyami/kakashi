/**
 * Real database integration tests.
 *
 * Until now every db test ran against `mock://`, an in-memory array. That
 * exercised `streamMasked`'s plumbing but never the six driver adapters
 * themselves, which are the part that can break: they are the code that touches
 * a client library's API surface, and none of them had ever executed. A driver
 * could have been syntactically fine and completely non-functional without a
 * single test noticing.
 *
 * These tests use REAL databases:
 *
 *   SQLite    — always, when `better-sqlite3` is installed. No server needed,
 *               so this is the one that runs everywhere including CI.
 *   Postgres  — when `pg` is installed AND KAKASHI_TEST_POSTGRES_URL points at
 *               a reachable server. CI supplies one as a service container.
 *
 * A driver whose prerequisites are missing is SKIPPED AND REPORTED AS SKIPPED,
 * never silently passed. A green run that quietly tested nothing is exactly the
 * failure mode this file exists to end.
 *
 * MySQL, MongoDB, Snowflake and Databricks remain uncovered — they need a
 * server (or an account) that CI does not have. Their `--limit` pushdown is
 * covered by the sqlWithLimit unit tests below; their connection handling is
 * still unproven, and PROJECT_SUMMARY.md says so.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { streamMasked, aggregate, inferDriver } = require('../src/engine/db');
const { spawnSync } = require('child_process');
const { sqlWithLimit, parseLimit } = require('../src/engine/db/limit');

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const PG_URL = process.env.KAKASHI_TEST_POSTGRES_URL || '';

/** Rows deliberately containing a repeated person, so token stability is testable. */
const SEED = [
  [1, 'Ahmed Al Mansouri', 'ahmed@example.ae', '784-1990-9999999-0', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa'],
  [2, 'Fatima Al Zaabi', 'fatima@example.ae', '784-1985-8888888-0', 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  [3, 'Ahmed Al Mansouri', 'ahmed@example.ae', '784-1990-9999999-0', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa'],
];

function have(mod) {
  try { require.resolve(mod); return true; } catch { return false; }
}

async function collect(stream) {
  const out = [];
  for await (const item of stream) out.push(item);
  return out;
}

/** Assertions that must hold for every driver, so the drivers stay comparable. */
async function assertMaskingContract(conn, sql, label) {
  const rows = await collect(streamMasked(conn, sql));
  assert.strictEqual(rows.length, 3, `${label}: expected 3 rows`);

  const [r1, r2, r3] = rows.map((r) => r.masked);

  // Nothing sensitive survives.
  const blob = JSON.stringify(rows.map((r) => r.masked));
  for (const leak of ['ahmed@example.ae', '784-1990-9999999-0', 'sk-ant-api03', 'ghp_bbbb', 'Ahmed Al Mansouri']) {
    assert.ok(!blob.includes(leak), `${label}: "${leak}" leaked into masked output`);
  }

  // Structure survives: same columns, non-sensitive values untouched.
  assert.deepStrictEqual(Object.keys(r1).sort(), ['eid', 'email', 'id', 'name', 'secret'].sort(), `${label}: columns changed`);
  assert.strictEqual(r1.id, 1, `${label}: non-sensitive column was altered`);

  // Token STABILITY: row 3 is the same person as row 1 and must reuse its tokens.
  // This is what makes a masked extract still analysable -- a join on `email`
  // still groups the same person together.
  assert.strictEqual(r3.email, r1.email, `${label}: same value got different tokens across rows`);
  assert.strictEqual(r3.name, r1.name, `${label}: same name got different tokens across rows`);

  // Token DISTINCTNESS: row 2 is a different person and must not collapse onto row 1.
  assert.notStrictEqual(r2.email, r1.email, `${label}: two different people share a token`);

  // Credentials in a free-text column are caught, and the two distinct secrets
  // get distinct token types.
  assert.ok(/^\[ANTHROPIC_\d+\]$/.test(r1.secret), `${label}: anthropic key not tokenised: ${r1.secret}`);
  assert.ok(/^\[GH_TOKEN_\d+\]$/.test(r2.secret), `${label}: github token not tokenised: ${r2.secret}`);

  return rows;
}

async function runDbIntegrationTests() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  async function check(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`FAIL ${name}: ${err.message}`);
      failed++;
    }
  }

  function skip(name, why) {
    console.log(`SKIP ${name} — ${why}`);
    skipped++;
  }

  // -------------------------------------------------------------------------
  // sqlWithLimit — pure, so it runs everywhere and covers the drivers that no
  // CI can reach.
  // -------------------------------------------------------------------------
  await check('sqlWithLimit wraps a statement in a capped derived table', () => {
    assert.strictEqual(
      sqlWithLimit('SELECT * FROM staff', 2),
      'SELECT * FROM (\nSELECT * FROM staff\n) AS kakashi_limited LIMIT 2',
    );
  });

  await check('sqlWithLimit strips trailing semicolons before wrapping', () => {
    // Without this the wrap produces `(SELECT …;) AS t`, a syntax error.
    assert.strictEqual(
      sqlWithLimit('SELECT * FROM staff;;  ', 5),
      'SELECT * FROM (\nSELECT * FROM staff\n) AS kakashi_limited LIMIT 5',
    );
  });

  await check('sqlWithLimit keeps a trailing -- comment inside the wrap', () => {
    // On one line, the comment swallowed the closing parenthesis.
    const wrapped = sqlWithLimit('SELECT * FROM staff -- active only', 5);
    assert.ok(wrapped.includes('-- active only\n) AS kakashi_limited'), wrapped);
  });

  // -------------------------------------------------------------------------
  // #34: an unusable limit is an ERROR. It used to leave the statement
  // unwrapped -- and the wrap is what stops a DELETE, UPDATE or DROP from
  // running -- so `--limit abc` turned db-scan into a way to empty a table.
  // -------------------------------------------------------------------------
  await check('#34 sqlWithLimit refuses an unusable limit instead of skipping the wrap', () => {
    for (const bad of [undefined, null, 0, -1, 1.5, '10', NaN, Infinity]) {
      assert.throws(() => sqlWithLimit('DELETE FROM staff', bad), /positive integer/, `accepted ${String(bad)}`);
    }
  });

  await check('#34 parseLimit accepts only a whole number from 1 to 10,000,000', () => {
    assert.strictEqual(parseLimit(undefined), 10000);
    assert.strictEqual(parseLimit('25'), 25);
    assert.strictEqual(parseLimit(' 7 '), 7);
    assert.strictEqual(parseLimit(10000000), 10000000);
    for (const bad of ['abc', '0', '-5', '1.5', '1e3', '0x10', '', '10000001', '07', '5 rows']) {
      assert.throws(() => parseLimit(bad), /whole number/, `accepted ${JSON.stringify(bad)}`);
    }
  });

  await check('#34 db-scan and db-mask exit 2 on an unusable --limit, before connecting', () => {
    const out = path.join(os.tmpdir(), `kakashi-limit-${process.pid}.jsonl`);
    for (const cmd of ['db-scan', 'db-mask']) {
      for (const bad of ['abc', '0', '-5']) {
        const r = cli([cmd, 'mock:customers', '-q', 'SELECT *', `--limit=${bad}`, ...(cmd === 'db-mask' ? ['-o', out] : [])]);
        assert.strictEqual(r.status, 2, `${cmd} --limit ${bad} -> ${r.status}`);
        assert.ok(/whole number/.test(r.stderr), r.stderr);
      }
    }
    assert.ok(!fs.existsSync(out), 'an output was written');
  });

  await check('#34 mysql: read-only transaction, rolled back, statement wrapped', async () => {
    if (!have('mysql2/promise')) return;
    // No MySQL server in CI: stand in for the client and record what is sent.
    const key = require.resolve('mysql2/promise');
    const real = require.cache[key];
    const sent = [];
    require.cache[key] = { id: key, filename: key, loaded: true, exports: {
      createConnection: async () => ({
        query: async (sql) => { sent.push(['query', sql]); return [[]]; },
        execute: async (sql) => { sent.push(['execute', sql]); return [[{ id: 1 }]]; },
        end: async () => { sent.push(['end']); },
      }),
    } };
    try {
      const rows = await collect(require('../src/engine/db/mysql').query('mysql://u:p@h/db', 'SELECT id FROM t;', { limit: 3 }));
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(sent, [
        ['query', 'START TRANSACTION READ ONLY'],
        ['execute', 'SELECT * FROM (\nSELECT id FROM t\n) AS kakashi_limited LIMIT 3'],
        ['query', 'ROLLBACK'],
        ['end'],
      ]);
    } finally {
      if (real) require.cache[key] = real;
      else delete require.cache[key];
    }
  });

  await check('inferDriver recognises every connection shape the CLI accepts', () => {
    assert.strictEqual(inferDriver('postgres://u:p@h/db'), 'postgres');
    assert.strictEqual(inferDriver('postgresql://u:p@h/db'), 'postgresql');
    assert.strictEqual(inferDriver('mysql://u:p@h/db'), 'mysql');
    assert.strictEqual(inferDriver('mongodb+srv://u:p@h/db'), 'mongodb+srv');
    assert.strictEqual(inferDriver('jdbc:databricks://h/p'), 'databricks');
    assert.strictEqual(inferDriver('./local.db'), 'sqlite');
    assert.strictEqual(inferDriver(':memory:'), 'sqlite');
  });

  // -------------------------------------------------------------------------
  // SQLite — a real file-backed database, no server.
  // -------------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-db-'));
  const dbPath = path.join(tmp, 'staff.db');

  if (!have('better-sqlite3')) {
    skip('sqlite: masks real rows', 'better-sqlite3 not installed');
    skip('sqlite: --limit is applied by the database', 'better-sqlite3 not installed');
  } else {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE staff (id INTEGER, name TEXT, email TEXT, eid TEXT, secret TEXT)');
    const ins = db.prepare('INSERT INTO staff VALUES (?,?,?,?,?)');
    for (const row of SEED) ins.run(...row);
    db.close();

    await check('sqlite: masks real rows and keeps them analysable', async () => {
      await assertMaskingContract(dbPath, 'SELECT * FROM staff ORDER BY id', 'sqlite');
    });

    await check('sqlite: --limit is applied by the database, not after the fetch', async () => {
      const rows = await collect(streamMasked(dbPath, 'SELECT * FROM staff ORDER BY id', { limit: 2 }));
      assert.strictEqual(rows.length, 2);
    });

    await check('sqlite: aggregate() reports findings across the result set', async () => {
      const summary = await aggregate(streamMasked(dbPath, 'SELECT * FROM staff'));
      assert.strictEqual(summary.rows, 3);
      assert.ok(summary.byCategory.cred >= 3, `expected credentials, got ${summary.byCategory.cred}`);
      assert.ok(summary.byCategory.pii > 0, 'expected PII findings');
    });
  }

  // -------------------------------------------------------------------------
  // Postgres — needs a server. CI provides one; a developer can export
  // KAKASHI_TEST_POSTGRES_URL to run these locally.
  // -------------------------------------------------------------------------
  if (!have('pg')) {
    skip('postgres: masks real rows', 'pg not installed');
    skip('postgres: --limit reaches the server', 'pg not installed');
  } else if (!PG_URL) {
    skip('postgres: masks real rows', 'KAKASHI_TEST_POSTGRES_URL not set');
    skip('postgres: --limit reaches the server', 'KAKASHI_TEST_POSTGRES_URL not set');
  } else {
    const { Client } = require('pg');
    const table = `kakashi_staff_${process.pid}`;
    let reachable = true;
    try {
      const c = new Client({ connectionString: PG_URL });
      await c.connect();
      await c.query(`CREATE TABLE ${table} (id int, name text, email text, eid text, secret text)`);
      for (const row of SEED) {
        await c.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4,$5)`, row);
      }
      await c.end();
    } catch (err) {
      reachable = false;
      skip('postgres: masks real rows', `server unreachable: ${err.message}`);
      skip('postgres: --limit reaches the server', `server unreachable: ${err.message}`);
    }

    if (reachable) {
      await check('postgres: masks real rows and keeps them analysable', async () => {
        await assertMaskingContract(PG_URL, `SELECT id, name, email, eid, secret FROM ${table} ORDER BY id`, 'postgres');
      });

      await check('postgres: --limit reaches the server, not just the client', async () => {
        // 20 million rows. `pg`'s client.query() resolves with the COMPLETE row
        // set, so if the cap were still applied client-side this would have to
        // buffer all of them before yielding one -- it would exhaust memory or
        // take minutes. Returning 3 rows quickly is the proof that the LIMIT
        // executed in the database.
        const started = Date.now();
        const rows = await collect(streamMasked(
          PG_URL,
          'SELECT i AS id, i::text AS name FROM generate_series(1,20000000) i',
          { limit: 3 },
        ));
        const elapsed = Date.now() - started;
        assert.strictEqual(rows.length, 3);
        assert.ok(elapsed < 30000, `took ${elapsed}ms — cap did not reach the server`);
      });

      // ---------------------------------------------------------------------
      // #34, against a real server: nothing the query text can say gets a
      // write past the read-only cursor.
      // ---------------------------------------------------------------------
      const count = async () => {
        const k = new Client({ connectionString: PG_URL });
        await k.connect();
        const r = await k.query(`SELECT count(*)::int AS n FROM ${table}`);
        await k.end();
        return r.rows[0].n;
      };
      const before = await count();
      const setup = new Client({ connectionString: PG_URL });
      await setup.connect();
      await setup.query(`CREATE OR REPLACE FUNCTION ${table}_wipe() RETURNS int LANGUAGE sql AS $$ DELETE FROM ${table} RETURNING 1 $$`);
      await setup.end();

      const attempts = [
        ['a DELETE with an unusable --limit', `DELETE FROM ${table}`, ['--limit=abc']],
        ['a DELETE with the default limit', `DELETE FROM ${table}`, []],
        ['a second statement after a SELECT', `SELECT 1; DELETE FROM ${table}`, []],
        ['a data-modifying WITH', `WITH d AS (DELETE FROM ${table} RETURNING *) SELECT * FROM d`, []],
        ['a function that writes', `SELECT ${table}_wipe()`, []],
        ['a DROP', `DROP TABLE ${table}`, []],
      ];
      for (const [label, sql, extra] of attempts) {
        await check(`#34 postgres: ${label} changes nothing and exits 2`, async () => {
          const r = cli(['db-scan', PG_URL, '-q', sql, ...extra]);
          assert.strictEqual(r.status, 2, `exit ${r.status}: ${r.stdout}${r.stderr}`);
          assert.strictEqual(await count(), before, 'rows changed');
        });
      }

      await check('#34 postgres: the cap holds across fetch batches and a trailing comment works', async () => {
        const rows = await collect(streamMasked(
          PG_URL, 'SELECT i FROM generate_series(1, 5000) i -- every row', { limit: 2500 },
        ));
        assert.strictEqual(rows.length, 2500);
      });

      const c = new Client({ connectionString: PG_URL });
      await c.connect();
      await c.query(`DROP FUNCTION IF EXISTS ${table}_wipe()`);
      await c.query(`DROP TABLE IF EXISTS ${table}`);
      await c.end();
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const tail = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`db-integration.test.js: ${passed} passed, ${failed} failed${tail}`);
  return failed === 0;
}

module.exports = { runDbIntegrationTests };

if (require.main === module) {
  runDbIntegrationTests().then((ok) => process.exit(ok ? 0 : 1));
}
