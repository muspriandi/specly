const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, Client, spec, upload, admin } = require('../support');

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
