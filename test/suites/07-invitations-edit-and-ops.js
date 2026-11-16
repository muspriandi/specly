const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, Client, spec, upload, lastMailLink, mails, flushMail, admin } = require('../support');

test('invitations carry a role and blueprints; emails go out for requests and assignments', async () => {
  const { id: bp } = await db.one(`SELECT id FROM blueprints ORDER BY id LIMIT 1`);
  const { id: other } = await db.one(`SELECT id FROM blueprints WHERE id<>$1 ORDER BY id LIMIT 1`, [bp]);
  assert.match((await admin.get('/manage/invites')).text, /name="role"/);
  const sent = await admin.post('/manage/invites', { emails: 'invited-member@example.com', role: 'member', bp: String(bp) });
  assert.equal(sent.status, 302);
  assert.match((await admin.get(sent.location)).text, /1 invitation\(s\) sent/);
  assert.match(mails[mails.length - 1], /starting with/, 'the email names the blueprints');
  const link = lastMailLink(/\/invite\/[\w-]+/);
  assert.match((await new Client().get(link)).text, /Create your member account/);
  const inv = new Client();
  assert.equal((await inv.post(link, { name: 'Invited', password: 'invitedpass1', confirm: 'invitedpass1' })).status, 302);
  assert.equal((await db.one(`SELECT role FROM users WHERE email='invited-member@example.com'`)).role, 'member');
  assert.equal((await inv.get(`/blueprints/${bp}`)).status, 200, 'the invited blueprint is ready on first sign-in');
  assert.equal((await inv.get(`/blueprints/${other}`)).status, 403, 'others stay locked');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='invite.accepted' AND detail LIKE '%member account%assigned%'`));
  // unknown roles fall back to guest; a guest cannot be invited with a nonexistent blueprint
  await admin.post('/manage/invites', { emails: 'invited-guest@example.com', role: 'admin', bp: '999999' });
  const t = await db.one(`SELECT role, blueprint_ids FROM tokens WHERE email='invited-guest@example.com'`);
  assert.equal(t.role, 'guest'); assert.deepEqual(t.blueprint_ids, []);

  // the member asks for another blueprint: admins are emailed; approving emails the member
  const before = mails.length;
  assert.equal((await inv.post(`/blueprints/${other}/request`, { message: 'need it' })).status, 302);
  await flushMail();
  assert.ok(mails.slice(before).some((m) => /Access request:/.test(m) && /need it/.test(m) && /To: admin@specly\.local/.test(m)), 'admin is notified');
  const rid = (await db.one(`SELECT r.id FROM access_requests r JOIN users u ON u.id=r.user_id WHERE u.email='invited-member@example.com' AND r.status='pending'`)).id;
  assert.equal((await admin.post(`/manage/requests/${rid}/approve`, {})).status, 302);
  await flushMail();
  assert.ok(mails.slice(before).some((m) => /You can now read/.test(m) && /To: invited-member@example\.com/.test(m)), 'member is told it was approved');
  assert.equal((await inv.get(`/blueprints/${other}`)).status, 200);
  // assigning from an access page emails too
  const g = await db.one(`SELECT id FROM users WHERE email='assigned-guest@example.com'`);
  const n = mails.length;
  await admin.post(`/manage/users/${g.id}/access`, { bp: String(other) });
  await flushMail();
  assert.ok(mails.slice(n).some((m) => /To: assigned-guest@example\.com/.test(m)));
});

test('editing: a stale form is refused with the typed text kept, unless the admin overwrites', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  const rev = async () => (await db.one('SELECT MAX(version_no)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [id])).n;
  const page = (await admin.get(`/manage/blueprints/${id}/edit`)).text;
  const opened = Number(page.match(/name="base" value="(\d+)"/)[1]);
  assert.equal(opened, await rev(), 'the form carries the revision it was opened at');
  // someone else saves in between
  assert.equal((await upload(admin, `/manage/blueprints/${id}`, spec('\n  /zzz-first:\n    get: { summary: First, responses: { "200": { description: ok } } }'), null, { base: opened })).status, 302);
  assert.equal(await rev(), opened + 1);
  // the stale form (still at `opened`) now saves different content: refused, nothing stored, text kept
  const mine = spec('\n  /zzz-mine:\n    get: { summary: Mine, responses: { "200": { description: ok } } }');
  const refused = await upload(admin, `/manage/blueprints/${id}`, mine, null, { base: opened });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /changed while you were editing/);
  assert.match(refused.text, /zzz-mine/, 'the typed text is still in the form');
  assert.match(refused.text, /name="overwrite"/);
  assert.equal(await rev(), opened + 1, 'nothing was saved');
  // identical content is never a conflict (nothing to lose)
  const same = (await db.one('SELECT source FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no DESC LIMIT 1', [id])).source;
  assert.equal((await upload(admin, `/manage/blueprints/${id}`, same, null, { base: opened })).status, 302);
  // overwrite on purpose
  assert.equal((await upload(admin, `/manage/blueprints/${id}`, mine, null, { base: opened, overwrite: '1' })).status, 302);
  assert.equal(await rev(), opened + 2);
});

test('operations: /healthz, request ids, and error pages that carry the reference', async () => {
  const h = await new Client().get('/healthz');
  assert.equal(h.status, 200);
  assert.deepEqual(JSON.parse(h.text), { status: 'ok' });
  assert.equal(h.headers.get('cache-control'), 'no-store');
  assert.match((await new Client().get('/login')).headers.get('x-request-id'), /^[0-9a-f]{12}$/);
  const { safePath } = require('../../src/lib/logger');
  assert.equal(safePath('/reset/abc123'), '/reset/:token');
  assert.equal(safePath('/invite/abc123'), '/invite/:token');
  assert.equal(safePath('/blueprints/4'), '/blueprints/4');
});

test('links use the address you browse when BASE_URL points at another local port', () => {
  const saved = process.env.BASE_URL;
  const fresh = () => { for (const k of Object.keys(require.cache)) if (/src[\\/](config|lib[\\/]http)\.js$/.test(k)) delete require.cache[k]; return require('../../src/lib/http'); };
  try {
    process.env.BASE_URL = 'http://localhost:3000';
    const { baseUrl } = fresh();
    const req = (host) => ({ protocol: 'http', get: () => host });
    assert.equal(baseUrl(req('localhost:3111')), 'http://localhost:3111', 'stale local port: use the address in use');
    assert.equal(baseUrl(req('localhost:3000')), 'http://localhost:3000');
    assert.equal(baseUrl(req('docs.example.com')), 'http://localhost:3000', 'a real host (proxy, tunnel) keeps BASE_URL');
    process.env.BASE_URL = 'https://docs.example.com';
    assert.equal(fresh().baseUrl(req('localhost:3111')), 'https://docs.example.com', 'a public BASE_URL is never overridden');
  } finally {
    if (saved === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = saved;
    fresh();
  }
});
