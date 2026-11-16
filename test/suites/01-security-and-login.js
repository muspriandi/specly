const { test } = require('node:test');
const log = require('../../src/lib/log');
const assert = require('node:assert/strict');
const { db, Client, admin, url } = require('../support');

test('anonymous users are redirected to login; security headers are set', async () => {
  const c = new Client();
  const r = await c.get('/');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login');
  const login = await c.get('/login');
  assert.match(login.headers.get('content-security-policy'), /script-src 'self'/);
});

test('POST without a CSRF token is rejected', async () => {
  const c = new Client();
  await c.get('/login');
  const bad = await fetch(url('/login'), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(bad.status, 403);
});

test('login: wrong password -> 401, admin login works', async () => {
  assert.equal((await admin.login('admin@specly.local', 'nope')).status, 401);
  assert.equal((await admin.login('ADMIN@specly.local', 'Admin1234')).status, 302);
  const home = await admin.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Task API/);
});

test('anonymous failures never write to the database: no audit rows for bad logins or reset requests', async () => {
  const count = async () => (await db.one('SELECT COUNT(*)::int AS n FROM audit_log')).n;
  const before = await count();
  const anon = new Client();
  const cap = log.capture();
  for (let i = 0; i < 3; i++) assert.equal((await anon.login(`nobody${i}@example.com`, 'wrong-password')).status, 401);
  assert.equal((await anon.login('admin@specly.local', 'wrong-password')).status, 401);
  // ...but they ARE logged, so brute force can be monitored: reason for the operator, masked email, never the password
  const failed = cap.entries.filter((e) => e.event === 'auth.login_failed');
  cap.stop();
  assert.equal(failed.length, 4);
  assert.ok(failed.every((e) => e.level === 'warn' && e.msg === 'security' && e.ip));
  assert.deepEqual(failed.map((e) => e.reason), ['unknown_account', 'unknown_account', 'unknown_account', 'wrong_password']);
  assert.equal(failed[3].email, 'a***@specly.local');
  assert.ok(!JSON.stringify(failed).includes('wrong-password') && !JSON.stringify(failed).includes('nobody0@example.com'), 'no password or full email in the log');
  assert.equal((await anon.post('/forgot', { email: 'admin@specly.local' })).status, 200);
  assert.equal(await count(), before, 'nothing was added to the audit log');
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action IN ('auth.login_failed','auth.reset_requested','auth.password_change_failed')`)).n, 0);
});

test('no hard-coded or shortcut credentials: admin/admin is rejected', async () => {
  assert.equal((await new Client().login('admin', 'admin')).status, 401);
});
