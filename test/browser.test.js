/* global document, innerWidth -- used inside page.evaluate(), which runs in the browser */// Smoke test in a real browser (headless Chrome). It guards the things jsdom cannot see: layout, sizes and the
// publish wizard's Preview step. Skipped automatically when Chrome or playwright-core is not available
// (set CHROME_PATH to point at a Chrome/Chromium binary).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { db, url } = require('./support');

const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => fs.existsSync(p));
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch { /* optional dev dependency */ }
const skip = !CHROME || !chromium ? 'Chrome or playwright-core not available (set CHROME_PATH)' : false;

test('browser: editor layout, no stray scrollbars, and the Preview step renders the draft', { skip }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(url('/login'));
    await page.fill('input[name=email]', 'admin@specly.local');
    await page.fill('input[name=password]', 'Admin1234');
    await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button.btn')]);

    // The sample blueprint is long: the editor must keep a fixed height instead of stretching to the file length.
    const { id } = await db.one('SELECT id FROM blueprints ORDER BY id LIMIT 1');
    await page.goto(url(`/manage/blueprints/${id}/edit`));
    await page.waitForSelector('textarea[data-editor]');
    const m = await page.evaluate(() => {
      const ta = document.querySelector('textarea[data-editor]');
      const gutter = ta.parentElement.parentElement.firstElementChild;
      return { pageW: document.documentElement.scrollWidth, winW: innerWidth, pageH: document.documentElement.scrollHeight,
        taH: ta.offsetHeight, taInner: ta.clientHeight, gutterH: gutter.offsetHeight, lines: ta.value.split('\n').length };
    });
    assert.ok(m.lines > 20, 'the sample is long enough to matter');
    assert.ok(m.pageW <= m.winW, `no horizontal page scroll (${m.pageW} > ${m.winW})`);
    assert.ok(m.taH >= 18 * 16 - 4 && m.taH <= 38 * 16 + 4, `editor height stays within its clamp (${m.taH}px)`);
    assert.equal(m.taH, m.taInner, 'no horizontal scrollbar inside the editor');
    assert.equal(m.gutterH, m.taH, 'the line-number gutter is as tall as the editor, not as the file');
    assert.ok(m.pageH < m.lines * 20, `the page is not as tall as the file (${m.pageH}px for ${m.lines} lines)`);

    // Preview step: edit the text, move on, and the draft renders with the new endpoint.
    await page.$eval('textarea[data-editor]', (ta) => {
      ta.value = ta.value.replace(/\npaths:\n/, '\npaths:\n  /smoke-test:\n    get:\n      summary: Smoke test endpoint\n      responses:\n        "200": { description: ok }\n');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => { const n = document.querySelector('[data-next]'); return n && !n.disabled; }, undefined, { timeout: 10000 });
    await page.click('[data-next]');
    const frameHandle = await page.waitForSelector('#bp-frame');
    const frame = await frameHandle.contentFrame();
    await frame.waitForSelector('#doc a', { timeout: 10000 });
    assert.match(await frame.$eval('#doc', (d) => d.innerText), /Smoke test endpoint/);
    assert.deepEqual(errors, [], 'no script errors on the page');
  } finally {
    await browser.close();
  }
});
