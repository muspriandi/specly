const crypto = require('crypto');
const helmet = require('helmet');
const config = require('../config');
const { cookieBase } = require('./http');
const log = require('./log');
const { pathOf } = require('./logger');

// Strict CSP: no inline scripts (confirm dialogs use data-confirm + /static/app.js).
const headers = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Swagger UI sets inline styles
      imgSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"], // same-origin only: the blueprint form embeds its draft preview
      objectSrc: ["'none'"],
      upgradeInsecureRequests: config.secureCookies ? [] : null,
    },
  },
  hsts: config.secureCookies,
  referrerPolicy: { policy: 'same-origin' },
});

// ---- CSRF (double-submit cookie) ----
// Every page gets a random token in a cookie; state-changing requests must echo it
// in a hidden "_csrf" field (or ?_csrf= for multipart forms, which are parsed later).
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function csrf(req, res, next) {
  let token = req.cookies.csrf;
  if (!token || !/^[\w-]{20,64}$/.test(token)) {
    token = crypto.randomBytes(24).toString('base64url');
    res.cookie('csrf', token, cookieBase);
  }
  res.locals.csrfToken = token;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.query._csrf;
  if (!sent || !safeEqual(sent, token)) {
    log.warn('security', { event: 'csrf.rejected', req: req.id, method: req.method, path: pathOf(req), user: req.user ? req.user.id : null, ip: req.ip });
    return res.status(403).render('error', { title: 'Session expired', message: 'Your form expired. Go back, refresh the page and try again.' });
  }
  next();
}

// ---- Rate limiting (in memory, fixed window) ----
function createLimiter({ max, windowMs }) {
  const hits = new Map();
  setInterval(() => { // drop expired windows
    const now = Date.now();
    for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  }, windowMs).unref();
  return {
    isLimited(key) {
      const h = hits.get(key);
      return !!h && h.until > Date.now() && h.count >= max;
    },
    hit(key) {
      const h = hits.get(key);
      if (!h || h.until < Date.now()) hits.set(key, { count: 1, until: Date.now() + windowMs });
      else h.count++;
    },
    reset: (key) => hits.delete(key),
  };
}

// Express middleware: answer 429 once `key(req)` has made `max` requests in the window.
function rateLimit({ max, windowMs, key = (req) => req.ip }) {
  const limiter = createLimiter({ max, windowMs });
  return (req, res, next) => {
    const k = key(req);
    if (limiter.isLimited(k)) {
      log.warn('security', { event: 'rate_limited', req: req.id, path: pathOf(req), ip: req.ip });
      return res.status(429).render('error', { title: 'Too many requests', message: 'Please wait a few minutes and try again.' });
    }
    limiter.hit(k);
    next();
  };
}

module.exports = { headers, csrf, createLimiter, rateLimit };
