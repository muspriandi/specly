const router = require('express').Router();
const db = require('../db');
const auth = require('../services/auth');
const { audit } = require('../services/audit');
const { flash, setOnce, takeOnce } = require('../lib/http');
const { rateLimit, createLimiter } = require('../lib/security');
const { passwordError, firstError } = require('../lib/validate');
const QRCode = require('qrcode');
const totp = require('../lib/totp');
const { describeAgent } = require('../lib/ua');
const log = require('../lib/log');

// Self-service for any signed-in user (admin, member or guest).
router.use('/account', auth.requireLogin);

// Wrong current-password attempts are throttled per account, not written to the audit log (they would be unbounded).
const wrongCurrent = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });

const form = (res, status, error) => res.status(status).render('account-password', { title: 'Change password', error });

router.get('/account/password', (req, res) => form(res, 200));

router.post('/account/password', rateLimit({ max: 30, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const { current, password, confirm } = req.body;
  const u = await db.one('SELECT id, email, password_hash FROM users WHERE id=$1', [req.user.id]);
  if (wrongCurrent.isLimited(u.id)) {
    log.warn('security', { event: 'auth.password_change_blocked', req: req.id, user: u.id, ip: req.ip });
    return form(res, 429, 'Too many wrong attempts. Try again in 15 minutes.');
  }
  if (!(await auth.checkPassword(current, u && u.password_hash))) {
    wrongCurrent.hit(u.id);
    log.warn('security', { event: 'auth.password_check_failed', req: req.id, user: u.id, ip: req.ip, locked: wrongCurrent.isLimited(u.id) || undefined });
    return form(res, 400, 'Your current password is incorrect.');
  }
  wrongCurrent.reset(u.id);
  const err = firstError(passwordError(password, confirm), current === password && 'Choose a password different from the current one.');
  if (err) return form(res, 400, err);

  await db.tx(async (q) => {
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await auth.hashPassword(password), u.id]);
    await auth.endAllSessions(u.id, q); // sign out everywhere, including this browser; a fresh session follows
  });
  await auth.startSession(res, u.id, req);
  await audit(req, 'auth.password_changed', { type: 'user', id: u.id, detail: 'Changed own password; all other sessions ended' });
  flash(res, 'Password updated. Other devices have been signed out.');
  res.redirect('/');
});

// ---- Active sessions: see where you are signed in and end any of them ----
router.get('/account/sessions', async (req, res) => {
  const mine = auth.sha(req.cookies.sid || '');
  const sessions = (await db.query(`SELECT left(token_hash, 16) AS id, created_at, ip, user_agent, (token_hash=$2) AS current
    FROM sessions WHERE user_id=$1 AND expires_at > now() ORDER BY (token_hash=$2) DESC, created_at DESC`, [req.user.id, mine]))
    .map((x) => ({ ...x, device: describeAgent(x.user_agent) }));
  res.render('account-sessions', { title: 'Active sessions', sessions });
});

router.post('/account/sessions/revoke', async (req, res) => {
  const mine = auth.sha(req.cookies.sid || '');
  const gone = await db.query(`DELETE FROM sessions WHERE user_id=$1 AND left(token_hash, 16)=$2 AND token_hash<>$3 RETURNING 1`, [req.user.id, String(req.body.id || ''), mine]);
  flash(res, gone.length ? 'Signed out of that device.' : 'That session is already gone.', gone.length ? 'success' : 'info');
  res.redirect('/account/sessions');
});

router.post('/account/sessions/revoke-others', async (req, res) => {
  const gone = await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2 RETURNING 1', [req.user.id, auth.sha(req.cookies.sid || '')]);
  if (gone.length) await audit(req, 'auth.sessions_ended', { type: 'user', id: req.user.id, detail: `Signed out ${gone.length} other session${gone.length === 1 ? '' : 's'}` });
  flash(res, gone.length ? `Signed out ${gone.length} other device${gone.length === 1 ? '' : 's'}.` : 'You are not signed in anywhere else.', gone.length ? 'success' : 'info');
  res.redirect('/account/sessions');
});

// ---- Two-factor sign-in (authenticator app) ----
// Wrong codes / passwords here are throttled per account (not audited: they are unbounded and attacker-triggered).
const twoFactorFails = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const me = (id) => db.one('SELECT id, email, password_hash, totp_secret, totp_enabled_at, totp_last_step, recovery_codes FROM users WHERE id=$1', [id]);

async function page2fa(req, res, status = 200, extra = {}) {
  const u = await me(req.user.id);
  const enabled = !!u.totp_enabled_at;
  const setup = !enabled && u.totp_secret
    ? { secret: u.totp_secret.match(/.{1,4}/g).join(' '), svg: await QRCode.toString(totp.otpauthUri(u.totp_secret, u.email), { type: 'svg', margin: 1, width: 192 }) }
    : null;
  res.status(status).render('account-2fa', { title: 'Two-factor sign-in', enabled, setup, since: u.totp_enabled_at, remaining: (u.recovery_codes || []).length, codes: null, error: null, ...extra });
}

// Checks the account password and one code (authenticator or recovery); returns an error message or null. Marks the code used.
async function confirmIdentity(u, password, code) {
  if (twoFactorFails.isLimited(u.id)) { log.warn('security', { event: 'auth.2fa_settings_blocked', user: u.id }); return 'Too many wrong attempts. Try again in 15 minutes.'; }
  // Password first: a wrong password must not use up a one-time code.
  if (!(await auth.checkPassword(password, u.password_hash))) {
    twoFactorFails.hit(u.id);
    log.warn('security', { event: 'auth.2fa_settings_failed', user: u.id, reason: 'wrong_password', locked: twoFactorFails.isLimited(u.id) || undefined });
    return 'Your password is incorrect.';
  }
  let okCode = false;
  const step = totp.verify(u.totp_secret, code, u.totp_last_step);
  if (step) okCode = (await db.query('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [u.id, step])).length > 0;
  else if ((u.recovery_codes || []).includes(totp.recoveryHash(code))) okCode = (await db.query('UPDATE users SET recovery_codes=array_remove(recovery_codes,$2) WHERE id=$1 AND $2 = ANY(recovery_codes) RETURNING id', [u.id, totp.recoveryHash(code)])).length > 0;
  if (!okCode) {
    twoFactorFails.hit(u.id);
    log.warn('security', { event: 'auth.2fa_settings_failed', user: u.id, reason: 'wrong_code', locked: twoFactorFails.isLimited(u.id) || undefined });
    return 'That code is not valid.';
  }
  twoFactorFails.reset(u.id);
  return null;
}

// Recovery codes are shown once, after a redirect (see setOnce): a refresh cannot regenerate and invalidate them.
const CODES_PATH = '/account/2fa';
router.get('/account/2fa', (req, res) => {
  const once = takeOnce(req, res, 'codes2fa', CODES_PATH);
  page2fa(req, res, 200, { codes: once && Array.isArray(once.codes) ? once.codes.map(String).slice(0, 20) : null });
});

router.post('/account/2fa/start', async (req, res) => {
  const u = await me(req.user.id);
  if (!u.totp_enabled_at) await db.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [u.id, totp.newSecret()]);
  res.redirect('/account/2fa');
});

router.post('/account/2fa/enable', async (req, res) => {
  const u = await me(req.user.id);
  if (u.totp_enabled_at || !u.totp_secret) return res.redirect('/account/2fa');
  if (twoFactorFails.isLimited(u.id)) return page2fa(req, res, 429, { error: 'Too many wrong attempts. Try again in 15 minutes.' });
  const step = totp.verify(u.totp_secret, req.body.code, 0);
  if (!step) { twoFactorFails.hit(u.id); return page2fa(req, res, 400, { error: 'That code is not valid. Check that the code is current and your phone\'s clock is automatic.' }); }
  twoFactorFails.reset(u.id);
  const { codes, hashes } = totp.newRecoveryCodes();
  await db.query('UPDATE users SET totp_enabled_at=now(), totp_last_step=$2, recovery_codes=$3 WHERE id=$1', [u.id, step, hashes]);
  await audit(req, 'auth.2fa_enabled', { type: 'user', id: u.id, detail: 'Turned on two-factor sign-in' });
  setOnce(res, 'codes2fa', { codes }, CODES_PATH);
  res.redirect('/account/2fa');
});

router.post('/account/2fa/disable', async (req, res) => {
  const u = await me(req.user.id);
  if (!u.totp_enabled_at) return res.redirect('/account/2fa');
  const err = await confirmIdentity(u, req.body.password, req.body.code);
  if (err) return page2fa(req, res, err.startsWith('Too many') ? 429 : 400, { error: err });
  await db.query('UPDATE users SET totp_secret=NULL, totp_enabled_at=NULL, totp_last_step=NULL, recovery_codes=NULL WHERE id=$1', [u.id]);
  await audit(req, 'auth.2fa_disabled', { type: 'user', id: u.id, detail: 'Turned off two-factor sign-in' });
  flash(res, 'Two-factor sign-in is off.');
  res.redirect('/account/2fa');
});

router.post('/account/2fa/recovery', async (req, res) => {
  const u = await me(req.user.id);
  if (!u.totp_enabled_at) return res.redirect('/account/2fa');
  const err = await confirmIdentity(u, req.body.password, req.body.code);
  if (err) return page2fa(req, res, err.startsWith('Too many') ? 429 : 400, { error: err });
  const { codes, hashes } = totp.newRecoveryCodes();
  await db.query('UPDATE users SET recovery_codes=$2 WHERE id=$1', [u.id, hashes]);
  await audit(req, 'auth.2fa_codes_renewed', { type: 'user', id: u.id, detail: 'Generated new recovery codes (old ones no longer work)' });
  setOnce(res, 'codes2fa', { codes }, CODES_PATH);
  res.redirect('/account/2fa');
});

module.exports = router;
