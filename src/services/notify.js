// Emails about access. All of them are queued (never block a request) and can be switched off with NOTIFY_EMAILS=false.
const db = require('../db');
const config = require('../config');
const { queueMail, background } = require('./mail');
const { baseUrl } = require('../lib/http');

const quote = (titles) => titles.map((t) => `  - ${t}`).join('\n');

// A member asked for a blueprint: tell the active admins (capped, so a big team does not get a flood).
async function notifyAdminsOfRequest(req, user, bp, message) {
  if (!config.mail.notify) return;
  const admins = await db.query(`SELECT email FROM users WHERE role='admin' AND active AND deleted_at IS NULL ORDER BY id LIMIT 20`);
  for (const a of admins) {
    queueMail({ to: a.email, subject: `Access request: ${bp.title}`,
      text: `${user.name} (${user.email}) asked for access to "${bp.title}".${message ? `\n\nTheir note: ${message}` : ''}\n\nReview it: ${baseUrl(req)}/manage/requests\n` });
  }
}

// Tell each user which blueprints they can now read. `done` is a list of { email, title }.
function notifyAccessGranted(req, done, until = null) {
  if (!config.mail.notify || !done.length) return;
  const byUser = new Map();
  for (const { email, title } of done) byUser.set(email, [...(byUser.get(email) || []), title]);
  for (const [to, titles] of byUser) {
    queueMail({ to, subject: titles.length === 1 ? `You can now read "${titles[0]}"` : `You can now read ${titles.length} blueprints`,
      text: `An admin gave you access to:\n${quote(titles)}\n${until ? `\nThis access ends on ${require('./access').lastDay(until)} (end of day, UTC).\n` : ''}\nOpen Specly: ${baseUrl(req)}/\n` });
  }
}

// A blueprint was published: tell the people who watch it. Access is re-checked at send time, so someone whose access was
// removed after they started watching gets nothing. Capped at 500 recipients per publish.
async function deliverToWatchers(req, blueprintId, saved) {
  if (!config.mail.notify) return;
  const bp = await db.one('SELECT id, title FROM blueprints WHERE id=$1 AND deleted_at IS NULL', [blueprintId]);
  if (!bp) return;
  const watchers = await db.query(`SELECT u.id, u.email, u.name, u.role FROM blueprint_watchers w
    JOIN users u ON u.id=w.user_id AND u.active AND u.deleted_at IS NULL WHERE w.blueprint_id=$1 ORDER BY w.created_at LIMIT 500`, [blueprintId]);
  if (!watchers.length) return;
  const { canView } = require('./access');
  const d = saved.diff || { added: [], changed: [], removed: [], deprecated: [] };
  const list = (label, items) => (items && items.length ? `${label} (${items.length}):\n${items.slice(0, 10).map((k) => `  ${k}`).join('\n')}${items.length > 10 ? `\n  …and ${items.length - 10} more` : ''}\n\n` : '');
  const breaking = (d.breaking || []).map((b) => `${b.endpoint}: ${b.change}`);
  const body = `${list('Breaking changes', breaking)}${list('Added', d.added)}${list('Changed', d.changed)}${list('Removed', d.removed)}${list('Newly deprecated', d.deprecated)}`
    || 'No endpoint changes (descriptions or other details were updated).\n\n';
  const link = `${baseUrl(req)}/blueprints/${bp.id}`;
  for (const w of watchers) {
    if (!(await canView(w, bp.id))) continue;
    queueMail({ to: w.email, subject: `${bp.title} was updated${saved.version ? ` (v${String(saved.version).replace(/^v/i, '')})` : ''}${breaking.length ? ': breaking changes' : ''}`,
      text: `"${bp.title}" has a new revision${saved.note ? `: ${saved.note}` : '.'}\n\n${body}What changed: ${link}/changelog\nRead it: ${link}\n\nYou get this because you are watching the blueprint. To stop, open it and click "Unwatch".\n` });
  }
}

// Runs after the response (the publisher never waits for it) but is tracked, so shutdown and tests can wait for it.
const notifyWatchers = (req, blueprintId, saved) => background(() => deliverToWatchers(req, blueprintId, saved));

module.exports = { notifyAdminsOfRequest, notifyAccessGranted, notifyWatchers };
