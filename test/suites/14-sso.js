const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { db, Client } = require('../support');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT_ID = 'specly-test', CLIENT_SECRET = 'a-client-secret-for-tests';

// ---- a small OpenID Connect provider: discovery, keys, authorize, token. `tamper` makes it misbehave on purpose.
async function startIdp() {
  const jose = await import('jose');
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const other = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const idp = { claims: {}, tamper: null, authorizeParams: null, issuer: '' };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, idp.issuer);
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'email', 'profile'] });
    }
    if (u.pathname === '/jwks') return json({ keys: [jwk] });
    if (u.pathname === '/authorize') {
      idp.authorizeParams = Object.fromEntries(u.searchParams);
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge') });
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
      res.statusCode = 302; res.setHeader('location', back.href); return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
      const secretOk = basic ? Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent)[1] === CLIENT_SECRET : form.get('client_secret') === CLIENT_SECRET;
      const verifierOk = entry && crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') === entry.challenge;
      if (!entry || !secretOk || !verifierOk) { res.statusCode = 400; return json({ error: 'invalid_grant' }); }
      const jwt = new jose.SignJWT({ nonce: idp.tamper === 'nonce' ? 'not-the-nonce' : entry.nonce, ...idp.claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(idp.issuer).setAudience(idp.tamper === 'aud' ? 'someone-else' : CLIENT_ID)
        .setSubject(idp.claims.sub || 'sub-1').setIssuedAt().setExpirationTime(idp.tamper === 'exp' ? Math.floor(Date.now() / 1000) - 600 : '5m');
      const idToken = await jwt.sign(idp.tamper === 'sig' ? other.privateKey : privateKey);
      return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, r));
  idp.issuer = `http://localhost:${server.address().port}`;
  idp.close = () => new Promise((r) => server.close(r));
  return idp;
}

// ---- the real app, as a child process with SSO switched on
async function startApp(idp, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'sso-app.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LOG_LEVEL: 'silent', OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET, OIDC_NAME: 'Acme SSO', OIDC_ALLOW_INSECURE: 'true', BASE_URL: '', ...extraEnv },
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const m = /PORT (\d+)/.exec(buf); if (m) resolve(Number(m[1])); });
    child.on('exit', (c) => reject(new Error(`the app exited with ${c} before it started`)));
  });
  const origin = `http://localhost:${port}`;
  const jar = new Map();
  const send = async (target, init = {}) => {
    const r = await fetch(target.startsWith('http') ? target : origin + target, { redirect: 'manual', ...init, headers: { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';'); const [k, ...v] = kv.split('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(attrs.join(';'))) jar.delete(k); else jar.set(k, v.join('='));
    }
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  return { origin, jar, get: send, stop: () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); }) };
}

// A complete browser journey: start at the app, go to the provider, come back with the code.
async function signIn(app, idp, claims, tamper = null, tweak = (url) => url) {
  idp.claims = claims; idp.tamper = tamper;
  const start = await app.get('/auth/oidc');
  assert.equal(start.status, 302, 'redirected to the provider');
  assert.ok(start.location.startsWith(idp.issuer + '/authorize'));
  const toIdp = await fetch(start.location, { redirect: 'manual' });
  const back = new URL(toIdp.headers.get('location'));
  return app.get(tweak(back.pathname + back.search));
}

test('single sign-on is off unless configured', async () => {
  const c = new Client();
  assert.equal((await c.get('/auth/oidc')).status, 404);
  assert.equal((await c.get('/auth/oidc/callback?code=x&state=y')).status, 404);
  assert.doesNotMatch((await c.get('/login')).text, /Sign in with/);
  const run = (env) => spawnSync(process.execPath, ['-e', "require('./src/config'); console.log('OK')"], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(run({ OIDC_ISSUER: 'http://idp.example.com', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b' }).stderr, /OIDC_ISSUER must be an https/);
  assert.match(run({ OIDC_ISSUER: 'https://idp.example.com', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', OIDC_AUTO_CREATE: 'true' }).stderr, /OIDC_AUTO_CREATE=true needs OIDC_ALLOWED_DOMAINS/);
  assert.match(run({ OIDC_ISSUER: 'https://idp.example.com', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b' }).stdout, /OK/);
  assert.match(run({ NODE_ENV: 'production', OIDC_ISSUER: 'http://localhost:1', OIDC_ALLOW_INSECURE: 'true', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', BASE_URL: 'https://x.example.com', DATABASE_URL: 'postgresql://a@b/c', SMTP_HOST: 's', ADMIN_PASSWORD: '' }).stderr, /OIDC_ISSUER must be an https/, 'production never allows an insecure issuer, whatever the flag says');
});

test('single sign-on: an existing account signs in, with every check the protocol requires', async () => {
  const idp = await startIdp();
  const app = await startApp(idp);
  try {
    assert.match((await app.get('/login')).text, /Sign in with Acme SSO/);
    const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
    await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('sso-member@example.com','Sso Member',$1,'member')`, [hash]);

    // the redirect to the provider carries PKCE, state and nonce
    const ok = await signIn(app, idp, { sub: 'u1', email: 'Sso-Member@Example.com', email_verified: true, name: 'Sso Member' });
    const p = idp.authorizeParams;
    assert.equal(p.response_type, 'code'); assert.equal(p.client_id, CLIENT_ID); assert.equal(p.code_challenge_method, 'S256');
    assert.ok(p.state.length >= 20 && p.nonce.length >= 20 && p.code_challenge.length >= 40);
    assert.match(p.scope, /openid/); assert.match(p.scope, /email/);
    assert.equal(p.redirect_uri, `${app.origin}/auth/oidc/callback`);
    assert.equal(ok.status, 302); assert.equal(ok.location, '/');
    assert.match((await app.get('/')).text, /Sso Member/, 'signed in as that account (email matching ignores case)');
    assert.ok(![...app.jar.keys()].includes('oidc'), 'the one-time sign-in cookie is gone');
    assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action='auth.login' AND actor_label='sso-member@example.com'`)).n, 0, 'a member sign-in is logged, not stored');

    // the attacks
    const fresh = async () => { for (const k of [...app.jar.keys()]) app.jar.delete(k); };
    await fresh();
    assert.equal((await signIn(app, idp, { sub: 'u1', email: 'sso-member@example.com', email_verified: false })).status, 403, 'an unverified email is refused');
    await fresh();
    assert.equal((await signIn(app, idp, { sub: 'u1', email: 'sso-member@example.com' })).status, 403, 'so is a missing email_verified');
    await fresh();
    assert.equal((await signIn(app, idp, { sub: 'u1', email: 'sso-member@example.com', email_verified: 'true' })).status, 403, 'a string "true" is not true');
    for (const tamper of ['nonce', 'aud', 'exp', 'sig']) {
      await fresh();
      const r = await signIn(app, idp, { sub: 'u1', email: 'sso-member@example.com', email_verified: true }, tamper);
      assert.equal(r.status, 401, `a token with a bad ${tamper} is refused`);
      assert.doesNotMatch((await app.get('/account/password')).location || '', /^\/account/);
      assert.equal((await app.get('/')).status, 302, `still signed out after the ${tamper} attack`);
    }
    await fresh();
    assert.equal((await signIn(app, idp, { sub: 'u1', email: 'sso-member@example.com', email_verified: true }, null, (u) => u.replace(/state=[^&]+/, 'state=forged'))).status, 401, 'a forged state is refused');
    await fresh();
    idp.claims = { sub: 'u1', email: 'sso-member@example.com', email_verified: true };
    const start = await app.get('/auth/oidc');
    const back = new URL((await fetch(start.location, { redirect: 'manual' })).headers.get('location'));
    const cookie = app.jar.get('oidc');
    await fresh();
    assert.equal((await app.get(back.pathname + back.search)).status, 401, 'a callback without the cookie of the browser that started it (login CSRF) is refused');
    app.jar.set('oidc', cookie);
    assert.equal((await app.get(back.pathname + back.search)).status, 302, 'with the right cookie it works');
    assert.equal((await app.get(back.pathname + back.search)).status, 401, 'and a code cannot be replayed');
    await fresh();
    // unknown account, disabled account
    assert.equal((await signIn(app, idp, { sub: 'u9', email: 'nobody-at-all@example.com', email_verified: true })).status, 403, 'no account and no auto-create');
    assert.equal(await db.one(`SELECT 1 FROM users WHERE email='nobody-at-all@example.com'`), null, 'nothing was created');
    await fresh();
    await db.query(`UPDATE users SET active=false WHERE email='sso-member@example.com'`);
    assert.equal((await signIn(app, idp, { sub: 'u1', email: 'sso-member@example.com', email_verified: true })).status, 403, 'a disabled account stays out');
    await db.query(`UPDATE users SET active=true WHERE email='sso-member@example.com'`);
  } finally { await app.stop(); await idp.close(); }
});

test('single sign-on: allowed domains, and accounts created on first sign-in', async () => {
  const idp = await startIdp();
  const app = await startApp(idp, { OIDC_ALLOWED_DOMAINS: 'example.org, Corp.Example.org', OIDC_AUTO_CREATE: 'true' });
  try {
    const reset = () => { for (const k of [...app.jar.keys()]) app.jar.delete(k); };
    // a new person from an allowed domain becomes a guest (no access yet)
    const r = await signIn(app, idp, { sub: 'n1', email: 'new.person@example.org', email_verified: true, name: 'New Person' });
    assert.equal(r.status, 302);
    const u = await db.one(`SELECT id, role, name, active FROM users WHERE email='new.person@example.org'`);
    assert.equal(u.role, 'guest'); assert.equal(u.name, 'New Person'); assert.equal(u.active, true);
    assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='user.created' AND detail LIKE '%new.person@example.org%single sign-on%'`), 'the creation is audited');
    assert.match((await app.get('/')).text, /No blueprints have been assigned to you yet/, 'a guest sees nothing until an admin assigns something');
    // the account has no usable password
    assert.equal((await new Client().login('new.person@example.org', 'anything-at-all')).status, 401);
    reset();
    assert.equal((await signIn(app, idp, { sub: 'n2', email: 'person@sub.example.org', email_verified: true })).status, 403, 'only the listed domains, exactly (subdomains are not included)');
    reset();
    assert.equal((await signIn(app, idp, { sub: 'n5', email: 'colleague@corp.example.org', email_verified: true })).status, 302, 'a listed subdomain is fine (and the list is case-insensitive)');
    reset();
    assert.equal((await signIn(app, idp, { sub: 'n3', email: 'someone@gmail.com', email_verified: true })).status, 403, 'another domain is refused');
    assert.equal(await db.one(`SELECT 1 FROM users WHERE email='someone@gmail.com'`), null);
    reset();
    // an existing account on a domain that is not allowed cannot sign in this way either
    const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
    await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('outsider@gmail.com','Out',$1,'member')`, [hash]);
    assert.equal((await signIn(app, idp, { sub: 'n4', email: 'outsider@gmail.com', email_verified: true })).status, 403);
    reset();
    // and the allowed domain still works for an existing account
    const again = await signIn(app, idp, { sub: 'n1', email: 'new.person@example.org', email_verified: true });
    assert.equal(again.status, 302);
    assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM users WHERE email='new.person@example.org'`)).n, 1, 'one account, not two');
  } finally { await app.stop(); await idp.close(); }
});
