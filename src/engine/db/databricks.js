const { sqlWithLimit } = require('./limit');

/**
 * Databricks SQL Warehouse driver adapter.
 *
 * Requires the `@databricks/sql` npm package:
 *   npm install -g @databricks/sql   (optional; see ./missing.js)
 *
 * Connection string:
 *   databricks://<pat-token>@<host>/<http-path>
 * Example:
 *   databricks://dapi1234@myworkspace.cloud.databricks.com/sql/1.0/warehouses/xxxx
 */

const { missingDriver } = require('./missing');

async function* query(conn, sql, options = {}) {
  let DBSQLClient;
  try {
    ({ DBSQLClient } = require('@databricks/sql'));
  } catch (err) {
    throw missingDriver('Databricks', '@databricks/sql', 'Version 2.2 or later is recommended; it needs Node 20 or later');
  }

  const url = new URL(conn);
  const client = new DBSQLClient();
  await client.connect({
    token: decodeURIComponent(url.username || url.password || ''),
    host: url.hostname,
    path: url.pathname,
  });

  const session = await client.openSession();
  try {
    const op = await session.executeStatement(sqlWithLimit(sql, options.limit), { runAsync: true });
    const rows = await op.fetchAll();
    await op.close();
    for (const row of rows) {
      yield row;
    }
  } finally {
    await session.close();
    await client.close();
  }
}

module.exports = { query };
