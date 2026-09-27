const { sqlWithLimit } = require('./limit');

/**
 * MySQL / MariaDB driver adapter.
 *
 * Requires the `mysql2` npm package:
 *   npm install mysql2
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
    throw new Error("MySQL driver requires the 'mysql2' package. Install with: npm install mysql2");
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
