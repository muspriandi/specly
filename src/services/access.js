const db = require('../db');

// Admins read everything. Members and guests read only the blueprints assigned to them (an approved access row):
// members get there by requesting access, guests only when an admin assigns the blueprint.
async function canView(user, blueprintId) {
  if (user.role === 'admin') return true;
  return !!(await db.one(`SELECT 1 FROM access_requests WHERE user_id=$1 AND blueprint_id=$2 AND status='approved'`,
    [user.id, blueprintId]));
}

// Blueprints with the user's access state: 'granted' | 'pending' | 'rejected' | 'none'.
// `where` may use $2, $3… for `params` ($1 is always the user id).
async function blueprintsFor(user, where = '', params = []) {
  const rows = await db.query(`
    SELECT b.id, b.title, b.version, left(b.description, 400) AS description, b.format, b.updated_at,
      (SELECT status FROM access_requests r WHERE r.user_id=$1 AND r.blueprint_id=b.id
        ORDER BY (r.status='approved') DESC, r.id DESC LIMIT 1) AS req_status,
      (SELECT COUNT(*)::int FROM endpoints e WHERE e.blueprint_id=b.id) AS endpoint_count
    FROM blueprints b WHERE b.deleted_at IS NULL ${where ? `AND (${where.replace(/^\s*WHERE\s+/i, '')})` : ''} ORDER BY lower(b.title)`, [user.id, ...params]);
  const all = rows.map((b) => ({
    ...b,
    access: user.role === 'admin' || b.req_status === 'approved' ? 'granted'
      : b.req_status === 'pending' ? 'pending'
      : b.req_status === 'rejected' ? 'rejected' : 'none',
  }));
  // Guests cannot request anything, so they only ever see what was assigned to them.
  return user.role === 'guest' ? all.filter((b) => b.access === 'granted') : all;
}

const ids = (list) => [...new Set([].concat(list).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

// Assigns every given user to every given blueprint (members/guests only, never admins; deleted rows are skipped).
// A pending request for the same pair is approved. Returns [{ email, title }] for the pairs that were newly granted.
async function grant(userIds, blueprintIds, adminId) {
  return db.tx(async (q) => {
    const users = await q(`SELECT id, email FROM users WHERE id = ANY($1) AND deleted_at IS NULL AND role <> 'admin'`, [ids(userIds)]);
    const bps = await q('SELECT id, title FROM blueprints WHERE id = ANY($1) AND deleted_at IS NULL', [ids(blueprintIds)]);
    const done = [];
    for (const u of users) for (const b of bps) {
      const [row] = await q(`SELECT id, status FROM access_requests WHERE user_id=$1 AND blueprint_id=$2 AND status IN ('pending','approved')
        ORDER BY (status='approved') DESC LIMIT 1`, [u.id, b.id]);
      if (row && row.status === 'approved') continue;
      if (row) await q(`UPDATE access_requests SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [row.id, adminId]);
      else await q(`INSERT INTO access_requests (user_id,blueprint_id,message,status,decided_by,decided_at) VALUES ($1,$2,'Assigned by an admin','approved',$3,now())`, [u.id, b.id, adminId]);
      done.push({ email: u.email, title: b.title });
    }
    return done;
  });
}

// Removes the approved access of the given users to the given blueprints (kept as 'rejected' so the history stays).
// Returns [{ email, title }] for what was actually removed.
const revoke = (userIds, blueprintIds, adminId) => db.query(`
  UPDATE access_requests r SET status='rejected', decided_by=$3, decided_at=now() FROM users u, blueprints b
  WHERE r.user_id = ANY($1) AND r.blueprint_id = ANY($2) AND r.status='approved' AND u.id=r.user_id AND b.id=r.blueprint_id
  RETURNING u.email, b.title`, [ids(userIds), ids(blueprintIds), adminId]);

module.exports = { canView, blueprintsFor, grant, revoke };
