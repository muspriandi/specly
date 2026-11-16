// Share links: an unguessable URL that lets someone WITHOUT an account read one blueprint until it expires or is revoked.
// Only a hash of the token is stored, so a database leak does not reveal working links. Viewing a link never writes
// to the database (anyone could otherwise fill it by hitting a URL).
const crypto = require('crypto');
const db = require('../db');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DAYS = [1, 7, 30, 90];
// At most this many links can be live (unexpired and unrevoked) for one blueprint at a time; revoking or letting one
// expire frees a slot. Every live link is a way in without an account, so the number is kept small and reviewable.
const MAX_ACTIVE = 5;

// Creates a link, or returns null when the blueprint already has MAX_ACTIVE live ones. The blueprint row is locked
// while counting, so two admins creating at the same moment cannot both take the last slot.
async function create(blueprintId, days, label, adminId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const d = DAYS.includes(Number(days)) ? Number(days) : 7;
  const made = await db.tx(async (q) => {
    await q('SELECT id FROM blueprints WHERE id=$1 FOR UPDATE', [blueprintId]);
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM share_links WHERE blueprint_id=$1 AND revoked_at IS NULL AND expires_at > now()`, [blueprintId]);
    if (n >= MAX_ACTIVE) return false;
    await q(`INSERT INTO share_links (token_hash, blueprint_id, label, created_by, expires_at)
      VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`, [sha(token), blueprintId, label || null, adminId, String(d)]);
    return true;
  });
  return made ? { token, days: d } : null;
}

// The blueprint behind a live (unexpired, unrevoked) link, or null.
const find = (token) => db.one(`
  SELECT s.blueprint_id AS id FROM share_links s JOIN blueprints b ON b.id=s.blueprint_id AND b.deleted_at IS NULL
  WHERE s.token_hash=$1 AND s.expires_at > now() AND s.revoked_at IS NULL`, [sha(String(token).slice(0, 100))]);

// Links of a blueprint that are still usable, plus the ones that ended in the last 30 days (for the admin's overview).
const listFor = (blueprintId) => db.query(`
  SELECT s.id, s.label, s.created_at, s.expires_at, s.revoked_at, u.name AS author,
    (s.revoked_at IS NULL AND s.expires_at > now()) AS live
  FROM share_links s LEFT JOIN users u ON u.id=s.created_by WHERE s.blueprint_id=$1
  ORDER BY live DESC, s.created_at DESC LIMIT 50`, [blueprintId]);

async function revoke(id, blueprintId) {
  const [r] = await db.query(`UPDATE share_links SET revoked_at=now() WHERE id=$1 AND blueprint_id=$2 AND revoked_at IS NULL RETURNING label`, [id, blueprintId]);
  return r || null;
}

// Several at once (bulk revoke). Returns the labels of the links that were actually live.
const revokeMany = (ids, blueprintId) => db.query(`UPDATE share_links SET revoked_at=now()
  WHERE id = ANY($1::int[]) AND blueprint_id=$2 AND revoked_at IS NULL RETURNING id, label`,
  [[...new Set([].concat(ids).map(Number).filter((n) => Number.isInteger(n) && n > 0))], blueprintId]);

module.exports = { create, find, listFor, revoke, revokeMany, DAYS, MAX_ACTIVE };
