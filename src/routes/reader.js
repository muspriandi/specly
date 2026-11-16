// Everything a reader can do with one blueprint: view it, fetch its spec / original file / Postman collection, read its
// changelog. The same routes are served twice: for signed-in readers at /blueprints/:id (access rules apply) and for
// holders of a share link at /s/:token (read-only, no account). `resolve(req, res, kind)` decides who may read what: it
// returns { id, base } or answers the request itself and returns null. kind: 'page' | 'json' | 'file'.
const express = require('express');
const db = require('../db');
const { getBlueprint, diffSpecs } = require('../services/blueprints');
const { toPostman } = require('../services/postman');
const { paginate } = require('../lib/paginate');

const slug = (t, fallback) => String(t).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || fallback;

function readerRouter(resolve, { shared = false } = {}) {
  const r = express.Router({ mergeParams: true });
  if (shared) r.use((req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store' }); next(); });

  r.get('/', async (req, res) => {
    const ctx = await resolve(req, res, 'page');
    if (!ctx) return;
    const bp = await getBlueprint(ctx.id);
    const watching = !shared && req.user ? !!(await db.one('SELECT 1 FROM blueprint_watchers WHERE user_id=$1 AND blueprint_id=$2', [req.user.id, bp.id])) : null;
    res.render('viewer', { title: bp.title, bp, scope: shared ? null : { id: bp.id, title: bp.title }, classic: req.query.view === 'swagger', base: ctx.base, shared, watching });
  });

  r.get('/spec.json', async (req, res) => {
    const ctx = await resolve(req, res, 'json');
    if (ctx) res.json((await getBlueprint(ctx.id, 'id,spec')).spec);
  });

  // Download the original document as uploaded (yaml or json).
  r.get('/source', async (req, res) => {
    const ctx = await resolve(req, res, 'file');
    if (!ctx) return;
    const bp = await getBlueprint(ctx.id, 'id,title,format,source');
    res.set('Content-Disposition', `attachment; filename="${slug(bp.title, 'openapi')}.${bp.format}"`)
      .type(bp.format === 'json' ? 'application/json' : 'text/yaml').send(bp.source);
  });

  // Postman Collection v2.1 generated from the spec.
  r.get('/postman.json', async (req, res) => {
    const ctx = await resolve(req, res, 'file');
    if (!ctx) return;
    const bp = await getBlueprint(ctx.id, 'id,title,spec');
    res.set('Content-Disposition', `attachment; filename="${slug(bp.title, 'api')}.postman_collection.json"`).json(toPostman(bp.spec));
  });

  // What changed in each revision, in reader terms: endpoints added / changed / removed / newly deprecated.
  r.get('/changelog', async (req, res) => {
    const ctx = await resolve(req, res, 'page');
    if (!ctx) return;
    const bp = await getBlueprint(ctx.id);
    const pg = await paginate(req, 'SELECT COUNT(*)::int AS n FROM blueprint_versions WHERE blueprint_id=$1', [bp.id]);
    // one extra (older) row so the last entry on the page can be compared with what came before it
    const rows = await db.query(`SELECT version_no, version, note, created_at, source FROM blueprint_versions
      WHERE blueprint_id=$1 ORDER BY version_no DESC LIMIT ${pg.limit + 1} OFFSET ${pg.offset}`, [bp.id]);
    const entries = rows.slice(0, pg.limit).map((v, i) => ({ ...v, source: undefined, initial: v.version_no === 1, diff: diffSpecs(rows[i + 1] ? rows[i + 1].source : null, v.source) }));
    res.render('changelog', { title: `Changelog: ${bp.title}`, bp, entries, pg, base: ctx.base, shared });
  });

  return r;
}

module.exports = { readerRouter };
