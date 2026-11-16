// Time-based one-time passwords (RFC 6238, the scheme Google Authenticator, 1Password, Authy etc. all speak):
// HMAC-SHA1, 6 digits, 30-second steps. Plus single-use recovery codes for a lost phone.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function base32Decode(str) {
  let bits = '';
  for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}

const stepNow = (now = Date.now()) => Math.floor(now / 1000 / STEP);

// Returns the matching time step (accepting one step either side for clock drift) or null. A step at or before
// `lastStep` is refused, so a code that was already used cannot be replayed.
function verify(secret, token, lastStep = 0, now = Date.now()) {
  const t = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  for (const step of [stepNow(now) - 1, stepNow(now), stepNow(now) + 1]) {
    if (step > Number(lastStep || 0) && crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(t))) return step;
  }
  return null;
}

// otpauth:// URI that authenticator apps read from a QR code.
const otpauthUri = (secret, email, issuer = 'Specly') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// Recovery codes: shown once as "abcde-fghij"; only their hashes are stored.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normalizeRecovery = (c) => String(c || '').toLowerCase().replace(/[^a-z2-7]/g, '');
function newRecoveryCodes(n = 10) {
  const codes = Array.from({ length: n }, () => { const c = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase(); return `${c.slice(0, 5)}-${c.slice(5)}`; });
  return { codes, hashes: codes.map((c) => sha(normalizeRecovery(c))) };
}
const recoveryHash = (c) => sha(normalizeRecovery(c));

module.exports = { newSecret, verify, otpauthUri, newRecoveryCodes, recoveryHash, codeAt, stepNow, base32Encode, base32Decode };
