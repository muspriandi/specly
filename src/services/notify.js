// Emails about access. All of them are queued (never block a request) and can be switched off with NOTIFY_EMAILS=false.
const db = require('../db');
const config = require('../config');
const { queueMail } = require('./mail');
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
function notifyAccessGranted(req, done) {
  if (!config.mail.notify || !done.length) return;
  const byUser = new Map();
  for (const { email, title } of done) byUser.set(email, [...(byUser.get(email) || []), title]);
  for (const [to, titles] of byUser) {
    queueMail({ to, subject: titles.length === 1 ? `You can now read "${titles[0]}"` : `You can now read ${titles.length} blueprints`,
      text: `An admin gave you access to:\n${quote(titles)}\n\nOpen Specly: ${baseUrl(req)}/\n` });
  }
}

module.exports = { notifyAdminsOfRequest, notifyAccessGranted };
