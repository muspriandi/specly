const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const swaggerUiDist = require('swagger-ui-dist');
const config = require('./config');
const db = require('./db');
const auth = require('./services/auth');
const { fmtDate } = require('./lib/format');
const { icon } = require('./lib/icons');
const { headers, csrf, rateLimit } = require('./lib/security');
const { requestLog, pathOf } = require('./lib/logger');
const log = require('./lib/log');
const shares = require('./services/shares');
const { readerRouter } = require('./routes/reader');
const { errorPage, notFound, readFlash } = require('./lib/http');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(requestLog);
  // Liveness/readiness probe for load balancers and orchestrators: 200 when the database answers, 503 otherwise.
  app.get('/healthz', async (req, res) => {
    const ok = await db.ping();
    res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({ status: ok ? 'ok' : 'unavailable' });
  });
  app.use(headers);
  app.use((req, res, next) => { // browser features this app never uses are switched off
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()');
    next();
  });
  app.use('/static/swagger', express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false }));
  // Markdown rendering for descriptions (client side), served from node_modules.
  app.use('/static/vendor/marked', express.static(path.dirname(require.resolve('marked'))));
  app.use('/static/vendor/dompurify', express.static(path.dirname(require.resolve('dompurify'))));
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));

  // Everything below /static is dynamic and often personal (accounts, access lists, specs): browsers and proxies must not keep it.
  app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(auth.loadUser);
  // Template locals + one-shot flash message.
  app.use((req, res, next) => {
    Object.assign(res.locals, { user: req.user, q: '', fmt: fmtDate, icon, currentPath: req.path, query: req.query, pendingCount: 0, flash: readFlash(req.cookies.flash), error: undefined });
    if (res.locals.flash) res.clearCookie('flash');
    next();
  });
  // Badge in the admin menu: number of access requests waiting for review.
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || !req.user || req.user.role !== 'admin') return next();
    try {
      const row = await db.one(`SELECT count(*)::int AS n FROM access_requests WHERE status='pending'`);
      res.locals.pendingCount = row ? row.n : 0;
    } catch { /* the badge is cosmetic */ }
    next();
  });
  app.use(csrf); // after the locals so its 403 page can render the layout

  // Share links: read one blueprint without an account. GET only, throttled per IP, nothing is ever written.
  const resolveShare = async (req, res, kind) => {
    const found = await shares.find(req.params.token);
    if (!found) {
      log.warn('security', { event: 'share.invalid', req: req.id, ip: req.ip });
      if (kind === 'json') res.status(404).json({ error: 'Not found' });
      else errorPage(res, 404, 'Link not available', 'This link is invalid, has expired or was revoked. Ask the person who shared it for a new one.');
      return null;
    }
    return { id: found.id, base: `/s/${req.params.token}` };
  };
  app.use('/s/:token', rateLimit({ max: 120, windowMs: 60 * 1000 }), readerRouter(resolveShare, { shared: true }));

  app.use(require('./routes/public'));
  app.use('/manage', require('./routes/admin'));
  app.use(require('./routes/account'));
  app.use(require('./routes/app'));

  app.use((req, res) => notFound(res));
  // Express 5 forwards rejected async handlers here.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') return errorPage(res, 413, 'Too large', 'The request is too large.');
    log.error('request failed', { event: 'http.error', req: req.id, method: req.method, path: pathOf(req), user: req.user ? req.user.id : null, ip: req.ip, err });
    errorPage(res, 500, 'Error', `Something went wrong. If it keeps happening, report reference ${req.id}.`);
  });
  return app;
}

module.exports = { createApp };
