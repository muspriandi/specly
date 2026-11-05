// Usage: npm run seed
// Adds every sample in samples/ (*.yaml, *.yml, *.json) that isn't already in the database
// (matched by title). Safe to run repeatedly; existing blueprints are never overwritten.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { parseSpec } = require('../src/services/spec');
const { saveBlueprint } = require('../src/services/blueprints');

const DIR = path.join(__dirname, '..', 'samples');

(async () => {
  await db.init();
  const admin = await db.one(`SELECT id FROM users WHERE role='admin' AND active AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  const existing = new Set((await db.query('SELECT lower(title) AS t FROM blueprints WHERE deleted_at IS NULL')).map((r) => r.t));
  let added = 0;
  for (const file of fs.readdirSync(DIR).filter((f) => /\.(ya?ml|json)$/i.test(f)).sort()) {
    try {
      const text = fs.readFileSync(path.join(DIR, file), 'utf8');
      const { spec } = parseSpec(text);
      const title = spec.info.title.trim();
      if (existing.has(title.toLowerCase())) { console.log(`skip   ${title} (already exists)`); continue; }
      const saved = await saveBlueprint(null, text, admin ? admin.id : null, 'Seeded sample');
      console.log(`added  ${title} v${spec.info.version} (${file}, ${saved.endpointCount} endpoints)`);
      added++;
    } catch (e) {
      console.error(`FAILED ${file}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${added} blueprint(s) added.`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
