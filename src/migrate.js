// Versioned, forward-only SQL migrations.
//
//   db/migrations/001_baseline.sql, 002_add_something.sql, ...   applied in number order, each in its own transaction,
//   recorded in the schema_migrations table with a checksum. Nothing is applied twice, and a file that was edited after it
//   was applied is refused (add a new migration instead). Several instances may start at once: an advisory lock makes
//   them take turns. A file whose first line is `-- migrate:no-transaction` runs outside a transaction (for statements such
//   as CREATE INDEX CONCURRENTLY).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./lib/log');

const DEFAULT_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATION_LOCK = 727274;
const FILE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
const NO_TX = /^\s*--\s*migrate:no-transaction\b/i;

const checksum = (sql) => crypto.createHash('sha256').update(sql.replace(/\r\n?/g, '\n')).digest('hex');

function loadFiles(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Migrations folder not found: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => FILE.test(f)).sort().map((f) => {
    const [, version, name] = FILE.exec(f);
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return { file: f, version, name, sql, checksum: checksum(sql), transactional: !NO_TX.test(sql.split('\n')[0]) };
  });
  const seen = new Set();
  for (const m of files) {
    if (seen.has(m.version)) throw new Error(`Two migrations share the number ${m.version}.`);
    seen.add(m.version);
  }
  return files;
}

const ENSURE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

async function withLock(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 0'); // an index build on a big table may legitimately take a while
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try { return await fn(client); } finally { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); }
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}

async function appliedMap(client) {
  await client.query(ENSURE);
  return new Map((await client.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows.map((r) => [r.version, r]));
}

// Applies every pending migration. Returns the names of the ones applied (empty when the database is up to date).
async function up(pool, { dir = DEFAULT_DIR } = {}) {
  const files = loadFiles(dir);
  return withLock(pool, async (client) => {
    const applied = await appliedMap(client);
    for (const m of files) {
      const done = applied.get(m.version);
      if (done && done.checksum !== m.checksum) {
        throw new Error(`Migration ${m.file} was changed after it was applied. Revert it and put the change in a new migration.`);
      }
    }
    for (const version of applied.keys()) {
      if (!files.some((m) => m.version === version)) log.warn(`database has migration ${version} that is not in ${dir}`, { event: 'db.migration_unknown', version });
    }
    const ran = [];
    for (const m of files.filter((f) => !applied.has(f.version))) {
      const started = Date.now();
      try {
        if (m.transactional) await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [m.version, m.name, m.checksum]);
        if (m.transactional) await client.query('COMMIT');
      } catch (e) {
        if (m.transactional) await client.query('ROLLBACK').catch(() => {});
        const err = new Error(`Migration ${m.file} failed${m.transactional ? ' and was rolled back' : ''}: ${e.message}`);
        err.cause = e;
        throw err;
      }
      ran.push(m.file);
      log.info(`applied migration ${m.file}`, { event: 'db.migration', version: m.version, name: m.name, ms: Date.now() - started });
    }
    return ran;
  });
}

// [{ version, name, file, applied, appliedAt, changed }] for every file and every recorded migration.
async function status(pool, { dir = DEFAULT_DIR } = {}) {
  const files = loadFiles(dir);
  return withLock(pool, async (client) => {
    const applied = await appliedMap(client);
    const rows = files.map((m) => {
      const done = applied.get(m.version);
      return { version: m.version, name: m.name, file: m.file, applied: !!done, appliedAt: done ? done.applied_at : null, changed: !!done && done.checksum !== m.checksum };
    });
    for (const [version, r] of applied) if (!files.some((m) => m.version === version)) rows.push({ version, name: r.name, file: null, applied: true, appliedAt: r.applied_at, changed: false, missing: true });
    return rows.sort((a, b) => a.version.localeCompare(b.version));
  });
}

// Creates the next numbered, empty migration and returns its path.
function create(name, { dir = DEFAULT_DIR } = {}) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('Give the migration a name, e.g. npm run migrate:new -- add_tags_to_blueprints');
  fs.mkdirSync(dir, { recursive: true });
  const last = loadFiles(dir).reduce((n, m) => Math.max(n, Number(m.version)), 0);
  const file = path.join(dir, `${String(last + 1).padStart(3, '0')}_${slug}.sql`);
  fs.writeFileSync(file, `-- ${slug.replace(/_/g, ' ')}\n-- Runs once, in a transaction. Never edit it after it has been applied: add a new migration instead.\n\n`, { flag: 'wx' });
  return file;
}

module.exports = { up, status, create, loadFiles, DEFAULT_DIR };
