/**
 * Row caps for the database drivers.
 *
 * `--limit` used to be enforced only in `streamMasked`, by counting rows as they
 * came back and breaking out of the loop. That is a cap on how much Kakashi
 * MASKS, not on how much the database SENDS -- and the two SQL drivers that
 * matter most buffer the whole result set before yielding anything
 * (`pg`'s `client.query()` and `snowflake-sdk`'s `execute()` both resolve with a
 * complete row array). Pointing `db-mask` at a production table therefore pulled
 * the entire table into Node's heap before a `--limit 100` had any effect.
 *
 * Postgres now reads through a server-side cursor (./postgres.js). The other SQL
 * drivers wrap the caller's statement in a derived table so the server stops
 * producing rows. The alias is required -- MySQL and Postgres both reject an
 * unaliased derived table -- and the trailing semicolon has to go. The
 * statement sits on its own lines, so a trailing `-- comment` cannot swallow the
 * closing parenthesis.
 *
 * The wrap is also a SAFETY property, not only a size cap: a `DELETE`, `DROP`
 * or `UPDATE` cannot appear inside a derived table, so the database rejects it
 * before running anything. That is why an unusable limit is an error (#34).
 * `--limit 0`, `-5` or `abc` used to leave the statement unwrapped, and
 * `db-scan "$PG" -q "DELETE FROM customers" --limit abc` deleted every row
 * while reporting "0 rows, clean".
 */

const ALIAS = 'kakashi_limited';

/** The largest cap accepted. Above this, a scan is an export, not a check. */
const MAX_LIMIT = 10000000;
const DEFAULT_LIMIT = 10000;

/**
 * Parse a `--limit` value. Only a whole number from 1 to MAX_LIMIT is a limit.
 * @param {string|number|undefined} value - undefined means the default
 * @returns {number}
 * @throws when the value is anything else
 */
function parseLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  const text = String(value).trim();
  const n = /^[1-9]\d*$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n) || n > MAX_LIMIT) {
    throw new Error(`--limit must be a whole number from 1 to ${MAX_LIMIT}, got "${String(value)}"`);
  }
  return n;
}

/** The caller's statement without trailing semicolons and whitespace. */
function stripStatement(sql) {
  return String(sql).trim().replace(/(;\s*)+$/, '');
}

/**
 * @param {string} sql - the caller's statement
 * @param {number} limit - maximum rows (a positive integer)
 * @returns {string}
 * @throws when `limit` is not a positive integer or the statement is empty
 */
function sqlWithLimit(sql, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`row limit must be a positive integer, got ${String(limit)}`);
  }
  const statement = stripStatement(sql);
  if (!statement) throw new Error('the query is empty');
  return `SELECT * FROM (\n${statement}\n) AS ${ALIAS} LIMIT ${limit}`;
}

module.exports = { sqlWithLimit, parseLimit, stripStatement, ALIAS, MAX_LIMIT, DEFAULT_LIMIT };
