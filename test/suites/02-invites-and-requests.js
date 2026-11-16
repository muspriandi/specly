const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, lastMailLink, mails, admin, guest } = require('../support');

test('invite -> accept -> guest is locked out until approved', async () => {
  assert.equal((await admin.post('/manage/invites', { emails: 'guest@example.com' })).status, 302, 'sending redirects to the result page');
  const link = lastMailLink(/\/invite\/[\w-]+/);
  assert.ok(link, 'invite email was sent');
  assert.equal((await guest.post(link, { name: 'Gus', password: 'guestpass1', confirm: 'guestpass1' })).status, 302);
  assert.equal((await guest.post(link, { name: 'Gus', password: 'guestpass1', confirm: 'guestpass1' })).status, 400, 'invite link is single use');

  assert.equal((await guest.get('/blueprints/1')).status, 403);
  assert.equal((await guest.get('/blueprints/1/spec.json')).status, 404);
  assert.equal((await guest.get('/manage/users')).status, 403);
  const search = await guest.get('/search?q=tasks');
  assert.doesNotMatch(search.text, /class="method m-/, 'no endpoints from unapproved blueprints');
});

test('bulk invite: many emails at once, skipping invalid, duplicate and existing ones', async () => {
  const before = mails.length;
  const r = await admin.post('/manage/invites', {
    emails: 'a1@example.com, A2@example.com;\nJane <a3@example.com>\na1@example.com\nnot-an-email\nguest@example.com',
  });
  assert.equal(r.status, 302);
  assert.equal(mails.length - before, 3, 'one email per valid new address, duplicates collapsed');
  const shown = await admin.get(r.location); // the result is shown once, after the redirect
  assert.match(shown.text, /3 invitation\(s\) sent/);
  assert.match(shown.text, /not-an-email — not a valid email/);
  assert.match(shown.text, /guest@example\.com — already has an account/);
  const refreshed = await admin.get(r.location); // a refresh: nothing is shown again and nothing is re-sent
  assert.doesNotMatch(refreshed.text, /invitation\(s\) sent/);
  assert.equal(mails.length - before, 3, 'refreshing sent no more email');
  assert.equal((await admin.post('/manage/invites', { emails: '  ' })).status, 400);
  const many = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(',');
  assert.equal((await admin.post('/manage/invites', { emails: many })).status, 400, 'batch size is capped');
});

test('guests cannot request access; members can, and read only what is assigned', async () => {
  assert.equal((await guest.post('/blueprints/1/request', { message: 'please' })).status, 403, 'guests cannot request');
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM access_requests`)).n, 0);
  assert.doesNotMatch((await guest.get('/')).text, /Request access/);
  await db.query(`UPDATE users SET role='member' WHERE email='guest@example.com'`); // the rest of the suite uses this account as a member
  assert.equal((await guest.get('/blueprints/1')).status, 403, 'a member does not see unassigned blueprints');
  assert.match((await guest.get('/')).text, /Request access/);
  assert.equal((await guest.post('/blueprints/1/request', { message: 'please' })).status, 302);
  assert.match((await admin.get('/manage/requests')).text, /please/);
  assert.equal((await admin.post('/manage/requests/1/approve', {})).status, 302);
  assert.equal((await guest.get('/blueprints/1')).status, 200);
  assert.equal((await guest.get('/blueprints/1/spec.json')).status, 200);
  assert.match((await guest.get('/search?q=tasks')).text, /class="method m-/);
  await admin.post('/manage/requests/1/revoke', {});
  assert.equal((await guest.get('/blueprints/1')).status, 403);
});
