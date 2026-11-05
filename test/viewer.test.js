// Renders the Postman-style viewer in jsdom with a stubbed spec fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { JSDOM } = require('jsdom');

// Same files the app serves under /static/vendor/*.
const vendor = (pkg, file) => fs.readFileSync(path.join(path.dirname(require.resolve(pkg)), file), 'utf8');
const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const scripts = [vendor('marked', 'marked.umd.js'), vendor('dompurify', 'purify.min.js'), pub('doc-model.js'), pub('postman-view.js')];

async function mount(spec) {
  const dom = new JSDOM('<!doctype html><body><div id="doc" data-spec="/spec.json"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/blueprints/1' });
  const w = dom.window;
  w.fetch = async () => ({ ok: true, json: async () => spec });
  w.scrollTo = () => {};
  w.eval('window.__errors=[];window.addEventListener("error",e=>window.__errors.push(e.message))');
  scripts.forEach((s) => w.eval(s));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.__errors.length, 0, w.__errors.join('; '));
  return w;
}
const go = (w, hash) => { w.location.hash = hash; w.dispatchEvent(new w.HashChangeEvent('hashchange')); };
const textOf = (w) => w.document.getElementById('doc').textContent;
const sample = () => yaml.load(fs.readFileSync(path.join(__dirname, '../samples/task-api.yaml'), 'utf8'));

test('overview lists folders, requests and base URLs', async () => {
  const text = textOf(await mount(sample()));
  assert.match(text, /Task API/);
  for (const name of ['Tasks', 'List tasks', 'Create a task', 'Get a task', 'Update a task', 'Delete a task']) assert.match(text, new RegExp(name), name);
  assert.match(text, /https:\/\/api\.example\.com\/v1/);
});

test('request page shows params, headers, body, responses and example code', async () => {
  const w = await mount(sample());
  go(w, '#/Tasks/updateTask');
  const text = textOf(w);
  assert.match(text, /PUT/);
  assert.match(text, /\/tasks\/\{id\}/);
  assert.match(text, /Path variables/);
  assert.match(text, /Authorization.*Bearer/s);
  assert.match(text, /curl --request PUT/);
  assert.match(text, /404/);
  const tab = [...w.document.querySelectorAll('[aria-label="Language"] button')].find((b) => b.textContent === 'Python (requests)');
  tab.click();
  assert.match(textOf(w), /import requests/);
});

test('deep links work, including operations without an operationId', async () => {
  const spec = { openapi: '3.0.0', info: { title: 'X', version: '1' }, paths: { '/a-b': { get: { summary: 'No id', responses: { 200: { description: 'ok' } } } } } };
  const w = await mount(spec);
  go(w, `#/default/${encodeURIComponent('get_a_b')}`);
  assert.match(textOf(w), /GET.*\/a-b/s);
});

test('untrusted spec content cannot inject markup or scripts', async () => {
  const spec = { openapi: '3.0.0', info: { title: '<img src=x onerror=alert(1)>', version: '1', description: 'hi <img src=x onerror="window.pwned=1"> <script>window.pwned=1</script> [x](javascript:alert(1))' },
    paths: { '/p': { get: { summary: '<b>bold</b>', description: '<script>1</script>**ok**', responses: { 200: { description: '<i>d</i>' } } } } } };
  const w = await mount(spec);
  go(w, '#/default/get_p');
  const doc = w.document.getElementById('doc');
  assert.equal(w.pwned, undefined);
  assert.equal(doc.querySelectorAll('script, img, b, i').length, 0);
  assert.equal(doc.querySelectorAll('a[href^="javascript"]').length, 0);
  assert.match(doc.textContent, /<b>bold<\/b>/, 'summary is shown as text');
});

test('swagger 2.0 documents are supported', async () => {
  const spec = { swagger: '2.0', info: { title: 'Old', version: '1' }, host: 'old.example.com', basePath: '/v2', schemes: ['https'],
    paths: { '/items': { post: { tags: ['Items'], operationId: 'addItem', summary: 'Add', consumes: ['application/json'],
      parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Item' } }],
      responses: { 201: { description: 'created', schema: { $ref: '#/definitions/Item' } } } } } },
    definitions: { Item: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } } } } };
  const w = await mount(spec);
  go(w, '#/Items/addItem');
  const text = textOf(w);
  assert.match(text, /https:\/\/old\.example\.com\/v2/);
  assert.match(text, /"name": "string"/);
});

test('request body schema is listed as a field table with required markers', async () => {
  const w = await mount(sample());
  go(w, '#/Tasks/updateTask');
  const text = textOf(w);
  assert.match(text, /Schema \(\d+ fields?\)/);
  assert.match(text, /title/);
  assert.match(text, /required/);
});

test('overview shows one card per folder with a method mix', async () => {
  const w = await mount(sample());
  assert.match(textOf(w), /Folders \(\d+\)/);
  assert.match(textOf(w), /\d+ requests?/);
});

test('x-status on an operation is exposed as a status flag', () => {
  const DocModel = require('../public/doc-model.js');
  const spec = { openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {
    '/a': { get: { summary: 'A', 'x-status': 'wip', 'x-status-description': ' Body may change. ', responses: { 200: { description: 'ok' } } } },
    '/b': { get: { summary: 'B', responses: { 200: { description: 'ok' } } } } } };
  const ops = DocModel.createModel(spec).operations();
  assert.equal(ops.find((o) => o.path === '/a').status, 'wip');
  assert.equal(ops.find((o) => o.path === '/a').statusNote, 'Body may change.');
  assert.equal(ops.find((o) => o.path === '/b').status, '');
});
