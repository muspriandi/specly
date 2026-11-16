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

// ---- OpenAPI keywords beyond the basics ----
const rich = () => ({
  openapi: '3.0.3',
  info: { title: 'Rich', version: '1', contact: { name: 'API Team', email: 'api@example.com' }, license: { name: 'MIT', url: 'https://example.com/mit' }, termsOfService: 'javascript:alert(1)' },
  externalDocs: { url: 'https://example.com/docs', description: 'Handbook' },
  tags: [{ name: 'Pets', externalDocs: { url: 'https://example.com/pets' } }],
  paths: {
    '/pets': {
      post: {
        tags: ['Pets'], summary: 'Add pet', deprecated: true, externalDocs: { url: 'javascript:alert(1)' },
        parameters: [
          { name: 'old', in: 'query', deprecated: true, schema: { type: 'string', minLength: 2, maxLength: 9, pattern: '^[a-z]+$' } },
          { name: 'sid', in: 'cookie', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: {
          id: { type: 'integer', readOnly: true }, name: { type: 'string', minLength: 3 }, secret: { type: 'string', writeOnly: true },
          nick: { type: 'string', nullable: true }, age: { type: 'integer', minimum: 0, exclusiveMinimum: false, maximum: 120 },
        } } } } },
        responses: { 200: { description: 'ok', headers: { 'X-Rate-Limit': { description: 'Calls left', schema: { type: 'integer' } } },
          content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }], discriminator: { propertyName: 'kind' } },
            examples: { a: { summary: 'First', value: { kind: 'cat' } }, b: { value: { kind: 'dog' } } } } } } },
      },
    },
    '/upload': { post: { summary: 'Upload', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: {
      file: { type: 'string', format: 'binary' }, label: { type: 'string', example: 'cover' } } } } } }, responses: { 200: { description: 'ok' } } } },
    '/login': { post: { summary: 'Login', requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { user: { type: 'string', example: 'ann' } } } } } }, responses: { 200: { description: 'ok' } } } },
  },
  components: { schemas: {
    Cat: { type: 'object', properties: { kind: { type: 'string' }, lives: { type: 'integer' } } },
    Dog: { type: 'object', properties: { kind: { type: 'string' }, bark: { type: 'boolean' } } },
  } },
});

test('model reads deprecated, nullable, read/write-only, constraints, headers, cookies, variants and form bodies', () => {
  const DocModel = require('../public/doc-model.js');
  const m = DocModel.createModel(rich());
  const ops = m.operations();
  const add = ops.find((o) => o.path === '/pets');
  assert.equal(add.deprecated, true);
  assert.equal(add.queryParams[0].deprecated, true);
  assert.deepEqual(add.queryParams[0].constraints, ['min length 2', 'max length 9', 'pattern ^[a-z]+$']);
  assert.equal(add.cookieParams.length, 1);
  assert.ok(add.headers.some((h) => h.key === 'Cookie'));
  const f = Object.fromEntries(add.body.fields.map((x) => [x.name, x]));
  assert.equal(f.id.readOnly, true); assert.equal(f.secret.writeOnly, true); assert.equal(f.nick.nullable, true);
  assert.deepEqual(f.name.constraints, ['min length 3']); assert.deepEqual(f.age.constraints, ['≥ 0', '≤ 120']);
  assert.ok(!('id' in JSON.parse(add.body.text)), 'readOnly property is left out of the request example');
  assert.ok('secret' in JSON.parse(add.body.text));
  const resp = add.responses[0];
  assert.equal(resp.headers[0].name, 'X-Rate-Limit');
  assert.equal(resp.variants.options.length, 2); assert.equal(resp.variants.discriminator, 'kind');
  assert.deepEqual(resp.variants.options.map((o) => o.name), ['Cat', 'Dog']);
  assert.equal(resp.examples.length, 2);
  assert.equal(add.externalDocs.url, 'https://example.com/pets', 'an unsafe operation link is ignored; the folder link is used');
  const up = ops.find((o) => o.path === '/upload');
  assert.equal(up.body.formKind, 'multipart'); assert.equal(up.body.form[0].isFile, true);
  const req = m.buildRequest(up, 'https://x.test');
  assert.equal(req.body, null); assert.ok(!req.headers.some(([k]) => k === 'Content-Type'));
  assert.match(DocModel.generators.cURL(req), /--form 'file=@\/path\/to\/file'/);
  assert.match(DocModel.generators.cURL(req), /--form 'label=cover'/);
  assert.match(DocModel.generators['JavaScript (fetch)'](req), /new FormData\(\)/);
  assert.match(DocModel.generators['Python (requests)'](req), /files=\{"file": open/);
  const login = m.buildRequest(ops.find((o) => o.path === '/login'), 'https://x.test');
  assert.match(DocModel.generators.cURL(login), /--data-urlencode 'user=ann'/);
  const about = m.about();
  assert.equal(about.terms, '', 'javascript: links are dropped'); assert.equal(about.docs.url, 'https://example.com/docs');
  assert.equal(about.license.url, 'https://example.com/mit');
});

test('swagger 2.0 formData parameters become a form body', () => {
  const DocModel = require('../public/doc-model.js');
  const m = DocModel.createModel({ swagger: '2.0', info: { title: 'T', version: '1' }, paths: { '/up': { post: { consumes: ['multipart/form-data'],
    parameters: [{ name: 'doc', in: 'formData', type: 'file', required: true }, { name: 'note', in: 'formData', type: 'string' }], responses: { 200: { description: 'ok' } } } } } });
  const body = m.operations()[0].body;
  assert.equal(body.formKind, 'multipart'); assert.deepEqual(body.form.map((r) => [r.name, r.isFile]), [['doc', true], ['note', false]]);
});

test('viewer shows deprecated, flags, constraints, response headers, variants, form fields and the about block', async () => {
  const w = await mount(rich());
  assert.match(textOf(w), /API Team/); assert.match(textOf(w), /Handbook/); assert.match(textOf(w), /MIT/);
  assert.ok(!/javascript:/.test(w.document.getElementById('doc').innerHTML), 'unsafe links are never rendered');
  assert.match(textOf(w), /deprecated/i);
  go(w, '#/Pets/post_pets');
  const t = textOf(w);
  assert.match(t, /This endpoint is deprecated/); assert.match(t, /Cookie params/); assert.match(t, /read-only/); assert.match(t, /write-only/); assert.match(t, /nullable/);
  assert.match(t, /min length 3/); assert.match(t, /pattern \^\[a-z\]\+\$/); assert.match(t, /Response headers/); assert.match(t, /X-Rate-Limit/);
  assert.match(t, /One of 2 shapes/); assert.match(t, /chosen by “kind”/); assert.match(t, /All examples \(2\)/);
  go(w, '#/default/post_upload');
  assert.match(textOf(w), /file upload/);
});

test('sidebar folders start folded, open for the current request, and expand/collapse all', async () => {
  const w = await mount(sample());
  const det = () => [...w.document.querySelectorAll('nav[aria-label="Requests"] details')];
  assert.ok(det().length > 0);
  assert.ok(det().every((d) => !d.open), 'all folded by default');
  assert.match(w.document.querySelector('nav[aria-label="Requests"]').textContent, /all folded/);
  go(w, '#/Tasks/updateTask');
  assert.ok(det().find((d) => /Tasks/.test(d.textContent)).open, 'folder of the current request opens');
  const btn = [...w.document.querySelectorAll('nav[aria-label="Requests"] button')].find((b) => /Collapse all|Expand all/.test(b.textContent));
  btn.click();
  assert.ok(det().every((d) => d.open) || det().every((d) => !d.open));
});

test('draft preview can jump to an endpoint by method and path, and open folders are remembered', async () => {
  const w = await mount(sample());
  go(w, '#/?op=' + encodeURIComponent('PUT /tasks/{id}'));
  assert.match(textOf(w), /Update a task/);
  const folderBtn = () => w.document.querySelector('nav[aria-label="Requests"] details summary');
  folderBtn().click();
  await new Promise((r) => setTimeout(r, 20)); // <details> fires "toggle" asynchronously
  assert.match(w.localStorage.getItem(`doc.open.${w.location.pathname}`) || '', /Tasks/, 'saved per blueprint');
});

test('deprecated and WIP badges look the same in the sidebar, overview and endpoint title', async () => {
  const spec = { openapi: '3.0.0', info: { title: 'B', version: '1' }, paths: { '/x': { get: { summary: 'Old', deprecated: true, 'x-status': 'beta', responses: { 200: { description: 'ok' } } } } } };
  const w = await mount(spec);
  const count = (sel) => [...w.document.querySelectorAll(sel)].length;
  assert.ok(count('nav[aria-label="Requests"] .flag-dep') === 1 && count('nav[aria-label="Requests"] .flag-wip') === 1, 'sidebar');
  assert.ok(count('section .flag-dep') >= 1 && count('section .flag-wip') >= 1, 'overview list');
  go(w, '#/default/get_x');
  assert.ok(count('h1 .flag-dep') === 1 && count('h1 .flag-wip') === 1, 'endpoint title');
  assert.equal(w.document.querySelector('h1 .flag-wip').textContent, 'beta');
});
