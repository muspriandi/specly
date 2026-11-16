const fs = require('fs');
const path = require('path');
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

// Several instances may start at once: an advisory lock makes them take turns, so the migration blocks never race.
// The schema runs without the statement timeout (an index build on a big table may legitimately take a while).
const SCHEMA_LOCK = 727274;
async function init() {
  await ensureDatabase();
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    try { await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')); }
    finally { await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]); }
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}

// True when the database answers a trivial query (used by /healthz).
const ping = () => pool.query('SELECT 1').then(() => true, () => false);

// Delete expired sessions, one-time tokens and old share links, and (when AUDIT_RETENTION_DAYS is set) old audit rows.
// Returns and logs how much was removed.
async function purgeExpired() {
  const run = async (sql, params = []) => (await pool.query(sql, params)).rowCount;
  const [sessions, tokens, shareLinks] = await Promise.all([
    run('DELETE FROM sessions WHERE expires_at < now()'),
    run('DELETE FROM tokens WHERE expires_at < now()'),
    run(`DELETE FROM share_links WHERE expires_at < now() - interval '30 days'`),
  ]);
  const audit = config.auditRetentionDays > 0
    ? await run(`DELETE FROM audit_log WHERE at < now() - ($1 || ' days')::interval`, [String(config.auditRetentionDays)]) : 0;
  const removed = { sessions, tokens, shareLinks, auditRows: audit };
  if (sessions + tokens + shareLinks + audit > 0) log.info('purged expired data', { event: 'db.purge', ...removed });
  return removed;
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (e) => e && e.code === UNIQUE_VIOLATION;

module.exports = { query, one, tx, init, ping, purgeExpired, isUniqueViolation, pool };
