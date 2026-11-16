// Encryption at rest for small secrets stored in the database (two-factor seeds): AES-256-GCM with a key derived from
// APP_SECRET. A database dump or backup alone is then not enough to clone someone's authenticator.
// Without APP_SECRET (development) values are stored as they are; production requires it (see config.js). Values written
// before APP_SECRET was set stay readable and are re-encrypted the next time they are used.
const crypto = require('crypto');
const config = require('../config');

const PREFIX = 'enc:v1:';
let cachedKey = null;
const key = () => cachedKey || (cachedKey = Buffer.from(crypto.hkdfSync('sha256', config.appSecret, 'specly', 'two-factor-secret', 32)));
const b64 = (b) => b.toString('base64url');

const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

function seal(plain) {
  if (!config.appSecret || plain == null) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${PREFIX}${b64(iv)}.${b64(c.getAuthTag())}.${b64(ct)}`;
}

function open(stored) {
  if (!isSealed(stored)) return stored;
  if (!config.appSecret) throw new Error('A two-factor secret is encrypted but APP_SECRET is not set.');
  const [iv, tag, ct] = stored.slice(PREFIX.length).split('.').map((p) => Buffer.from(p, 'base64url'));
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt a two-factor secret (is APP_SECRET the one it was encrypted with?).');
  }
}

module.exports = { seal, open, isSealed };
