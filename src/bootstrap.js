const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./services/auth');
const { saveBlueprint } = require('./services/blueprints');
const { parseSpec, listEndpoints } = require('./services/spec');

const SAMPLE = path.join(__dirname, '..', 'samples', 'task-api.yaml');

// First run only: create an admin account and a sample blueprint.
async function bootstrap() {
  if (!(await db.one('SELECT 1 FROM users LIMIT 1'))) {
    const { email, password: configured } = config.admin;
    const password = configured || crypto.randomBytes(9).toString('base64url');
    await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,'Administrator',$2,'admin')`,
      [email, await auth.hashPassword(password)]);
    console.log(`\nCreated admin account: ${email}${configured ? ' (password from ADMIN_PASSWORD)' : ` / ${password}  (shown once; or run: npm run reset-admin)`}\n`);
  }
  if (!(await db.one('SELECT 1 FROM blueprints LIMIT 1')) && fs.existsSync(SAMPLE)) {
    await saveBlueprint(null, fs.readFileSync(SAMPLE, 'utf8'), null);
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
