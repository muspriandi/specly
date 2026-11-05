const db = require('../db');

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

module.exports = { deleteBlueprint, restoreBlueprint, deleteUser, restoreUser, purgeBlueprint, purgeUser };
