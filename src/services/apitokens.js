// API tokens: let a CI pipeline publish ONE blueprint (PUT /api/v1/blueprints/:id) without a person signing in.
// A token is scoped to a single blueprint, can only publish (it cannot read anything or touch any other blueprint),
// can expire, can be revoked, and only its hash is stored. The "spk_" prefix lets secret scanners recognise a leaked one.
const crypto = require('crypto');
const db = require('../db');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DAYS = [30, 90, 365, 0]; // 0 = no expiry
const MAX_ACTIVE = 10;

// Creates a token, or returns null when the blueprint already has MAX_ACTIVE usable ones.
async function create(blueprintId, name, days, adminId) {
  const token = `spk_${crypto.randomBytes(32).toString('base64url')}`;
  const d = DAYS.includes(Number(days)) ? Number(days) : 90;
  const made = await db.tx(async (q) => {
    await q('SELECT id FROM blueprints WHERE id=$1 FOR UPDATE', [blueprintId]);
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM api_tokens WHERE blueprint_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [blueprintId]);
    if (n >= MAX_ACTIVE) return false;
    await q(`INSERT INTO api_tokens (token_hash, blueprint_id, name, created_by, expires_at)
      VALUES ($1,$2,$3,$4, CASE WHEN $5::int = 0 THEN NULL ELSE now() + ($5::int * interval '1 day') END)`, [sha(token), blueprintId, name, adminId, d]);
    return true;
  });
  return made ? { token, days: d } : null;
}

// The live token behind a presented secret (and records the use), or null.
async function authenticate(presented) {
  if (typeof presented !== 'string' || !/^spk_[A-Za-z0-9_-]{43}$/.test(presented)) return null;
  const t = await db.one(`
    SELECT a.id, a.blueprint_id, a.name FROM api_tokens a JOIN blueprints b ON b.id=a.blueprint_id AND b.deleted_at IS NULL
    WHERE a.token_hash=$1 AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())`, [sha(presented)]);
  if (t) db.query('UPDATE api_tokens SET last_used_at=now() WHERE id=$1', [t.id]).catch(() => {});
  return t;
}

const listFor = (blueprintId) => db.query(`
  SELECT a.id, a.name, a.created_at, a.expires_at, a.last_used_at, a.revoked_at, u.name AS author,
    (a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())) AS live
  FROM api_tokens a LEFT JOIN users u ON u.id=a.created_by WHERE a.blueprint_id=$1
  ORDER BY live DESC, a.created_at DESC LIMIT 50`, [blueprintId]);

const revokeMany = (ids, blueprintId) => db.query(`UPDATE api_tokens SET revoked_at=now()
  WHERE id = ANY($1::int[]) AND blueprint_id=$2 AND revoked_at IS NULL RETURNING id, name`,
  [[...new Set([].concat(ids).map(Number).filter((n) => Number.isInteger(n) && n > 0))], blueprintId]);

module.exports = { create, authenticate, listFor, revokeMany, DAYS, MAX_ACTIVE };
