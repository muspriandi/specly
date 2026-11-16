// Starts the real app on a random port for the single sign-on tests (which need their own environment variables) and
// prints "PORT <n>". It shares the test database with the main suites.
const { createApp } = require('../../src/app');
const db = require('../../src/db');

db.init().then(() => {
  const server = createApp().listen(0, () => console.log(`PORT ${server.address().port}`));
  process.on('SIGTERM', () => server.close(() => db.pool.end().then(() => process.exit(0))));
});
