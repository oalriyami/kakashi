/**
 * Database masking — router + driver dispatcher.
 *
 * Kakashi's DB masking is 100% client-side. We connect to the database from
 * the user's machine, stream query results locally, run each row through
 * the same maskText() pipeline used for files, and write a masked-copy CSV
 * or JSON on disk. No hosted service, no proxy, no cloud. This preserves
 * Kakashi's "nothing leaves your machine" guarantee even when the source
 * data lives in a remote database.
 *
 * Driver loading strategy:
 *   Each per-driver adapter (`./postgres`, `./mysql`, ...) uses a LAZY
 *   `require()` of its underlying npm client (e.g. `pg`, `mysql2`). If the
 *   client isn't installed on the user's machine, we throw a friendly error
 *   telling them exactly what to `npm install`. This keeps Kakashi's base
 *   dependency footprint small — you only pay for what you use.
 */

const { maskText } = require('../masker');
const { parseLimit } = require('./limit');

const DRIVERS = {
  postgres:   () => require('./postgres'),
  postgresql: () => require('./postgres'),
  mysql:      () => require('./mysql'),
  mysql2:     () => require('./mysql'),
  mongodb:    () => require('./mongodb'),
  'mongodb+srv': () => require('./mongodb'),
  snowflake:  () => require('./snowflake'),
  databricks: () => require('./databricks'),
  sqlite:     () => require('./sqlite'),
  sqlite3:    () => require('./sqlite'),
  // In-memory mock adapter — used by tests to exercise the full pipeline
  // without any real database installed.
  mock:       () => require('./mock'),
};

/**
 * Infer the driver id from a connection string.
 * Accepts URI-style ("postgres://..."), JDBC-style ("jdbc:mysql://..."),
 * and file paths (assumed to be sqlite).
 * @param {string} conn
 * @returns {string} — driver id from DRIVERS
 */
function inferDriver(conn) {
  if (!conn || typeof conn !== 'string' || !conn.trim()) {
    // The documented call is `db-scan "$DATABASE_URL"`; unset, it is empty.
    throw new Error('No connection string was given. If you passed $DATABASE_URL, it is not set in this shell.');
  }
  const trimmed = conn.trim();

  // JDBC style
  const jdbc = trimmed.match(/^jdbc:([a-z0-9]+):/i);
  if (jdbc) return jdbc[1].toLowerCase();

  // URI style
  const uri = trimmed.match(/^([a-z0-9+]+):\/\//i);
  if (uri) return uri[1].toLowerCase();

  // File path -> sqlite
  if (/\.(db|sqlite|sqlite3)$/i.test(trimmed) || trimmed === ':memory:') {
    return 'sqlite';
  }

  // Explicit mock (for tests)
  if (trimmed.startsWith('mock:')) return 'mock';

  // Never echo the string: it usually holds a password (#44).
  if (/(?:^|;)\s*(?:server|data source|host|password|pwd|user id|uid|database)\s*=/i.test(trimmed)) {
    throw new Error('Key=value connection strings (ADO.NET, ODBC) are not supported; use a URL such as '
      + 'postgres://user:pass@host/db. The string is not shown because it may hold a password.');
  }
  throw new Error('Could not tell which database this connection string is for. Expected scheme://…, '
    + 'jdbc:<driver>://… or a .db / .sqlite file. The string is not shown because it may hold a password.');
}

/**
 * Load a driver by id.
 * @param {string} id
 */
function loadDriver(id) {
  const factory = DRIVERS[id];
  if (!factory) {
    throw new Error(`Unsupported database driver: "${id}". Supported: ${Object.keys(DRIVERS).sort().join(', ')}`);
  }
  try {
    return factory();
  } catch (err) {
    // Re-throw with a clearer message when the underlying client is missing.
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Driver "${id}" needs its client library installed. See src/engine/db/${id}.js for the exact npm command.\n` +
        `Original error: ${err.message}`,
      );
    }
    throw err;
  }
}

/**
 * Mask one row value by value (#43).
 *
 * The row used to be serialised to JSON, masked as one text and parsed back.
 * A token in a number (`"phone": 971501234567` -> `[INTL_PHONE_1]`) made the
 * JSON unparseable, and the row was written as `{"__masked_raw__": …}` -- or,
 * in CSV, as empty columns -- with exit 0. Each scalar is now masked on its
 * own, as `key: value` so that the column name still gives the patterns their
 * context (`password: …`, `dob: …`, `full_name: …`), and only findings in the
 * value are applied. A masked number becomes a string; everything else keeps
 * its type.
 *
 * @returns {{ masked: *, findings: object[] }}
 */
function maskRow(row, maskOpts, valueMap, counters) {
  const findings = [];
  const walk = (value, key) => {
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : walk(value.toISOString(), key);
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (typeof value === 'object') {
      if (typeof value.toJSON === 'function') {
        const json = value.toJSON();
        if (json !== value) return walk(json, key);
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    const str = typeof value === 'string' ? value : String(value);
    if (!str.trim()) return value;
    const label = key ? `${key}: ` : '';
    const r = maskText(label + str, { ...maskOpts, valueMap, counters });
    const mine = r.findings.filter((f) => f.offset + f.original.length > label.length);
    if (mine.length === 0) return value;
    let out = '';
    let at = 0;
    for (const f of mine) {
      // A finding that began in the label is clipped to the value.
      const start = Math.max(0, f.offset - label.length);
      const end = f.offset - label.length + f.original.length;
      out += str.slice(at, start) + f.replacement;
      at = end;
      findings.push({ ...f, offset: start, original: str.slice(start, end), line: 1 });
    }
    return out + str.slice(at);
  };
  return { masked: walk(row, ''), findings };
}

/**
 * Run a query, mask every row locally, and yield masked rows one at a time.
 * @param {string} conn — connection string
 * @param {string} query — SQL / mongo query
 * @param {object} options
 * @param {object} options.maskOpts — passed to maskText
 * @param {string} [options.driver] — explicit driver override
 * @param {number} [options.limit] — safety cap on row count (default 10000)
 * @returns {AsyncGenerator<{ row: object, masked: object, findings: object[] }>}
 */
async function* streamMasked(conn, query, options = {}) {
  const driverId = options.driver || inferDriver(conn);
  const driver = loadDriver(driverId);
  const { maskOpts = {} } = options;
  // Only a positive whole number is a limit. Anything else used to switch
  // the cap -- and with it the SQL drivers' protection against writes -- off
  // (#34).
  const limit = parseLimit(options.limit);

  // Token state is shared across EVERY row of this result set. maskText()
  // defaults these to fresh objects per call, which for a row-by-row stream
  // would restart numbering at `_1` on each row -- so five distinct customers
  // all masked to [FULL_NAME_1] and `--mode fake` gave every row the same
  // synthetic person. Threading one map through the whole stream keeps tokens
  // stable (same value -> same token) and distinct (different value ->
  // different token), which is what makes masked rows still analysable.
  const valueMap = {};
  const counters = {};

  let count = 0;
  // `limit` is passed to the driver so it can cap the query at the SERVER (see
  // ./limit.js), and re-checked here as a second line of defence for drivers
  // that cannot push it down.
  for await (const row of driver.query(conn, query, { ...options, limit })) {
    if (count >= limit) break;
    count++;
    const { masked, findings } = maskRow(row, maskOpts, valueMap, counters);
    yield { row, masked, findings };
  }
}

/**
 * Aggregate stream results into a summary — used by db-scan.
 * @param {AsyncGenerator} stream — from streamMasked
 * @returns {Promise<{ rows: number, findings: object[], byCategory: object }>}
 */
async function aggregate(stream) {
  const findings = [];
  let rows = 0;
  for await (const item of stream) {
    rows++;
    findings.push(...item.findings);
  }
  const byCategory = { id: 0, pii: 0, cred: 0 };
  for (const f of findings) {
    if (byCategory[f.cat] != null) byCategory[f.cat]++;
  }
  return { rows, findings, byCategory };
}

/**
 * `message` with the connection string, and the password inside it, removed
 * (#44). Driver errors can quote either.
 * @param {string} message
 * @param {string} conn
 */
function redactConnection(message, conn) {
  let out = String(message);
  const c = String(conn || '').trim();
  const secrets = [];
  if (c.length >= 4) secrets.push(c);
  // user:password@ in any URL-like form, and Password=…; in key=value form.
  const userinfo = /^[^:/@\s]*:\/\/[^:/@\s]*:([^@\s]+)@/.exec(c) || /^[^:/@\s]+:([^@\s]+)@/.exec(c);
  if (userinfo) {
    secrets.push(userinfo[1]);
    try { secrets.push(decodeURIComponent(userinfo[1])); } catch { /* not encoded */ }
  }
  for (const m of c.matchAll(/(?:password|pwd)\s*=\s*([^;]+)/gi)) secrets.push(m[1].trim());
  for (const secret of secrets.filter((x) => x && x.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('***');
  }
  return out;
}

module.exports = {
  redactConnection,
  maskRow,
  inferDriver,
  loadDriver,
  streamMasked,
  aggregate,
  DRIVERS,
};
