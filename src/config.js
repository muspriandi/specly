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
  secureCookies: isProd || (baseUrl || '').startsWith('https:'),
  admin: { email: (env.ADMIN_EMAIL || 'admin@specly.local').toLowerCase(), password: env.ADMIN_PASSWORD || null },
  mail: {
    host: env.SMTP_HOST || null,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || null,
    pass: env.SMTP_PASS || null,
    from: env.MAIL_FROM || 'Specly <no-reply@specly.local>',
  },
});

if (isProd && !baseUrl) throw new Error('BASE_URL is required when NODE_ENV=production (used in email links).');
if (!Number.isInteger(config.port) || config.port < 0) throw new Error('PORT must be a number.');

module.exports = config;
