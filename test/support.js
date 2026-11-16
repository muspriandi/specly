// Shared harness for the end-to-end suites in test/suites/: a throwaway PostgreSQL database (created and dropped
// automatically), the app on a random port, a tiny cookie-keeping HTTP client and a few helpers.
// Requires a reachable server at DATABASE_URL's host (default postgres:postgres@localhost:5432).
const { before, after } = require('node:test');

const base = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/specly';
const dbName = `specly_test_${process.pid}`;
process.env.DATABASE_URL = base.replace(/\/[^/]*$/, `/${dbName}`);
process.env.ADMIN_PASSWORD = 'Admin1234';
process.env.NODE_ENV = 'test';
process.env.BCRYPT_COST = '4'; // fast hashing: the suites sign in hundreds of times
process.env.APP_SECRET = 'test-app-secret-0123456789abcdef0123456789';
process.env.LOGIN_RATE_MAX = '10000'; // every test signs in from the same address

const db = require('../src/db');
const { flushMail } = require('../src/services/mail');
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
const upload = (client, url, content, note, fields = {}) => {
  const fd = new FormData();
  fd.set('file', new Blob([content]), 'spec.yaml');
  if (note) fd.set('note', note);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
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
  await dropDatabase(admin, dbName);
  await admin.end();
});

const admin = new Client(), guest = new Client();


// Drops a database once the server has really closed every connection to it. pool.end() returns before the backends are gone,
// and DROP DATABASE ... WITH (FORCE) would then kill a connection the client already closed: that late "terminating
// connection" error lands on a client with no listener and fails whichever test is running (seen on PostgreSQL 16 in CI).
async function dropDatabase(admin, name) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [name]);
    if (!rows.length) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

// Absolute URL of the app under test (the port is chosen when the harness starts).
const url = (p) => origin + p;

module.exports = { db, Client, spec, upload, lastMailLink, mails, flushMail, admin, guest, url, dropDatabase };
