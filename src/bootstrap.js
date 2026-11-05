const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./services/auth');
const { saveBlueprint } = require('./services/blueprints');

const SAMPLE = path.join(__dirname, '..', 'samples', 'task-api.yaml');

// First run only: create an admin account and a sample blueprint.
async function bootstrap() {
  if (!(await db.one('SELECT 1 FROM users LIMIT 1'))) {
    const { email, password: configured } = config.admin;
    const password = configured || crypto.randomBytes(9).toString('base64url');
    await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ($1,'Administrator',$2,'admin')`,
      [email, await auth.hashPassword(password)]);
    console.log(`\nCreated admin account: ${email}${configured ? ' (password from ADMIN_PASSWORD)' : ` / ${password}  (shown once; or run: npm run reset-admin)`}\n`);
  }
  if (!(await db.one('SELECT 1 FROM blueprints LIMIT 1')) && fs.existsSync(SAMPLE)) {
    await saveBlueprint(null, fs.readFileSync(SAMPLE, 'utf8'), null);
  }
}

module.exports = { bootstrap };
