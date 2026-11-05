const router = require('./router')();
const db = require('../../db');
const { text } = require('../../lib/validate');

const GROUPS = ['auth', 'user', 'invite', 'request', 'blueprint'];
const DEFAULT_LIMIT = 50, MIN_LIMIT = 5, MAX_LIMIT = 200;
// Sortable columns (whitelist: the values are interpolated into SQL). `at` is the primary key, which is time-ordered.
// Nullable columns are COALESCEd so the keyset comparison below never meets NULL.
const SORTS = { at: 'id', who: "COALESCE(actor_label,'')", action: 'action', detail: "COALESCE(detail,'')", ip: "COALESCE(ip,'')" };
const FIELD = { who: 'actor_label', detail: 'detail', ip: 'ip', action: 'action' };

// Cursor = base64url JSON of the sort key of the boundary row: [id] for `at`, [value, id] otherwise.
const encode = (parts) => Buffer.from(JSON.stringify(parts)).toString('base64url');
function decode(raw, sort) {
  try {
    const p = JSON.parse(Buffer.from(String(raw || ''), 'base64url').toString('utf8'));
    const okId = (v) => Number.isSafeInteger(v) && v > 0;
    if (sort === 'at') return Array.isArray(p) && p.length === 1 && okId(p[0]) ? p : null;
    return Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && okId(p[1]) ? p : null;
  } catch { return null; }
}

// Keyset (cursor) pagination: `after` = rows following the cursor in the current order, `before` = rows preceding it.
// No OFFSET and no COUNT(*): cost stays flat however deep you go, and rows added meanwhile never shift pages.
router.get('/', async (req, res) => {
  const q = text(req.query.q, 100);
  const group = GROUPS.includes(req.query.group) ? req.query.group : '';
  const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'at';
  const dir = req.query.dir === 'asc' ? 'asc' : req.query.dir === 'desc' ? 'desc' : (sort === 'at' ? 'desc' : 'asc');
  const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
  const backwards = req.query.before !== undefined && req.query.after === undefined;
  const cursor = decode(backwards ? req.query.before : req.query.after, sort);

  const where = [], params = [];
  // Every '?' in `sql` refers to the same value.
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (group) add('action LIKE ?', `${group}.%`);
  if (q) add('(action ILIKE ? OR actor_label ILIKE ? OR detail ILIKE ? OR ip ILIKE ?)', `%${q.replace(/[\\%_]/g, '\\$&')}%`);
  if (cursor) {
    const op = (dir === 'asc') !== backwards ? '>' : '<'; // moving forward in asc order, or backwards in desc order
    if (sort === 'at') add(`id ${op} ?`, cursor[0]);
    else { params.push(cursor[0], cursor[1]); where.push(`(${SORTS[sort]}, id) ${op} ($${params.length - 1}, $${params.length})`); }
  }
  const order = (dir === 'asc') !== backwards ? 'ASC' : 'DESC';
  const rows = await db.query(
    `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${SORTS[sort]} ${order}, id ${order} LIMIT ${limit + 1}`, params);
  const more = rows.length > limit;
  if (more) rows.pop();
  if (backwards) rows.reverse();

  const key = (r) => encode(sort === 'at' ? [Number(r.id)] : [String(r[FIELD[sort]] ?? ''), Number(r.id)]); // bigint ids arrive as strings
  // Coming from a cursor means there is a page on the other side; `more` tells about the side we moved towards.
  const hasNext = rows.length > 0 && (backwards ? !!cursor : more);
  const hasPrev = rows.length > 0 && (backwards ? more : !!cursor);
  res.render('admin/audit', {
    title: 'Audit log', rows, q, group, sort, dir, limit, groups: GROUPS, limits: [25, DEFAULT_LIMIT, 100, MAX_LIMIT],
    next: hasNext ? key(rows[rows.length - 1]) : null,
    prev: hasPrev ? key(rows[0]) : null,
  });
});

module.exports = router;
