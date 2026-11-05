const config = require('./src/config');
const db = require('./src/db');
const { createApp } = require('./src/app');
const { bootstrap } = require('./src/bootstrap');

async function main() {
  await db.init();
  await bootstrap();
  await db.purgeExpired();
  const purge = setInterval(() => db.purgeExpired().catch((e) => console.error('purge failed:', e.message)), 3600 * 1000);
  purge.unref();

  const server = createApp().listen(config.port, () => console.log(`Specly running at http://localhost:${config.port}`));

  // Graceful shutdown: stop accepting connections, then close the DB pool.
  const stop = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

main().catch((e) => {
  console.error(e.code === 'ECONNREFUSED' ? 'Cannot reach PostgreSQL. Check DATABASE_URL in .env.' : e);
  process.exit(1);
});
