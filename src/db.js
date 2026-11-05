const fs = require('fs');
const path = require('path');
const { Pool, Client } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });
pool.on('error', (e) => console.error('Postgres pool error:', e.message)); // idle client dropped

// Run a query and return all rows. Use $1, $2… placeholders.
const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params = []) => (await query(sql, params))[0] || null;

// Run fn(q) inside a transaction. q has the same signature as query().
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
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
      console.log(`Created database "${name}"`);
    }
  } finally {
    await admin.end();
  }
}

async function init() {
  await ensureDatabase();
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
}

// Delete expired sessions and one-time tokens.
const purgeExpired = () => Promise.all([
  pool.query('DELETE FROM sessions WHERE expires_at < now()'),
  pool.query('DELETE FROM tokens WHERE expires_at < now()'),
]);

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (e) => e && e.code === UNIQUE_VIOLATION;

module.exports = { query, one, tx, init, purgeExpired, isUniqueViolation, pool };
