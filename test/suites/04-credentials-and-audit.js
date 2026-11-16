const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, Client, lastMailLink, flushMail, admin } = require('../support');

test('password reset: single use, ends other sessions', async () => {
  const other = new Client();
  await other.login('guest@example.com', 'guestpass1');
  assert.equal((await other.get('/')).status, 200);
  const anon = new Client();
  assert.equal((await anon.post('/forgot', { email: 'guest@example.com' })).status, 200);
  assert.equal((await anon.post('/forgot', { email: 'nobody@example.com' })).status, 200, 'same answer for unknown emails');
  await flushMail(); // the token and email are created after the reply
  const link = lastMailLink(/\/reset\/[\w-]+/);
  assert.equal((await anon.post(link, { password: 'brandnew123', confirm: 'brandnew123' })).status, 302);
  assert.equal((await anon.post(link, { password: 'another1234', confirm: 'another1234' })).status, 400, 'reset link is single use');
  assert.equal((await other.get('/')).status, 302, 'old session was signed out');
  assert.equal((await new Client().login('guest@example.com', 'brandnew123')).status, 302);
});

test('any signed-in user can change their own password; others are signed out', async () => {
  const { hashPassword } = require('../../src/services/auth');
  for (const role of ['member', 'guest']) {
    await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4)`, [`${role}-pw@example.com`, role, await hashPassword('oldpass1234'), role]);
  }
  for (const [email, oldPw, newPw] of [['member-pw@example.com', 'oldpass1234', 'memberpass2'], ['guest-pw@example.com', 'oldpass1234', 'guestnew4567']]) {
    const me = new Client(), elsewhere = new Client();
    await me.login(email, oldPw); await elsewhere.login(email, oldPw);
    assert.equal((await me.get('/account/password')).status, 200);
    assert.equal((await me.post('/account/password', { current: 'wrong', password: newPw, confirm: newPw })).status, 400, 'needs the current password');
    assert.equal((await me.post('/account/password', { current: oldPw, password: newPw, confirm: 'mismatch99' })).status, 400);
    assert.equal((await me.post('/account/password', { current: oldPw, password: 'short', confirm: 'short' })).status, 400);
    assert.equal((await me.post('/account/password', { current: oldPw, password: oldPw, confirm: oldPw })).status, 400, 'must differ');
    assert.equal((await me.post('/account/password', { current: oldPw, password: newPw, confirm: newPw })).status, 302);
    assert.equal((await me.get('/')).status, 200, 'this browser stays signed in');
    assert.equal((await elsewhere.get('/')).status, 302, 'other sessions are signed out');
    assert.equal((await new Client().login(email, oldPw)).status, 401, 'old password no longer works');
    assert.equal((await new Client().login(email, newPw)).status, 302);
  }
  assert.equal((await new Client().get('/account/password')).status, 302, 'anonymous users are sent to sign in');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='auth.password_changed'`));
});

test('changing a password: repeated wrong current passwords lock that account for a while, without audit rows', async () => {
  const { hashPassword } = require('../../src/services/auth');
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('lockme@example.com','L',$1,'member')`, [await hashPassword('lockpass1234')]);
  const me = new Client();
  await me.login('lockme@example.com', 'lockpass1234');
  const before = (await db.one('SELECT COUNT(*)::int AS n FROM audit_log')).n;
  for (let i = 0; i < 5; i++) assert.equal((await me.post('/account/password', { current: 'wrong', password: 'newpass12345', confirm: 'newpass12345' })).status, 400);
  const locked = await me.post('/account/password', { current: 'lockpass1234', password: 'newpass12345', confirm: 'newpass12345' });
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM audit_log')).n, before, 'no audit rows for the failures');
});

test('robustness: bad ids 404, admin cannot demote or delete themselves', async () => {
  assert.equal((await admin.get('/blueprints/abc')).status, 404);
  assert.equal((await admin.get('/manage/users/1x/edit')).status, 404);
  assert.equal((await admin.get('/blueprints/99999')).status, 404);
  const demote = await admin.post('/manage/users/1', { name: 'A', role: 'guest', active: 'on' });
  assert.equal(demote.status, 400);
  assert.match(demote.text, /cannot demote/);
  await admin.post('/manage/users/1/delete', {});
  assert.ok(await db.one('SELECT 1 FROM users WHERE id=1'));
});

test('audit log records the events and can be filtered', async () => {
  const page = await admin.get('/manage/audit');
  assert.equal(page.status, 200);
  for (const action of ['auth.login', 'invite.accepted', 'request.approved', 'request.revoked', 'blueprint.restored', 'auth.password_reset']) {
    assert.match(page.text, new RegExp(action.replace('.', '\\.')), action);
  }
  const filtered = await admin.get('/manage/audit?group=request&q=guest');
  assert.match(filtered.text, /request\.approved/);
  assert.doesNotMatch(filtered.text, /auth\.login/);
  const fresh = new Client();
  await fresh.login('guest@example.com', 'brandnew123');
  assert.equal((await fresh.get('/manage/audit')).status, 403);
});
