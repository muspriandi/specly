const db = require('../db');
const config = require('../config');
const log = require('../lib/log');

// Every event goes through audit(): it is ALWAYS written to the application log (as {msg:'audit', event:'<action>', …}),
// and only the events below are also stored in the audit_log TABLE. The table is the admin-facing record of
// who changed access, accounts and content, so it holds the security and administrative changes and stays small;
// high-volume or low-value events (sign-ins, requests, invitations, content saves) live in the log, and content
// saves are in any case recorded, with author and note, in blueprint_versions.
// Move an action between the two by editing this list; AUDIT_STORE=all stores everything.
const STORED = new Set([
  // accounts and roles
  'user.created', 'user.updated', 'user.deleted', 'user.restored', 'user.purged', 'user.2fa_reset', 'user.access_changed',
  'invite.accepted',
  // access to blueprints
  'blueprint.access_changed', 'blueprint.share_created', 'blueprint.share_revoked', 'blueprint.api_token_created', 'blueprint.api_token_revoked',
  'request.approved', 'request.rejected', 'request.revoked',
  // destructive or reverting content actions
  'blueprint.deleted', 'blueprint.restored', 'blueprint.purged',
  // sensitive reads
  'audit.exported',
  // credentials
  'auth.password_changed', 'auth.password_reset', 'auth.2fa_enabled', 'auth.2fa_disabled', 'auth.2fa_codes_renewed',
]);
// Not stored (log only): auth.login (admin sign-ins are stored, see the call site), auth.sessions_ended,
// request.created, invite.sent, invite.email_failed, invite.revoked, blueprint.created, blueprint.updated.

const STORED_DETAIL = 300; // characters kept in the table; the log line keeps up to 800

// Record an event. Never throws: a logging failure must not break the user's request.
// `actor` defaults to req.user; pass null (anonymous) or { id, email } to override.
// `store` forces (true) or prevents (false) the table row for this one call.
async function audit(req, action, { type = null, id = null, detail = null, actor, store } = {}) {
  const a = actor !== undefined ? actor : req.user;
  const persist = store !== undefined ? store : config.auditStore === 'all' || STORED.has(action);
  const text = detail ? String(detail).slice(0, 800) : null;
  log.info('audit', { event: action, req: req.id, actor: a ? a.email : null, actorId: a ? a.id : null,
    target: type ? `${type}:${id == null ? '' : id}` : null, detail: text, ip: req.ip || null, stored: persist });
  if (!persist) return;
  try {
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_label, action, target_type, target_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a ? a.id : null, a ? a.email : null, action, type, id == null ? null : String(id),
        text ? text.slice(0, STORED_DETAIL) : null, req.ip || null]);
  } catch (e) {
    log.error('audit write failed', { event: action, err: e });
  }
}

module.exports = { audit, STORED };
