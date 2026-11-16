const router = require('./router')();
const db = require('../../db');
const { audit } = require('../../services/audit');
const { flash } = require('../../lib/http');
const { paginate, limitSql } = require('../../lib/paginate');
const { notifyAccessGranted } = require('../../services/notify');

const FROM = `
  FROM access_requests r JOIN users u ON u.id=r.user_id AND u.deleted_at IS NULL JOIN blueprints b ON b.id=r.blueprint_id AND b.deleted_at IS NULL
  LEFT JOIN users d ON d.id=r.decided_by`;
const SELECT = `SELECT r.*, u.name AS user_name, u.email AS user_email, b.title AS blueprint_title, d.name AS decider ${FROM}`;

// Two tables, each with its own page parameter: ?ppage= (pending) and ?hpage= (history).
router.get('/', async (req, res) => {
  const [pp, hp] = [await paginate(req, `SELECT COUNT(*)::int AS n ${FROM} WHERE r.status='pending'`, [], { param: 'ppage' }),
    await paginate(req, `SELECT COUNT(*)::int AS n ${FROM} WHERE r.status<>'pending'`, [], { param: 'hpage' })];
  const pending = await db.query(`${SELECT} WHERE r.status='pending' ORDER BY r.created_at DESC, r.id DESC ${limitSql(pp)}`);
  const history = await db.query(`${SELECT} WHERE r.status<>'pending' ORDER BY r.decided_at DESC NULLS LAST, r.id DESC ${limitSql(hp)}`);
  res.render('admin/requests', { title: 'Access requests', pending, history, pp, hp });
});

// Move a request from one status to another. The UPDATE's WHERE makes it safe to double-click.
const decide = ({ from, to, event, message, verb }) => async (req, res) => {
  const r = await db.one(`UPDATE access_requests SET status=$1, decided_by=$2, decided_at=now()
    WHERE id=$3 AND status=$4 RETURNING user_id, blueprint_id`, [to, req.user.id, req.params.id, from]);
  if (r) {
    const info = await db.one(`SELECT u.email, b.title FROM users u, blueprints b WHERE u.id=$1 AND b.id=$2 AND u.deleted_at IS NULL AND b.deleted_at IS NULL`, [r.user_id, r.blueprint_id]);
    await audit(req, `request.${event}`, { type: 'blueprint', id: r.blueprint_id, detail: `${verb(info.email, info.title)}` });
    if (to === 'approved') notifyAccessGranted(req, [info]);
  }
  flash(res, r ? message : 'That request was already handled.', r ? 'success' : 'info');
  res.redirect('/manage/requests');
};

// Approve or reject several pending requests at once (checkbox form on the page).
router.post('/bulk', async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(String).filter((x) => /^\d{1,9}$/.test(x)).map(Number);
  const approve = req.body.action === 'approve';
  if (!ids.length || !['approve', 'reject'].includes(req.body.action)) {
    flash(res, 'Select at least one request first.', 'error');
    return res.redirect('/manage/requests');
  }
  const rows = await db.query(`UPDATE access_requests r SET status=$1, decided_by=$2, decided_at=now()
    FROM users u, blueprints b WHERE r.id = ANY($3) AND r.status='pending' AND u.id=r.user_id AND b.id=r.blueprint_id AND u.deleted_at IS NULL AND b.deleted_at IS NULL
    RETURNING r.blueprint_id, u.email, b.title`, [approve ? 'approved' : 'rejected', req.user.id, ids]);
  for (const r of rows) {
    await audit(req, approve ? 'request.approved' : 'request.rejected', { type: 'blueprint', id: r.blueprint_id,
      detail: `${approve ? 'Approved' : 'Rejected'} ${r.email}'s request to read "${r.title}" (bulk)` });
  }
  if (approve) notifyAccessGranted(req, rows);
  flash(res, `${rows.length} request${rows.length === 1 ? '' : 's'} ${approve ? 'approved' : 'rejected'}.`);
  res.redirect('/manage/requests');
});

router.post('/:id/approve', decide({ from: 'pending', to: 'approved', event: 'approved', message: 'Request approved.', verb: (e, t) => `Approved ${e}'s request to read "${t}"` }));
router.post('/:id/reject', decide({ from: 'pending', to: 'rejected', event: 'rejected', message: 'Request rejected.', verb: (e, t) => `Rejected ${e}'s request to read "${t}"` }));
router.post('/:id/revoke', decide({ from: 'approved', to: 'rejected', event: 'revoked', message: 'Access revoked.', verb: (e, t) => `Revoked ${e}'s access to "${t}"` }));

module.exports = router;
