const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, Client, admin } = require('../support');

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

test('search matches operationId, and a bare method name matches that method exactly', async () => {
  assert.match((await admin.get('/search?q=listPets')).text, /\/pets/, 'operationId search');
  assert.match((await admin.get('/search?q=GET')).text, /class="method m-/, 'method name (any case) lists endpoints');
  assert.match((await admin.get('/search?q=get')).text, /class="method m-/);
  assert.equal((await admin.get('/search?q=%25_')).status, 200, 'wildcards are escaped, not an error');
});

test('schema is idempotent and the migrated shape holds: natural endpoint key, trimmed columns, no dead indexes', async () => {
  await db.init(); // a second run must be a no-op, not an error
  const cols = async (t) => (await db.query('SELECT column_name FROM information_schema.columns WHERE table_name=$1', [t])).map((c) => c.column_name);
  assert.ok(!(await cols('endpoints')).includes('id'));
  assert.ok(!(await cols('blueprints')).some((c) => ['created_by', 'created_at', 'source'].includes(c)));
  const idx = (await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).map((r) => r.indexname);
  for (const gone of ['idx_audit_at', 'idx_audit_action', 'idx_tokens_expires', 'idx_endpoints_bp']) assert.ok(!idx.includes(gone), `${gone} is gone`);
  for (const kept of ['idx_endpoints_opid_trgm', 'idx_audit_action_prefix', 'endpoints_pkey']) assert.ok(idx.includes(kept), `${kept} exists`);
  assert.equal((await db.one(`SELECT attnotnull FROM pg_attribute WHERE attrelid='endpoints'::regclass AND attname='deprecated'`)).attnotnull, true);
  assert.match((await db.one(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='access_requests_status_check'`)).d, /cancelled/);
});
