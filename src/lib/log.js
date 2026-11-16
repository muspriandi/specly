// Application log for monitoring: one structured line per event, to stdout (warn/error to stderr), so any collector
// (Docker logs, journald, Loki, CloudWatch, Datadog…) can pick it up. JSON in production, readable text in development.
//
//   log.info('server started', { port: 3000 });
//   log.warn('security', { event: 'auth.login_failed', ip });       // `event` is the stable name to alert on
//   const rlog = log.child({ req: id });                            // adds fields to every line
//
// Levels: error < warn < info < debug. LOG_LEVEL picks the lowest one shown ('silent' turns it all off).
// Never put passwords, tokens, cookies or full request bodies in a log field; mask emails with maskEmail().
const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = config.logLevel === 'silent' ? -1 : LEVELS[config.logLevel];
let capture = null; // tests: an array that receives every entry, whatever the level

const MAX_FIELD = 1000;
function clean(value, depth = 0) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code,
      stack: String(value.stack || '').split('\n').slice(0, 8).map((l) => l.trim()).join(' | ').slice(0, 1500) };
  }
  if (typeof value === 'string') return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value;
  if (value && typeof value === 'object' && depth < 3) {
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clean(v, depth + 1)]));
  }
  return value;
}

const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
function pretty(entry) {
  const { t, level, msg, err, ...rest } = entry;
  if (err && typeof err === 'object') rest.err = err.message || err.name; // the stack goes on its own lines below
  const tty = process.stdout.isTTY;
  const tag = level.toUpperCase().padEnd(5);
  const kv = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' && /[\s"=]/.test(v) ? JSON.stringify(v) : typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`).join(' ');
  const stack = err && err.stack ? `\n      ${err.stack.split(' | ').join('\n      ')}` : '';
  return `${t.slice(11, 23)} ${tty ? `${COLORS[level]}${tag}\x1b[0m` : tag} ${msg}${kv ? `  ${kv}` : ''}${stack}`;
}

function emit(level, msg, fields) {
  const entry = { t: new Date().toISOString(), level, msg, ...(fields ? clean(fields) : {}) };
  if (capture) capture.push(entry);
  if (LEVELS[level] > threshold) return;
  let line;
  try { line = config.logFormat === 'json' ? JSON.stringify(entry) : pretty(entry); } catch { line = `${entry.t} ${level} ${msg}`; }
  (LEVELS[level] <= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

function make(base) {
  const f = (level) => (msg, fields) => emit(level, msg, base ? { ...base, ...fields } : fields);
  return { error: f('error'), warn: f('warn'), info: f('info'), debug: f('debug'), child: (extra) => make({ ...base, ...extra }) };
}

const log = make(null);

// Test helper: collect every entry (at any level) until stop() is called.
log.capture = () => {
  const entries = [];
  capture = entries;
  return { entries, stop: () => { capture = null; } };
};
// Test helper: change what is printed (the capture is unaffected).
log.setLevel = (level) => { threshold = level === 'silent' ? -1 : LEVELS[level]; };

// "j***@example.com": enough to recognise an account in a log, not enough to harvest addresses from one.
log.maskEmail = (email) => {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  return at < 1 ? (s ? `${s[0]}***` : '') : `${s[0]}***${s.slice(at)}`;
};

module.exports = log;
