const config = require('../config');

const FLASH_TTL_MS = 10_000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const cookieBase = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies };
const sessionCookie = { ...cookieBase, maxAge: SESSION_TTL_MS };

// One-shot message shown on the next page, as a toast. `type` is 'success' (default), 'error' or 'info';
// it travels in the cookie as a "type|" prefix.
const FLASH_TYPES = ['success', 'error', 'info'];
// `undo` ({ url, body }) adds an Undo button to the toast: it POSTs `body` to the same-site /manage `url`.
const flash = (res, msg, type = 'success', undo = null) =>
  res.cookie('flash', `${type}|${msg}${undo ? `\t${undo.url}\t${undo.body || ''}` : ''}`, { ...cookieBase, maxAge: FLASH_TTL_MS });
const readFlash = (raw) => {
  if (!raw) return null;
  const i = String(raw).indexOf('|');
  const type = i > 0 ? raw.slice(0, i) : '';
  const [message, url, body] = (FLASH_TYPES.includes(type) ? raw.slice(i + 1) : String(raw)).split('\t');
  const undo = url && /^\/manage\/[\w/-]+$/.test(url) ? { url, body: body || '' } : null;
  return { type: FLASH_TYPES.includes(type) ? type : 'success', message, undo };
};

// Error pages.
const errorPage = (res, status, title, message) => res.status(status).render('error', { title, message });
const notFound = (res, message = 'Page not found.') => errorPage(res, 404, 'Not found', message);
const badLink = (res, title, message) => errorPage(res, 400, title, message);

// Public URL for links in emails.
const baseUrl = (req) => config.baseUrl || `${req.protocol}://${req.get('host')}`;

// router.param handler: reject non-numeric ids with a 404 instead of hitting the database.
function numericParam(req, res, next, value) {
  if (!/^\d{1,9}$/.test(value)) return notFound(res);
  next();
}

// Load a row for the route or answer 404. Usage: router.get('/x/:id', load(fn), handler) -> req.row
const load = (fetcher, label = 'Item') => async (req, res, next) => {
  const row = await fetcher(req);
  if (!row) return notFound(res, `${label} not found.`);
  req.row = row;
  next();
};

module.exports = { cookieBase, sessionCookie, flash, readFlash, errorPage, notFound, badLink, baseUrl, numericParam, load };
