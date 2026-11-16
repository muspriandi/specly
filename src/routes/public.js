const router = require('express').Router();
const config = require('../config');
const db = require('../db');
const auth = require('../services/auth');
const { audit } = require('../services/audit');
const access = require('../services/access');
const { queueMail, background } = require('../services/mail');
const { flash, badLink, baseUrl, cookieBase, notFound } = require('../lib/http');
const totp = require('../lib/totp');
const crypto = require('crypto');
const oidc = require('../services/oidc');
const log = require('../lib/log');
const { rateLimit, createLimiter } = require('../lib/security');
const { normEmail, isEmail, text, passwordError, firstError } = require('../lib/validate');

const LOGIN_TITLE = 'Sign in';
const renderLogin = (res, status, email, error) =>
  res.status(status).render('login', { title: LOGIN_TITLE, email, error, sso: config.oidc ? config.oidc.name : null });

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  renderLogin(res, 200, '');
});

router.post('/login', rateLimit({ max: config.loginRateMax, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  const key = `${email}|${req.ip}`;

  if (auth.loginFailures.isLimited(key)) {
    log.warn('security', { event: 'auth.login_blocked', req: req.id, email: log.maskEmail(email), ip: req.ip });
    return renderLogin(res, 429, email, 'Too many attempts. Try again in 15 minutes.');
  }

  const u = await db.one('SELECT * FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [email]);
  const ok = await auth.checkPassword(password, u && u.password_hash);
  if (!u || !u.active || !ok) {
    // Failed sign-ins are logged (to watch for brute force) but never stored in the database: anyone can send them,
    // so storing them would let an anonymous visitor fill it. The in-memory throttle is the defence. The reason is
    // for the log only; the visitor always sees the same message.
    auth.loginFailures.hit(key);
    log.warn('security', { event: 'auth.login_failed', req: req.id, email: log.maskEmail(email), ip: req.ip, reason: !u ? 'unknown_account' : !u.active ? 'account_disabled' : 'wrong_password' });
    if (auth.loginFailures.isLimited(key)) log.warn('security', { event: 'auth.login_locked', req: req.id, email: log.maskEmail(email), ip: req.ip, minutes: 15 });
    return renderLogin(res, 401, email, 'Invalid email or password.');
  }
  auth.loginFailures.reset(key);
  await auth.upgradeHash(u.id, password, u.password_hash).catch(() => {});
  if (u.totp_enabled_at) { // right password, but a second factor is needed: no session yet, only a 5-minute pending token
    const pending = await auth.issueToken({ type: 'login2fa', email: u.email.toLowerCase(), userId: u.id, ttlHours: 5 / 60 });
    res.cookie('mfa', pending, { ...cookieBase, maxAge: 5 * 60 * 1000 });
    return res.redirect('/login/2fa');
  }
  // Sign-ins are logged for everyone; only admin sign-ins are also kept in the audit table.
  await audit(req, 'auth.login', { actor: { id: u.id, email: u.email }, detail: `Signed in as ${u.role}`, store: u.role === 'admin' });
  await auth.startSession(res, u.id, req);
  res.redirect('/');
});

// ---- Second step of sign-in (authenticator code or a recovery code) ----
const mfaFailures = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
async function pendingLogin(req) {
  const t = req.cookies.mfa && await auth.findToken(req.cookies.mfa, 'login2fa');
  const u = t && await db.one('SELECT * FROM users WHERE id=$1 AND active AND deleted_at IS NULL AND totp_enabled_at IS NOT NULL', [t.user_id]);
  return u || null;
}
const renderMfa = (res, status, email, error) => res.status(status).render('login-2fa', { title: 'Two-factor sign-in', email, error });

router.get('/login/2fa', async (req, res) => {
  if (req.user) return res.redirect('/');
  const u = await pendingLogin(req);
  if (!u) return res.redirect('/login');
  renderMfa(res, 200, u.email);
});

router.post('/login/2fa', rateLimit({ max: config.loginRateMax, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const u = await pendingLogin(req);
  if (!u) return res.redirect('/login');
  const key = `mfa:${u.id}`;
  if (mfaFailures.isLimited(key)) {
    log.warn('security', { event: 'auth.2fa_blocked', req: req.id, email: log.maskEmail(u.email), ip: req.ip });
    res.clearCookie('mfa');
    return renderMfa(res, 429, u.email, 'Too many wrong codes. Sign in again in 15 minutes.');
  }
  const code = String(req.body.code || '');
  let ok = false, viaRecovery = false;
  const step = totp.verify(auth.totpSecretOf(u), code, u.totp_last_step);
  if (step) { // record the step atomically so the same code cannot be used twice, even in parallel
    ok = (await db.query('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [u.id, step])).length > 0;
  } else if ((u.recovery_codes || []).includes(totp.recoveryHash(code))) {
    ok = viaRecovery = (await db.query('UPDATE users SET recovery_codes=array_remove(recovery_codes,$2) WHERE id=$1 AND $2 = ANY(recovery_codes) RETURNING id', [u.id, totp.recoveryHash(code)])).length > 0;
  }
  if (!ok) {
    mfaFailures.hit(key);
    log.warn('security', { event: 'auth.2fa_failed', req: req.id, email: log.maskEmail(u.email), ip: req.ip, locked: mfaFailures.isLimited(key) || undefined });
    return renderMfa(res, 401, u.email, 'That code is not valid.');
  }
  mfaFailures.reset(key);
  if (!(await auth.consumeToken(req.cookies.mfa, 'login2fa'))) return res.redirect('/login');
  res.clearCookie('mfa');
  await audit(req, 'auth.login', { actor: { id: u.id, email: u.email }, detail: `Signed in as ${u.role} (two-factor${viaRecovery ? ', recovery code used' : ''})`, store: u.role === 'admin' || viaRecovery });
  await auth.startSession(res, u.id, req);
  res.redirect('/');
});

// ---- Single sign-on (OpenID Connect), only when configured ----
const ssoLimit = rateLimit({ max: config.loginRateMax, windowMs: 15 * 60 * 1000 });
const ssoDenied = (req, res, reason, message, email = null) => {
  log.warn('security', { event: 'auth.oidc_denied', req: req.id, reason, email: email ? log.maskEmail(email) : undefined, ip: req.ip });
  return renderLogin(res, 403, '', message);
};

router.get('/auth/oidc', ssoLimit, async (req, res) => {
  if (!config.oidc) return notFound(res);
  if (req.user) return res.redirect('/');
  try { res.redirect(await oidc.begin(req, res)); } catch (e) {
    log.error('single sign-on could not start', { event: 'auth.oidc_unavailable', req: req.id, err: e });
    renderLogin(res, 502, '', 'Single sign-on is unavailable right now. Use your password instead.');
  }
});

router.get('/auth/oidc/callback', ssoLimit, async (req, res) => {
  if (!config.oidc) return notFound(res);
  let claims;
  try { claims = await oidc.finish(req, res); } catch (e) {
    log.warn('security', { event: 'auth.oidc_failed', req: req.id, ip: req.ip, reason: String(e.message).slice(0, 200) });
    return renderLogin(res, 401, '', 'Single sign-on failed. Please try again.');
  }
  const email = normEmail(claims.email);
  if (!isEmail(email) || claims.email_verified !== true) return ssoDenied(req, res, 'email_not_verified', 'Your identity provider did not confirm your email address, so you cannot sign in this way.', email);
  if (!oidc.domainAllowed(email)) return ssoDenied(req, res, 'domain_not_allowed', 'Single sign-on is not available for that email domain.', email);
  let u = await db.one('SELECT * FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [email]);
  if (!u) {
    if (!config.oidc.autoCreate) return ssoDenied(req, res, 'no_account', 'There is no account for that email. Ask an admin to invite you.', email);
    const name = text(claims.name, 100) || email.split('@')[0];
    u = await db.one(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,'guest') RETURNING *`, [email, name, await auth.hashPassword(crypto.randomBytes(32).toString('base64url'))]); // no usable password: SSO only (until they reset it)
    await audit(req, 'user.created', { actor: { id: u.id, email }, type: 'user', id: u.id, detail: `Created a guest account for ${email} (${name}) on first single sign-on` });
  }
  if (!u.active) return ssoDenied(req, res, 'account_disabled', 'That account is disabled.', email);
  // The identity provider has authenticated them (and applies its own second factor), so the local authenticator step is skipped.
  await audit(req, 'auth.login', { actor: { id: u.id, email: u.email }, detail: `Signed in as ${u.role} (single sign-on)`, store: u.role === 'admin' });
  await auth.startSession(res, u.id, req);
  res.redirect('/');
});

router.post('/logout', async (req, res) => {
  if (req.cookies.sid) await auth.endSession(req.cookies.sid);
  res.clearCookie('sid');
  res.redirect('/login');
});

// ---- Forgot / reset password ----
router.get('/forgot', (req, res) => res.render('forgot', { title: 'Forgot password' }));

// At most 3 reset emails per address per hour, however many IPs the requests come from (also stops mail-bombing).
const resetAsks = createLimiter({ max: 3, windowMs: 60 * 60 * 1000 });

router.post('/forgot', rateLimit({ max: 5, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const email = normEmail(req.body.email);
  const throttled = resetAsks.isLimited(email);
  resetAsks.hit(email);
  // Asking for a reset is not audited either (anyone can trigger it); finishing one (auth.password_reset) is.
  const u = throttled ? null : await db.one('SELECT * FROM users WHERE lower(email)=$1 AND active AND deleted_at IS NULL', [email]);
  // Same response, sent at the same moment, whether or not the account exists: the token and the email are handled
  // after replying, so response time does not reveal which addresses are registered.
  res.render('forgot', { title: 'Forgot password', sent: true });
  if (u) background(async () => {
    const token = await auth.issueToken({ type: 'reset', email: u.email.toLowerCase(), userId: u.id, ttlHours: 1 });
    queueMail({
      to: u.email,
      subject: 'Reset your Specly password',
      text: `Hi ${u.name},\n\nUse this link to set a new password (valid for 1 hour):\n${baseUrl(req)}/reset/${token}\n\nIf you did not ask for this, ignore this email.`,
    });
  });
});

const resetToken = auth.requireToken('reset', 'Link expired', 'This reset link is invalid or has expired.');
router.get('/reset/:token', resetToken, (req, res) => res.render('reset', { title: 'Set new password' }));

router.post('/reset/:token', resetToken, async (req, res) => {
  const err = passwordError(req.body.password, req.body.confirm);
  if (err) return res.status(400).render('reset', { title: 'Set new password', error: err });
  const t = await db.tx(async (q) => {
    const used = await auth.consumeToken(req.params.token, 'reset', q); // atomic: a link works once
    if (!used) return null;
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await auth.hashPassword(req.body.password), used.user_id]);
    await auth.endAllSessions(used.user_id, q); // sign out everywhere
    return used;
  });
  if (!t) return badLink(res, 'Link expired', 'This reset link is invalid or has expired.');
  await audit(req, 'auth.password_reset', { actor: { id: t.user_id, email: t.email }, type: 'user', id: t.user_id, detail: 'Set a new password via reset link; all other sessions ended' });
  flash(res, 'Password updated. Please sign in.');
  res.redirect('/login');
});

// ---- Accept a guest invitation ----
const inviteToken = auth.requireToken('invite', 'Invitation expired', 'This invitation is invalid or has expired. Ask an admin to send a new one.');
router.get('/invite/:token', inviteToken, (req, res) =>
  res.render('accept-invite', { title: 'Accept invitation', email: req.token.email, role: req.token.role || 'guest' }));

router.post('/invite/:token', inviteToken, async (req, res) => {
  const name = text(req.body.name, 100);
  const email = req.token.email.toLowerCase();
  const err = firstError(!name && 'Name is required.', passwordError(req.body.password, req.body.confirm));
  const role = req.token.role || 'guest';
  if (err) return res.status(400).render('accept-invite', { title: 'Accept invitation', email, role, error: err, name });

  let user;
  try {
    user = await db.tx(async (q) => {
      if (!(await auth.consumeToken(req.params.token, 'invite', q))) return null;
      return (await q(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, name, await auth.hashPassword(req.body.password), role]))[0];
    });
  } catch (e) {
    if (db.isUniqueViolation(e)) return badLink(res, 'Already registered', 'An account with this email already exists.');
    throw e;
  }
  if (!user) return badLink(res, 'Invitation expired', 'This invitation is invalid or has expired.');
  const assigned = req.token.blueprint_ids && req.token.blueprint_ids.length
    ? await access.grant([user.id], req.token.blueprint_ids, req.token.invited_by) : [];
  await audit(req, 'invite.accepted', { actor: { id: user.id, email }, type: 'user', id: user.id,
    detail: `Accepted the invitation and created a ${role} account (${name})${assigned.length ? `; assigned ${assigned.map((a) => `"${a.title}"`).join(', ')}` : ''}` });
  await auth.startSession(res, user.id, req);
  flash(res, role === 'member' ? 'Welcome! Request access to the blueprints you need.' : assigned.length ? 'Welcome! Your blueprints are ready.' : 'Welcome! An admin will assign blueprints to you.');
  res.redirect('/');
});

module.exports = router;
