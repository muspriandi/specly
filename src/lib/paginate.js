const db = require('../db');

// Offset pagination shared by the Manage lists. Query string: ?page=N&limit=M (a list with two tables on one
// page uses its own page parameter, e.g. ?hpage=2). Counts first so an out-of-range page clamps to the last one.
const DEFAULT_LIMIT = 50, MIN_LIMIT = 5, MAX_LIMIT = 200;
const SIZES = [25, 50, 100, 200];

async function paginate(req, countSql, params = [], { param = 'page' } = {}) {
  const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
  const total = (await db.one(countSql, params)).n;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, parseInt(req.query[param], 10) || 1), pages);
  const offset = (page - 1) * limit;
  return { param, page, pages, limit, total, offset, from: total ? offset + 1 : 0, to: Math.min(total, offset + limit), sizes: SIZES };
}

// SQL fragment for "LIMIT n OFFSET m" built from a paginate() result (both are validated integers).
const limitSql = (pg) => `LIMIT ${pg.limit} OFFSET ${pg.offset}`;
// Escapes % and _ so user text matches literally inside ILIKE.
const likeOf = (s) => `%${String(s).replace(/[\\%_]/g, '\\$&')}%`;

module.exports = { paginate, limitSql, likeOf, DEFAULT_LIMIT };
