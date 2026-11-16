const router = require('./router')();
const db = require('../../db');
const auth = require('../../services/auth');
const { audit } = require('../../services/audit');
const { trySendMail } = require('../../services/mail');
const { baseUrl, setOnce, takeOnce, flash } = require('../../lib/http');
const { normEmail, isEmail, text } = require('../../lib/validate');
const { paginate, limitSql, likeOf } = require('../../lib/paginate');
const INVITE_ROLES = ['member', 'guest'];

const MAX_BATCH = 10;
const render = async (req, res, status, extra = {}) => {
  const filter = text(req.query.q, 100);
  const where = `type='invite'${filter ? ' AND email ILIKE $1' : ''}`, params = filter ? [likeOf(filter)] : [];
  const pg = await paginate(req, `SELECT COUNT(*)::int AS n FROM tokens WHERE ${where}`, params);
  const pending = await db.query(`
    SELECT left(t.token_hash, 16) AS id, t.email, t.role, COALESCE(array_length(t.blueprint_ids, 1), 0) AS blueprint_count, t.created_at, t.expires_at, (t.expires_at < now()) AS expired, u.name AS invited_by
    FROM tokens t LEFT JOIN users u ON u.id=t.invited_by WHERE ${where.replace(/\b(type|email)\b/g, 't.$1')}
    ORDER BY t.created_at DESC, t.email ${limitSql(pg)}`, params);
  const picked = extra.picked || [];
  const pickedBlueprints = picked.length ? await db.query('SELECT id, title FROM blueprints WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY lower(title)', [picked]) : [];
  res.status(status).render('admin/invites', { title: 'Invitations', pending, pg, filter, maxBatch: MAX_BATCH, pickedBlueprints, role: 'guest', ...extra, picked });
};

const parseEmails = (raw) => [...new Set(
  String(raw || '').split(/[\s,;]+/).map((t) => normEmail(t.replace(/^.*<|>.*$/g, ''))).filter(Boolean))];

// The result of a send is kept across the redirect (see setOnce), so refreshing the page cannot send the invitations again.
router.get('/', (req, res) => {
  const done = takeOnce(req, res, 'invres', '/manage/invites');
  const lists = done && done.result && ['sent', 'mailFailed', 'skipped'].every((k) => Array.isArray(done.result[k]));
  render(req, res, 200, lists ? { result: done.result, emails: String(done.emails || ''), role: INVITE_ROLES.includes(done.role) ? done.role : 'guest',
    picked: (done.picked || []).map(Number).filter(Number.isInteger) } : {});
});

// Type-ahead for "Blueprints to assign": at least 3 characters, the best 5 (title matches first), minus the ones already picked.
router.get('/blueprint-options', async (req, res) => {
  const q = text(req.query.q, 100);
  if (q.length < 3) return res.json({ items: [] });
  const exclude = String(req.query.exclude || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
  const items = await db.query(`SELECT id, title, version, left(description, 160) AS description FROM blueprints
    WHERE deleted_at IS NULL AND (title ILIKE $1 OR description ILIKE $1) AND NOT (id = ANY($2))
    ORDER BY (title ILIKE $3) DESC, (title ILIKE $1) DESC, lower(title), id LIMIT 5`, [likeOf(q), exclude, `${q.replace(/[\\%_]/g, '\\$&')}%`]);
  res.json({ items });
});

// Issues a fresh 72-hour link (replacing any earlier one for the address) and emails it. Returns whether the email went out.
async function sendInvite(req, email, role, chosen) {
  const token = await auth.issueToken({ type: 'invite', email, invitedBy: req.user.id, ttlHours: 72, role, blueprintIds: chosen.map((b) => b.id) });
  await audit(req, 'invite.sent', { type: 'invite',
    detail: `Invited ${email} as a ${role}${chosen.length ? ` with access to ${chosen.map((b) => `"${b.title}"`).join(', ')}` : ''} (link valid 72 hours)` });
  const ok = await trySendMail({
    to: email,
    subject: `${req.user.name} invited you to Specly`,
    text: `Hi,\n\n${req.user.name} invited you to view API documentation on Specly${chosen.length ? `, starting with:\n${chosen.map((b) => `  - ${b.title}`).join('\n')}\n` : '.\n'}\nAccept the invitation (valid for 72 hours):\n${baseUrl(req)}/invite/${token}\n`,
  });
  if (!ok) await audit(req, 'invite.email_failed', { type: 'invite', detail: `Invitation email to ${email} could not be sent` });
  return ok;
}

router.post('/', async (req, res) => {
  const emails = parseEmails(req.body.emails);
  const role = INVITE_ROLES.includes(req.body.role) ? req.body.role : 'guest';
  const wanted = [].concat(req.body.bp || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const chosen = wanted.length ? await db.query('SELECT id, title FROM blueprints WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY lower(title)', [wanted]) : [];
  const form = { role, picked: chosen.map((b) => b.id) };
  if (!emails.length) return render(req, res, 400, { error: 'Enter at least one email address.', emails: '', ...form });
  if (emails.length > MAX_BATCH) {
    return render(req, res, 400, { error: `Please invite at most ${MAX_BATCH} people at a time.`, emails: req.body.emails, ...form });
  }

  const existing = new Set((await db.query('SELECT lower(email) AS email FROM users WHERE deleted_at IS NULL AND lower(email) = ANY($1)', [emails])).map((r) => r.email));
  const result = { sent: [], mailFailed: [], skipped: [] };
  for (const email of emails) {
    if (!isEmail(email)) { result.skipped.push({ email, reason: 'not a valid email' }); continue; }
    if (existing.has(email)) { result.skipped.push({ email, reason: 'already has an account' }); continue; }
    const ok = await sendInvite(req, email, role, chosen);
    (ok ? result.sent : result.mailFailed).push(email);
  }
  // Keep the skipped addresses in the box so they can be fixed and resubmitted.
  setOnce(res, 'invres', { result, emails: result.skipped.map((s) => s.email).join('\n'), role: form.role, picked: form.picked }, '/manage/invites');
  res.redirect('/manage/invites');
});

// Resend or revoke a pending invitation. Its id is the first 16 characters of the token hash (the token itself is never stored).
const findInvite = (tid) => (/^[0-9a-f]{16}$/.test(tid) ? db.one(`SELECT * FROM tokens WHERE type='invite' AND left(token_hash,16)=$1`, [tid]) : null);

router.post('/:tid/resend', async (req, res) => {
  const inv = await findInvite(req.params.tid);
  if (!inv) { flash(res, 'That invitation no longer exists.', 'info'); return res.redirect('/manage/invites'); }
  if (await db.one('SELECT 1 FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [inv.email.toLowerCase()])) {
    await db.query('DELETE FROM tokens WHERE token_hash=$1', [inv.token_hash]);
    flash(res, `${inv.email} already has an account, so the invitation was removed.`, 'info');
    return res.redirect('/manage/invites');
  }
  const chosen = inv.blueprint_ids && inv.blueprint_ids.length ? await db.query('SELECT id, title FROM blueprints WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY lower(title)', [inv.blueprint_ids]) : [];
  const ok = await sendInvite(req, inv.email, inv.role || 'guest', chosen);
  flash(res, ok ? `A new invitation was sent to ${inv.email}. The old link no longer works.` : `The new link for ${inv.email} was created but the email failed (check SMTP).`, ok ? 'success' : 'error');
  res.redirect('/manage/invites');
});

router.post('/:tid/revoke', async (req, res) => {
  const inv = await findInvite(req.params.tid);
  if (inv) {
    await db.query('DELETE FROM tokens WHERE token_hash=$1', [inv.token_hash]);
    await audit(req, 'invite.revoked', { type: 'invite', detail: `Revoked the invitation for ${inv.email}` });
  }
  flash(res, inv ? `The invitation for ${inv.email} was revoked: its link stops working.` : 'That invitation no longer exists.', inv ? 'success' : 'info');
  res.redirect('/manage/invites');
});

module.exports = router;
