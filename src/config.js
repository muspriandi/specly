// Single place where environment variables are read, validated and defaulted.
require('dotenv').config({ quiet: true });
const env = process.env;

const isProd = env.NODE_ENV === 'production';
const baseUrl = (env.BASE_URL || '').replace(/\/+$/, '') || null;

const config = Object.freeze({
  isProd,
  port: Number(env.PORT || 3000),
  baseUrl,
  databaseUrl: env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/specly',
  trustProxy: env.TRUST_PROXY === 'true',
  sessionIdleHours: env.SESSION_IDLE_HOURS === undefined || env.SESSION_IDLE_HOURS === '' ? 24 : Math.max(0, Number(env.SESSION_IDLE_HOURS)), // 0 = no idle timeout
  appSecret: env.APP_SECRET || null, // encrypts two-factor secrets at rest (required in production): openssl rand -base64 32
  bcryptCost: Math.min(15, Math.max(4, Number(env.BCRYPT_COST || 12))),
  autoMigrate: env.AUTO_MIGRATE !== 'false', // apply pending migrations on start (false: refuse to start until `npm run migrate`)
  autoSeed: env.AUTO_SEED !== 'false',       // on the very first start (no users yet) create the admin and a sample blueprint
  loginRateMax: Number(env.LOGIN_RATE_MAX || 30), // sign-in attempts per IP per 15 minutes
  db: {
    poolMax: Number(env.DB_POOL_MAX || 10),
    statementTimeoutMs: Number(env.DB_STATEMENT_TIMEOUT_MS || 15000), // 0 = no limit
    connectTimeoutMs: Number(env.DB_CONNECT_TIMEOUT_MS || 5000),
    idleTimeoutMs: Number(env.DB_IDLE_TIMEOUT_MS || 30000),
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
  },
  // Logging for monitoring (see src/lib/log.js).
  logLevel: ['silent', 'error', 'warn', 'info', 'debug'].includes(env.LOG_LEVEL) ? env.LOG_LEVEL : env.NODE_ENV === 'test' ? 'silent' : 'info',
  logFormat: ['json', 'pretty'].includes(env.LOG_FORMAT) ? env.LOG_FORMAT : env.NODE_ENV === 'production' ? 'json' : 'pretty',
  slowRequestMs: Number(env.SLOW_REQUEST_MS || 1000), // requests slower than this are logged as warnings (0 = never)
  slowQueryMs: Number(env.SLOW_QUERY_MS || 500),      // so are database queries
  // What the audit TABLE keeps: 'important' (security and admin changes, see services/audit.js) or 'all'. Everything is logged either way.
  auditStore: env.AUDIT_STORE === 'all' ? 'all' : 'important',
  auditRetentionDays: Number(env.AUDIT_RETENTION_DAYS || 0), // delete stored audit rows older than this (0 = keep forever)
  secureCookies: isProd || (baseUrl || '').startsWith('https:'),
  admin: { email: (env.ADMIN_EMAIL || 'admin@specly.local').toLowerCase(), password: env.ADMIN_PASSWORD || null },
  mail: {
    host: env.SMTP_HOST || null,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || null,
    pass: env.SMTP_PASS || null,
    from: env.MAIL_FROM || 'Specly <no-reply@specly.local>',
    notify: env.NOTIFY_EMAILS !== 'false', // emails about access requests and assignments (invitations and resets always send)
  },
});

if (env.APP_SECRET && env.APP_SECRET.length < 32) throw new Error('APP_SECRET must be at least 32 characters (openssl rand -base64 32).');

// Production refuses to start on settings that are only safe on a developer laptop.
if (isProd) {
  const problems = [];
  if (!baseUrl) problems.push('BASE_URL is required (used in email links).');
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is required (the localhost default is for development).');
  if (!env.SMTP_HOST && env.ALLOW_CONSOLE_MAIL !== 'true') {
    problems.push('SMTP_HOST is required: without it emails (including password reset links) are printed to the log. Set ALLOW_CONSOLE_MAIL=true only for a demo.');
  }
  if (!env.APP_SECRET) problems.push('APP_SECRET is required (it encrypts two-factor secrets in the database). Generate one: openssl rand -base64 32');
  if (env.ADMIN_PASSWORD && (env.ADMIN_PASSWORD.length < 12 || /^(newpass123|admin1234|changeme|password)/i.test(env.ADMIN_PASSWORD))) {
    problems.push('ADMIN_PASSWORD is too weak or a well-known example (use at least 12 characters, or leave it empty to get a generated one).');
  }
  if (problems.length) throw new Error(`Cannot start in production:\n - ${problems.join('\n - ')}`);
}
if (!Number.isInteger(config.port) || config.port < 0) throw new Error('PORT must be a number.');

module.exports = config;
