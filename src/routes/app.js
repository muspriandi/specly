const router = require('express').Router();
const db = require('../db');
const { requireLogin } = require('../services/auth');
const { canView, blueprintsFor } = require('../services/access');
const { audit } = require('../services/audit');
const { notifyAdminsOfRequest } = require('../services/notify');
const { getBlueprint } = require('../services/blueprints');
const { flash, notFound, errorPage, numericParam } = require('../lib/http');
const { text } = require('../lib/validate');

router.use(requireLogin);
router.param('id', numericParam);

router.get('/', async (req, res) => {
  res.render('home', { title: 'API Documentation', blueprints: await blueprintsFor(req.user) });
});

// ---- Search ----
// SQL access filter shared by the search queries: $3 = user id, $4 = user is restricted (not an admin).
const READABLE = `(NOT $4 OR EXISTS (SELECT 1 FROM access_requests r WHERE r.user_id=$3 AND r.blueprint_id=e.blueprint_id AND r.status='approved'))`;
// Global by default. With ?bp=<id> (sent from a blueprint's page) the search is limited to that blueprint's endpoints.
// Returns { id, title } for a readable blueprint, null when unscoped, or false when the scope is invalid/forbidden.
async function searchScope(req) {
  if (req.query.bp === undefined || req.query.bp === '') return null;
  const id = Number(req.query.bp);
  if (!Number.isInteger(id) || id < 1) return false;
  const bp = await getBlueprint(id, 'id,title');
  return bp && (await canView(req.user, bp.id)) ? { id: bp.id, title: bp.title } : false;
}

// Searching for just a method name ("get", "post") matches that method exactly; every other arm of the search is a
// trigram-indexed substring match, so adding a substring match on the method too would force a full table scan.
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);

router.get('/search', async (req, res) => {
  const q = text(req.query.q, 100);
  const scope = await searchScope(req);
  if (scope === false) return notFound(res, 'Blueprint not found.');
  let blueprints = [], endpoints = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    if (!scope) blueprints = await blueprintsFor(req.user, `WHERE b.title ILIKE $2 OR b.description ILIKE $2`, [like]);
    // Endpoints are only searched inside blueprints the user may read (filtered in SQL, no per-row lookups).
    endpoints = await db.query(`
      SELECT e.*, b.title AS blueprint_title FROM endpoints e JOIN blueprints b ON b.id=e.blueprint_id
      WHERE (e.path ILIKE $1 OR e.summary ILIKE $1 OR e.operation_id ILIKE $1${METHODS.has(q.toUpperCase()) ? ' OR e.method = $5' : ''})
        AND ($2::int IS NULL OR e.blueprint_id = $2) AND b.deleted_at IS NULL AND ${READABLE}
      ORDER BY lower(b.title), e.path LIMIT 200`, [like, scope ? scope.id : null, req.user.id, req.user.role !== 'admin', ...(METHODS.has(q.toUpperCase()) ? [q.toUpperCase()] : [])]);
  }
  res.render('search', { title: q ? `Search: ${q}` : 'Search', q, blueprints, endpoints, scope });
});

// Type-ahead for the header search: a few blueprints and endpoints the user may read. GET /search/suggest?q=
router.get('/search/suggest', async (req, res) => {
  const q = text(req.query.q, 100);
  const scope = await searchScope(req);
  if (q.length < 2 || scope === false) return res.json({ blueprints: [], endpoints: [] });
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const blueprints = scope ? [] : (await blueprintsFor(req.user, `WHERE b.title ILIKE $2`, [like])).filter((b) => b.access === 'granted').slice(0, 4)
    .map((b) => ({ id: b.id, title: b.title }));
  const rows = await db.query(`
    SELECT e.method, e.path, e.summary, e.operation_id, e.tag, e.blueprint_id, e.deprecated, e.status, b.title AS blueprint_title
    FROM endpoints e JOIN blueprints b ON b.id=e.blueprint_id
    WHERE (e.path ILIKE $1 OR e.summary ILIKE $1 OR e.operation_id ILIKE $1)
      AND ($2::int IS NULL OR e.blueprint_id = $2) AND b.deleted_at IS NULL AND ${READABLE}
    ORDER BY lower(b.title), e.path LIMIT 6`, [like, scope ? scope.id : null, req.user.id, req.user.role !== 'admin']);
  const endpoints = rows.map((e) => ({ method: e.method, path: e.path, summary: e.summary, blueprint: e.blueprint_title, deprecated: !!e.deprecated, status: e.status || '',
    href: `/blueprints/${e.blueprint_id}#/${encodeURIComponent(e.tag)}/${encodeURIComponent(e.operation_id || (e.method.toLowerCase() + e.path.replace(/[^\w]/g, '_')))}` }));
  res.json({ blueprints, endpoints });
});

// ---- Read a blueprint ----
// Guests without access get an explanatory 403; unknown ids get 404.
router.get('/blueprints/:id', async (req, res) => {
  const bp = await getBlueprint(req.params.id);
  if (!bp) return notFound(res, 'Blueprint not found.');
  if (!(await canView(req.user, bp.id))) {
    return errorPage(res, 403, 'No access', req.user.role === 'member' ? 'This blueprint is not assigned to you. Request access from the home page.' : 'This blueprint is not assigned to you. Ask an admin to assign it.');
  }
  res.render('viewer', { title: bp.title, bp, scope: { id: bp.id, title: bp.title }, classic: req.query.view === 'swagger' });
});

router.get('/blueprints/:id/spec.json', async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,spec');
  if (!bp || !(await canView(req.user, bp.id))) return res.status(404).json({ error: 'Not found' });
  res.json(bp.spec);
});

// Download the original document as uploaded (yaml or json).
router.get('/blueprints/:id/source', async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title,format,source');
  if (!bp || !(await canView(req.user, bp.id))) return notFound(res);
  const name = bp.title.replace(/[^\w.-]+/g, '-').toLowerCase() || 'openapi';
  res.set('Content-Disposition', `attachment; filename="${name}.${bp.format}"`)
    .type(bp.format === 'json' ? 'application/json' : 'text/yaml').send(bp.source);
});

// ---- Member: request access (guests cannot; an admin assigns blueprints to them) ----
router.post('/blueprints/:id/request', async (req, res) => {
  const bp = await getBlueprint(req.params.id, 'id,title');
  if (!bp) return notFound(res, 'Blueprint not found.');
  const existing = await db.one(`SELECT 1 FROM access_requests WHERE user_id=$1 AND blueprint_id=$2 AND status IN ('pending','approved')`,
    [req.user.id, bp.id]);
  if (req.user.role === 'guest') return errorPage(res, 403, 'Not allowed', 'Guests cannot request access. Ask an admin to assign the blueprint to you.');
  if (existing || req.user.role === 'admin') {
    flash(res, 'You already have access or a pending request.', 'info');
  } else {
    await db.query('INSERT INTO access_requests (user_id,blueprint_id,message) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [req.user.id, bp.id, text(req.body.message, 500)]);
    const msg = text(req.body.message, 120);
    await audit(req, 'request.created', { type: 'blueprint', id: bp.id,
      detail: `Requested access to "${bp.title}"${msg ? ` — "${msg}"` : ''}` });
    await notifyAdminsOfRequest(req, req.user, bp, msg);
    flash(res, `Access to "${bp.title}" requested. An admin will review it.`);
  }
  res.redirect('/');
});

module.exports = router;
