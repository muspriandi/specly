const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { parseSpec, MAX_NODES } = require('../../src/services/spec');
const { passwordError } = require('../../src/lib/validate');
const secrets = require('../../src/lib/secrets');
const auth = require('../../src/services/auth');
const { db, Client, admin, spec, upload } = require('../support');

const ROOT = path.join(__dirname, '..', '..');
const head = 'openapi: 3.0.3\ninfo: {title: T, version: "1"}\npaths: {}\n';

test('documents that expand enormously, nest too deeply or loop are rejected quickly (alias bombs)', async () => {
  const bomb = (levels) => { let t = head + 'x0: &a0 [x,x,x,x,x,x,x,x,x]\n'; for (let i = 1; i < levels; i++) t += `x${i}: &a${i} [${Array(9).fill('*a' + (i - 1)).join(',')}]\n`; return t; };
  const start = Date.now();
  assert.throws(() => parseSpec(bomb(10)), /expands to more than .* values/);   // 9^10 values from ~600 bytes
  assert.throws(() => parseSpec(head + 'loop: &l [*l]\n'), /circular reference/);
  const json = (d) => `{"openapi":"3.0.3","info":{"title":"T","version":"1"},"paths":{},"deep":${'['.repeat(d)}${']'.repeat(d)}}`;
  assert.throws(() => parseSpec(json(130)), /nested more than/);                  // our guard (JSON has no parser depth limit)
  assert.throws(() => parseSpec(head + 'deep: ' + '['.repeat(130) + ']'.repeat(130) + '\n'), /nesting exceeded|nested more than/); // the YAML parser's own limit
  assert.doesNotThrow(() => parseSpec(json(50)));
  assert.ok(Date.now() - start < 2000, 'rejected fast, without expanding anything');
  assert.doesNotThrow(() => parseSpec(bomb(5)), 'a large but real document (59k values) is fine');
  assert.ok(MAX_NODES >= 1_000_000);
  // and through the real endpoints: the editor's validation and the publish route both refuse it, and nothing is stored
  const before = (await db.one('SELECT COUNT(*)::int AS n FROM blueprints')).n;
  const r = await upload(admin, '/manage/blueprints/preview', bomb(10));
  assert.equal(JSON.parse(r.text).ok, false);
  assert.match(JSON.parse(r.text).error, /alias bomb/);
  assert.equal((await upload(admin, '/manage/blueprints', bomb(10))).status, 400);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM blueprints')).n, before);
});

test('passwords: trivial ones are refused, hashes are upgraded at sign-in, two-factor seeds are encrypted', async () => {
  for (const bad of ['password', 'Password123', '12345678', 'qwertyuiop', 'aaaaaaaaaa', 'short', 'x'.repeat(73)]) {
    assert.ok(passwordError(bad), `${bad} is refused`);
  }
  assert.equal(passwordError('correct horse battery'), null);
  assert.equal(passwordError('Admin1234'), null, 'ordinary strong-enough passwords still pass');
  // a hash stored with a lower cost is replaced by one at the current cost the next time the user signs in
  const weak = await bcrypt.hash('upgrade-me-123', 4);
  const { id } = await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ('rehash@example.com','Re',$1,'guest') RETURNING id`, [weak]);
  assert.equal(await auth.upgradeHash(id, 'upgrade-me-123', weak, 5), true);
  const stored = (await db.one('SELECT password_hash FROM users WHERE id=$1', [id])).password_hash;
  assert.equal(bcrypt.getRounds(stored), 5);
  assert.equal(await bcrypt.compare('upgrade-me-123', stored), true, 'the password still works');
  assert.equal(await auth.upgradeHash(id, 'upgrade-me-123', stored, 5), false, 'already strong enough: untouched');
  // encryption at rest
  const sealed = secrets.seal('JBSWY3DPEHPK3PXP');
  assert.match(sealed, /^enc:v1:/);
  assert.ok(!sealed.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(secrets.open(sealed), 'JBSWY3DPEHPK3PXP');
  assert.notEqual(secrets.seal('JBSWY3DPEHPK3PXP'), sealed, 'every value gets its own nonce');
  assert.equal(secrets.open('PLAINLEGACYSEED'), 'PLAINLEGACYSEED', 'seeds from before encryption stay readable');
  const parts = sealed.split('.');
  assert.throws(() => secrets.open(`${parts[0]}.${parts[1]}.${Buffer.from('tampered').toString('base64url')}`), /Could not decrypt/);
  // a legacy plaintext seed is encrypted the first time it is read
  const uid = (await db.one(`INSERT INTO users (email,name,password_hash,role,totp_secret) VALUES ('legacyseed@example.com','Leg','x','member','LEGACYPLAINSEED234') RETURNING id`)).id;
  assert.equal(auth.totpSecretOf({ id: uid, totp_secret: 'LEGACYPLAINSEED234' }), 'LEGACYPLAINSEED234');
  await new Promise((r) => setTimeout(r, 150));
  assert.match((await db.one('SELECT totp_secret FROM users WHERE id=$1', [uid])).totp_secret, /^enc:v1:/);
});

test('response headers: no caching of dynamic pages, a restrictive permissions policy, nosniff, CSP, no framing', async () => {
  const page = await new Client().get('/login');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('permissions-policy'), /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/, 'no inline or remote scripts');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal((await admin.get('/manage/users')).headers.get('cache-control'), 'no-store');
  const { id } = await db.one(`SELECT id FROM blueprints ORDER BY id LIMIT 1`);
  const json = await admin.get(`/blueprints/${id}/spec.json`);
  assert.match(json.headers.get('content-type'), /application\/json/);
});

test('hostile content in a spec is escaped everywhere it is shown', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const doc = spec().replace('Pets API', `Evil ${evil}`).replace('List pets', `${evil} list`);
  assert.equal((await upload(admin, '/manage/blueprints', doc)).status, 302);
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title LIKE 'Evil%'`);
  for (const url of ['/', `/blueprints/${id}/changelog`, '/manage/blueprints', `/manage/blueprints/${id}/access`, '/search?q=Evil', `/manage/blueprints/${id}/versions`]) {
    const html = (await admin.get(url)).text;
    assert.ok(!html.includes(evil), `${url} does not contain the raw payload`);
  }
  assert.match((await admin.get('/')).text, /Evil &lt;img src=x onerror=alert\(1\)&gt;/);
});

test('search is limited per signed-in user', async () => {
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('searcher@example.com','S',$1,'admin')`, [hash]);
  const me = new Client();
  assert.equal((await me.login('searcher@example.com', 'Admin1234')).status, 302);
  let limited = 0;
  for (let i = 0; i < 245; i++) if ((await me.get('/search/suggest?q=ab')).status === 429) limited++;
  assert.ok(limited >= 4 && limited <= 6, `the 241st request onwards is refused (${limited})`);
  assert.equal((await admin.get('/search/suggest?q=ab')).status, 200, 'another account is not affected');
  await db.query(`DELETE FROM users WHERE email='searcher@example.com'`);
});

test('production refuses weak or missing security settings', () => {
  const start = (env) => spawnSync(process.execPath, ['-e', "require('./src/config'); console.log('STARTED')"], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', BASE_URL: 'https://docs.example.com', DATABASE_URL: 'postgresql://a@b/c', SMTP_HOST: 'smtp.example.com',
      APP_SECRET: 'x'.repeat(40), ADMIN_PASSWORD: '', ...env },
  });
  assert.match(start({}).stdout, /STARTED/, 'a proper production environment starts');
  assert.match(start({ APP_SECRET: '' }).stderr, /APP_SECRET is required/);
  assert.match(start({ APP_SECRET: 'too-short' }).stderr, /APP_SECRET must be at least 32 characters/);
  assert.match(start({ ADMIN_PASSWORD: 'NewPass123' }).stderr, /ADMIN_PASSWORD is too weak/);
  assert.match(start({ ADMIN_PASSWORD: 'short' }).stderr, /ADMIN_PASSWORD is too weak/);
  assert.match(start({ ADMIN_PASSWORD: 'a-long-unique-passphrase' }).stdout, /STARTED/);
  assert.match(start({ SMTP_HOST: '' }).stderr, /SMTP_HOST is required/);
});
