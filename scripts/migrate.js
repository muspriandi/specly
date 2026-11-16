// Usage: npm run migrate                      apply pending migrations (creates the database if needed)
//        npm run migrate:status               list every migration and whether it is applied
//        npm run migrate:new -- add_a_column  create the next numbered, empty migration file
const db = require('../src/db');
const migrate = require('../src/migrate');

const command = process.argv[2] || 'up';

(async () => {
  if (command === 'new') {
    console.log(`Created ${migrate.create(process.argv[3])}`);
    return;
  }
  await db.ensureDatabase();
  if (command === 'status') {
    const rows = await migrate.status(db.pool);
    for (const r of rows) {
      console.log(`${r.applied ? '✓' : '·'} ${r.version}  ${r.name.padEnd(34)} ${r.applied ? `applied ${r.appliedAt.toISOString().slice(0, 16).replace('T', ' ')}` : 'pending'}${r.changed ? '  CHANGED after it was applied!' : ''}${r.missing ? '  (file missing)' : ''}`);
    }
    const pending = rows.filter((r) => !r.applied).length;
    console.log(pending ? `\n${pending} pending. Run: npm run migrate` : '\nUp to date.');
    if (rows.some((r) => r.changed)) process.exitCode = 1;
    return;
  }
  if (command !== 'up') throw new Error(`Unknown command "${command}". Use: up, status or new <name>.`);
  const ran = await migrate.up(db.pool);
  console.log(ran.length ? `Applied ${ran.length} migration(s):\n  ${ran.join('\n  ')}` : 'Already up to date.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
