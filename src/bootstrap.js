const config = require('./config');
const db = require('./db');
const log = require('./lib/log');
const seed = require('./seed');
const { parseSpec, listEndpoints } = require('./services/spec');

// Runs on every start: on the very first one (empty database) it creates the admin and a sample blueprint
// (see src/seed.js; AUTO_SEED=false turns that off, `npm run seed` does it on demand), then fills in data for older databases.
async function bootstrap() {
  if (config.autoSeed) {
    const first = await seed.firstRun();
    if (first.admin && first.admin.created) {
      // The one place a credential is printed: on the very first start, and only when no ADMIN_PASSWORD was set.
      console.log(`\nCreated admin account: ${first.admin.email}${first.admin.generated ? ` / ${first.admin.password}  (generated: shown once, change it after signing in)` : ' (password from ADMIN_PASSWORD)'}\n`);
      log.info('first start: created the admin account', { event: 'seed.admin_created', email: log.maskEmail(first.admin.email) });
    }
  }
  await backfillDeprecated();
  await backfillStatus();
}

// Older databases have endpoints indexed before the `deprecated` column existed (NULL): fill them from each blueprint's
// latest revision, then make the column NOT NULL. Once that is done (every new or migrated database) this is one cheap check.
async function backfillDeprecated() {
  const col = await db.one(`SELECT attnotnull FROM pg_attribute WHERE attrelid='endpoints'::regclass AND attname='deprecated'`);
  if (!col || col.attnotnull) return;
  const stale = await db.query('SELECT DISTINCT blueprint_id FROM endpoints WHERE deprecated IS NULL');
  for (const { blueprint_id: id } of stale) {
    const cur = await db.one('SELECT source FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no DESC LIMIT 1', [id]);
    let flags = [];
    try { flags = cur ? listEndpoints(parseSpec(cur.source).spec) : []; } catch { /* unparseable legacy content stays unflagged */ }
    for (const e of flags) await db.query('UPDATE endpoints SET deprecated=$4 WHERE blueprint_id=$1 AND method=$2 AND path=$3', [id, e.method, e.path, e.deprecated]);
    await db.query('UPDATE endpoints SET deprecated=false WHERE blueprint_id=$1 AND deprecated IS NULL', [id]);
  }
  await db.query('ALTER TABLE endpoints ALTER COLUMN deprecated SET DEFAULT false, ALTER COLUMN deprecated SET NOT NULL');
}

// Same idea for the x-status flag: rows indexed before the column existed have NULL; fill them from each blueprint's latest revision.
async function backfillStatus() {
  const stale = await db.query('SELECT DISTINCT blueprint_id FROM endpoints WHERE status IS NULL');
  for (const { blueprint_id: id } of stale) {
    const cur = await db.one('SELECT source FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no DESC LIMIT 1', [id]);
    let flags = [];
    try { flags = cur ? listEndpoints(parseSpec(cur.source).spec) : []; } catch { /* unparseable legacy content stays unflagged */ }
    for (const e of flags) if (e.status) await db.query('UPDATE endpoints SET status=$4 WHERE blueprint_id=$1 AND method=$2 AND path=$3', [id, e.method, e.path, e.status]);
    await db.query(`UPDATE endpoints SET status='' WHERE blueprint_id=$1 AND status IS NULL`, [id]);
  }
}

module.exports = { bootstrap, backfillDeprecated, backfillStatus };
