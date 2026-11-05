// Usage: npm run reset-admin -- [email] [new-password]
// Sets the password of an existing user (and makes them an active admin), or creates the admin.
// Without a password argument, a random one is generated and printed.
const crypto = require('crypto');
const db = require('../src/db');
const auth = require('../src/services/auth');
const { normEmail, passwordError } = require('../src/lib/validate');

(async () => {
  const email = normEmail(process.argv[2] || 'admin@specly.local');
  const generated = !process.argv[3];
  const password = process.argv[3] || crypto.randomBytes(9).toString('base64url');
  const err = passwordError(password);
  if (err) throw new Error(err);

  await db.init();
  const hash = await auth.hashPassword(password);
  await db.tx(async (q) => {
    const [user] = await q('SELECT id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [email]);
    if (user) {
      await q(`UPDATE users SET password_hash=$1, role='admin', active=TRUE WHERE id=$2`, [hash, user.id]);
      await auth.endAllSessions(user.id, q);
    } else {
      await q(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,'Administrator',$2,'admin')`, [email, hash]);
    }
  });
  console.log(`Admin ready: ${email}${generated ? ` / ${password}` : ''}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
