// Usage: npm run seed:users
// Adds a member and a guest account for testing role behaviour (the admin comes from .env on first run).
// The guest also gets one approved and one pending access request so both states can be seen.
// Existing accounts are left untouched, so it is safe to run repeatedly. Refuses to run in production.
const config = require('../src/config');
const db = require('../src/db');
const auth = require('../src/services/auth');

if (config.isProd) { console.error('Refusing to create test accounts when NODE_ENV=production.'); process.exit(1); }

const PASSWORD = 'Specly1234';
const USERS = [
  { email: 'member@specly.local', name: 'Test Member', role: 'member' },
  { email: 'guest@specly.local', name: 'Test Guest', role: 'guest' },
];

(async () => {
  await db.init();
  const hash = await auth.hashPassword(PASSWORD);
  const ids = {};
  for (const u of USERS) {
    const row = await db.one('SELECT id, role FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [u.email]);
    if (row) { ids[u.role] = row.id; console.log(`skip   ${u.email} (already exists as ${row.role})`); continue; }
    ids[u.role] = (await db.one('INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id', [u.email, u.name, hash, u.role])).id;
    console.log(`added  ${u.email}  ${u.role}  password: ${PASSWORD}`);
  }
  const admin = await db.one(`SELECT id FROM users WHERE role='admin' AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  const bps = await db.query('SELECT id, title FROM blueprints WHERE deleted_at IS NULL ORDER BY id LIMIT 2');
  const states = [['approved', 'Seeded access'], ['pending', 'Seeded pending request']];
  for (const [i, bp] of bps.entries()) {
    const [status, message] = states[i];
    if (await db.one('SELECT 1 FROM access_requests WHERE user_id=$1 AND blueprint_id=$2', [ids.guest, bp.id])) continue;
    await db.query(`INSERT INTO access_requests (user_id,blueprint_id,message,status,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,${status === 'approved' ? 'now()' : 'NULL'})`,
      [ids.guest, bp.id, message, status, status === 'approved' && admin ? admin.id : null]);
    console.log(`guest  ${status} access on "${bp.title}"`);
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
