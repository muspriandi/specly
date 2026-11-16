const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, Client, spec, upload, admin } = require('../support');

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

test('deleting shows an Undo toast that restores it; bulk delete moves several at once', async () => {
  const mk = async (title, path) => { await upload(admin, '/manage/blueprints', spec().replace('Pets API', title).replace('/pets', path)); return (await db.one('SELECT id FROM blueprints WHERE title=$1', [title])).id; };
  const a = await mk('Undo A API', '/undo-a'), b = await mk('Undo B API', '/undo-b');
  const gone = async (id) => !!(await db.one('SELECT deleted_at FROM blueprints WHERE id=$1', [id])).deleted_at;

  await admin.post(`/manage/blueprints/${a}/delete`, {});
  assert.match((await admin.get('/manage/blueprints')).text, new RegExp(`data-undo-url="/manage/trash/blueprints/${a}/restore"`));
  await admin.post(`/manage/trash/blueprints/${a}/restore`, {});
  assert.equal(await gone(a), false, 'undo restores it');

  const both = new URLSearchParams(); both.append('ids', a); both.append('ids', b);
  await admin.post('/manage/blueprints/bulk-delete', both);
  assert.ok((await gone(a)) && (await gone(b)), 'both are in the trash');
  assert.match((await admin.get('/manage/blueprints')).text, /2 blueprints moved to the trash/);
  for (const id of [a, b]) await admin.post(`/manage/trash/blueprints/${id}/restore`, {});

  // users: your own account is skipped
  const me = (await db.one(`SELECT id FROM users WHERE email='admin@specly.local'`)).id;
  const other = (await db.one(`SELECT id FROM users WHERE email='guest@example.com'`)).id;
  const users = new URLSearchParams(); users.append('ids', me); users.append('ids', other);
  await admin.post('/manage/users/bulk-delete', users);
  assert.equal((await db.one('SELECT deleted_at FROM users WHERE id=$1', [me])).deleted_at, null, 'self is skipped');
  assert.ok((await db.one('SELECT deleted_at FROM users WHERE id=$1', [other])).deleted_at, 'the other user is trashed');
  await admin.post(`/manage/trash/users/${other}/restore`, {});

  // un-assign carries an Undo that assigns the same user again
  await admin.post(`/manage/blueprints/${a}/access`, { users: other });
  await admin.post(`/manage/blueprints/${a}/access/${other}/revoke`, {});
  const page = (await admin.get(`/manage/blueprints/${a}/access`)).text;
  assert.match(page, new RegExp(`data-undo-url="/manage/blueprints/${a}/access" data-undo-body="users=${other}"`));
  await admin.post(`/manage/blueprints/${a}/access`, { users: other });
  assert.equal((await db.one(`SELECT status FROM access_requests WHERE user_id=$1 AND blueprint_id=$2 ORDER BY id DESC LIMIT 1`, [other, a])).status, 'approved');
});

test('flash undo links must stay inside /manage', () => {
  const { readFlash } = require('../../src/lib/http');
  assert.deepEqual(readFlash('success|Done\t/manage/trash/users/3/restore\t').undo, { url: '/manage/trash/users/3/restore', body: '' });
  assert.equal(readFlash('success|Done\thttps://evil.test/x\t').undo, null);
  assert.equal(readFlash('success|Done\t/manage/../account\t').undo, null);
  assert.equal(readFlash('error|Plain').undo, null);
});

test('lists sort by whitelisted columns only; the preview suggests summaries and operationIds with line numbers', async () => {
  const r = await admin.get('/manage/blueprints?sort=endpoints&dir=desc');
  assert.equal(r.status, 200);
  assert.match(r.text, /aria-sort="descending"/);
  assert.equal((await admin.get('/manage/blueprints?sort=title;DROP%20TABLE%20users&dir=sideways')).status, 200, 'unknown sort keys are ignored');
  assert.match((await admin.get('/manage/users?sort=name&dir=asc')).text, /aria-sort="ascending"/);

  const doc = 'openapi: 3.0.3\ninfo: { title: Lint API, version: "1" }\npaths:\n  /a:\n    get:\n      operationId: dup\n      responses: { "200": { description: ok } }\n  /b:\n    get:\n      summary: B\n      operationId: dup\n      responses: { "200": { description: ok } }\n';
  const out = JSON.parse((await upload(admin, '/manage/blueprints/preview', doc)).text);
  assert.equal(out.ok, true);
  const kinds = out.warnings.map((w) => `${w.kind}@${w.line}`);
  assert.deepEqual(kinds, ['summary@5', 'duplicate@9']);
  assert.equal(out.warningCount, 2);
  assert.equal(JSON.parse((await upload(admin, '/manage/blueprints/preview', spec())).text).warningCount, 0, 'a complete operation has no suggestions');
});

test('deprecated and WIP badges are indexed and shown the same way in search and type-ahead', async () => {
  const doc = 'openapi: 3.0.3\ninfo: { title: Badge API, version: "1" }\npaths:\n  /badgey:\n    get: { summary: Old one, deprecated: true, x-status: wip, responses: { "200": { description: ok } } }\n  /plain:\n    get: { summary: Plain badgey, responses: { "200": { description: ok } } }\n';
  await upload(admin, '/manage/blueprints', doc);
  const html = (await admin.get('/search?q=badgey')).text;
  assert.match(html, /flag flag-dep[^>]*>deprecated</);
  assert.match(html, /flag flag-wip[^>]*>wip</);
  assert.equal((html.match(/flag flag-wip/g) || []).length, 1, 'only the WIP endpoint carries the badge');
  const sug = JSON.parse((await admin.get('/search/suggest?q=badgey')).text).endpoints;
  assert.deepEqual(sug.map((e) => [e.path, e.deprecated, e.status]).sort(), [['/badgey', true, 'wip'], ['/plain', false, '']]);
});
