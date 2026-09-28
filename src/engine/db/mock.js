/**
 * Mock database driver — for tests and demos only.
 *
 * Connection strings:
 *   mock:customers   → yields a canned UAE customer list (5 rows)
 *   mock:empty       → yields nothing
 *   mock:leaky       → yields rows with embedded credentials
 *   mock:typed       → yields numbers, booleans and a carriage return
 *
 * No real database required. Lets us exercise the full db-scan / db-mask /
 * db-audit CLI paths in CI without installing pg / mysql / mongodb / etc.
 */

const CANNED = {
  customers: [
    { id: 1, name: 'Ahmed Al Mansouri', emirates_id: '784-1990-9999999-0', email: 'ahmed@example.ae', phone: '+971501234567', iban: 'AE070331234567890123456' },
    { id: 2, name: 'Fatima Al Zaabi',   emirates_id: '784-1985-8888888-0', email: 'fatima@example.ae', phone: '+971502345678', iban: 'AE070331234567890123457' },
    { id: 3, name: 'Mohammed Hassan',   emirates_id: '784-1978-7777777-0', email: 'm.hassan@example.ae', phone: '+971503456789', iban: 'AE070331234567890123458' },
    { id: 4, name: 'Sara Al Nuaimi',    emirates_id: '784-1992-6666666-0', email: 'sara@example.ae', phone: '+971504567890', iban: 'AE070331234567890123459' },
    { id: 5, name: 'Khalid Bin Rashid', emirates_id: '784-1980-5555555-0', email: 'khalid@example.ae', phone: '+971505678901', iban: 'AE070331234567890123460' },
  ],
  empty: [],
  // Typed values, as SQLite and Postgres return them: numbers, booleans and
  // text with a carriage return in it (#43).
  typed: [
    { id: 1, full_name: 'Ahmed Hassan', phone: 971501234567, card: 4111111111111111, note: 'first line\rsecond line', active: true },
    { id: 2, full_name: 'Sara Ali', phone: 971502345678, card: null, note: 'ok', active: false },
  ],
  leaky: [
    { id: 1, config: 'OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr678stu', db: 'postgresql://admin:P@ssword1@prod.db.example.ae:5432/customers' },
  ],
};

async function* query(conn) {
  const key = conn.replace(/^mock:/, '') || 'customers';
  const rows = CANNED[key] || [];
  for (const row of rows) {
    yield row;
  }
}

module.exports = { query };
