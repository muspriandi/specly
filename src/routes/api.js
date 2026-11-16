// Machine API (no cookies, no sessions, no CSRF: it is authenticated by a bearer token only and mounted before the CSRF check).
//   PUT /api/v1/blueprints/:id     body = the OpenAPI / Swagger document (YAML or JSON), optional header X-Change-Note
const express = require('express');
const { rateLimit, createLimiter } = require('../lib/security');
const tokens = require('../services/apitokens');
const { saveBlueprint, describeSave } = require('../services/blueprints');
const { audit } = require('../services/audit');
const { notifyWatchers } = require('../services/notify');
const log = require('../lib/log');

const MAX_BODY = '5mb';
const tokenHits = createLimiter({ max: 60, windowMs: 60 * 1000 });
const router = express.Router();

const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });

// Throttle by address first (so guessing tokens is slow), then by token.
router.use(rateLimit({ max: 300, windowMs: 60 * 1000, json: true }));

router.put('/blueprints/:id', express.text({ type: () => true, limit: MAX_BODY }), async (req, res) => {
  const header = String(req.get('authorization') || '');
  const presented = /^Bearer\s+(\S+)$/i.exec(header);
  const token = presented && await tokens.authenticate(presented[1]);
  if (!token) {
    log.warn('security', { event: 'api.token_rejected', req: req.id, ip: req.ip });
    return res.status(401).set('WWW-Authenticate', 'Bearer realm="specly"').json({ ok: false, error: 'A valid API token is required (Authorization: Bearer spk_…).' });
  }
  if (String(token.blueprint_id) !== String(req.params.id)) return fail(res, 403, 'This token is not valid for that blueprint.');
  if (tokenHits.isLimited(token.id)) return res.status(429).set('Retry-After', '60').json({ ok: false, error: 'Too many publishes with this token. Retry in a minute.' });
  tokenHits.hit(token.id);
  const type = String(req.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (type && !/^(application\/(json|ya?ml|x-ya?ml|octet-stream)|text\/(plain|ya?ml|x-ya?ml))$/.test(type)) {
    return fail(res, 415, 'Send the document as application/yaml, application/json or text/plain.');
  }
  if (typeof req.body !== 'string' || !req.body.trim()) return fail(res, 400, 'The request body must be the OpenAPI / Swagger document.');

  const note = String(req.get('x-change-note') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
  try {
    const saved = await saveBlueprint(token.blueprint_id, req.body, null, `${note ? `${note} ` : ''}(API token "${token.name}")`);
    if (!saved.unchanged) {
      await audit(req, 'blueprint.updated', { actor: { id: null, email: `api token: ${token.name}` }, type: 'blueprint', id: token.blueprint_id, detail: describeSave(saved) });
      notifyWatchers(req, token.blueprint_id, saved);
    }
    const d = saved.diff || { added: [], changed: [], removed: [], deprecated: [] };
    res.json({ ok: true, unchanged: !!saved.unchanged, revision: saved.revision, title: saved.title, version: saved.version, endpoints: saved.endpointCount,
      diff: { added: d.added.length, changed: d.changed.length, removed: d.removed.length, deprecated: d.deprecated.length }, breaking: (d.breaking || []).map((b) => `${b.endpoint}: ${b.change}`) });
  } catch (e) {
    fail(res, 400, e.message, { line: e.line || null, column: e.column || null });
  }
});

// Errors raised by the body parser (too large, malformed) answer in JSON like everything else here.
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return fail(res, 413, `The document is larger than ${MAX_BODY}.`);
  if (err.status && err.status < 500) return fail(res, err.status, 'The request could not be read.');
  next(err);
});

router.use((req, res) => fail(res, 404, 'Unknown API endpoint.'));

module.exports = router;
