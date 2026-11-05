// End-to-end tests against a throwaway PostgreSQL database (created and dropped automatically).
// Requires a reachable server at DATABASE_URL's host (default postgres:postgres@localhost:5432).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/specly';
const dbName = `specly_test_${process.pid}`;
process.env.DATABASE_URL = base.replace(/\/[^/]*$/, `/${dbName}`);
process.env.ADMIN_PASSWORD = 'Admin1234';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { createApp } = require('../src/app');
const { bootstrap } = require('../src/bootstrap');

let server, origin;
const mails = [];
const realLog = console.log;

// Minimal browser: keeps cookies, never follows redirects, adds the CSRF token to form posts.
class Client {
  jar = new Map();
  async req(method, url, { form, multipart, headers } = {}) {
    const h = { ...headers };
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let body, target = url;
    if (form) {
      // form may be a plain object or a URLSearchParams (for repeated fields such as several checkboxes)
      const f = form instanceof URLSearchParams ? form : new URLSearchParams(form);
      f.set('_csrf', this.jar.get('csrf') || '');
      body = f; h['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (multipart) { body = multipart; target += `${url.includes('?') ? '&' : '?'}_csrf=${this.jar.get('csrf') || ''}`; }
    const res = await fetch(origin + target, { method, body, headers: h, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const [k, ...v] = kv.split('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(attrs.join(';'))) this.jar.delete(k); else this.jar.set(k, v.join('='));
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }
  async get(url) { return this.req('GET', url); }
  async post(url, form) { if (!this.jar.has('csrf')) await this.get('/login'); return this.req('POST', url, { form }); }
  async login(email, password) { return this.post('/login', { email, password }); }
}

const spec = (extra = '') => `openapi: 3.0.3
info: { title: Pets API, version: '1.0' }
paths:
  /pets:
    get: { summary: List pets, operationId: listPets, responses: { '200': { description: ok } } }${extra}
`;
const upload = (client, url, content, note) => {
  const fd = new FormData();
  fd.set('file', new Blob([content]), 'spec.yaml');
  if (note) fd.set('note', note);
  return client.req('POST', url, { multipart: fd });
};
const lastMailLink = (re) => { const m = [...mails].reverse().join('\n').match(re); return m && m[0]; };

before(async () => {
  console.log = (...a) => { const s = a.join(' '); if (s.includes('email (SMTP')) mails.push(s); else realLog(...a); };
  await db.init();
  await bootstrap();
  server = createApp().listen(0);
  origin = `http://localhost:${server.address().port}`;
});

after(async () => {
  console.log = realLog;
  await new Promise((r) => server.close(r));
  await db.pool.end();
  const { Client: Pg } = require('pg');
  const url = new URL(process.env.DATABASE_URL); url.pathname = '/postgres';
  const admin = new Pg({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
});

const admin = new Client(), guest = new Client();

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
  const bad = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(bad.status, 403);
});

test('login: wrong password -> 401, admin login works', async () => {
  assert.equal((await admin.login('admin@specly.local', 'nope')).status, 401);
  assert.equal((await admin.login('ADMIN@specly.local', 'Admin1234')).status, 302);
  const home = await admin.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Task API/);
});

test('no hard-coded or shortcut credentials: admin/admin is rejected', async () => {
  assert.equal((await new Client().login('admin', 'admin')).status, 401);
});

test('invite -> accept -> guest is locked out until approved', async () => {
  assert.equal((await admin.post('/manage/invites', { emails: 'guest@example.com' })).status, 200);
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
  assert.equal(r.status, 200);
  assert.equal(mails.length - before, 3, 'one email per valid new address, duplicates collapsed');
  assert.match(r.text, /3 invitation\(s\) sent/);
  assert.match(r.text, /not-an-email — not a valid email/);
  assert.match(r.text, /guest@example\.com — already has an account/);
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

test('blueprints accept YAML and JSON, reject garbage', async () => {
  assert.equal((await upload(admin, '/manage/blueprints', spec())).status, 302);
  const json = fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'));
  assert.equal((await upload(admin, '/manage/blueprints', json)).status, 302);
  const bad = await upload(admin, '/manage/blueprints', 'hello: world');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /openapi/);
});

test('versions: changes add a version, identical content does not, restore keeps history', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  const url = `/manage/blueprints/${id}`;
  const count = async () => (await db.one('SELECT COUNT(*)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [id])).n;
  assert.equal(await count(), 1);
  await upload(admin, url, spec('\n    post: { summary: Add pet, responses: { "201": { description: ok } } }'), 'add POST');
  assert.equal(await count(), 2);
  await upload(admin, url, spec('\n    post: { summary: Add pet, responses: { "201": { description: ok } } }'));
  assert.equal(await count(), 2, 'identical upload is not a new version');
  const same = spec('\n    post: { summary: Add pet, responses: { "201": { description: ok } } }');
  await upload(admin, url, same.replace(/\n/g, '\r\n') + '\r\n\r\n');
  assert.equal(await count(), 2, 'CRLF line endings and trailing blank lines are not a change');
  const history = await admin.get(`${url}/versions`);
  assert.match(history.text, /add POST/);
  const v1 = await db.one('SELECT id FROM blueprint_versions WHERE blueprint_id=$1 AND version_no=1', [id]);
  assert.equal((await admin.post(`${url}/versions/${v1.id}/restore`, {})).status, 302);
  assert.equal(await count(), 3);
  assert.match((await admin.get(`${url}/versions`)).text, /Restored from revision 1/);
});

test('audit entries describe what changed (e.g. version bump with endpoint diff)', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  const bumped = spec('\n    post: { summary: Add pet, responses: { "201": { description: ok } } }').replace("version: '1.0'", "version: '3.0.0'");
  await upload(admin, `/manage/blueprints/${id}`, bumped, 'major release');
  const row = await db.one(`SELECT detail FROM audit_log WHERE action='blueprint.updated' ORDER BY id DESC LIMIT 1`);
  assert.match(row.detail, /Updated "Pets API" from v1\.0 to v3\.0\.0/);
  assert.match(row.detail, /endpoints: 1 added/);
  assert.match(row.detail, /note: "major release"/);
  const again = await upload(admin, `/manage/blueprints/${id}`, bumped);
  assert.equal(again.status, 302);
  const same = await db.one(`SELECT detail FROM audit_log WHERE action='blueprint.updated' ORDER BY id DESC LIMIT 1`);
  assert.equal(same.detail, row.detail, 'a no-change save is not audited');
});

test('password reset: single use, ends other sessions', async () => {
  const other = new Client();
  await other.login('guest@example.com', 'guestpass1');
  assert.equal((await other.get('/')).status, 200);
  const anon = new Client();
  assert.equal((await anon.post('/forgot', { email: 'guest@example.com' })).status, 200);
  assert.equal((await anon.post('/forgot', { email: 'nobody@example.com' })).status, 200, 'same answer for unknown emails');
  const link = lastMailLink(/\/reset\/[\w-]+/);
  assert.equal((await anon.post(link, { password: 'brandnew123', confirm: 'brandnew123' })).status, 302);
  assert.equal((await anon.post(link, { password: 'another1234', confirm: 'another1234' })).status, 400, 'reset link is single use');
  assert.equal((await other.get('/')).status, 302, 'old session was signed out');
  assert.equal((await new Client().login('guest@example.com', 'brandnew123')).status, 302);
});

test('any signed-in user can change their own password; others are signed out', async () => {
  const { hashPassword } = require('../src/services/auth');
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
  for (const action of ['auth.login', 'auth.login_failed', 'invite.sent', 'invite.accepted', 'request.approved', 'request.revoked', 'blueprint.restored', 'auth.password_reset']) {
    assert.match(page.text, new RegExp(action.replace('.', '\\.')), action);
  }
  const filtered = await admin.get('/manage/audit?group=request&q=guest');
  assert.match(filtered.text, /request\.approved/);
  assert.doesNotMatch(filtered.text, /auth\.login/);
  const fresh = new Client();
  await fresh.login('guest@example.com', 'brandnew123');
  assert.equal((await fresh.get('/manage/audit')).status, 403);
});

test('type-ahead suggestions only include what the user may read', async () => {
  const mine = JSON.parse((await admin.get('/search/suggest?q=task')).text);
  assert.ok(mine.endpoints.length > 0 && mine.endpoints[0].href.startsWith('/blueprints/'));
  const fresh = new Client();
  await fresh.login('guest@example.com', 'brandnew123');
  const theirs = JSON.parse((await fresh.get('/search/suggest?q=task')).text);
  assert.deepEqual(theirs.endpoints, [], 'guest without approval sees nothing');
  assert.deepEqual(JSON.parse((await admin.get('/search/suggest?q=t')).text), { blueprints: [], endpoints: [] }, 'needs 2+ characters');
});

test('search is global on home but limited to one blueprint when scoped with ?bp=', async () => {
  const all = await admin.get('/search?q=a');
  assert.match(all.text, /Blueprints<\/h2>/, 'global search lists blueprints');
  const sug = JSON.parse((await admin.get('/search/suggest?q=task')).text);
  const bpId = sug.endpoints[0].href.match(/blueprints\/(\d+)/)[1];
  const scoped = JSON.parse((await admin.get(`/search/suggest?q=task&bp=${bpId}`)).text);
  assert.deepEqual(scoped.blueprints, []);
  assert.ok(scoped.endpoints.every((e) => e.href.startsWith(`/blueprints/${bpId}#`)));
  const page = await admin.get(`/search?q=a&bp=${bpId}`);
  assert.doesNotMatch(page.text, /Blueprints<\/h2>/, 'no blueprint list when scoped');
  assert.equal((await admin.get('/search?q=a&bp=99999')).status, 404);
  assert.match((await admin.get(`/blueprints/${bpId}`)).text, new RegExp(`name="bp" value="${bpId}"`), 'viewer search sends its blueprint id');
  assert.doesNotMatch((await admin.get('/')).text, /name="bp"/, 'home search stays global');
});

test('blueprint preview validates and diffs without saving', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  const before = (await db.one('SELECT COUNT(*)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [id])).n;
  const ok = JSON.parse((await upload(admin, `/manage/blueprints/preview?for=${id}`, spec('\n  /owners:\n    get: { summary: Owners, responses: { "200": { description: ok } } }'))).text);
  assert.equal(ok.ok, true);
  assert.equal(ok.title, 'Pets API');
  assert.ok(ok.diff.added.some((k) => k.includes('/owners')));
  const bad = JSON.parse((await upload(admin, '/manage/blueprints/preview', 'hello: world')).text);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /openapi/);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [id])).n, before, 'nothing saved');
  const fresh = new Client();
  await fresh.login('guest@example.com', 'brandnew123');
  assert.equal((await upload(fresh, '/manage/blueprints/preview', spec())).status, 403);
});

test('draft preview renders the unsaved document, and errors safely', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  const before = (await db.one('SELECT COUNT(*)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [id])).n;
  const ok = await upload(admin, '/manage/blueprints/preview/render', spec('\n  /zebras:\n    get: { summary: Zebras </script>, responses: { "200": { description: ok } } }'));
  assert.equal(ok.status, 200);
  assert.match(ok.text, /id="doc-spec"/);
  assert.match(ok.text, /\/zebras/);
  assert.doesNotMatch(ok.text, /Zebras <\/script>/, 'spec JSON cannot close the script tag');
  const bad = await upload(admin, '/manage/blueprints/preview/render', 'hello: world');
  assert.match(bad.text, /can't be previewed|can&#39;t be previewed/);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [id])).n, before, 'nothing saved');
  const fresh = new Client();
  await fresh.login('guest@example.com', 'brandnew123');
  assert.equal((await upload(fresh, '/manage/blueprints/preview/render', spec())).status, 403);
  assert.match((await admin.get(`/manage/blueprints/${id}/edit`)).text, /data-views/);
});

test('user access page: assign blueprints, a guest sees only those; un-assign removes them', async () => {
  const { id: bp } = await db.one(`SELECT id FROM blueprints ORDER BY id LIMIT 1`);
  const { id: other } = await db.one(`SELECT id FROM blueprints WHERE id<>$1 ORDER BY id LIMIT 1`, [bp]);
  const gid = (await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ('assigned-guest@example.com','AG',(SELECT password_hash FROM users WHERE id=1),'guest') RETURNING id`)).id;
  const ag = new Client();
  await ag.login('assigned-guest@example.com', 'Admin1234');
  assert.doesNotMatch((await ag.get('/')).text, /Access required/);
  assert.equal((await ag.get(`/blueprints/${bp}`)).status, 403);
  assert.doesNotMatch((await admin.get(`/manage/users/${gid}/edit`)).text, /name="bp"/, 'the edit form no longer carries the checklist');
  assert.match((await admin.get('/manage/users')).text, new RegExp(`/manage/users/${gid}/access`));
  const page = (await admin.get(`/manage/users/${gid}/access`)).text;
  assert.ok(page.includes(`name="bp" value="${bp}"`), 'unassigned blueprints are offered');
  assert.equal((await admin.post(`/manage/users/${gid}/access`, { bp: String(bp) })).status, 302);
  assert.equal((await ag.get(`/blueprints/${bp}`)).status, 200, 'assigned blueprint opens');
  assert.equal((await ag.get(`/blueprints/${other}`)).status, 403, 'unassigned stays locked');
  const home = (await ag.get('/')).text;
  assert.ok(home.includes(`/blueprints/${bp}`) && !home.includes(`/blueprints/${other}"`), 'home lists only assigned blueprints');
  assert.match((await admin.get(`/manage/users/${gid}/access`)).text, /data-bulk-row/, 'listed as assigned');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='user.access_changed'`));
  assert.equal((await admin.post(`/manage/users/${gid}/access/revoke`, { bp: String(bp) })).status, 302);
  assert.equal((await ag.get(`/blueprints/${bp}`)).status, 403, 'un-assigned blueprint is locked again');
  assert.match((await admin.get('/manage/users/1/access')).text, /Admins can read every blueprint/);
  assert.equal((await admin.get('/manage/users/99999/access')).status, 404);
});

test('blueprint access page: see readers, assign and un-assign users', async () => {
  const { id: bp } = await db.one(`SELECT id FROM blueprints ORDER BY id LIMIT 1`);
  const gid = (await db.one(`SELECT id FROM users WHERE email='assigned-guest@example.com'`)).id;
  await db.query(`UPDATE access_requests SET status='rejected' WHERE user_id=$1`, [gid]);
  const page = (await admin.get(`/manage/blueprints/${bp}/access`)).text;
  assert.equal(page.includes('value="' + gid + '"'), true, 'unassigned guest is offered for assignment');
  assert.ok(!/name="users" value="1"/.test(page), 'admins are never offered');
  assert.equal((await admin.post(`/manage/blueprints/${bp}/access`, { users: String(gid) })).status, 302);
  assert.equal((await admin.post(`/manage/blueprints/${bp}/access`, { users: '1' })).status, 302);
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM access_requests WHERE user_id=1`)).n, 0, 'admin never assigned');
  let readers = (await admin.get(`/manage/blueprints/${bp}/access`)).text;
  assert.match(readers, /assigned-guest@example\.com/);
  assert.match((await admin.get('/manage/blueprints')).text, new RegExp(`/manage/blueprints/${bp}/access`));
  const ag = new Client();
  await ag.login('assigned-guest@example.com', 'Admin1234');
  assert.equal((await ag.get(`/blueprints/${bp}`)).status, 200, 'assigned user can read');
  assert.equal((await admin.post(`/manage/blueprints/${bp}/access/${gid}/revoke`, {})).status, 302);
  assert.equal((await ag.get(`/blueprints/${bp}`)).status, 403, 'un-assigned user is locked out');
  readers = (await admin.get(`/manage/blueprints/${bp}/access`)).text;
  assert.ok(!/<td class="td"><div class="clip font-medium"[^>]*>AG</.test(readers), 'no longer listed as a reader');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='blueprint.access_changed' AND detail LIKE 'Removed %'`));
  assert.equal((await admin.post(`/manage/blueprints/${bp}/access`, {})).status, 302, 'empty selection is harmless');
  assert.equal((await ag.get(`/manage/blueprints/${bp}/access`)).status, 403, 'non-admins cannot open it');
  assert.equal((await admin.get('/manage/blueprints/99999/access')).status, 404);
  assert.equal((await admin.get('/manage/blueprints/1x/access')).status, 404);
});

test('blueprint access page: filter by role and un-assign several at once', async () => {
  const { id: bp } = await db.one(`SELECT id FROM blueprints ORDER BY id LIMIT 1`);
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  const made = [];
  for (const [n, role] of [['bulk-g1', 'guest'], ['bulk-g2', 'guest'], ['bulk-m1', 'member']]) {
    const id = (await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id`, [`${n}@example.com`, n, hash, role])).id;
    await admin.post(`/manage/blueprints/${bp}/access`, { users: String(id) });
    made.push({ n, role, id });
  }
  const shown = (html) => new Set([...html.matchAll(/title="(bulk-[a-z0-9]+@example\.com)"/g)].map((m) => m[1]));
  assert.equal(shown((await admin.get(`/manage/blueprints/${bp}/access`)).text).size, 3);
  assert.deepEqual([...shown((await admin.get(`/manage/blueprints/${bp}/access?role=guest`)).text)].sort(), ['bulk-g1@example.com', 'bulk-g2@example.com']);
  assert.deepEqual([...shown((await admin.get(`/manage/blueprints/${bp}/access?role=member`)).text)], ['bulk-m1@example.com']);
  assert.equal(shown((await admin.get(`/manage/blueprints/${bp}/access?role=bogus`)).text).size, 3, 'unknown role is ignored');
  // un-assign the two guests in one go, as repeated checkbox fields
  const pick = new URLSearchParams();
  made.filter((m) => m.role === 'guest').forEach((m) => pick.append('users', m.id));
  assert.equal((await admin.post(`/manage/blueprints/${bp}/access/revoke`, pick)).status, 302);
  assert.deepEqual([...shown((await admin.get(`/manage/blueprints/${bp}/access`)).text)], ['bulk-m1@example.com'], 'only the member is left');
  assert.equal((await admin.post(`/manage/blueprints/${bp}/access/revoke`, {})).status, 302, 'empty selection is harmless');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='blueprint.access_changed' AND detail LIKE 'Removed %bulk-g1@example.com%bulk-g2@example.com%'`));
});

test('bulk approve/reject decides several pending requests at once', async () => {
  const g = new Client();
  await g.login('guest@example.com', 'brandnew123');
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  await g.post(`/blueprints/${id}/request`, { message: 'bulk' });
  const pending = await db.query(`SELECT id FROM access_requests WHERE status='pending'`);
  assert.ok(pending.length >= 1);
  assert.match((await admin.get('/manage/requests')).text, /Pending/);
  const r = await admin.post('/manage/requests/bulk', { action: 'approve', ids: String(pending[0].id) });
  assert.equal(r.status, 302);
  assert.equal((await db.one(`SELECT status FROM access_requests WHERE id=$1`, [pending[0].id])).status, 'approved');
  const none = await admin.post('/manage/requests/bulk', { action: 'approve' });
  assert.equal(none.status, 302);
  assert.equal((await g.post('/manage/requests/bulk', { action: 'approve', ids: '1' })).status, 403, 'admins only');
});

test('soft delete: hidden everywhere, related data updated, restorable from the trash', async () => {
  const trashSpec = spec().replace('Pets API', 'Trash API').replace('/pets', '/trashcans');
  await upload(admin, '/manage/blueprints', trashSpec);
  const bp = await db.one(`SELECT id FROM blueprints WHERE title='Trash API'`);
  await admin.post('/manage/users', { name: 'Tracy', email: 'tracy@example.com', role: 'member', password: 'tracypass12' });
  const tracy = new Client();
  assert.equal((await tracy.login('tracy@example.com', 'tracypass12')).status, 302);
  await tracy.post(`/blueprints/${bp.id}/request`, { message: 'trash me' });
  const reqRow = () => db.one(`SELECT status FROM access_requests r JOIN users u ON u.id=r.user_id WHERE u.email='tracy@example.com' AND r.blueprint_id=$1`, [bp.id]);
  assert.equal((await reqRow()).status, 'pending');

  // -- blueprint --
  await admin.post(`/manage/blueprints/${bp.id}/delete`, {});
  assert.ok((await db.one('SELECT deleted_at FROM blueprints WHERE id=$1', [bp.id])).deleted_at, 'row is kept');
  assert.equal((await reqRow()).status, 'cancelled', 'pending request is cancelled');
  assert.equal((await admin.get(`/blueprints/${bp.id}`)).status, 404);
  assert.equal((await admin.get(`/manage/blueprints/${bp.id}/edit`)).status, 404);
  assert.doesNotMatch((await admin.get('/')).text, /Trash API/);
  assert.doesNotMatch((await admin.get('/manage/blueprints')).text, /Trash API/);
  assert.match((await admin.get('/search?q=trashcans')).text, /No results/);
  assert.doesNotMatch((await admin.get('/manage/requests')).text, /trash me/);
  assert.match((await admin.get('/manage/trash')).text, /Trash API/);
  assert.match((await db.one(`SELECT detail FROM audit_log WHERE action='blueprint.deleted' ORDER BY id DESC LIMIT 1`)).detail, /Moved "Trash API".*trash.*1 pending request cancelled/);
  await admin.post(`/manage/trash/blueprints/${bp.id}/restore`, {});
  assert.equal((await admin.get(`/blueprints/${bp.id}`)).status, 200);
  assert.match((await admin.get('/search?q=trashcans')).text, /class="method m-/, 'endpoints are searchable again');

  // -- user --
  const tid = (await db.one(`SELECT id FROM users WHERE email='tracy@example.com'`)).id;
  assert.equal((await tracy.get('/')).status, 200);
  await admin.post(`/manage/users/${tid}/delete`, {});
  assert.equal((await tracy.get('/')).status, 302, 'their session ended');
  assert.equal((await new Client().login('tracy@example.com', 'tracypass12')).status, 401, 'cannot sign in');
  assert.doesNotMatch((await admin.get('/manage/users')).text, /tracy@example/);
  assert.match((await admin.get('/manage/trash')).text, /tracy@example/);
  // the email can be used again while the old account sits in the trash ...
  assert.equal((await admin.post('/manage/users', { name: 'Tracy 2', email: 'tracy@example.com', role: 'guest', password: 'tracypass34' })).status, 302);
  // ... which then blocks restoring the old one
  await admin.post(`/manage/trash/users/${tid}/restore`, {});
  assert.ok((await db.one('SELECT deleted_at FROM users WHERE id=$1', [tid])).deleted_at, 'restore refused on email clash');
  await admin.post(`/manage/trash/users/${tid}/purge`, {});
  assert.equal(await db.one('SELECT 1 FROM users WHERE id=$1', [tid]), null, 'purge removes it for good');
  // live items cannot be purged through the trash
  assert.equal(await db.one('SELECT 1 FROM users WHERE email=$1 AND deleted_at IS NULL', ['tracy@example.com']) !== null, true);
});

test('preview reports the line of a syntax error', async () => {
  const json = JSON.parse((await upload(admin, '/manage/blueprints/preview', '\n{"a": 1,\n"b": }')).text);
  assert.equal(json.ok, false);
  assert.equal(json.line, 3);
  const yml = JSON.parse((await upload(admin, '/manage/blueprints/preview', 'openapi: 3.0.0\ninfo:\n  title: x\n   bad: [\n')).text);
  assert.equal(yml.ok, false);
  assert.equal(yml.line, 4);
});

test('audit log sorts by column and ignores unknown sort keys', async () => {
  const asc = await admin.get('/manage/audit?sort=action&dir=asc');
  assert.equal(asc.status, 200);
  assert.match(asc.text, /aria-sort="ascending"/);
  assert.equal((await admin.get('/manage/audit?sort=id;DROP&dir=sideways')).status, 200);
});

test('flash messages carry a type that becomes the toast tone', async () => {
  const r = await admin.post('/manage/requests/bulk', { action: 'approve' });
  assert.equal(r.status, 302);
  const page = await admin.get('/manage/requests');
  assert.match(page.text, /data-flash-type="error"/);
});

test('audit log: cursor pagination walks every event once, forwards and backwards, for any sort', async () => {
  const ids = (await db.query('SELECT id FROM audit_log ORDER BY id DESC')).map((r) => Number(r.id));
  assert.ok(ids.length > 12, 'enough events to span several pages');
  const hrefOf = (html, rel) => { const m = html.match(new RegExp(`rel="${rel}" href="([^"]+)"`)); return m && '/manage/audit' + m[1].replace(/&amp;/g, '&'); };
  const idsOn = (html) => [...html.matchAll(/data-audit-id="(\d+)"/g)].map((m) => Number(m[1]));
  const walk = async (start) => {
    const seen = [];
    let url = start;
    for (let i = 0; i < 100 && url; i++) { const html = (await admin.get(url)).text; seen.push(...idsOn(html)); url = hrefOf(html, 'next'); }
    return seen;
  };
  // default limit is 50; the page never exceeds it
  assert.ok(idsOn((await admin.get('/manage/audit')).text).length <= 50);
  // forwards through the default order (newest first) with a small limit
  assert.deepEqual(await walk('/manage/audit?limit=5'), ids);
  // sorted by a text column: still each event exactly once
  const byWho = await walk('/manage/audit?sort=who&dir=asc&limit=5');
  assert.deepEqual([...byWho].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
  assert.equal(new Set(byWho).size, ids.length);
  // backwards from page 2 returns page 1
  const p1 = (await admin.get('/manage/audit?limit=5')).text;
  const p2 = (await admin.get(hrefOf(p1, 'next'))).text;
  assert.equal(hrefOf(p1, 'prev'), null, 'first page has no previous');
  assert.deepEqual(idsOn((await admin.get(hrefOf(p2, 'prev'))).text), idsOn(p1));
  // a tampered cursor falls back to the first page instead of failing
  assert.deepEqual(idsOn((await admin.get('/manage/audit?limit=5&after=%25%25garbage')).text), idsOn(p1));
});

test('users list filters by role and/or status', async () => {
  await db.query(`UPDATE users SET active=false WHERE email='guest@example.com'`);
  const rows = (html) => new Set([...html.matchAll(/<span class="clip" title="([^"]+@[^"]+)"/g)].map((m) => m[1]));
  const roleOf = async (qs) => (await db.query(`SELECT email, role, active FROM users WHERE deleted_at IS NULL ORDER BY id`)).filter((u) => (qs.role ? u.role === qs.role : true) && (qs.status ? u.active === (qs.status === 'active') : true));
  const guests = (await admin.get('/manage/users?role=guest')).text;
  for (const u of await roleOf({ role: 'guest' })) assert.ok(rows(guests).has(u.email), `${u.email} listed under guest`);
  for (const u of (await roleOf({})).filter((x) => x.role !== 'guest')) assert.ok(!rows(guests).has(u.email), `${u.email} hidden under guest`);
  const off = (await admin.get('/manage/users?status=disabled')).text;
  assert.ok(rows(off).has('guest@example.com'));
  assert.ok(!rows(off).has('admin@specly.local') && rows(off).size >= 1, 'active users hidden under disabled');
  const both = (await admin.get('/manage/users?role=admin&status=disabled')).text;
  assert.match(both, /No users match these filters/);
  assert.match((await admin.get('/manage/users?role=bogus&status=bogus')).text, /Showing/, 'unknown values are ignored');
  assert.match(guests, /<option value="guest" selected>/, 'selection is kept');
  await db.query(`UPDATE users SET active=true WHERE email='guest@example.com'`);
});

test('manage lists: offset pagination with server-side search, page clamping and per-page size', async () => {
  for (let i = 1; i <= 7; i++) await admin.post('/manage/users', { name: `Pager ${i}`, email: `pager${i}@example.com`, role: 'guest', password: 'pagerpass12' });
  const rows = (html) => new Set(html.match(/pager\d@example\.com/g) || []).size;
  const p1 = (await admin.get('/manage/users?q=pager&limit=5')).text;
  assert.equal(rows(p1), 5, 'limit applies');
  assert.match(p1, /Showing 1–5 of 7/);
  const p2 = (await admin.get('/manage/users?q=pager&limit=5&page=2')).text;
  assert.equal(rows(p2), 2);
  assert.match(p2, /Showing 6–7 of 7/);
  assert.match(p2, /rel="prev" href="\?[^"]*q=pager/, 'links keep the search');
  assert.equal(rows((await admin.get('/manage/users?q=pager&limit=5&page=99')).text), 2, 'out-of-range page clamps to the last');
  assert.equal(rows((await admin.get('/manage/users?q=pager&limit=5&page=abc')).text), 5, 'bad page falls back to 1');
  assert.match((await admin.get('/manage/users?q=zzzzzz')).text, /No users match/);
  // default size is 50 and the other lists render with the shared pager too
  assert.match((await admin.get('/manage/users')).text, /aria-current="true">50</);
  for (const url of ['/manage/blueprints?limit=5', '/manage/invites?limit=25', '/manage/requests?hpage=1&ppage=1', '/manage/trash?bpage=2&upage=2']) {
    assert.equal((await admin.get(url)).status, 200, url);
  }
  assert.match((await admin.get('/manage/blueprints?q=zzzzzz')).text, /No blueprints match/);
});
