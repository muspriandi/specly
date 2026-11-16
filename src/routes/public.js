const router = require('express').Router();
const db = require('../db');
const auth = require('../services/auth');
const { audit } = require('../services/audit');
const { trySendMail } = require('../services/mail');
const { flash, badLink, baseUrl } = require('../lib/http');
const { rateLimit } = require('../lib/security');
const { normEmail, text, passwordError, firstError } = require('../lib/validate');

const LOGIN_TITLE = 'Sign in';
const renderLogin = (res, status, email, error) =>
  res.status(status).render('login', { title: LOGIN_TITLE, email, error });

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  renderLogin(res, 200, '');
});

router.post('/login', rateLimit({ max: 30, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  const key = `${email}|${req.ip}`;

  if (auth.loginFailures.isLimited(key)) return renderLogin(res, 429, email, 'Too many attempts. Try again in 15 minutes.');

  const u = await db.one('SELECT * FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [email]);
  const ok = await auth.checkPassword(password, u && u.password_hash);
  if (!u || !u.active || !ok) {
    auth.loginFailures.hit(key);
    await audit(req, 'auth.login_failed', { actor: null,
      detail: `Failed sign-in for "${email}" (${u ? (u.active ? 'wrong password' : 'account disabled') : 'unknown account'})` });
    return renderLogin(res, 401, email, 'Invalid email or password.');
  }
  auth.loginFailures.reset(key);
  await audit(req, 'auth.login', { actor: { id: u.id, email: u.email }, detail: `Signed in as ${u.role}` });
  await auth.startSession(res, u.id);
  res.redirect('/');
});

router.post('/logout', async (req, res) => {
  if (req.cookies.sid) await auth.endSession(req.cookies.sid);
  res.clearCookie('sid');
  res.redirect('/login');
});

// ---- Forgot / reset password ----
router.get('/forgot', (req, res) => res.render('forgot', { title: 'Forgot password' }));

router.post('/forgot', rateLimit({ max: 5, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE lower(email)=$1 AND active AND deleted_at IS NULL', [normEmail(req.body.email)]);
  if (u) {
    const token = await auth.issueToken({ type: 'reset', email: u.email.toLowerCase(), userId: u.id, ttlHours: 1 });
    await audit(req, 'auth.reset_requested', { actor: { id: u.id, email: u.email }, type: 'user', id: u.id, detail: 'Requested a password reset email (link valid 1 hour)' });
    await trySendMail({
      to: u.email,
      subject: 'Reset your Specly password',
      text: `Hi ${u.name},\n\nUse this link to set a new password (valid for 1 hour):\n${baseUrl(req)}/reset/${token}\n\nIf you did not ask for this, ignore this email.`,
    });
  }
  // Same response whether or not the account exists, to avoid leaking registered emails.
  res.render('forgot', { title: 'Forgot password', sent: true });
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
      return (await q(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,'guest') RETURNING id`,
        [email, name, await auth.hashPassword(req.body.password)]))[0];
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
