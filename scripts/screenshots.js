/* global document, localStorage, window -- used inside page.evaluate(), which runs in the browser */
// Builds a throwaway database (your own data is never touched), seeds it, adds a little realistic activity, starts the app
// in-process and drives headless Chrome through the real UI. Needs Chrome/Chromium (CHROME_PATH to point at one) and playwright-core.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ quiet: true });

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const ADMIN_PASSWORD = 'Screenshots-1';

const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => fs.existsSync(p));
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { /* reported below */ }
if (!CHROME || !chromium) { console.error('Needs Chrome or Chromium (set CHROME_PATH) and the playwright-core dev dependency (npm install).'); process.exit(1); }

// Everything below runs against a scratch database: point the app at it BEFORE its modules are loaded.
const base = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/specly';
const scratchName = `specly_screenshots_${process.pid}`;
const adminUrl = base.replace(/\/[^/]*$/, '/postgres');
Object.assign(process.env, { DATABASE_URL: base.replace(/\/[^/]*$/, `/${scratchName}`), ADMIN_PASSWORD, LOG_LEVEL: 'silent', NODE_ENV: 'development', BASE_URL: '', ADMIN_EMAIL: 'admin@specly.local' });

const { Client: Pg } = require('pg');
const yaml = require('js-yaml');

async function main() {
  const realLog = console.log;
  console.log = (...a) => { if (!String(a[0]).includes('email (SMTP not configured)')) realLog(...a); }; // development mail printout
  fs.mkdirSync(OUT, { recursive: true });
  execSync('npm run -s build:css', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });

  const admin = new Pg({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${scratchName}"`);

  const db = require('../src/db');
  const seed = require('../src/seed');
  const { saveBlueprint } = require('../src/services/blueprints');
  const { createApp } = require('../src/app');
  let server, browser;
  try {
    await db.init();
    const adminAccount = await seed.seedAdmin();
    await seed.seedSamples();
    await seed.seedDemo({ password: 'Demo-Screens-1' });
    const adminId = (await db.one(`SELECT id FROM users WHERE email=$1`, [adminAccount.email])).id;
    const bp = async (title) => (await db.one('SELECT id FROM blueprints WHERE title=$1', [title])).id;
    const bookstore = await bp('Bookstore API'), payments = await bp('Payments API');

    // A realistic history for the changelog: two more revisions of the Bookstore API.
    const current = async () => (await db.one(`SELECT source FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no DESC LIMIT 1`, [bookstore])).source;
    let spec = yaml.load(await current());
    spec.info.version = '2.2.0';
    spec.paths['/books/{isbn}/reviews'] = { get: { tags: ['Books'], summary: 'List reviews of a book', operationId: 'listReviews',
      parameters: [{ name: 'isbn', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Reviews, newest first.' } } } };
    await saveBlueprint(bookstore, yaml.dump(spec, { lineWidth: -1 }), adminId, 'Add book reviews');
    spec = yaml.load(await current());
    spec.info.version = '2.3.0';
    Object.assign(spec.paths['/books/{isbn}/reviews'].get, { 'x-status': 'beta', 'x-status-description': 'The review format may still change before 2.4.' });
    await saveBlueprint(bookstore, yaml.dump(spec, { lineWidth: -1 }), adminId, 'Mark reviews as beta');
    // ...and a release with breaking changes, so the changelog and the comparison have something to warn about
    spec = yaml.load(await current());
    spec.info.version = '3.0.0';
    delete (spec.components.schemas.Book.allOf || []).find((part) => part.properties && part.properties.rating).properties.rating; // Book = BookInput + { rating }
    spec.paths['/books'].get.parameters = [...(spec.paths['/books'].get.parameters || []), { name: 'region', in: 'query', required: true, description: 'Storefront region, e.g. EU or US.', schema: { type: 'string' } }];
    await saveBlueprint(bookstore, yaml.dump(spec, { lineWidth: -1 }), adminId, 'Regional catalogues: region is now required');

    server = createApp().listen(0);
    const origin = `http://localhost:${server.address().port}`;
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'] });
    let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await context.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {})); // "leave this page?" after editing in the publish wizard
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const go = async (url) => { await page.goto(origin + url, { waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready); };
    // Crops each shot to its content (pages shorter than the window would otherwise end in a blank area).
    const shot = async (name) => {
      await pause(250);
      const vp = page.viewportSize();
      const bottom = await page.evaluate(() => Math.ceil(document.querySelector('main').getBoundingClientRect().bottom + window.scrollY));
      const height = Math.min(vp.height, Math.max(420, bottom - 24));
      await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: vp.width, height } });
      console.log(`  ${name}.png`);
    };
    const post = (url, fields) => page.evaluate(async ({ u, f }) => {
      const token = document.querySelector('input[name=_csrf]').value;
      await fetch(u, { method: 'POST', body: new URLSearchParams({ _csrf: token, ...f }), redirect: 'manual', credentials: 'same-origin' });
    }, { u: url, f: fields });
    const theme = async (t) => { await page.evaluate((x) => localStorage.setItem('theme', x), t); await page.reload({ waitUntil: 'networkidle' }); };
    const openOperation = async (selector) => { // the sidebar starts with its folders folded: unfold them, then open the endpoint
      await page.evaluate(() => { const b = [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim() === 'Expand all'); if (b) b.click(); });
      await pause(200);
      await page.waitForSelector(selector, { state: 'visible' });
      await page.click(selector);
      await pause(600);
    };

    // ---- sign in, and create some activity through the real forms ----
    await go('/login');
    await page.fill('input[name=email]', adminAccount.email);
    await page.fill('input[name=password]', ADMIN_PASSWORD);
    await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button.btn')]);
    await page.evaluate(() => localStorage.setItem('theme', 'light'));
    await post('/manage/users', { name: 'Priya Nair', email: 'priya.nair@example.com', role: 'member', password: 'Priya-Screens-1' });
    await post('/manage/users', { name: 'Marco Silva', email: 'marco.silva@example.com', role: 'guest', password: 'Marco-Screens-1' });
    const priya = (await db.one(`SELECT id FROM users WHERE email='priya.nair@example.com'`)).id;
    const marco = (await db.one(`SELECT id FROM users WHERE email='marco.silva@example.com'`)).id;
    await post(`/manage/blueprints/${bookstore}/access`, { users: String(priya) });
    await post(`/manage/blueprints/${await bp('Weather API')}/access`, { users: String(marco) }); // Marco stays unassigned on the Bookstore API: the Assign list has someone in it
    await post(`/manage/blueprints/${payments}/access`, { users: String(priya) });
    await post(`/manage/blueprints/${payments}/share`, { days: '30', label: 'Partner review' });
    await post(`/manage/blueprints/${payments}/share`, { days: '7', label: 'Acme integration team' });

    console.log('Screenshots:');
    // ---- the product, as a reader ----
    await go('/');
    await shot('home');
    await go(`/blueprints/${bookstore}`);
    await page.waitForSelector('#doc a[href^="#/"]');
    await openOperation('a[title="POST /books"]');
    await shot('viewer');
    await theme('dark');
    await openOperation('a[title="POST /books"]');
    await shot('viewer-dark');
    await theme('light');
    await go(`/blueprints/${payments}`);
    await page.waitForSelector('#doc a[href^="#/"]');
    await openOperation('a[title="POST /refunds"]');
    await shot('viewer-wip');
    await go(`/blueprints/${bookstore}/changelog`);
    await shot('changelog');

    // ---- publishing: edit, preview, review ----
    await go(`/manage/blueprints/${bookstore}/edit`);
    await page.waitForSelector('textarea[data-editor]');
    await shot('publish-edit');
    await page.$eval('textarea[data-editor]', (ta) => {
      ta.value = ta.value.replace(/\npaths:\n/, '\npaths:\n  /books/{isbn}/similar:\n    get:\n      tags: [Books]\n      summary: Books readers also liked\n      responses:\n        "200": { description: A short list of related books. }\n');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => { const n = document.querySelector('[data-next]'); return n && !n.disabled; }, undefined, { timeout: 15000 });
    await page.click('[data-next]');
    const frame = await (await page.waitForSelector('#bp-frame')).contentFrame();
    await frame.waitForSelector('#doc a', { timeout: 15000 });
    await pause(600);
    await shot('publish-preview');
    await page.click('[data-next]');
    await page.waitForFunction(() => document.querySelector('#changes-body') && document.querySelector('#changes-body').innerText.length > 20, undefined, { timeout: 15000 });
    await shot('publish-review');

    // ---- administration ----
    await go(`/manage/blueprints/${bookstore}/access`);
    await shot('access');
    await go(`/manage/blueprints/${payments}/share`);
    await shot('share-links');
    await go(`/manage/blueprints/${bookstore}/compare?from=3&to=4`);
    await shot('compare');
    await post(`/manage/blueprints/${bookstore}/api`, { name: 'GitHub Actions, main branch', days: '90' });
    await go(`/manage/blueprints/${bookstore}/api`);
    await shot('api-tokens');
    await go('/manage/users');
    await shot('users');
    await go('/manage/audit');
    await shot('audit');

    // ---- a phone ----
    const cookies = await context.cookies(); // stay signed in on the phone-sized context
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await context.addCookies(cookies);
    page = await context.newPage();
    await go('/');
    await shot('mobile-home');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((r) => server.close(r));
    await db.pool.end();
    for (let i = 0; i < 100; i++) { // wait for the server to close its connections, then drop the scratch database
      const { rows } = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [scratchName]);
      if (!rows.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
