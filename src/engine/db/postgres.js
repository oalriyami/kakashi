const { stripStatement } = require('./limit');

/**
 * PostgreSQL driver adapter.
 *
 * Requires the `pg` npm package:
 *   npm install pg
 *
 * Connection string: postgres://user:pass@host:port/db
 *
 * The query runs inside a READ ONLY transaction, through a server-side cursor,
 * and the transaction is always rolled back (#34):
 *
 *   - `DECLARE … CURSOR FOR` accepts only a SELECT or VALUES, so a DELETE,
 *     UPDATE, DROP or a data-modifying WITH is rejected before anything runs.
 *   - It is sent as a prepared statement, which cannot hold a second
 *     statement: `SELECT 1; DELETE FROM customers` is an error, not two queries.
 *   - READ ONLY stops a function called from the SELECT from writing.
 *   - FETCH takes the rows in batches up to the limit, so the server stops at
 *     the cap and memory stays bounded however large the table is. No rewriting
 *     of the caller's SQL is needed, so comments and CTEs work as written.
 */

const BATCH = 1000;

async function* query(conn, sql, options = {}) {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    throw new Error("Postgres driver requires the 'pg' package. Install with: npm install pg");
  }
  const limit = options.limit;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`row limit must be a positive integer, got ${String(limit)}`);
  }
  const statement = stripStatement(sql);
  if (!statement) throw new Error('the query is empty');

  const client = new Client({ connectionString: conn });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query({ name: 'kakashi_declare', text: `DECLARE kakashi_rows NO SCROLL CURSOR FOR\n${statement}\n` });
    let remaining = limit;
    while (remaining > 0) {
      const size = Math.min(remaining, BATCH);
      const result = await client.query(`FETCH FORWARD ${size} FROM kakashi_rows`);
      for (const row of result.rows) yield row;
      if (result.rows.length < size) break;
      remaining -= result.rows.length;
    }
  } finally {
    // Nothing was written, and nothing may be: always roll back.
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    await client.end();
  }
}

module.exports = { query };
