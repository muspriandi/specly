const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const swaggerUiDist = require('swagger-ui-dist');
const config = require('./config');
const db = require('./db');
const auth = require('./services/auth');
const { fmtDate } = require('./lib/format');
const { icon } = require('./lib/icons');
const { headers, csrf } = require('./lib/security');
const { errorPage, notFound, readFlash } = require('./lib/http');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(headers);
  app.use('/static/swagger', express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false }));
  // Markdown rendering for descriptions (client side), served from node_modules.
  app.use('/static/vendor/marked', express.static(path.dirname(require.resolve('marked'))));
  app.use('/static/vendor/dompurify', express.static(path.dirname(require.resolve('dompurify'))));
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));

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

  app.use(require('./routes/public'));
  app.use('/manage', require('./routes/admin'));
  app.use(require('./routes/account'));
  app.use(require('./routes/app'));

  app.use((req, res) => notFound(res));
  // Express 5 forwards rejected async handlers here.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') return errorPage(res, 413, 'Too large', 'The request is too large.');
    console.error(err);
    errorPage(res, 500, 'Error', 'Something went wrong.');
  });
  return app;
}

module.exports = { createApp };
