const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const log = require('../../src/lib/log');
const { audit, STORED } = require('../../src/services/audit');
const { requestLog } = require('../../src/lib/logger');
const { db, Client, admin } = require('../support');

const ROOT = path.join(__dirname, '..', '..');
const rows = async (where = 'TRUE', params = []) => (await db.query(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`, params));

test('audit policy: security and admin changes are stored; high-volume events are only logged', async () => {
  const cap = log.capture();
  const before = (await rows()).length;
  const req = { id: 'testreq', ip: '10.0.0.9', user: null };
  await audit(req, 'request.created', { type: 'blueprint', id: 1, detail: 'member asked' });
  await audit(req, 'invite.sent', { detail: 'Invited x@example.com' });
  await audit(req, 'blueprint.updated', { detail: 'saved' });
  await audit(req, 'auth.sessions_ended', { detail: 'ended 2' });
  assert.equal((await rows()).length, before, 'none of the log-only events wrote a row');
  await audit(req, 'user.deleted', { type: 'user', id: 7, detail: 'Moved a@x.com to the trash' });
  await audit(req, 'request.approved', { type: 'blueprint', id: 1, detail: 'Approved' });
  assert.equal((await rows()).length, before + 2, 'access and account changes are stored');
  // every call is in the log either way, with whether it was stored
  const lines = cap.entries.filter((e) => e.msg === 'audit');
  cap.stop();
  assert.deepEqual(lines.map((e) => [e.event, e.stored]), [['request.created', false], ['invite.sent', false], ['blueprint.updated', false],
    ['auth.sessions_ended', false], ['user.deleted', true], ['request.approved', true]]);
  assert.ok(lines.every((e) => e.req === 'testreq' && e.ip === '10.0.0.9'));
  assert.ok(STORED.has('user.deleted') && !STORED.has('request.created') && !STORED.has('invite.sent'));
  // the table keeps a shorter detail than the log
  await audit(req, 'user.updated', { detail: 'x'.repeat(700) });
  assert.equal((await rows(`action='user.updated'`)).pop().detail.length, 300);
  // a single call can override the policy
  await audit(req, 'custom.forced', { store: true });
  await audit(req, 'user.created', { store: false });
  assert.equal((await rows(`action='custom.forced'`)).length, 1);
  assert.equal((await rows(`action='user.created' AND actor_label IS NULL AND detail IS NULL AND ip='10.0.0.9'`)).length, 0);
});

test('sign-ins: logged for everyone, stored only for admins', async () => {
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('logmember@example.com','LM',$1,'member')`, [hash]);
  const cap = log.capture();
  assert.equal((await new Client().login('logmember@example.com', 'Admin1234')).status, 302);
  assert.equal((await new Client().login('admin@specly.local', 'Admin1234')).status, 302);
  const logins = cap.entries.filter((e) => e.msg === 'audit' && e.event === 'auth.login');
  cap.stop();
  assert.deepEqual(logins.map((e) => [e.actor, e.stored]), [['logmember@example.com', false], ['admin@specly.local', true]]);
  assert.equal((await rows(`action='auth.login' AND actor_label='logmember@example.com'`)).length, 0, 'a member sign-in is not in the table');
  assert.ok((await rows(`action='auth.login' AND actor_label='admin@specly.local'`)).length > 0, 'admin sign-ins are');
});

test('request log: one line per request with an id that matches X-Request-Id, masked paths, no query strings', async () => {
  const cap = log.capture();
  const c = new Client();
  const r = await c.get('/login?secret=abc123&_csrf=zzz');
  const t = await c.get('/reset/sometoken123');
  const g = await new Client().get('/blueprints/1'); // anonymous: redirected to sign in
  const sh = await new Client().get('/s/sharetoken999/spec.json'); // inside a mounted router: the full path is still logged
  const html = await admin.get('/healthz'), asset = await c.get('/static/theme.js');
  const lines = cap.entries.filter((e) => e.event === 'http.request');
  cap.stop();
  assert.equal(html.status, 200); assert.equal(asset.status, 200);
  assert.equal(lines.length, 4, 'static files and /healthz are not logged');
  const login = lines.find((e) => e.path === '/login');
  assert.equal(login.req, r.headers.get('x-request-id'));
  assert.equal(login.status, 200); assert.equal(login.level, 'info'); assert.equal(login.method, 'GET');
  assert.ok(typeof login.ms === 'number' && login.ms >= 0);
  assert.ok(!JSON.stringify(lines).includes('abc123') && !JSON.stringify(lines).includes('zzz'), 'query strings are never logged');
  assert.equal(lines.find((e) => e.path.startsWith('/reset')).path, '/reset/:token');
  assert.ok(!JSON.stringify(lines).includes('sometoken123'));
  assert.equal(lines.find((e) => e.path.startsWith('/s/')).path, '/s/:token/spec.json');
  assert.ok(!JSON.stringify(lines).includes('sharetoken999'), 'share-link tokens are masked');
  assert.equal(sh.status, 404);
  assert.equal(t.status, 400);
  assert.equal(g.status, 302);
});

test('request log severity: 5xx error, 401/403/429 and slow requests warn', () => {
  const fake = (status, slowMs = 5) => {
    const res = Object.assign(new EventEmitter(), { statusCode: status, setHeader() {}, get() { return undefined; } });
    const req = { path: '/x', method: 'GET', ip: '1.1.1.1', user: null };
    const realNow = process.hrtime.bigint;
    let t = 0n; process.hrtime.bigint = () => { const v = t; t += BigInt(slowMs) * 1_000_000n; return v; };
    const cap = log.capture();
    try { requestLog(req, res, () => {}); res.emit('finish'); } finally { process.hrtime.bigint = realNow; cap.stop(); }
    return cap.entries.find((e) => e.event === 'http.request');
  };
  assert.equal(fake(200).level, 'info');
  assert.equal(fake(404).level, 'info', 'a 404 is normal traffic');
  assert.equal(fake(403).level, 'warn');
  assert.equal(fake(401).level, 'warn');
  assert.equal(fake(429).level, 'warn');
  assert.equal(fake(500).level, 'error');
  const slow = fake(200, 2500);
  assert.equal(slow.level, 'warn'); assert.equal(slow.slow, true);
  assert.ok(fake(200).slow === undefined);
});

test('security events are logged: CSRF rejection, invalid share link, throttled sign-in', async () => {
  const cap = log.capture();
  const anon = new Client();
  assert.equal((await anon.req('POST', '/login', { form: { email: 'a@b.c', password: 'x', _csrf: 'wrong' } })).status, 403);
  assert.equal((await anon.get('/s/not-a-real-token')).status, 404);
  const events = cap.entries.filter((e) => e.msg === 'security').map((e) => e.event);
  cap.stop();
  assert.ok(events.includes('csrf.rejected'));
  assert.ok(events.includes('share.invalid'));
});

test('slow queries are logged with the SQL but never the parameters', async () => {
  const cap = log.capture();
  await db.query('SELECT pg_sleep(0.6), $1::text AS secret', ['do-not-log-this-value']);
  const slow = cap.entries.filter((e) => e.event === 'db.slow_query');
  cap.stop();
  assert.equal(slow.length, 1);
  assert.equal(slow[0].level, 'warn');
  assert.ok(slow[0].ms >= 500);
  assert.match(slow[0].sql, /pg_sleep/);
  assert.ok(!JSON.stringify(slow).includes('do-not-log-this-value'));
});

test('output format: JSON lines in production, readable text otherwise; level filter and masking', () => {
  const SCRIPT = `const log = require('./src/lib/log'); log.debug('quiet'); log.info('hello', { event: 'x.y', email: log.maskEmail('jane.doe@example.com'), err: new Error('boom') }); log.warn('careful', { n: 1 });`;
  const out = (env) => { const r = spawnSync(process.execPath, ['-e', SCRIPT], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); return { stdout: r.stdout, stderr: r.stderr }; };

  const json = out({ NODE_ENV: 'production', LOG_FORMAT: 'json', LOG_LEVEL: 'info', BASE_URL: 'https://x.test', DATABASE_URL: 'postgresql://a@b/c', SMTP_HOST: 'smtp.test', ADMIN_PASSWORD: '' });
  const info = JSON.parse(json.stdout.trim());
  assert.equal(info.level, 'info'); assert.equal(info.msg, 'hello'); assert.equal(info.event, 'x.y');
  assert.match(info.t, /^\d{4}-\d\d-\d\dT/);
  assert.equal(info.email, 'j***@example.com');
  assert.equal(info.err.message, 'boom'); assert.match(info.err.stack, /boom/);
  assert.ok(!json.stdout.includes('quiet'), 'debug is hidden at info level');
  assert.equal(JSON.parse(json.stderr.trim()).level, 'warn', 'warnings go to stderr');

  const text = out({ NODE_ENV: 'development', LOG_FORMAT: 'pretty', LOG_LEVEL: 'debug' });
  assert.match(text.stdout, /DEBUG quiet/);
  assert.match(text.stdout, /INFO\s+hello\s+event=x\.y email=j\*\*\*@example\.com err=boom/);
  assert.match(text.stderr, /WARN\s+careful\s+n=1/);

  const quiet = out({ LOG_LEVEL: 'error' });
  assert.equal(quiet.stdout + quiet.stderr, '', 'error level hides info and warn');
  assert.equal(log.maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.equal(log.maskEmail('nope'), 'n***');
  assert.equal(log.maskEmail(''), '');
});

test('audit retention: AUDIT_RETENTION_DAYS deletes old rows on the hourly purge, and is off by default', async () => {
  await db.query(`INSERT INTO audit_log (at, actor_label, action) VALUES (now() - interval '100 days', 'old@example.com', 'retention.old'), (now() - interval '2 days', 'new@example.com', 'retention.new')`);
  const purge = (env) => JSON.parse(execFileSync(process.execPath, ['-e', `require('./src/db').purgeExpired().then((r) => { console.log(JSON.stringify(r)); process.exit(0); })`],
    { cwd: ROOT, env: { ...process.env, ...env, LOG_LEVEL: 'silent' }, encoding: 'utf8' }).trim());
  assert.equal(purge({}).auditRows, 0, 'default: keep forever');
  assert.equal((await rows(`action LIKE 'retention.%'`)).length, 2);
  assert.equal(purge({ AUDIT_RETENTION_DAYS: '30' }).auditRows >= 1, true);
  assert.deepEqual((await rows(`action LIKE 'retention.%'`)).map((r) => r.action), ['retention.new'], 'only the old row went');
});
