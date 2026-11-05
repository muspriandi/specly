const router = require('express').Router();
const db = require('../db');
const auth = require('../services/auth');
const { audit } = require('../services/audit');
const { flash } = require('../lib/http');
const { rateLimit } = require('../lib/security');
const { passwordError, firstError } = require('../lib/validate');

// Self-service for any signed-in user (admin, member or guest).
router.use('/account', auth.requireLogin);

const form = (res, status, error) => res.status(status).render('account-password', { title: 'Change password', error });

router.get('/account/password', (req, res) => form(res, 200));

router.post('/account/password', rateLimit({ max: 10, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const { current, password, confirm } = req.body;
  const u = await db.one('SELECT id, email, password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await auth.checkPassword(current, u && u.password_hash))) {
    await audit(req, 'auth.password_change_failed', { type: 'user', id: req.user.id, detail: 'Wrong current password when changing password' });
    return form(res, 400, 'Your current password is incorrect.');
  }
  const err = firstError(passwordError(password, confirm), current === password && 'Choose a password different from the current one.');
  if (err) return form(res, 400, err);

  await db.tx(async (q) => {
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await auth.hashPassword(password), u.id]);
    await auth.endAllSessions(u.id, q); // sign out everywhere, including this browser; a fresh session follows
  });
  await auth.startSession(res, u.id);
  await audit(req, 'auth.password_changed', { type: 'user', id: u.id, detail: 'Changed own password; all other sessions ended' });
  flash(res, 'Password updated. Other devices have been signed out.');
  res.redirect('/');
});

module.exports = router;
