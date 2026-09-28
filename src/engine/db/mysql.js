const { missingDriver } = require('./missing');
const { sqlWithLimit } = require('./limit');

/**
 * MySQL / MariaDB driver adapter.
 *
 * Requires the `mysql2` npm package:
 *   npm install -g mysql2   (optional; see ./missing.js)
 *
 * Connection string: mysql://user:pass@host:port/db
 *
 * The query runs inside a READ ONLY transaction that is always rolled back,
 * as a prepared statement (one statement only), wrapped in a capped derived
 * table that a DELETE, UPDATE or DROP cannot appear in (#34).
 */

async function* query(conn, sql, options = {}) {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (err) {
    throw missingDriver('MySQL', 'mysql2');
  }

  const wrapped = sqlWithLimit(sql, options.limit);
  const connection = await mysql.createConnection(conn);
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const [rows] = await connection.execute(wrapped);
    for (const row of rows) {
      yield row;
    }
  } finally {
    try { await connection.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    await connection.end();
  }
}

module.exports = { query };
