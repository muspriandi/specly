const router = require('./router')();
const db = require('../../db');
const trash = require('../../services/trash');
const { audit } = require('../../services/audit');
const { flash } = require('../../lib/http');
const { paginate, limitSql } = require('../../lib/paginate');
const { ver } = require('../../services/blueprints');

// Two tables, each with its own page parameter: ?bpage= (blueprints) and ?upage= (users).
router.get('/', async (req, res) => {
  const bp = await paginate(req, 'SELECT COUNT(*)::int AS n FROM blueprints WHERE deleted_at IS NOT NULL', [], { param: 'bpage' });
  const up = await paginate(req, 'SELECT COUNT(*)::int AS n FROM users WHERE deleted_at IS NOT NULL', [], { param: 'upage' });
  const [blueprints, users] = await Promise.all([
    db.query(`SELECT b.id, b.title, b.version, b.deleted_at,
        (SELECT COUNT(*)::int FROM endpoints e WHERE e.blueprint_id=b.id) AS endpoint_count,
        (SELECT COUNT(*)::int FROM blueprint_versions v WHERE v.blueprint_id=b.id) AS revisions
      FROM blueprints b WHERE b.deleted_at IS NOT NULL ORDER BY b.deleted_at DESC, b.id DESC ${limitSql(bp)}`),
    db.query(`SELECT id, email, name, role, deleted_at FROM users WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC ${limitSql(up)}`),
  ]);
  res.render('admin/trash', { title: 'Trash', blueprints, users, bp, up });
});

router.post('/blueprints/:id/restore', async (req, res) => {
  const bp = await trash.restoreBlueprint(req.params.id);
  if (bp) await audit(req, 'blueprint.restored', { type: 'blueprint', id: bp.id, detail: `Restored "${bp.title}" ${ver(bp.version)} from the trash` });
  flash(res, bp ? `“${bp.title}” restored.` : 'Blueprint not found in the trash.', bp ? 'success' : 'error');
  res.redirect('/manage/trash');
});

router.post('/blueprints/:id/purge', async (req, res) => {
  const bp = await trash.purgeBlueprint(req.params.id);
  if (bp) await audit(req, 'blueprint.purged', { type: 'blueprint', id: req.params.id, detail: `Permanently deleted "${bp.title}" ${ver(bp.version)} with its history` });
  flash(res, bp ? `“${bp.title}” permanently deleted.` : 'Blueprint not found in the trash.', bp ? 'success' : 'error');
  res.redirect('/manage/trash');
});

router.post('/users/:id/restore', async (req, res) => {
  const u = await trash.restoreUser(req.params.id);
  if (u && u.conflict) flash(res, 'Cannot restore: another account already uses this email.', 'error');
  else {
    if (u) await audit(req, 'user.restored', { type: 'user', id: u.id, detail: `Restored ${u.role} account ${u.email} (${u.name}) from the trash` });
    flash(res, u ? `${u.name} restored.` : 'User not found in the trash.', u ? 'success' : 'error');
  }
  res.redirect('/manage/trash');
});

router.post('/users/:id/purge', async (req, res) => {
  const u = await trash.purgeUser(req.params.id);
  if (u) await audit(req, 'user.purged', { type: 'user', id: req.params.id, detail: `Permanently deleted ${u.role} account ${u.email} (${u.name})` });
  flash(res, u ? `${u.name} permanently deleted.` : 'User not found in the trash.', u ? 'success' : 'error');
  res.redirect('/manage/trash');
});

module.exports = router;
