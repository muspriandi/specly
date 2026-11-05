const router = require('./router')();
const db = require('../../db');
const auth = require('../../services/auth');
const { audit } = require('../../services/audit');
const { trySendMail } = require('../../services/mail');
const { baseUrl } = require('../../lib/http');
const { normEmail, isEmail, text } = require('../../lib/validate');
const { paginate, limitSql, likeOf } = require('../../lib/paginate');

const MAX_BATCH = 10;
const render = async (req, res, status, extra = {}) => {
  const filter = text(req.query.q, 100);
  const where = `type='invite'${filter ? ' AND email ILIKE $1' : ''}`, params = filter ? [likeOf(filter)] : [];
  const pg = await paginate(req, `SELECT COUNT(*)::int AS n FROM tokens WHERE ${where}`, params);
  const pending = await db.query(`
    SELECT t.email, t.created_at, t.expires_at, (t.expires_at < now()) AS expired, u.name AS invited_by
    FROM tokens t LEFT JOIN users u ON u.id=t.invited_by WHERE ${where.replace(/\b(type|email)\b/g, 't.$1')}
    ORDER BY t.created_at DESC, t.email ${limitSql(pg)}`, params);
  res.status(status).render('admin/invites', { title: 'Invitations', pending, pg, filter, maxBatch: MAX_BATCH, ...extra });
};

const parseEmails = (raw) => [...new Set(
  String(raw || '').split(/[\s,;]+/).map((t) => normEmail(t.replace(/^.*<|>.*$/g, ''))).filter(Boolean))];

router.get('/', (req, res) => render(req, res, 200));

router.post('/', async (req, res) => {
  const emails = parseEmails(req.body.emails);
  if (!emails.length) return render(req, res, 400, { error: 'Enter at least one email address.', emails: '' });
  if (emails.length > MAX_BATCH) {
    return render(req, res, 400, { error: `Please invite at most ${MAX_BATCH} people at a time.`, emails: req.body.emails });
  }

  const existing = new Set((await db.query('SELECT lower(email) AS email FROM users WHERE deleted_at IS NULL AND lower(email) = ANY($1)', [emails])).map((r) => r.email));
  const result = { sent: [], mailFailed: [], skipped: [] };
  for (const email of emails) {
    if (!isEmail(email)) { result.skipped.push({ email, reason: 'not a valid email' }); continue; }
    if (existing.has(email)) { result.skipped.push({ email, reason: 'already has an account' }); continue; }
    const token = await auth.issueToken({ type: 'invite', email, invitedBy: req.user.id, ttlHours: 72 });
    await audit(req, 'invite.sent', { type: 'invite', detail: `Invited ${email} as a guest (link valid 72 hours)` });
    const ok = await trySendMail({
      to: email,
      subject: `${req.user.name} invited you to Specly`,
      text: `Hi,\n\n${req.user.name} invited you to view API documentation on Specly.\nAccept the invitation (valid for 72 hours):\n${baseUrl(req)}/invite/${token}\n`,
    });
    if (!ok) await audit(req, 'invite.email_failed', { type: 'invite', detail: `Invitation email to ${email} could not be sent` });
    (ok ? result.sent : result.mailFailed).push(email);
  }
  // Keep the skipped addresses in the box so they can be fixed and resubmitted.
  await render(req, res, 200, { result, emails: result.skipped.map((s) => s.email).join('\n') });
});

module.exports = router;
