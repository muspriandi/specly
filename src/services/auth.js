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
const hashPassword = (pw) => bcrypt.hash(pw, 10);
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);
// Compare against a dummy hash when the user doesn't exist so response time doesn't reveal valid emails.
const checkPassword = (pw, hash) => bcrypt.compare(String(pw), hash || DUMMY_HASH).then((ok) => ok && !!hash);

// ---- sessions ----
async function startSession(res, userId) {
  const token = newToken();
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)',
    [sha(token), userId, new Date(Date.now() + SESSION_TTL_MS)]);
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
      SELECT u.id, u.email, u.name, u.role FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active AND u.deleted_at IS NULL`, [sha(token)]);
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
  hashPassword, checkPassword, passwordError, startSession, endSession, endAllSessions, loadUser,
  requireLogin, requireAdmin, issueToken, findToken, consumeToken, requireToken, loginFailures,
};
