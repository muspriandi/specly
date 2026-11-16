const router = require('./router')();
const db = require('../../db');
const { text } = require('../../lib/validate');
const { audit } = require('../../services/audit');

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

// CSV export of the same filters (group, q), newest first, in batches so a large log never sits in memory. Capped at 50,000 rows.
// Cells that start with = + - @ (or a control character) are prefixed with an apostrophe, so a spreadsheet never runs them as a formula.
const EXPORT_MAX = 50_000, EXPORT_BATCH = 2000;
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
router.get('/export.csv', async (req, res) => {
  const q = text(req.query.q, 100);
  const group = GROUPS.includes(req.query.group) ? req.query.group : '';
  const conds = [], params = [];
  if (group) { params.push(`${group}.%`); conds.push(`action LIKE $${params.length}`); }
  if (q) { params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); conds.push(`(action ILIKE $${params.length} OR actor_label ILIKE $${params.length} OR detail ILIKE $${params.length} OR ip ILIKE $${params.length})`); }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
  res.write('time,actor,action,target,detail,ip\r\n');
  let sent = 0, last = null;
  while (sent < EXPORT_MAX) {
    const p = [...params];
    const where = [...conds];
    if (last !== null) { p.push(last); where.push(`id < $${p.length}`); }
    const rows = await db.query(`SELECT id, at, actor_label, action, target_type, target_id, detail, ip FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(EXPORT_BATCH, EXPORT_MAX - sent)}`, p);
    if (!rows.length) break;
    for (const r of rows) res.write([r.at.toISOString(), r.actor_label, r.action, r.target_type ? `${r.target_type}:${r.target_id || ''}` : '', r.detail, r.ip].map(csvCell).join(',') + '\r\n');
    sent += rows.length; last = rows[rows.length - 1].id;
  }
  await audit(req, 'audit.exported', { detail: `Exported ${sent} audit log row${sent === 1 ? '' : 's'}${group ? ` (group ${group})` : ''}${q ? ` matching "${q}"` : ''}` });
  res.end();
});

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
