// Keeps the system from locking itself out: at least one active admin must always remain.
// The check locks the active admin rows, so two admins demoting/disabling/deleting each other at the same moment
// cannot both succeed.
class LastAdminError extends Error {
  constructor() { super('At least one active admin is required.'); this.name = 'LastAdminError'; }
}

// `q` is the query function of an open transaction. True when `userId` is the only active admin.
async function isLastActiveAdmin(q, userId) {
  const rows = await q(`SELECT id FROM users WHERE role='admin' AND active AND deleted_at IS NULL ORDER BY id FOR UPDATE`);
  return rows.length === 1 && rows[0].id === Number(userId);
}

module.exports = { isLastActiveAdmin, LastAdminError };
