const { test } = require('node:test');
const log = require('../../src/lib/log');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { db, spec, upload, admin } = require('../support');

test('blueprints accept YAML and JSON, reject garbage', async () => {
  assert.equal((await upload(admin, '/manage/blueprints', spec())).status, 302);
  // a JSON document, built from the sample in the repo (no files outside the repository: CI has none)
  const json = JSON.stringify(yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'task-api.yaml'), 'utf8')));
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

test('saves are logged with what changed (version bump, endpoint diff) but not stored in the audit table', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  const bumped = spec('\n    post: { summary: Add pet, responses: { "201": { description: ok } } }').replace("version: '1.0'", "version: '3.0.0'");
  const cap = log.capture();
  await upload(admin, `/manage/blueprints/${id}`, bumped, 'major release');
  const updates = () => cap.entries.filter((e) => e.msg === 'audit' && e.event === 'blueprint.updated');
  assert.equal(updates().length, 1);
  const row = updates()[0];
  assert.match(row.detail, /Updated "Pets API" from v1\.0 to v3\.0\.0/);
  assert.match(row.detail, /endpoints: 1 added/);
  assert.match(row.detail, /note: "major release"/);
  assert.equal(row.stored, false, 'content saves are log-only: blueprint_versions is their record');
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action IN ('blueprint.updated','blueprint.created')`)).n, 0);
  const again = await upload(admin, `/manage/blueprints/${id}`, bumped);
  assert.equal(again.status, 302);
  assert.equal(updates().length, 1, 'a no-change save is not logged as an update');
  cap.stop();
});
