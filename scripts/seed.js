// Usage: npm run seed                    first admin (ADMIN_EMAIL / ADMIN_PASSWORD) + the sample blueprints
//        npm run seed -- --demo          also a demo member and guest (development only)
//        npm run seed -- --no-samples    skip the sample blueprints
// Safe to run repeatedly: it only adds what is missing. Run `npm run migrate` first (npm start also does it).
const config = require('../src/config');
const db = require('../src/db');
const seed = require('../src/seed');

const args = new Set(process.argv.slice(2));

(async () => {
  await db.init();

  const admin = await seed.seedAdmin();
  console.log(admin.created
    ? `admin    created ${admin.email}${admin.generated ? `  password: ${admin.password}  (generated: shown once, change it after signing in)` : '  (password from ADMIN_PASSWORD)'}`
    : `admin    ${admin.email} already exists`);

  if (!args.has('--no-samples')) {
    for (const r of await seed.seedSamples()) {
      console.log(`sample   ${r.status.padEnd(7)} ${r.title || r.file}${r.status === 'added' ? ` v${r.version} (${r.endpoints} endpoints)` : r.status === 'failed' ? `: ${r.error}` : ''}`);
      if (r.status === 'failed') process.exitCode = 1;
    }
  }

  if (args.has('--demo')) {
    const demo = await seed.seedDemo();
    for (const u of demo.users) console.log(`demo     ${u.created ? 'created' : 'exists '} ${u.email} (${u.role})${u.created ? `  password: ${u.password}` : ''}`);
    for (const line of demo.assigned) console.log(`demo     ${line}`);
  }

  console.log(`\nSign in at ${config.baseUrl || `http://localhost:${config.port}`} with the admin account above, then \`npm start\` if the server is not running yet.`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
