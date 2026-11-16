const router = require('./router')();
const db = require('../../db');
const auth = require('../../services/auth');
const trash = require('../../services/trash');
const { audit } = require('../../services/audit');
const { flash, notFound } = require('../../lib/http');
const { paginate, limitSql, likeOf, sortOf } = require('../../lib/paginate');
const access = require('../../services/access');
const { ROLES, normEmail, isEmail, text, passwordError, firstError } = require('../../lib/validate');

const getUser = (id) => db.one('SELECT id,email,name,role,active FROM users WHERE id=$1 AND deleted_at IS NULL', [id]);
const renderForm = (res, status, u, isNew, error) =>
  res.status(status).render('admin/user-form', { title: isNew ? 'New user' : 'Edit user', u, roles: ROLES, isNew, error });

router.get('/', async (req, res) => {
  const filter = text(req.query.q, 100);
  const role = ROLES.includes(req.query.role) ? req.query.role : '';
  const status = ['active', 'disabled'].includes(req.query.status) ? req.query.status : '';
  const params = [], conds = ['deleted_at IS NULL'];
  if (filter) { params.push(likeOf(filter)); conds.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
  if (role) { params.push(role); conds.push(`role = $${params.length}`); }
  if (status) conds.push(status === 'active' ? 'active' : 'NOT active');
  const where = conds.join(' AND ');
  const pg = await paginate(req, `SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params);
  const sort = sortOf(req, { name: 'lower(name)', email: 'lower(email)', role: 'role', status: 'active', created: 'created_at' }, 'created', 'desc');
  const users = await db.query(`SELECT id,email,name,role,active,created_at FROM users WHERE ${where} ORDER BY ${sort.sql}, id DESC ${limitSql(pg)}`, params);
  res.render('admin/users', { title: 'Users', users, pg, filter, role, status, roles: ROLES, sort });
});

router.get('/new', (req, res) => renderForm(res, 200, {}, true));

router.post('/', async (req, res) => {
  const name = text(req.body.name, 100), email = normEmail(req.body.email), role = req.body.role, password = req.body.password;
  const err = firstError(
    !name && 'Name is required.',
    !isEmail(email) && 'A valid email is required.',
    !ROLES.includes(role) && 'Invalid role.',
    passwordError(password),
  );
  if (err) return renderForm(res, 400, { name, email, role }, true, err);
  let created;
  try {
    created = await db.one('INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id',
      [email, name, await auth.hashPassword(password), role]);
  } catch (e) {
    if (db.isUniqueViolation(e)) return renderForm(res, 400, { name, email, role }, true, 'Email already in use.');
    throw e;
  }
  await audit(req, 'user.created', { type: 'user', id: created.id, detail: `Created ${role} account for ${email} (${name})` });
  flash(res, 'User created.');
  res.redirect('/manage/users');
});

// ---- Which blueprints this user can read: list (filter by title), assign, un-assign one or many ----
// Same layout as /manage/blueprints/:id/access. Admins read everything, so their page just says so.
const backTo = (req) => `/manage/users/${req.params.id}/access`;
const titles = (rows) => rows.map((r) => `"${r.title}"`).join(', ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

router.get('/:id/access', async (req, res) => {
  const u = await getUser(req.params.id);
  if (!u) return notFound(res, 'User not found.');
  const filter = text(req.query.q, 100);
  const params = [u.id], conds = ['r.user_id=$1', `r.status='approved'`];
  if (filter) { params.push(likeOf(filter)); conds.push(`b.title ILIKE $${params.length}`); }
  const from = `FROM access_requests r JOIN blueprints b ON b.id=r.blueprint_id AND b.deleted_at IS NULL WHERE ${conds.join(' AND ')}`;
  const pg = await paginate(req, `SELECT COUNT(*)::int AS n ${from}`, params);
  const readers = u.role === 'admin' ? [] : await db.query(`SELECT b.id, b.title, b.version, r.decided_at ${from} ORDER BY lower(b.title), b.id ${limitSql(pg)}`, params);
  const candidates = u.role === 'admin' ? [] : await db.query(`
    SELECT b.id, b.title, b.version,
      EXISTS (SELECT 1 FROM access_requests r WHERE r.user_id=$1 AND r.blueprint_id=b.id AND r.status='pending') AS requested
    FROM blueprints b WHERE b.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM access_requests r WHERE r.user_id=$1 AND r.blueprint_id=b.id AND r.status='approved')
    ORDER BY requested DESC, lower(b.title), b.id LIMIT 500`, [u.id]);
  res.render('admin/user-access', { title: `Access: ${u.name}`, u, readers, candidates, pg, filter });
});

router.post('/:id/access', async (req, res) => {
  const u = await getUser(req.params.id);
  if (!u) return notFound(res, 'User not found.');
  const done = await access.grant([u.id], [].concat(req.body.bp || []), req.user.id);
  if (done.length) await audit(req, 'user.access_changed', { type: 'user', id: u.id, detail: `Assigned ${titles(done)} to ${u.email}` });
  flash(res, done.length ? `Assigned ${plural(done.length, 'blueprint')}.` : 'Select at least one blueprint to assign.', done.length ? 'success' : 'error');
  res.redirect(backTo(req));
});

const revokeBlueprints = (pick) => async (req, res) => {
  const u = await getUser(req.params.id);
  if (!u) return notFound(res, 'User not found.');
  const done = await access.revoke([u.id], pick(req), req.user.id);
  if (done.length) await audit(req, 'user.access_changed', { type: 'user', id: u.id, detail: `Removed ${titles(done)} from ${u.email}` });
  flash(res, done.length ? `Removed access to ${plural(done.length, 'blueprint')}.` : 'Select at least one blueprint first.', done.length ? 'success' : 'error',
    done.length && done.length <= 50 ? { url: `/manage/users/${u.id}/access`, body: done.map((d) => `bp=${d.blueprint_id}`).join('&') } : null);
  res.redirect(backTo(req));
};
router.post('/:id/access/revoke', revokeBlueprints((req) => [].concat(req.body.bp || [])));
router.post('/:id/access/:bid/revoke', revokeBlueprints((req) => [req.params.bid]));

router.post('/bulk-delete', async (req, res) => {
  const ids = [...new Set([].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== req.user.id))].slice(0, 200);
  let n = 0;
  for (const id of ids) {
    const u = await trash.deleteUser(id, req.user.id);
    if (!u) continue;
    n += 1;
    await audit(req, 'user.deleted', { type: 'user', id, detail: `Moved ${u.role} account ${u.email} (${u.name}) to the trash (bulk)` });
  }
  flash(res, n ? `${n} user${n === 1 ? '' : 's'} moved to the trash.` : 'Select at least one user first (you cannot delete yourself).', n ? 'success' : 'error');
  res.redirect('/manage/users');
});

router.get('/:id/edit', async (req, res) => {
  const u = await getUser(req.params.id);
  if (!u) return notFound(res, 'User not found.');
  renderForm(res, 200, u, false);
});

router.post('/:id', async (req, res) => {
  const u = await getUser(req.params.id);
  if (!u) return notFound(res, 'User not found.');
  const name = text(req.body.name, 100), role = req.body.role, active = !!req.body.active, password = req.body.password;
  const fail = (error) => renderForm(res, 400, { ...u, name, role, active }, false, error);
  const err = firstError(
    !name && 'Name is required.',
    !ROLES.includes(role) && 'Invalid role.',
    u.id === req.user.id && (role !== 'admin' || !active) && 'You cannot demote or deactivate yourself.',
    password && passwordError(password),
  );
  if (err) return fail(err);

  await db.tx(async (q) => {
    await q('UPDATE users SET name=$1, role=$2, active=$3 WHERE id=$4', [name, role, active, u.id]);
    if (password) await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await auth.hashPassword(password), u.id]);
    if (!active || password) await auth.endAllSessions(u.id, q);
  });
  const changes = [];
  if (u.role !== role) changes.push(`role changed from ${u.role} to ${role}`);
  if (u.active !== active) changes.push(active ? 'account enabled' : 'account disabled (sessions ended)');
  if (u.name !== name) changes.push(`name changed from "${u.name}" to "${name}"`);
  if (password) changes.push('password reset by admin (sessions ended)');
  await audit(req, 'user.updated', { type: 'user', id: u.id, detail: `Updated ${u.email}: ${changes.join('; ') || 'no changes'}` });
  flash(res, 'User updated.');
  res.redirect('/manage/users');
});

router.post('/:id/delete', async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    flash(res, 'You cannot delete yourself.', 'error');
  } else {
    const u = await trash.deleteUser(req.params.id, req.user.id);
    if (u) {
      const extra = [u.endedSessions && `${u.endedSessions} session${u.endedSessions === 1 ? '' : 's'} ended`,
        u.cancelledRequests && `${u.cancelledRequests} pending request${u.cancelledRequests === 1 ? '' : 's'} cancelled`].filter(Boolean).join(', ');
      await audit(req, 'user.deleted', { type: 'user', id: req.params.id,
        detail: `Moved ${u.role} account ${u.email} (${u.name}) to the trash${extra ? ` — ${extra}` : ''}` });
    }
    flash(res, u ? `${u.name} moved to the trash.` : 'User not found.', u ? 'success' : 'error', u ? { url: `/manage/trash/users/${u.id}/restore` } : null);
  }
  res.redirect('/manage/users');
});

module.exports = router;
