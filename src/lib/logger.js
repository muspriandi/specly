const crypto = require('crypto');
const config = require('../config');
const log = require('./log');

// One log line per request with a request id that is also sent to the client as X-Request-Id and shown on error pages,
// so "something went wrong" can be traced to the exact lines. `req.log` carries that id for any line written while handling it.
// One-time tokens in URLs (reset / invite / share links) are masked, and query strings are never logged.
// Severity: 5xx error; 401, 403, 429 and slow requests warn; the rest info. (Static files and /healthz are not logged.)
const SECRET_PATH = /^(\/(?:reset|invite|s))\/[^/]+/;
const safePath = (p) => p.replace(SECRET_PATH, '$1/:token');
// The path as the client sent it (without the query string, tokens masked). req.path is relative inside a mounted
// router (e.g. under /s/:token), so the original URL is used.
const pathOf = (req) => safePath(String(req.originalUrl || req.url || '/').split('?')[0]);

function requestLog(req, res, next) {
  req.id = crypto.randomBytes(6).toString('hex');
  req.log = log.child({ req: req.id });
  res.setHeader('X-Request-Id', req.id);
  if (req.path.startsWith('/static/') || req.path === '/healthz') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    const status = res.statusCode;
    const slow = config.slowRequestMs > 0 && ms >= config.slowRequestMs;
    const level = status >= 500 ? 'error' : [401, 403, 429].includes(status) || slow ? 'warn' : 'info';
    const path = pathOf(req);
    log[level](`${req.method} ${path} ${status} ${ms}ms`, { req: req.id, event: 'http.request', method: req.method, path, status, ms,
      user: req.user ? req.user.id : null, ip: req.ip, slow: slow || undefined, bytes: Number(res.get('content-length')) || undefined });
  });
  next();
}

module.exports = { requestLog, safePath, pathOf };
