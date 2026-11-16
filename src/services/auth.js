const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sessionCookie, errorPage } = require('../lib/http');
const { createLimiter } = require('../lib/security');
const { passwordError } = require('../lib/validate');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---- passwords (async so hashing never blocks the event loop) ----
const config = require('../config');
const secrets = require('../lib/secrets');
const hashPassword = (pw) => bcrypt.hash(pw, config.bcryptCost);
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', config.bcryptCost);
// Compare against a dummy hash when the user doesn't exist so response time doesn't reveal valid emails.
const checkPassword = (pw, hash) => bcrypt.compare(String(pw), hash || DUMMY_HASH).then((ok) => ok && !!hash);

// After a successful sign-in: if the stored hash is weaker than the current cost setting, store a fresh one.
async function upgradeHash(userId, password, hash, cost = config.bcryptCost) {
  if (!hash || bcrypt.getRounds(hash) >= cost) return false;
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, await bcrypt.hash(password, cost)]);
  return true;
}

// The user's two-factor seed in clear (it is encrypted at rest when APP_SECRET is set). A seed stored before encryption
// was switched on is encrypted the first time it is read.
function totpSecretOf(row) {
  if (!row || !row.totp_secret) return null;
  const clear = secrets.open(row.totp_secret);
  if (!secrets.isSealed(row.totp_secret) && config.appSecret && row.id) {
    db.query('UPDATE users SET totp_secret=$2 WHERE id=$1 AND totp_secret=$3', [row.id, secrets.seal(clear), row.totp_secret]).catch(() => {});
  }
  return clear;
}

// ---- sessions ----
async function startSession(res, userId, req = null) {
  const token = newToken();
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
    [sha(token), userId, new Date(Date.now() + SESSION_TTL_MS), req ? req.ip || null : null, req ? String(req.get('user-agent') || '').slice(0, 300) || null : null]);
  res.cookie('sid', token, sessionCookie);
}
const endSession = (token) => db.query('DELETE FROM sessions WHERE token_hash=$1', [sha(token)]);
const endAllSessions = (userId, q = db.query) => q('DELETE FROM sessions WHERE user_id=$1', [userId]);

// Attaches req.user (or null) from the session cookie.
async function loadUser(req, res, next) {
  req.user = null;
  const token = req.cookies.sid;
  if (token) {
    req.user = await db.one(`
      SELECT u.id, u.email, u.name, u.role, s.last_seen_at FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > now()
        AND ($2::int = 0 OR s.last_seen_at > now() - ($2::int * interval '1 hour'))
        AND u.active AND u.deleted_at IS NULL`, [sha(token), config.sessionIdleHours]);
    // Keep an active session alive without writing on every request: only when it was last touched more than five minutes ago.
    if (req.user) {
      if (Date.now() - new Date(req.user.last_seen_at).getTime() > 5 * 60 * 1000) db.query('UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1', [sha(token)]).catch(() => {});
      delete req.user.last_seen_at;
    }
  }
  next();
}

const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return errorPage(res, 403, 'Forbidden', 'Admins only.');
  next();
};

// ---- one-time tokens (invite / reset); only a hash is stored ----
async function issueToken({ type, email, userId = null, invitedBy = null, ttlHours, role = null, blueprintIds = null }) {
  const token = newToken();
  await db.tx(async (q) => {
    await q('DELETE FROM tokens WHERE type=$1 AND email=$2', [type, email]); // newest link wins
    await q(`INSERT INTO tokens (token_hash,type,email,user_id,invited_by,expires_at,role,blueprint_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sha(token), type, email, userId, invitedBy, new Date(Date.now() + ttlHours * 3600 * 1000), role, blueprintIds]);
  });
  return token;
}
const findToken = (token, type) =>
  db.one('SELECT * FROM tokens WHERE token_hash=$1 AND type=$2 AND expires_at > now()', [sha(token), type]);
// Atomically use up a token: returns its row only to the first caller.
const consumeToken = async (token, type, q = db.query) =>
  (await q('DELETE FROM tokens WHERE token_hash=$1 AND type=$2 AND expires_at > now() RETURNING *', [sha(token), type]))[0] || null;

// Route guard: put a valid token of `type` on req.token or show an "expired" page.
const requireToken = (type, title, message) => async (req, res, next) => {
  req.token = await findToken(req.params.token, type);
  if (!req.token) return errorPage(res, 400, title, message);
  next();
};

// Failed-login throttle: 10 failures / 15 min per email+IP.
const loginFailures = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

module.exports = {
  hashPassword, checkPassword, upgradeHash, totpSecretOf, passwordError, sha, startSession, endSession, endAllSessions, loadUser,
  requireLogin, requireAdmin, issueToken, findToken, consumeToken, requireToken, loginFailures,
};
