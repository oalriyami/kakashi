const { sqlWithLimit } = require('./limit');

/**
 * SQLite driver adapter.
 *
 * Requires the `better-sqlite3` npm package:
 *   npm install -g better-sqlite3   (optional; see ./missing.js)
 *
 * Connection string: a file path like "./local.db" or ":memory:".
 */

const { missingDriver } = require('./missing');

async function* query(conn, sql, options = {}) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    throw missingDriver('SQLite', 'better-sqlite3');
  }

  const db = new Database(conn, { readonly: true, fileMustExist: conn !== ':memory:' });
  try {
    const rows = db.prepare(sqlWithLimit(sql, options.limit)).all();
    for (const row of rows) {
      yield row;
    }
  } finally {
    db.close();
  }
}

module.exports = { query };
