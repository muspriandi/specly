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

if (isProd && !baseUrl) throw new Error('BASE_URL is required when NODE_ENV=production (used in email links).');
if (!Number.isInteger(config.port) || config.port < 0) throw new Error('PORT must be a number.');

module.exports = config;
