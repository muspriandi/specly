const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diffSpecs } = require('../../src/services/blueprints');
const trash = require('../../src/services/trash');
const seed = require('../../src/seed');
const { audit } = require('../../src/services/audit');
const { db, Client, admin, upload, mails, flushMail, lastMailLink, url } = require('../support');

const DOC = (extra = '', version = '1.0') => `openapi: 3.0.3
info: { title: Publish API, version: '${version}' }
paths:
  /things:
    get:
      summary: List things${extra}
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: integer }
                  label: { type: string }
`;
const put = (id, token, body, headers = {}) => fetch(url(`/api/v1/blueprints/${id}`), { method: 'PUT', headers: { 'content-type': 'application/yaml', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
async function newToken(bpId, name = 'ci', days = '90') {
  assert.equal((await admin.post(`/manage/blueprints/${bpId}/api`, { name, days })).status, 302);
  const m = (await admin.get(`/manage/blueprints/${bpId}/api`)).text.match(/value="(spk_[A-Za-z0-9_-]{43})"/);
  assert.ok(m, 'the token is shown once, right after it is created');
  return m[1];
}
const makeBlueprint = async (title = 'Publish API') => {
  assert.equal((await upload(admin, '/manage/blueprints', DOC().replace('Publish API', title))).status, 302);
  return (await db.one('SELECT id FROM blueprints WHERE title=$1 ORDER BY id DESC LIMIT 1', [title])).id;
};

test('API tokens: a pipeline can publish exactly one blueprint, and nothing else', async () => {
  const id = await makeBlueprint('Publish API');
  const other = await makeBlueprint('Other API');
  const token = await newToken(id, 'GitHub Actions');
  assert.doesNotMatch((await admin.get(`/manage/blueprints/${id}/api`)).text, /spk_[A-Za-z0-9_-]{43}/, 'not shown again after a refresh');
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM api_tokens WHERE token_hash=$1', [token])).n, 0, 'only a hash is stored');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='blueprint.api_token_created'`));
  const revs = async (b = id) => (await db.one('SELECT MAX(version_no)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [b])).n;
  const before = await revs();

  // publishing a change
  const r = await put(id, token, DOC('\n      description: now with a description', '1.1'), { 'x-change-note': 'Release abc123' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true); assert.equal(body.unchanged, false); assert.equal(body.revision, before + 1); assert.equal(body.version, '1.1');
  assert.deepEqual(Object.keys(body.diff), ['added', 'changed', 'removed', 'deprecated']);
  assert.match((await db.one('SELECT note FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no DESC LIMIT 1', [id])).note, /Release abc123 \(API token "GitHub Actions"\)/);
  assert.ok((await db.one('SELECT last_used_at FROM api_tokens WHERE blueprint_id=$1', [id])).last_used_at, 'last use is recorded');
  // identical content is not a new revision
  const same = await (await put(id, token, DOC('\n      description: now with a description', '1.1'))).json();
  assert.equal(same.unchanged, true);
  assert.equal(await revs(), before + 1);

  // everything that must be refused
  assert.equal((await put(id, null, DOC())).status, 401, 'no token');
  assert.equal((await put(id, 'spk_' + 'x'.repeat(43), DOC())).status, 401, 'wrong token');
  assert.equal((await put(id, 'not-a-token', DOC())).status, 401);
  assert.equal((await put(other, token, DOC())).status, 403, 'a token is scoped to its own blueprint');
  assert.equal((await fetch(url(`/api/v1/blueprints/${id}`), { method: 'PUT', headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` }, body: 'x' })).status, 415);
  assert.equal((await put(id, token, '   ')).status, 400, 'empty body');
  const broken = await put(id, token, 'openapi: 3.0.3\ninfo: {title: X\npaths: {}');
  assert.equal(broken.status, 400);
  const brokenBody = await broken.json();
  assert.equal(brokenBody.ok, false); assert.match(brokenBody.error, /Invalid YAML/);
  assert.equal((await put(id, token, `${DOC()}# ${'x'.repeat(5.5 * 1024 * 1024)}`)).status, 413, 'larger than 5 MB');
  assert.equal(await revs(), before + 1, 'none of the refused requests changed anything');
  assert.equal((await fetch(url(`/api/v1/blueprints/${id}`), { method: 'GET', headers: { authorization: `Bearer ${token}` } })).status, 404, 'publishing is the only thing a token can do');
  // a signed-in browser session is NOT enough: the API only knows tokens
  const cookie = [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  assert.equal((await fetch(url(`/api/v1/blueprints/${id}`), { method: 'PUT', headers: { cookie, 'content-type': 'application/yaml' }, body: DOC() })).status, 401);
  // a bomb is refused like any invalid document
  const bomb = ['openapi: 3.0.3', 'info: {title: B, version: "1"}', 'paths: {}', 'x0: &a0 [x,x,x,x,x,x,x,x,x]', ...Array.from({ length: 9 }, (_, i) => `x${i + 1}: &a${i + 1} [${Array(9).fill('*a' + i).join(',')}]`)].join('\n');
  const bombRes = await put(id, token, bomb);
  assert.equal(bombRes.status, 400); assert.match((await bombRes.json()).error, /alias bomb/);

  // revoking stops it at once; so does expiry
  const tid = (await db.one('SELECT id FROM api_tokens WHERE blueprint_id=$1', [id])).id;
  await db.query(`UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id=$1`, [tid]);
  assert.equal((await put(id, token, DOC())).status, 401, 'expired');
  await db.query('UPDATE api_tokens SET expires_at = NULL WHERE id=$1', [tid]);
  assert.equal((await put(id, token, DOC('\n      description: now with a description', '1.1'))).status, 200);
  assert.equal((await admin.post(`/manage/blueprints/${id}/api/revoke`, { ids: String(tid) })).status, 302);
  assert.equal((await put(id, token, DOC())).status, 401, 'revoked');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='blueprint.api_token_revoked'`));
  // only admins manage tokens
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('notadmin-api@example.com','NA',$1,'member')`, [hash]);
  const member = new Client(); await member.login('notadmin-api@example.com', 'Admin1234');
  assert.equal((await member.get(`/manage/blueprints/${id}/api`)).status, 403);
  assert.equal((await member.post(`/manage/blueprints/${id}/api`, { name: 'x' })).status, 403);
});

test('API tokens: at most 10 active per blueprint, and a token is throttled', async () => {
  const id = await makeBlueprint('Token Limit API');
  const tokens = [];
  for (let i = 1; i <= 10; i++) tokens.push(await newToken(id, `t${i}`));
  const page = (await admin.get(`/manage/blueprints/${id}/api`)).text;
  assert.match(page, /10 of 10 active/);
  assert.equal((await admin.post(`/manage/blueprints/${id}/api`, { name: 'eleventh' })).status, 302);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM api_tokens WHERE blueprint_id=$1', [id])).n, 10, 'still ten');
  assert.equal((await admin.post(`/manage/blueprints/${id}/api`, { name: '' })).status, 302, 'a name is required');
  // 60 publishes a minute per token
  let limited = 0;
  for (let i = 0; i < 63; i++) if ((await put(id, tokens[0], DOC())).status === 429) limited++;
  assert.ok(limited >= 2 && limited <= 4, `requests beyond the 60th are refused (${limited})`);
  assert.equal((await put(id, tokens[1], DOC())).status, 200, 'another token is not affected');
});

test('breaking changes are detected field by field, and shown in the review, the changelog and when comparing revisions', async () => {
  const id = await makeBlueprint('Break API');
  const v2 = DOC('', '2.0').replace('Publish API', 'Break API').replace("                  label: { type: string }\n", '').replace('      summary: List things', '      parameters:\n        - { name: owner, in: query, required: true, schema: { type: string } }\n      summary: List things');
  // unit level
  const unit = diffSpecs(DOC(), v2);
  const breaking = unit.breaking.map((b) => b.change);
  assert.ok(breaking.includes('Required query parameter "owner" added'), breaking.join(' | '));
  assert.ok(breaking.includes('Response 200 field "label" removed'));
  assert.deepEqual(unit.changed, ['GET /things']);
  assert.equal(diffSpecs(DOC(), DOC()).breaking.length, 0, 'identical documents have no changes at all');
  const optional = diffSpecs(DOC(), DOC().replace('      summary: List things', '      parameters:\n        - { name: q, in: query, schema: { type: string } }\n      summary: List things'));
  assert.equal(optional.breaking.length, 0, 'an optional parameter is not breaking');
  assert.ok(optional.details['GET /things'].some((c) => /Optional query parameter "q" added/.test(c.text)));
  assert.deepEqual(diffSpecs(DOC(), DOC().replace(/ {2}\/things:[\s\S]*$/, '')).breaking.map((b) => b.change), ['Endpoint removed']);
  // the publish review (preview with ?for=) carries it
  const prev = JSON.parse((await upload(admin, `/manage/blueprints/preview?for=${id}`, v2.replace('Publish API', 'Break API'))).text);
  assert.ok(prev.diff.breaking.length >= 2);
  // publish it, then it is in the changelog (for readers) and in the admin comparison
  assert.equal((await upload(admin, `/manage/blueprints/${id}`, v2)).status, 302);
  const log = (await admin.get(`/blueprints/${id}/changelog`)).text;
  assert.match(log, /2 breaking/);
  assert.match(log, /Required query parameter &#34;owner&#34; added|Required query parameter "owner" added/);
  const versions = await db.query('SELECT id, version_no FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no', [id]);
  const cmp = (await admin.get(`/manage/blueprints/${id}/compare?from=${versions[0].version_no}&to=${versions[1].version_no}`)).text;
  assert.match(cmp, /Breaking changes \(2\)/);
  assert.match(cmp, /Response 200 field/);
  assert.match((await admin.get(`/manage/blueprints/${id}/compare?from=1&to=1`)).text, /Pick two different revisions/);
  assert.equal((await admin.get(`/manage/blueprints/${id}/compare?from=999&to=abc`)).status, 200, 'unknown revisions fall back to sensible ones');
  assert.match((await admin.get(`/manage/blueprints/${id}/versions`)).text, /\/compare\?from=1&(amp;)?to=2/);
});

test('old revisions can be read as documentation by admins only', async () => {
  const id = (await db.one(`SELECT id FROM blueprints WHERE title='Break API'`)).id;
  const [first, second] = await db.query('SELECT id, version_no FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no', [id]);
  const page = await admin.get(`/manage/blueprints/${id}/versions/${first.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Revision 1<\/strong> of 2: not the current version/);
  assert.match(page.text, new RegExp(`data-spec="/manage/blueprints/${id}/versions/${first.id}/spec.json"`));
  assert.doesNotMatch(page.text, /Postman collection|>Changelog</, 'no actions that only make sense for the current version');
  const spec1 = await (await admin.get(`/manage/blueprints/${id}/versions/${first.id}/spec.json`)).text;
  assert.match(spec1, /"label"/, 'revision 1 still has the field that revision 2 removed');
  assert.doesNotMatch(await (await admin.get(`/blueprints/${id}/spec.json`)).text, /"label"/, 'the current version does not');
  assert.match((await admin.get(`/manage/blueprints/${id}/versions/${second.id}`)).text, /\(the current one\)/);
  assert.equal((await admin.get(`/manage/blueprints/${id}/versions/999999`)).status, 404);
  assert.equal((await admin.get(`/manage/blueprints/${id}/versions/1x`)).status, 404);
  // readers cannot: they get the changelog, not the old documents
  const m = new Client(); await m.login('notadmin-api@example.com', 'Admin1234');
  for (const u of [`/manage/blueprints/${id}/versions/${first.id}`, `/manage/blueprints/${id}/versions/${first.id}/spec.json`, `/manage/blueprints/${id}/compare`]) assert.equal((await m.get(u)).status, 403, u);
  assert.equal((await new Client().get(`/manage/blueprints/${id}/versions/${first.id}/spec.json`)).status, 302);
});

test('watching a blueprint: an email on every publish, only while you can still read it', async () => {
  const id = await makeBlueprint('Watched API');
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  const wid = (await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ('watcher@example.com','Wat',$1,'member') RETURNING id`, [hash])).id;
  const w = new Client(); await w.login('watcher@example.com', 'Admin1234');
  assert.equal((await w.post(`/blueprints/${id}/watch`, {})).status, 404, 'you cannot watch what you cannot read (and are not told it exists)');
  await admin.post(`/manage/users/${wid}/access`, { bp: String(id) });
  assert.match((await w.get(`/blueprints/${id}`)).text, />\s*Watch\s*</);
  assert.equal((await w.post(`/blueprints/${id}/watch`, {})).status, 302);
  assert.match((await w.get(`/blueprints/${id}`)).text, />\s*Watching\s*</);
  assert.equal((await w.post(`/blueprints/${id}/watch`, {})).status, 302, 'watching twice is harmless');
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM blueprint_watchers WHERE blueprint_id=$1', [id])).n, 1);

  const sent = (marker) => mails.slice(marker).filter((m) => /To: watcher@example\.com/.test(m) && /was updated/.test(m));
  let mark = mails.length;
  // published from the UI
  assert.equal((await upload(admin, `/manage/blueprints/${id}`, DOC('\n      description: v2', '1.1').replace('Publish API', 'Watched API'), 'second revision')).status, 302);
  await flushMail();
  assert.equal(sent(mark).length, 1);
  assert.match(sent(mark)[0], /Subject: Watched API was updated \(v1\.1\)/);
  assert.match(sent(mark)[0], /second revision/);
  assert.match(sent(mark)[0], /\/blueprints\/\d+\/changelog/);
  // published by a pipeline, with a breaking change
  const token = await newToken(id, 'ci');
  mark = mails.length;
  const broken = DOC('', '2.0').replace('Publish API', 'Watched API').replace("                  label: { type: string }\n", '');
  assert.equal((await put(id, token, broken)).status, 200);
  await flushMail();
  assert.equal(sent(mark).length, 1);
  assert.match(sent(mark)[0], /Subject: Watched API was updated \(v2\.0\): breaking changes/);
  assert.match(sent(mark)[0], /Breaking changes \(1\):[\s\S]*Response 200 field "label" removed/);
  // identical content: nothing to tell
  mark = mails.length;
  await put(id, token, broken);
  await flushMail();
  assert.equal(sent(mark).length, 0);
  // access removed: no more mail, even though still "watching"
  await admin.post(`/manage/users/${wid}/access/revoke`, { bp: String(id) });
  mark = mails.length;
  await put(id, token, DOC('\n      description: v3', '3.0').replace('Publish API', 'Watched API'));
  await flushMail();
  assert.equal(sent(mark).length, 0, 'a reader whose access was removed hears nothing');
  // unwatch
  await admin.post(`/manage/users/${wid}/access`, { bp: String(id) });
  assert.equal((await w.post(`/blueprints/${id}/unwatch`, {})).status, 302);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM blueprint_watchers WHERE blueprint_id=$1', [id])).n, 0);
  mark = mails.length;
  await put(id, token, DOC('\n      description: v4', '4.0').replace('Publish API', 'Watched API'));
  await flushMail();
  assert.equal(sent(mark).length, 0);
  assert.equal((await new Client().post(`/blueprints/${id}/watch`, {})).status, 302, 'sign-in required');
});

test('sessions end after a period of inactivity, and an active one is kept alive', async () => {
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  const uid = (await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ('idle@example.com','Idle',$1,'member') RETURNING id`, [hash])).id;
  const c = new Client(); await c.login('idle@example.com', 'Admin1234');
  assert.equal((await c.get('/')).status, 200);
  await db.query(`UPDATE sessions SET last_seen_at = now() - interval '10 minutes' WHERE user_id=$1`, [uid]);
  assert.equal((await c.get('/')).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  const touched = (await db.one(`SELECT now() - last_seen_at AS age FROM sessions WHERE user_id=$1`, [uid])).age;
  assert.ok(touched.seconds === undefined || touched.seconds < 30 && !touched.minutes, `the session was refreshed (${JSON.stringify(touched)})`);
  await db.query(`UPDATE sessions SET last_seen_at = now() - interval '25 hours' WHERE user_id=$1`, [uid]);
  assert.equal((await c.get('/')).status, 302, 'idle for more than 24 hours: signed out');
  assert.equal((await c.get('/account/sessions')).status, 302);
  // and the cleanup removes it
  await require('../../src/db').purgeExpired();
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM sessions WHERE user_id=$1', [uid])).n, 0);
});

test('invitations can be resent (the old link dies) and revoked', async () => {
  assert.equal((await admin.post('/manage/invites', { emails: 'resend-me@example.com', role: 'member' })).status, 302);
  const first = lastMailLink(/\/invite\/[\w-]+/);
  const list = (await admin.get('/manage/invites')).text;
  const id = list.match(/\/manage\/invites\/([0-9a-f]{16})\/resend/)[1];
  assert.match(list, /Revoke/);
  assert.equal((await new Client().get(first)).status, 200);
  const before = mails.length;
  assert.equal((await admin.post(`/manage/invites/${id}/resend`, {})).status, 302);
  const second = lastMailLink(/\/invite\/[\w-]+/);
  assert.notEqual(second, first);
  assert.ok(mails.length > before, 'a new email was sent');
  assert.equal((await new Client().get(first)).status, 400, 'the old link no longer works');
  assert.equal((await new Client().get(second)).status, 200);
  assert.equal((await db.one(`SELECT role FROM tokens WHERE type='invite' AND email='resend-me@example.com'`)).role, 'member', 'role is kept');
  // revoke
  const id2 = (await admin.get('/manage/invites')).text.match(/\/manage\/invites\/([0-9a-f]{16})\/revoke/)[1];
  assert.equal((await admin.post(`/manage/invites/${id2}/revoke`, {})).status, 302);
  assert.equal((await new Client().get(second)).status, 400, 'revoked');
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM tokens WHERE type='invite' AND email='resend-me@example.com'`)).n, 0);
  assert.equal((await admin.post(`/manage/invites/${id2}/revoke`, {})).status, 302, 'revoking twice is harmless');
  assert.equal((await admin.post('/manage/invites/zzzzzzzzzzzzzzzz/resend', {})).status, 302, 'a made-up id is harmless');
  const n = new Client(); await n.login('notadmin-api@example.com', 'Admin1234');
  assert.equal((await n.post(`/manage/invites/${id}/revoke`, {})).status, 403);
});

test('audit log export: filtered CSV, safe against spreadsheet formulas, and the export itself is recorded', async () => {
  await audit({ id: 'csv', ip: '10.1.1.1', user: null }, 'custom.csv', { detail: '=HYPERLINK("http://evil.example","click"),with, comma', actor: { id: null, email: '+cmd@example.com' }, store: true });
  await audit({ id: 'csv', ip: '10.1.1.2', user: null }, 'custom.other', { detail: 'plain', store: true });
  const r = await admin.get('/manage/audit/export.csv?q=custom.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="audit-log-\d{4}-\d\d-\d\d\.csv"/);
  const lines = r.text.trim().split('\r\n');
  assert.equal(lines[0], 'time,actor,action,target,detail,ip');
  assert.equal(lines.length, 2, 'only the matching row');
  assert.match(lines[1], /,'\+cmd@example\.com,custom\.csv,,"'=HYPERLINK\(""http:\/\/evil\.example"",""click""\),with, comma",10\.1\.1\.1$/);
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='audit.exported'`), 'exporting the log is itself logged');
  const all = (await admin.get('/manage/audit/export.csv')).text.trim().split('\r\n');
  assert.ok(all.length > 5);
  assert.ok((await admin.get('/manage/audit/export.csv?group=user')).text.trim().split('\r\n').slice(1).every((l) => /,user\./.test(l)));
  const m = new Client(); await m.login('notadmin-api@example.com', 'Admin1234');
  assert.equal((await m.get('/manage/audit/export.csv')).status, 403);
  assert.equal((await new Client().get('/manage/audit/export.csv')).status, 302);
});

test('the trash empties itself after the retention period, and every removal is on the record', async () => {
  const old = (await db.one(`INSERT INTO blueprints (title, format, spec, deleted_at) VALUES ('Old Trash','yaml','{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}', now() - interval '45 days') RETURNING id`)).id;
  const fresh = (await db.one(`INSERT INTO blueprints (title, format, spec, deleted_at) VALUES ('Fresh Trash','yaml','{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}', now() - interval '3 days') RETURNING id`)).id;
  await db.query(`INSERT INTO users (email,name,password_hash,role,deleted_at) VALUES ('old-trash@example.com','Old','x','guest', now() - interval '45 days')`);
  assert.deepEqual(await trash.purgeOld(0), { blueprints: 0, users: 0 }, '0 days means never');
  assert.equal(await db.one('SELECT 1 FROM blueprints WHERE id=$1', [old]) !== null, true);
  const gone = await trash.purgeOld(30);
  assert.ok(gone.blueprints >= 1 && gone.users >= 1);
  assert.equal(await db.one('SELECT 1 FROM blueprints WHERE id=$1', [old]), null, 'past the period: gone');
  assert.ok(await db.one('SELECT 1 FROM blueprints WHERE id=$1', [fresh]), 'recently deleted: still restorable');
  assert.equal(await db.one(`SELECT 1 FROM users WHERE email='old-trash@example.com'`), null);
  const rec = await db.one(`SELECT actor_label, detail FROM audit_log WHERE action='blueprint.purged' AND detail LIKE '%Old Trash%'`);
  assert.equal(rec.actor_label, 'system (trash cleanup)');
  assert.match(rec.detail, /after 30 days in the trash/);
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='user.purged' AND detail LIKE '%old-trash@example.com%'`));
});

test('seeding does not add a sample again after it was renamed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specly-seed-'));
  fs.writeFileSync(path.join(dir, 'x.yaml'), 'openapi: 3.0.3\ninfo: { title: Seed Rename Me, version: "1" }\npaths:\n  /x:\n    get: { responses: { "200": { description: ok } } }\n');
  assert.deepEqual((await seed.seedSamples({ dir })).map((r) => r.status), ['added']);
  assert.deepEqual((await seed.seedSamples({ dir })).map((r) => r.status), ['skipped'], 'same title');
  await db.query(`UPDATE blueprints SET title='Seed Renamed By A Human' WHERE title='Seed Rename Me'`);
  assert.deepEqual((await seed.seedSamples({ dir })).map((r) => r.status), ['skipped'], 'renamed, but it is still that very file');
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM blueprints WHERE title LIKE 'Seed Re%'`)).n, 1);
});

test('time-limited access: it works until the end date, then stops everywhere and can be renewed or re-requested', async () => {
  const id = await makeBlueprint('Temporary Access API');
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  const gid = (await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ('temp-guest@example.com','Tempy','${hash}','guest') RETURNING id`)).id;
  const mid = (await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ('temp-member@example.com','Memby','${hash}','member') RETURNING id`)).id;
  const g = new Client(); await g.login('temp-guest@example.com', 'Admin1234');
  const m = new Client(); await m.login('temp-member@example.com', 'Admin1234');
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

  // bad dates are refused and nothing is assigned
  for (const bad of ['2001-01-01', 'soon', '2026-02-31', '2099-01-01']) {
    assert.equal((await admin.post(`/manage/blueprints/${id}/access`, { users: String(gid), until: bad })).status, 302);
    assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM access_requests WHERE user_id=$1', [gid])).n, 0, `${bad} assigned nothing`);
  }
  const before = mails.length;
  assert.equal((await admin.post(`/manage/blueprints/${id}/access`, { users: String(gid), until: tomorrow })).status, 302);
  assert.equal((await admin.post(`/manage/users/${mid}/access`, { bp: String(id), until: tomorrow })).status, 302);
  await flushMail();
  assert.ok(mails.slice(before).some((x) => /To: temp-guest@example\.com/.test(x) && new RegExp(`ends on ${tomorrow}`).test(x)), 'the email says when it ends');
  const row = await db.one('SELECT expires_at FROM access_requests WHERE user_id=$1', [gid]);
  assert.equal(row.expires_at.getTime(), new Date(`${tomorrow}T00:00:00Z`).getTime() + 86400000, 'ends at the end of the chosen day (UTC)');
  assert.match((await admin.get(`/manage/blueprints/${id}/access`)).text, new RegExp(tomorrow.slice(0, 4)), 'the end date is listed');
  assert.equal((await g.get(`/blueprints/${id}`)).status, 200, 'access works before the end');
  assert.match((await g.get('/')).text, /Temporary Access API/);

  // the end date passes
  await db.query(`UPDATE access_requests SET expires_at = now() - interval '1 minute' WHERE blueprint_id=$1`, [id]);
  assert.equal((await g.get(`/blueprints/${id}`)).status, 403);
  assert.equal((await g.get(`/blueprints/${id}/spec.json`)).status, 404);
  assert.equal((await g.get(`/blueprints/${id}/changelog`)).status, 403);
  assert.doesNotMatch((await g.get('/')).text, /Temporary Access API/, 'it disappears from the guest\'s list');
  assert.doesNotMatch((await g.get('/search?q=things')).text, /Temporary Access API/, 'and from search');
  assert.equal((await m.get(`/blueprints/${id}`)).status, 403);
  assert.match((await m.get('/')).text, /Request access/, 'a member can ask again');
  const page = (await admin.get(`/manage/blueprints/${id}/access`)).text;
  assert.ok(!/Tempy/.test(page.split('Assign users')[0]), 'no longer listed as a reader');
  assert.match(page, /name="users" value="\d+"/, 'but offered for assignment again');
  assert.doesNotMatch((await admin.get('/manage/blueprints')).text, /Temporary Access API[\s\S]{0,400}?>2</, 'not counted as readers');

  // the member re-requests (the ended row must not block it); the admin renews the guest
  assert.equal((await m.post(`/blueprints/${id}/request`, { message: 'again please' })).status, 302);
  assert.equal((await db.one(`SELECT status FROM access_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [mid])).status, 'pending');
  assert.equal((await admin.post(`/manage/blueprints/${id}/access`, { users: String(gid) })).status, 302);
  assert.equal((await g.get(`/blueprints/${id}`)).status, 200, 'renewed, this time without an end');
  assert.equal((await db.one('SELECT expires_at FROM access_requests WHERE user_id=$1 AND status=$2', [gid, 'approved'])).expires_at, null);

  // housekeeping closes ended access for good
  await db.query(`UPDATE access_requests SET expires_at = now() - interval '1 minute' WHERE user_id=$1 AND status='approved'`, [gid]);
  const removed = await require('../../src/db').purgeExpired();
  assert.ok(removed.accessEnded >= 1);
  assert.equal((await db.one(`SELECT status FROM access_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [gid])).status, 'rejected');
});

test('the home page is paginated, and Enter searches every blueprint on the server', async () => {
  const spec = (n) => JSON.stringify({ openapi: '3.0.3', info: { title: `Bulk ${String(n).padStart(3, '0')} API`, version: '1' }, paths: {} });
  for (let i = 1; i <= 50; i++) await db.query(`INSERT INTO blueprints (title, format, spec) VALUES ($1,'yaml',$2)`, [`Bulk ${String(i).padStart(3, '0')} API`, spec(i)]);
  const cards = (html) => (html.match(/data-bp="/g) || []).length;
  const first = (await admin.get('/')).text;
  assert.equal(cards(first), 48, '48 on a page');
  assert.match(first, /Page 1 of \d+/);
  assert.match(first, /rel="next" href="\?page=2"/);
  const second = (await admin.get('/?page=2')).text;
  assert.ok(cards(second) >= 1 && cards(second) <= 48);
  assert.notEqual(first, second);
  assert.equal(cards((await admin.get('/?page=999')).text) >= 1, true, 'a page past the end shows the last one');
  assert.equal(cards((await admin.get('/?page=abc')).text), 48, 'a bad page number shows the first');
  const found = (await admin.get('/?q=Bulk 042')).text;
  assert.equal(cards(found), 1, 'the server-side search finds the one match on any page');
  assert.match(found, /Bulk 042 API/);
  assert.match((await admin.get('/?q=zzzznothing')).text, /No blueprints match/);
  assert.equal(cards((await admin.get('/?q=%25')).text), 0, 'wildcards are escaped');
  await db.query(`DELETE FROM blueprints WHERE title LIKE 'Bulk %'`);
});
