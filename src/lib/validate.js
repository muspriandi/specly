const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const ROLES = ['admin', 'member', 'guest'];

const normEmail = (v) => String(v || '').trim().toLowerCase();
const isEmail = (v) => EMAIL_RE.test(v) && v.length <= 254;
const text = (v, max) => String(v || '').trim().slice(0, max);

// The passwords everybody tries first. Not a substitute for length, just a floor.
const COMMON = new Set(['password', 'password1', 'password12', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwertyuiop',
  'qwerty123', 'iloveyou', 'letmein1', 'welcome1', 'welcome123', 'changeme', 'changeme1', 'admin123', 'administrator', 'specly123', 'abc12345', '11111111', '00000000']);

// bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than silently truncated.
function passwordError(pw, confirm) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(pw) > 72) return 'Password must be at most 72 bytes.';
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 'That password is too easy to guess. Choose another.';
  if (confirm !== undefined && pw !== confirm) return 'Passwords do not match.';
  return null;
}

// First truthy value wins, so validators can be chained: firstError(a(), b(), c()).
const firstError = (...errs) => errs.find(Boolean) || null;

module.exports = { ROLES, normEmail, isEmail, text, passwordError, firstError };
