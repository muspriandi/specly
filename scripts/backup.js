// Usage: npm run backup            (writes backups/specly-YYYYMMDD-HHMMSS.dump, keeps the newest 14)
//        BACKUP_DIR=/var/backups/specly BACKUP_KEEP=30 npm run backup
// Needs pg_dump on the PATH (the Docker image includes it). Restore with:
//        pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" backups/specly-….dump
// Schedule it with cron / a systemd timer / your platform's scheduled jobs, and copy the files off the machine.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../src/config');

const dir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const file = path.join(dir, `specly-${stamp}.dump`);

fs.mkdirSync(dir, { recursive: true });
const r = spawnSync('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`, config.databaseUrl], { stdio: ['ignore', 'inherit', 'inherit'] });
if (r.error || r.status !== 0) {
  fs.rmSync(file, { force: true });
  console.error(r.error ? `Could not run pg_dump (${r.error.code === 'ENOENT' ? 'not installed or not on PATH' : r.error.message}).` : 'pg_dump failed.');
  process.exit(1);
}
console.log(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);

// Retention: delete the oldest dumps beyond `keep` (only files this script names).
const old = fs.readdirSync(dir).filter((f) => /^specly-\d{8}-\d{6}\.dump$/.test(f)).sort().slice(0, -keep);
for (const f of old) { fs.rmSync(path.join(dir, f)); console.log(`Removed old backup: ${f}`); }
