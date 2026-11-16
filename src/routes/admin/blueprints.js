const multer = require('multer');
const router = require('./router')();
const db = require('../../db');
const { audit } = require('../../services/audit');
const { canonical, saveBlueprint, diffSpecs, getBlueprint, describeSave, ver } = require('../../services/blueprints');
const { parseSpec, listEndpoints } = require('../../services/spec');
const { lintSpec } = require('../../services/lint');
const { flash, notFound, baseUrl, cookieBase } = require('../../lib/http');
const trash = require('../../services/trash');
const access = require('../../services/access');
const { text } = require('../../lib/validate');
const { paginate, limitSql, likeOf, sortOf } = require('../../lib/paginate');

const MAX_UPLOAD = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, fieldSize: MAX_UPLOAD, files: 1 } });

// Uploaded .yaml/.yml/.json file wins over pasted text.
const sourceFrom = (req) => (req.file ? req.file.buffer.toString('utf8') : String(req.body.content || ''));
const noteFrom = (req) => text(req.body.note, 200) || null;
const renderForm = (res, status, bp, content, error, conflict = null) =>
  res.status(status).render('admin/blueprint-form', { title: bp ? 'Edit blueprint' : 'Add blueprint', bp, content, error, conflict });

// Newest saved revision of a blueprint (number, when, by whom): the form remembers the number it was opened at.
const latestRevision = (id) => db.one(`SELECT v.version_no, v.created_at, u.name AS author FROM blueprint_versions v
  LEFT JOIN users u ON u.id=v.created_by WHERE v.blueprint_id=$1 ORDER BY v.version_no DESC LIMIT 1`, [id]);

router.get('/', async (req, res) => {
  const filter = text(req.query.q, 100);
  const where = `deleted_at IS NULL${filter ? ' AND title ILIKE $1' : ''}`, params = filter ? [likeOf(filter)] : [];
  const pg = await paginate(req, `SELECT COUNT(*)::int AS n FROM blueprints WHERE ${where}`, params);
  const sort = sortOf(req, { title: 'lower(b.title)', version: 'b.version', format: 'b.format', endpoints: 'endpoint_count', readers: 'reader_count', updated: 'b.updated_at' }, 'title');
  const blueprints = await db.query(`
    SELECT b.id,b.title,b.version,b.format,b.updated_at,
      (SELECT COUNT(*)::int FROM endpoints e WHERE e.blueprint_id=b.id) AS endpoint_count,
      (SELECT COUNT(*)::int FROM access_requests r JOIN users u ON u.id=r.user_id AND u.deleted_at IS NULL WHERE r.blueprint_id=b.id AND r.status='approved') AS reader_count
    FROM blueprints b WHERE ${where.replace(/\b(deleted_at|title)\b/g, 'b.$1')} ORDER BY ${sort.sql}, b.id ${limitSql(pg)}`, params);
  res.render('admin/blueprints', { title: 'Blueprints', blueprints, pg, filter, sort });
});

router.get('/new', (req, res) => renderForm(res, 200, null));

// Dry run for the form: validates the document and, when editing, diffs it against the current source.
// Nothing is saved. POST /manage/blueprints/preview[?for=<id>]
router.post('/preview', upload.single('file'), async (req, res) => {
  try {
    const source = sourceFrom(req);
    const { format, spec } = parseSpec(source);
    const endpoints = listEndpoints(spec);
    const out = {
      ok: true, format, title: spec.info.title.trim(), version: spec.info.version ? String(spec.info.version) : null,
      standard: spec.openapi ? `OpenAPI ${spec.openapi}` : `Swagger ${spec.swagger}`,
      endpointCount: endpoints.length, folders: new Set(endpoints.map((e) => e.tag)).size, ...lintSpec(source, spec),
    };
    const forId = /^\d{1,9}$/.test(String(req.query.for || '')) ? Number(req.query.for) : null;
    if (forId) {
      const cur = await getBlueprint(forId, 'id,source');
      if (cur) {
        out.diff = canonical(source) === canonical(cur.source) ? { same: true } : diffSpecs(cur.source, source);
        try { const p = parseSpec(cur.source).spec; out.current = { title: p.info.title.trim(), version: p.info.version ? String(p.info.version) : null }; } catch { /* legacy content */ }
      }
    }
    res.json(out);
  } catch (e) {
    res.json({ ok: false, error: e.message, line: e.line || null, column: e.column || null });
  }
});

// Renders the submitted (unsaved) document with the real viewer, for the form's Preview button (opens in a new tab).
// Nothing is saved. POST /manage/blueprints/preview/render
router.post('/preview/render', upload.single('file'), (req, res) => {
  let spec = null, error = null;
  try { spec = parseSpec(sourceFrom(req)).spec; } catch (e) { error = e.message; }
  res.render('admin/preview-frame', { title: 'Preview', error, specJson: spec && JSON.stringify(spec).replace(/</g, '\\u003c') });
});

router.post('/', upload.single('file'), async (req, res) => {
  try {
    const saved = await saveBlueprint(null, sourceFrom(req), req.user.id, noteFrom(req));
    await audit(req, 'blueprint.created', { type: 'blueprint', id: saved.id, detail: describeSave(saved) });
    flash(res, 'Blueprint added.');
    res.redirect(`/blueprints/${saved.id}`);
  } catch (e) {
    renderForm(res, 400, null, req.body.content, e.message);
  }
});

// Several at once (checkboxes on the list). No undo toast for a batch, so the form asks first.
router.post('/bulk-delete', async (req, res) => {
  const ids = [...new Set([].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  let n = 0;
  for (const id of ids) {
    const bp = await trash.deleteBlueprint(id, req.user.id);
    if (!bp) continue;
    n += 1;
    await audit(req, 'blueprint.deleted', { type: 'blueprint', id, detail: `Moved "${bp.title}" ${ver(bp.version)} to the trash (bulk)` });
  }
  flash(res, n ? `${n} blueprint${n === 1 ? '' : 's'} moved to the trash.` : 'Select at least one blueprint first.', n ? 'success' : 'error');
  res.redirect('/manage/blueprints');
});

router.get('/:id/edit', async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title,source');
  if (!bp) return notFound(res, 'Blueprint not found.');
  bp.revision = ((await latestRevision(bp.id)) || {}).version_no;
  renderForm(res, 200, bp, bp.source);
});

router.post('/:id', upload.single('file'), async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title,source');
  if (!bp) return notFound(res, 'Blueprint not found.');
  // Optimistic concurrency: the form carries the revision it was opened at. If someone saved a newer one meanwhile,
  // refuse (keeping the text the admin typed) unless they tick "overwrite". Saving identical content is never a conflict.
  const latest = await latestRevision(bp.id);
  const opened = Number(req.body.base);
  bp.revision = opened || (latest && latest.version_no);
  if (latest && opened && opened !== latest.version_no && !req.body.overwrite) {
    const content = sourceFrom(req);
    if (String(content).replace(/\r\n?/g, '\n').trimEnd() !== String(bp.source).replace(/\r\n?/g, '\n').trimEnd()) {
      return renderForm(res, 409, bp, content, 'This blueprint was changed while you were editing it. Your text is kept below; nothing was saved.',
        { revision: latest.version_no, author: latest.author, at: latest.created_at });
    }
  }
  try {
    const saved = await saveBlueprint(bp.id, sourceFrom(req), req.user.id, noteFrom(req));
    if (!saved.unchanged) await audit(req, 'blueprint.updated', { type: 'blueprint', id: bp.id, detail: describeSave(saved) });
    flash(res, saved.unchanged ? 'No changes: the content is identical to the current revision.' : 'Blueprint updated.', saved.unchanged ? 'info' : 'success');
    res.redirect('/manage/blueprints');
  } catch (e) {
    renderForm(res, 400, bp, req.body.content, e.message);
  }
});

router.post('/:id/delete', async (req, res) => {
  const bp = await trash.deleteBlueprint(req.params.id, req.user.id);
  if (bp) {
    const extra = [bp.cancelledRequests && `${bp.cancelledRequests} pending request${bp.cancelledRequests === 1 ? '' : 's'} cancelled`,
      bp.approvedKept && `${bp.approvedKept} approved access${bp.approvedKept === 1 ? '' : 'es'} kept for a restore`].filter(Boolean).join(', ');
    await audit(req, 'blueprint.deleted', { type: 'blueprint', id: req.params.id,
      detail: `Moved "${bp.title}" ${ver(bp.version)} to the trash — hidden from everyone${extra ? `; ${extra}` : ''}` });
  }
  flash(res, bp ? `“${bp.title}” moved to the trash.` : 'Blueprint not found.', bp ? 'success' : 'error', bp ? { url: `/manage/trash/blueprints/${bp.id}/restore` } : null);
  res.redirect('/manage/blueprints');
});

// ---- Who can read this blueprint: list (filter by name/email and role), assign, un-assign one or many ----
// Admins read everything, so only members and guests are listed here.
const back = (req) => `/manage/blueprints/${req.params.id}/access`;
const list = (rows) => rows.map((r) => r.email).join(', ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

router.get('/:id/access', async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title');
  if (!bp) return notFound(res, 'Blueprint not found.');
  const filter = text(req.query.q, 100);
  const role = ['member', 'guest'].includes(req.query.role) ? req.query.role : '';
  const params = [bp.id], conds = [`r.blueprint_id=$1`, `r.status='approved'`];
  if (filter) { params.push(likeOf(filter)); conds.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  if (role) { params.push(role); conds.push(`u.role=$${params.length}`); }
  const from = `FROM access_requests r JOIN users u ON u.id=r.user_id AND u.deleted_at IS NULL WHERE ${conds.join(' AND ')}`;
  const pg = await paginate(req, `SELECT COUNT(*)::int AS n ${from}`, params);
  const readers = await db.query(`SELECT u.id, u.name, u.email, u.role, u.active, r.decided_at ${from} ORDER BY lower(u.name), u.id ${limitSql(pg)}`, params);
  const candidates = await db.query(`
    SELECT u.id, u.name, u.email, u.role,
      EXISTS (SELECT 1 FROM access_requests r WHERE r.user_id=u.id AND r.blueprint_id=$1 AND r.status='pending') AS requested
    FROM users u WHERE u.deleted_at IS NULL AND u.active AND u.role <> 'admin'
      AND NOT EXISTS (SELECT 1 FROM access_requests r WHERE r.user_id=u.id AND r.blueprint_id=$1 AND r.status='approved')
    ORDER BY requested DESC, lower(u.name), u.id LIMIT 500`, [bp.id]);
  res.render('admin/blueprint-access', { title: `Access: ${bp.title}`, bp, readers, candidates, pg, filter, role });
});

router.post('/:id/access', async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title');
  if (!bp) return notFound(res, 'Blueprint not found.');
  const done = await access.grant([].concat(req.body.users || []), [bp.id], req.user.id);
  if (done.length) await audit(req, 'blueprint.access_changed', { type: 'blueprint', id: bp.id, detail: `Assigned "${bp.title}" to ${list(done)}` });
  flash(res, done.length ? `Assigned to ${plural(done.length, 'user')}.` : 'Select at least one user to assign.', done.length ? 'success' : 'error');
  res.redirect(back(req));
});

// Un-assign one user (/access/:uid/revoke) or several (/access/revoke with users[]).
const revokeUsers = (pick) => async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title');
  if (!bp) return notFound(res, 'Blueprint not found.');
  const done = await access.revoke(pick(req), [bp.id], req.user.id);
  if (done.length) await audit(req, 'blueprint.access_changed', { type: 'blueprint', id: bp.id, detail: `Removed ${list(done)} from "${bp.title}"` });
  flash(res, done.length ? `Removed access for ${plural(done.length, 'user')}.` : 'Select at least one user first.', done.length ? 'success' : 'error',
    done.length && done.length <= 50 ? { url: `/manage/blueprints/${bp.id}/access`, body: done.map((d) => `users=${d.user_id}`).join('&') } : null);
  res.redirect(back(req));
};
router.post('/:id/access/revoke', revokeUsers((req) => [].concat(req.body.users || [])));
router.post('/:id/access/:uid/revoke', revokeUsers((req) => [req.params.uid]));

// ---- Version history ----
const getVersion = (req) => db.one(
  `SELECT v.version_no, v.format, v.source FROM blueprint_versions v JOIN blueprints b ON b.id=v.blueprint_id AND b.deleted_at IS NULL
   WHERE v.id=$2 AND v.blueprint_id=$1`, [req.params.id, req.params.vid]);

router.get('/:id/versions', async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title');
  if (!bp) return notFound(res, 'Blueprint not found.');
  const rows = await db.query(`
    SELECT v.id, v.version_no, v.title, v.version, v.format, v.source, v.note, v.created_at, u.name AS author
    FROM blueprint_versions v LEFT JOIN users u ON u.id=v.created_by
    WHERE v.blueprint_id=$1 ORDER BY v.version_no ASC`, [bp.id]);
  const versions = rows.map((v, i) => ({ ...v, source: undefined, diff: diffSpecs(i ? rows[i - 1].source : null, v.source) })).reverse();
  res.render('admin/versions', { title: `History: ${bp.title}`, bp, versions });
});

router.get('/:id/versions/:vid/source', async (req, res) => {
  const v = await getVersion(req);
  if (!v) return notFound(res, 'Version not found.');
  res.set('Content-Disposition', `attachment; filename="blueprint-${req.params.id}-v${v.version_no}.${v.format}"`)
    .type(v.format === 'json' ? 'application/json' : 'text/yaml').send(v.source);
});

// Restoring saves the old content as a NEW version on top, so history is never lost.
router.post('/:id/versions/:vid/restore', async (req, res) => {
  const v = await getVersion(req);
  if (!v) return notFound(res, 'Version not found.');
  const saved = await saveBlueprint(Number(req.params.id), v.source, req.user.id, `Restored from revision ${v.version_no}`);
  await audit(req, 'blueprint.restored', { type: 'blueprint', id: req.params.id,
    detail: describeSave(saved, { restoredFrom: { revision: v.version_no, version: saved.version } }) });
  flash(res, `Restored revision ${v.version_no} as the current one.`);
  res.redirect(`/manage/blueprints/${req.params.id}/versions`);
});

// Multer errors (e.g. file too large) -> friendly form error instead of a 500.
router.use((err, req, res, next) => {
  if (!(err instanceof multer.MulterError)) return next(err);
  if (req.path === '/preview/render') return res.status(400).render('admin/preview-frame', { title: 'Preview', error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : err.message, specJson: null });
  if (req.path === '/preview') return res.json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : err.message });
  renderForm(res, 400, null, '', err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : err.message);
});

module.exports = router;
