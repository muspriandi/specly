const config = require('./src/config');
const log = require('./src/lib/log');
const db = require('./src/db');
const { createApp } = require('./src/app');
const { bootstrap } = require('./src/bootstrap');
const { flushMail } = require('./src/services/mail');
const trash = require('./src/services/trash');

// Where the database is, without credentials, for the startup line.
function dbTarget() {
  try { const u = new URL(config.databaseUrl); return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`; } catch { return 'unknown'; }
}

async function main() {
  await db.init();
  await bootstrap();
  const housekeeping = async () => {
    await db.purgeExpired();
    const gone = await trash.purgeOld(config.trashRetentionDays);
    if (gone.blueprints + gone.users) log.info('emptied the trash', { event: 'trash.purged', ...gone, days: config.trashRetentionDays });
  };
  await housekeeping();
  const purge = setInterval(() => housekeeping().catch((e) => log.error('purge failed', { event: 'db.purge_failed', err: e })), 3600 * 1000);
  purge.unref();

  const server = createApp().listen(config.port, () => {
    log.info(`Specly running at http://localhost:${config.port}`, { event: 'server.started', port: config.port, env: process.env.NODE_ENV || 'development',
      version: require('./package.json').version, node: process.version, db: dbTarget(), logLevel: config.logLevel, auditStore: config.auditStore,
      auditRetentionDays: config.auditRetentionDays || 'forever', slowRequestMs: config.slowRequestMs, slowQueryMs: config.slowQueryMs });
  });
  if (!config.isProd && config.baseUrl) {
    try {
      const b = new URL(config.baseUrl);
      if (['localhost', '127.0.0.1'].includes(b.hostname) && Number(b.port || 80) !== config.port) {
        log.warn(`BASE_URL is ${config.baseUrl} but the server listens on port ${config.port}. Links will use the address you browse; set BASE_URL=http://localhost:${config.port} to silence this.`, { event: 'config.base_url_mismatch' });
      }
    } catch { /* BASE_URL validity is not this check's job */ }
  }

  // Graceful shutdown: stop accepting connections, let queued emails finish, then close the DB pool.
  const stop = (signal) => {
    log.info(`${signal} received, shutting down`, { event: 'server.stopping', signal });
    server.close(() => flushMail().then(() => db.pool.end()).finally(() => { log.info('stopped', { event: 'server.stopped' }); process.exit(0); }));
    setTimeout(() => { log.error('forced exit: shutdown took longer than 10 seconds', { event: 'server.forced_exit' }); process.exit(1); }, 10_000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

process.on('unhandledRejection', (e) => log.error('unhandled rejection', { event: 'process.unhandled_rejection', err: e }));
process.on('uncaughtException', (e) => { log.error('uncaught exception, exiting', { event: 'process.uncaught_exception', err: e }); process.exit(1); });

main().catch((e) => {
  log.error(e.code === 'ECONNREFUSED' ? 'Cannot reach PostgreSQL. Check DATABASE_URL in .env.' : 'startup failed', { event: 'server.start_failed', err: e });
  process.exit(1);
});
