const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool, Client: Pg } = require('pg');
const migrate = require('../../src/migrate');
const seed = require('../../src/seed');
const { db, Client, dropDatabase } = require('../support');

const ROOT = path.join(__dirname, '..', '..');
const urlFor = (name) => process.env.DATABASE_URL.replace(/\/[^/]*$/, `/${name}`);

// A throwaway database (the shared test one must not be touched by migration experiments).
async function scratch(label) {
  const name = `specly_mig_${process.pid}_${label}`;
  const admin = new Pg({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: urlFor(name) });
  return { name, url: urlFor(name), pool, drop: async () => { await pool.end(); await dropDatabase(admin, name); await admin.end(); } };
}
const tmpDir = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specly-mig-'));
  for (const [f, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), sql);
  return dir;
};
const tables = async (pool) => (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map((r) => r.table_name);
const run = (args, env) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent', ADMIN_PASSWORD: 'Admin1234', ...env } });

test('migrations: the baseline builds the whole schema on an empty database, then nothing is applied twice', async () => {
  const s = await scratch('fresh');
  try {
    assert.deepEqual(await migrate.up(s.pool), ['001_baseline.sql']);
    const t = await tables(s.pool);
    for (const name of ['users', 'blueprints', 'endpoints', 'access_requests', 'share_links', 'audit_log', 'schema_migrations']) assert.ok(t.includes(name), name);
    assert.deepEqual(await migrate.up(s.pool), [], 'a second run is a no-op');
    const rows = await migrate.status(s.pool);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].version, rows[0].name, rows[0].applied, rows[0].changed], ['001', 'baseline', true, false]);
    assert.match((await s.pool.query('SELECT checksum FROM schema_migrations')).rows[0].checksum, /^[0-9a-f]{64}$/);
  } finally { await s.drop(); }
});

test('migrations: a database created by the old schema.sql is adopted without changes', async () => {
  const s = await scratch('legacy');
  try {
    await s.pool.query(fs.readFileSync(path.join(migrate.DEFAULT_DIR, '001_baseline.sql'), 'utf8')); // what schema.sql used to do
    await s.pool.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('old@example.com','Old','x','admin')`);
    assert.ok(!(await tables(s.pool)).includes('schema_migrations'));
    assert.deepEqual(await migrate.up(s.pool), ['001_baseline.sql'], 'recorded as applied');
    assert.equal((await s.pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n, 1, 'data untouched');
  } finally { await s.drop(); }
});

test('migrations: applied in order, one transaction each; a failure rolls back and can be retried', async () => {
  const s = await scratch('order');
  const dir = tmpDir({
    '001_first.sql': 'CREATE TABLE a (id int);',
    '002_second.sql': 'CREATE TABLE b (id int); THIS IS NOT SQL;',
    '003_third.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx_a_id ON a (id);',
  });
  try {
    await assert.rejects(() => migrate.up(s.pool, { dir }), /002_second\.sql failed and was rolled back/);
    const t = await tables(s.pool);
    assert.ok(t.includes('a'), 'the first migration stays applied');
    assert.ok(!t.includes('b'), 'the failed one left nothing behind');
    assert.deepEqual((await s.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version), ['001']);
    fs.writeFileSync(path.join(dir, '002_second.sql'), 'CREATE TABLE b (id int);'); // not applied yet, so it may still be fixed
    assert.deepEqual(await migrate.up(s.pool, { dir }), ['002_second.sql', '003_third.sql']);
    assert.ok((await tables(s.pool)).includes('b'));
    assert.equal((await s.pool.query(`SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname='idx_a_id'`)).rows[0].n, 1, 'a no-transaction migration ran');
  } finally { await s.drop(); }
});

test('migrations: editing an applied migration is refused; duplicate numbers are refused; new scaffolds the next file', async () => {
  const s = await scratch('guard');
  const dir = tmpDir({ '001_a.sql': 'CREATE TABLE a (id int);' });
  try {
    await migrate.up(s.pool, { dir });
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int, extra int);');
    await assert.rejects(() => migrate.up(s.pool, { dir }), /001_a\.sql was changed after it was applied/);
    assert.equal((await migrate.status(s.pool, { dir }))[0].changed, true);
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int);');
    assert.deepEqual(await migrate.up(s.pool, { dir }), []);
    // CRLF line endings do not count as a change
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int);'.replace(/\n/g, '\r\n'));
    assert.deepEqual(await migrate.up(s.pool, { dir }), []);
    const made = migrate.create('Add Tags To Blueprints!', { dir });
    assert.equal(path.basename(made), '002_add_tags_to_blueprints.sql');
    assert.match(fs.readFileSync(made, 'utf8'), /Never edit it after it has been applied/);
    assert.throws(() => migrate.create('   ', { dir }), /Give the migration a name/);
    fs.writeFileSync(path.join(dir, '002_other.sql'), 'SELECT 1;');
    assert.throws(() => migrate.loadFiles(dir), /share the number 002/);
  } finally { await s.drop(); }
});

test('migrations: two instances starting at once apply each migration exactly once', async () => {
  const s = await scratch('race');
  const dir = tmpDir({ '001_a.sql': 'CREATE TABLE a (id int);', '002_b.sql': 'CREATE TABLE b (id int);' });
  try {
    const results = await Promise.all([migrate.up(s.pool, { dir }), migrate.up(s.pool, { dir }), migrate.up(s.pool, { dir })]);
    assert.equal(results.flat().length, 2, 'applied once in total, whoever got there first');
    assert.equal((await s.pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n, 2);
  } finally { await s.drop(); }
});

test('onboarding: migrate, seed and start on a brand new database (the real CLIs)', async () => {
  const s = await scratch('cli');
  try {
    const env = { DATABASE_URL: s.url, NODE_ENV: 'development' };
    const status0 = run(['scripts/migrate.js', 'status'], env);
    assert.match(status0.stdout, /· 001\s+baseline\s+pending/);
    assert.match(status0.stdout, /1 pending/);
    const up = run(['scripts/migrate.js'], env);
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /Applied 1 migration\(s\)[\s\S]*001_baseline\.sql/);
    assert.match(run(['scripts/migrate.js'], env).stdout, /Already up to date/);
    assert.match(run(['scripts/migrate.js', 'status'], env).stdout, /Up to date/);

    const seeded = run(['scripts/seed.js', '--demo'], env);
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.match(seeded.stdout, /admin\s+created admin@specly\.local\s+\(password from ADMIN_PASSWORD\)/);
    assert.match(seeded.stdout, /sample\s+added\s+Bookstore API/);
    assert.equal((seeded.stdout.match(/sample\s+added/g) || []).length, 5, 'all five samples');
    assert.match(seeded.stdout, /demo\s+created demo\.member@specly\.local \(member\)\s+password: \S{12}/);
    assert.match(seeded.stdout, /demo\s+created demo\.guest@specly\.local \(guest\)\s+password: \S{12}/);
    assert.match(seeded.stdout, /pending request from demo\.member@specly\.local/);
    const [pm, pg] = [seeded.stdout.match(/demo\.member@specly\.local \(member\)\s+password: (\S+)/)[1], seeded.stdout.match(/demo\.guest@specly\.local \(guest\)\s+password: (\S+)/)[1]];
    assert.notEqual(pm, pg, 'each demo account gets its own password');

    const again = run(['scripts/seed.js', '--demo'], env);
    assert.match(again.stdout, /admin\s+admin@specly\.local already exists/);
    assert.equal((again.stdout.match(/sample\s+skipped/g) || []).length, 5, 'nothing is added twice');
    assert.match(again.stdout, /demo\s+exists\s+demo\.member@specly\.local/);
    assert.ok(!/password: /.test(again.stdout), 'passwords are only ever shown when created');

    const counts = (await s.pool.query(`SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM blueprints) AS bps`)).rows[0];
    assert.deepEqual(counts, { users: 3, bps: 5 });
  } finally { await s.drop(); }
});

test('first start: the server creates the admin and one sample once; AUTO_SEED and AUTO_MIGRATE can be switched off', async () => {
  const boot = `const db = require('./src/db'); db.init().then(() => require('./src/bootstrap').bootstrap()).then(async () => { const r = await db.one('SELECT (SELECT COUNT(*)::int FROM users) AS u, (SELECT COUNT(*)::int FROM blueprints) AS b'); console.log('COUNTS', r.u, r.b); await db.pool.end(); }).catch((e) => { console.log('ERROR', e.message); process.exit(1); });`;
  const s1 = await scratch('first');
  try {
    const first = run(['-e', boot], { DATABASE_URL: s1.url });
    assert.match(first.stdout, /Created admin account: admin@specly\.local \(password from ADMIN_PASSWORD\)/);
    assert.match(first.stdout, /COUNTS 1 1/);
    const second = run(['-e', boot], { DATABASE_URL: s1.url });
    assert.doesNotMatch(second.stdout, /Created admin account/);
    assert.match(second.stdout, /COUNTS 1 1/);
    // generated password when ADMIN_PASSWORD is not set: printed once
    const s2 = await scratch('generated');
    try {
      const gen = run(['-e', boot], { DATABASE_URL: s2.url, ADMIN_PASSWORD: '' });
      assert.match(gen.stdout, /Created admin account: admin@specly\.local \/ \S{12}\s+\(generated: shown once/);
    } finally { await s2.drop(); }
  } finally { await s1.drop(); }
  const s3 = await scratch('noauto');
  try {
    const noSeed = run(['-e', boot], { DATABASE_URL: s3.url, AUTO_SEED: 'false' });
    assert.match(noSeed.stdout, /COUNTS 0 0/, 'AUTO_SEED=false leaves the database empty');
  } finally { await s3.drop(); }
  const s4 = await scratch('manual');
  try {
    const blocked = run(['-e', boot], { DATABASE_URL: s4.url, AUTO_MIGRATE: 'false' });
    assert.match(blocked.stdout, /ERROR 1 pending migration\(s\): 001_baseline\.sql\. Run: npm run migrate/);
    assert.equal(run(['scripts/migrate.js'], { DATABASE_URL: s4.url }).status, 0);
    assert.match(run(['-e', boot], { DATABASE_URL: s4.url, AUTO_MIGRATE: 'false' }).stdout, /COUNTS 1 1/, 'after migrating, it starts');
  } finally { await s4.drop(); }
});

test('seeding: admin from env or generated, weak passwords refused, samples that fail do not stop the rest', async () => {
  const dup = await seed.seedAdmin({ email: 'ADMIN@specly.local', password: 'Whatever123' });
  assert.deepEqual(dup, { email: 'admin@specly.local', created: false }, 'an existing account is never touched');
  const made = await seed.seedAdmin({ email: 'seeded-admin@example.com', password: 'SeededAdmin123' });
  assert.equal(made.created, true); assert.equal(made.generated, false);
  assert.equal((await new Client().login('seeded-admin@example.com', 'SeededAdmin123')).status, 302);
  const gen = await seed.seedAdmin({ email: 'generated-admin@example.com', password: null });
  assert.equal(gen.generated, true); assert.ok(gen.password.length >= 12);
  assert.equal((await new Client().login('generated-admin@example.com', gen.password)).status, 302);
  await assert.rejects(() => seed.seedAdmin({ email: 'weak@example.com', password: 'short' }), /ADMIN_PASSWORD: Password must be at least 8/);
  assert.equal(await db.one(`SELECT 1 FROM users WHERE email='weak@example.com'`), null);

  const dir = tmpDir({
    'good.yaml': 'openapi: 3.0.3\ninfo: { title: Seed Good API, version: "1" }\npaths:\n  /x:\n    get: { responses: { "200": { description: ok } } }\n',
    'bad.yaml': 'this: is not an openapi document',
    'notes.txt': 'ignored',
  });
  const first = await seed.seedSamples({ dir });
  assert.deepEqual(first.map((r) => [r.file, r.status]), [['bad.yaml', 'failed'], ['good.yaml', 'added']]);
  assert.match(first[0].error, /openapi|swagger/i);
  assert.deepEqual((await seed.seedSamples({ dir, only: ['good.yaml'] })).map((r) => r.status), ['skipped']);
});

test('demo accounts: own passwords, they can sign in, roles behave, and they are refused in production', async () => {
  const demo = await seed.seedDemo();
  assert.deepEqual(demo.users.map((u) => [u.email, u.role, u.created]), [['demo.member@specly.local', 'member', true], ['demo.guest@specly.local', 'guest', true]]);
  const [member, guest] = demo.users;
  const { id: first } = await db.one('SELECT id FROM blueprints WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
  const { id: second } = await db.one('SELECT id FROM blueprints WHERE deleted_at IS NULL ORDER BY id OFFSET 1 LIMIT 1');
  const g = new Client();
  assert.equal((await g.login(guest.email, guest.password)).status, 302);
  assert.equal((await g.get(`/blueprints/${first}`)).status, 200, 'the guest can read the first blueprint');
  assert.equal((await g.get(`/blueprints/${second}`)).status, 403, 'and nothing else');
  const m = new Client();
  assert.equal((await m.login(member.email, member.password)).status, 302);
  assert.equal((await m.get(`/blueprints/${first}`)).status, 200);
  assert.equal((await db.one(`SELECT status FROM access_requests r JOIN users u ON u.id=r.user_id WHERE u.email=$1 AND r.blueprint_id=$2`, [member.email, second])).status, 'pending');
  const again = await seed.seedDemo();
  assert.ok(again.users.every((u) => !u.created && !u.password), 'a second run changes nothing');
  await assert.rejects(() => seed.seedDemo({ password: 'weak' }), /DEMO_PASSWORD/);
  const prod = run(['-e', `require('./src/seed').seedDemo().then(() => console.log('CREATED'), (e) => console.log('REFUSED', e.message))`],
    { NODE_ENV: 'production', BASE_URL: 'https://docs.example.com', SMTP_HOST: 'smtp.example.com', DATABASE_URL: process.env.DATABASE_URL });
  assert.match(prod.stdout, /REFUSED Demo accounts are for development/);
});
