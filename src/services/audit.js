const db = require('../db');

// Record an event. Never throws: a logging failure must not break the user's request.
// `actor` defaults to req.user; pass null (anonymous) or { id, email } to override.
async function audit(req, action, { type = null, id = null, detail = null, actor } = {}) {
  try {
    const a = actor !== undefined ? actor : req.user;
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_label, action, target_type, target_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a ? a.id : null, a ? a.email : null, action, type, id == null ? null : String(id),
        detail ? String(detail).slice(0, 800) : null, req.ip || null]);
  } catch (e) {
    console.error('audit failed:', e.message);
  }
}

module.exports = { audit };
