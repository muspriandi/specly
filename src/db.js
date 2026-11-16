const { Pool, Client } = require('pg');
const config = require('./config');
const log = require('./lib/log');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  connectionTimeoutMillis: config.db.connectTimeoutMs, // fail fast when the database is unreachable instead of hanging
  statement_timeout: config.db.statementTimeoutMs,     // a runaway query cannot hold a connection forever
  idle_in_transaction_session_timeout: 60000,          // nor can a transaction left open
  application_name: 'specly',
  ssl: config.db.ssl,
});
pool.on('error', (e) => log.error('postgres pool error (idle client dropped)', { event: 'db.pool_error', err: e }));

// Slow-query warning: the SQL text (never the parameters, which may hold personal data) and how long it took.
const timed = async (sql, run) => {
  const start = process.hrtime.bigint();
  try { return await run(); } finally {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (config.slowQueryMs > 0 && ms >= config.slowQueryMs) log.warn('slow query', { event: 'db.slow_query', ms: Math.round(ms), sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
};

// Run a query and return all rows. Use $1, $2… placeholders.
const query = async (sql, params = []) => (await timed(sql, () => pool.query(sql, params))).rows;
const one = async (sql, params = []) => (await query(sql, params))[0] || null;

// Run fn(q) inside a transaction. q has the same signature as query().
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(async (sql, params = []) => (await timed(sql, () => client.query(sql, params))).rows);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Create the target database if it doesn't exist yet (connects to the "postgres" db).
async function ensureDatabase() {
  const url = new URL(config.databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[\w-]+$/.test(name)) throw new Error(`Unsupported database name: ${name}`);
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE "${name}"`);
      log.info(`created database "${name}"`, { event: 'db.created' });
    }
  } finally {
    await admin.end();
  }
}

// Brings the schema up to date (see src/migrate.js). With AUTO_MIGRATE=false the server only checks: it refuses to start
// while migrations are pending, so they can be applied deliberately with `npm run migrate` (for example before a deploy).
async function init() {
  await ensureDatabase();
  const migrate = require('./migrate');
  if (config.autoMigrate) {
    await migrate.up(pool);
    return;
  }
  const pending = (await migrate.status(pool)).filter((m) => !m.applied);
  if (pending.length) throw new Error(`${pending.length} pending migration(s): ${pending.map((m) => m.file).join(', ')}. Run: npm run migrate`);
}

// True when the database answers a trivial query (used by /healthz).
const ping = () => pool.query('SELECT 1').then(() => true, () => false);

// Delete expired sessions, one-time tokens and old share links, and (when AUDIT_RETENTION_DAYS is set) old audit rows.
// Returns and logs how much was removed.
async function purgeExpired() {
  const run = async (sql, params = []) => (await pool.query(sql, params)).rowCount;
  const [sessions, tokens, shareLinks] = await Promise.all([
    run(`DELETE FROM sessions WHERE expires_at < now() OR ($1::int > 0 AND last_seen_at < now() - ($1::int * interval '1 hour'))`, [config.sessionIdleHours]),
    run('DELETE FROM tokens WHERE expires_at < now()'),
    run(`DELETE FROM share_links WHERE expires_at < now() - interval '30 days'`),
  ]);
  const audit = config.auditRetentionDays > 0
    ? await run(`DELETE FROM audit_log WHERE at < now() - ($1 || ' days')::interval`, [String(config.auditRetentionDays)]) : 0;
  const ended = await run(`UPDATE access_requests SET status='rejected', decided_at=now() WHERE status='approved' AND expires_at <= now()`); // time-limited access that ran out
  const removed = { sessions, tokens, shareLinks, auditRows: audit, accessEnded: ended };
  if (sessions + tokens + shareLinks + audit + ended > 0) log.info('purged expired data', { event: 'db.purge', ...removed });
  return removed;
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (e) => e && e.code === UNIQUE_VIOLATION;

module.exports = { query, one, tx, init, ensureDatabase, ping, purgeExpired, isUniqueViolation, pool };
