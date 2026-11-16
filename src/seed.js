// Starter data for onboarding. Every function is idempotent: it only adds what is missing and never overwrites anything.
//   seedAdmin    the first admin account (ADMIN_EMAIL / ADMIN_PASSWORD, or a generated password shown once)
//   seedSamples  the example blueprints in samples/ (matched by title)
//   seedDemo     a demo member and guest with a sample assignment and a pending request, for trying the roles (development only)
//   firstRun     what the server does on its very first start: an admin and one sample blueprint
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./services/auth');
const access = require('./services/access');
const { parseSpec } = require('./services/spec');
const { saveBlueprint } = require('./services/blueprints');
const { normEmail, passwordError } = require('./lib/validate');

const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const generatePassword = () => crypto.randomBytes(9).toString('base64url');

// Creates the admin unless an account with that email already exists. `password` is returned only when it was created here.
async function seedAdmin({ email = config.admin.email, password = config.admin.password, name = 'Administrator' } = {}) {
  email = normEmail(email);
  if (await db.one('SELECT 1 FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [email])) return { email, created: false };
  const generated = !password;
  const pw = password || generatePassword();
  const err = passwordError(pw);
  if (err) throw new Error(`ADMIN_PASSWORD: ${err}`);
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,'admin')`, [email, name, await auth.hashPassword(pw)]);
  return { email, created: true, password: pw, generated };
}

const firstAdminId = async () => ((await db.one(`SELECT id FROM users WHERE role='admin' AND active AND deleted_at IS NULL ORDER BY id LIMIT 1`)) || {}).id || null;

// Adds the samples that are not in the database yet (by title). `only` limits it to some file names.
async function seedSamples({ dir = SAMPLES_DIR, only = null } = {}) {
  const adminId = await firstAdminId();
  const existing = new Set((await db.query('SELECT lower(title) AS t FROM blueprints WHERE deleted_at IS NULL')).map((r) => r.t));
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/i.test(f) && (!only || only.includes(f))).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      const { spec } = parseSpec(text);
      const title = spec.info.title.trim();
      if (existing.has(title.toLowerCase())) { out.push({ file, title, status: 'skipped' }); continue; }
      const saved = await saveBlueprint(null, text, adminId, 'Seeded sample');
      existing.add(title.toLowerCase());
      out.push({ file, title, version: spec.info.version, endpoints: saved.endpointCount, status: 'added' });
    } catch (e) {
      out.push({ file, status: 'failed', error: e.message });
    }
  }
  return out;
}

const DEMO = [
  { email: 'demo.member@specly.local', name: 'Demo Member', role: 'member' },
  { email: 'demo.guest@specly.local', name: 'Demo Guest', role: 'guest' },
];

// A member and a guest to try the roles with: both can read the first blueprint, and the member has a pending request for
// the second one (so the approval flow can be seen). Passwords are generated (DEMO_PASSWORD sets one for both). Not for production.
async function seedDemo({ password = process.env.DEMO_PASSWORD || null, allowProduction = false } = {}) {
  if (config.isProd && !allowProduction) throw new Error('Demo accounts are for development: refusing to create them when NODE_ENV=production.');
  if (password && passwordError(password)) throw new Error(`DEMO_PASSWORD: ${passwordError(password)}`);
  const adminId = await firstAdminId();
  const users = [];
  for (const d of DEMO) {
    let row = await db.one('SELECT id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [d.email]);
    if (row) { users.push({ ...d, id: row.id, created: false }); continue; }
    const pw = password || generatePassword();
    row = await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id`, [d.email, d.name, await auth.hashPassword(pw), d.role]);
    users.push({ ...d, id: row.id, created: true, password: pw });
  }
  const [first, second] = await db.query('SELECT id, title FROM blueprints WHERE deleted_at IS NULL ORDER BY id LIMIT 2');
  const assigned = [];
  if (first) {
    const granted = await access.grant(users.map((u) => u.id), [first.id], adminId);
    if (granted.length) assigned.push(`${first.title}: read access for ${granted.map((g) => g.email).join(', ')}`);
  }
  const member = users.find((u) => u.role === 'member');
  if (second && member && member.created) {
    await db.query(`INSERT INTO access_requests (user_id, blueprint_id, message) VALUES ($1,$2,'Demo request: approve or reject me') ON CONFLICT DO NOTHING`, [member.id, second.id]);
    assigned.push(`${second.title}: pending request from ${member.email}`);
  }
  return { users, assigned };
}

// The very first start: an admin and one sample blueprint, only into an empty database. Returns what was created.
async function firstRun() {
  const out = { admin: null, sample: null };
  if (!(await db.one('SELECT 1 FROM users LIMIT 1'))) out.admin = await seedAdmin();
  if (!(await db.one('SELECT 1 FROM blueprints LIMIT 1'))) {
    const [r] = await seedSamples({ only: ['task-api.yaml'] });
    out.sample = r || null;
  }
  return out;
}

module.exports = { seedAdmin, seedSamples, seedDemo, firstRun, DEMO, SAMPLES_DIR };
