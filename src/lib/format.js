// "29 Oct 2026, 10:25" in the server's locale/timezone.
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
module.exports = { fmtDate };
