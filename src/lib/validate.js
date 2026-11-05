const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const ROLES = ['admin', 'member', 'guest'];

const normEmail = (v) => String(v || '').trim().toLowerCase();
const isEmail = (v) => EMAIL_RE.test(v) && v.length <= 254;
const text = (v, max) => String(v || '').trim().slice(0, max);

// bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than silently truncated.
function passwordError(pw, confirm) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(pw) > 72) return 'Password must be at most 72 bytes.';
  if (confirm !== undefined && pw !== confirm) return 'Passwords do not match.';
  return null;
}

// First truthy value wins, so validators can be chained: firstError(a(), b(), c()).
const firstError = (...errs) => errs.find(Boolean) || null;

module.exports = { ROLES, normEmail, isEmail, text, passwordError, firstError };
