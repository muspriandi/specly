const db = require('../db');
const { isLastActiveAdmin } = require('./admins');

// Soft delete: rows stay (with their history) but are hidden everywhere. Related data is updated in the same
// transaction so nothing is left pointing at something that no longer appears:
//   blueprint -> pending access requests are cancelled (approved ones are kept and work again after a restore)
//   user      -> sessions ended, invite/reset links removed, pending requests cancelled
// Each function returns null when the target is missing / already in the wanted state.

async function deleteBlueprint(id, actorId) {
  return db.tx(async (q) => {
    const [bp] = await q(`UPDATE blueprints SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id, title, version`, [id]);
    if (!bp) return null;
    const cancelled = await q(`UPDATE access_requests SET status='cancelled', decided_by=$2, decided_at=now()
      WHERE blueprint_id=$1 AND status='pending' RETURNING id`, [id, actorId]);
    const [{ n: approved }] = await q(`SELECT COUNT(*)::int AS n FROM access_requests WHERE blueprint_id=$1 AND status='approved'`, [id]);
    return { ...bp, cancelledRequests: cancelled.length, approvedKept: approved };
  });
}

async function restoreBlueprint(id) {
  const [bp] = await db.query(`UPDATE blueprints SET deleted_at=NULL, updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id, title, version`, [id]);
  return bp || null;
}

async function deleteUser(id, actorId) {
  return db.tx(async (q) => {
    if (await isLastActiveAdmin(q, id)) return { lastAdmin: true };
    const [u] = await q(`UPDATE users SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id, email, name, role`, [id]);
    if (!u) return null;
    const sessions = await q('DELETE FROM sessions WHERE user_id=$1 RETURNING 1', [id]);
    await q(`DELETE FROM tokens WHERE user_id=$1 OR (lower(email)=lower($2) AND type IN ('invite','reset'))`, [id, u.email]);
    const cancelled = await q(`UPDATE access_requests SET status='cancelled', decided_by=$2, decided_at=now()
      WHERE user_id=$1 AND status='pending' RETURNING id`, [id, actorId]);
    return { ...u, endedSessions: sessions.length, cancelledRequests: cancelled.length };
  });
}

// Returns { conflict: true } when a live account already uses the email.
async function restoreUser(id) {
  try {
    const [u] = await db.query(`UPDATE users SET deleted_at=NULL WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id, email, name, role`, [id]);
    return u || null;
  } catch (e) {
    if (db.isUniqueViolation(e)) return { conflict: true };
    throw e;
  }
}

// Permanent removal of something already in the trash (cascades to versions, endpoints, requests, sessions).
const purgeBlueprint = async (id) => (await db.query('DELETE FROM blueprints WHERE id=$1 AND deleted_at IS NOT NULL RETURNING title, version', [id]))[0] || null;
const purgeUser = async (id) => (await db.query('DELETE FROM users WHERE id=$1 AND deleted_at IS NOT NULL RETURNING email, name, role', [id]))[0] || null;

// Removes what has sat in the trash for more than `days` days (0 or less: nothing). Each removal is written to the audit log
// with a system actor, so nothing disappears without a trace.
async function purgeOld(days) {
  if (!(days > 0)) return { blueprints: 0, users: 0 };
  const { audit } = require('./audit');
  const system = { ip: null, id: 'trash-cleanup' }, actor = { id: null, email: 'system (trash cleanup)' };
  const interval = `${Number(days)} days`;
  const bps = await db.query(`DELETE FROM blueprints WHERE deleted_at < now() - $1::interval RETURNING id, title, version`, [interval]);
  for (const b of bps) await audit(system, 'blueprint.purged', { actor, type: 'blueprint', id: b.id, detail: `Permanently deleted "${b.title}" after ${days} days in the trash` });
  const us = await db.query(`DELETE FROM users WHERE deleted_at < now() - $1::interval RETURNING id, email, name, role`, [interval]);
  for (const u of us) await audit(system, 'user.purged', { actor, type: 'user', id: u.id, detail: `Permanently deleted ${u.role} account ${u.email} after ${days} days in the trash` });
  return { blueprints: bps.length, users: us.length };
}

module.exports = { deleteBlueprint, restoreBlueprint, deleteUser, restoreUser, purgeBlueprint, purgeUser, purgeOld };
