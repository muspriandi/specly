const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, Client, admin } = require('../support');

test('changelog and Postman export are available to readers; share links work without an account', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  // changelog: reader-facing, no author names, endpoint changes per revision
  const log = await admin.get(`/blueprints/${id}/changelog`);
  assert.equal(log.status, 200);
  assert.match(log.text, /What changed in Pets API/);
  assert.match(log.text, /Revision 1/);
  assert.match(log.text, /First published version/);
  assert.match(log.text, /zzz-first|\/zzz-mine|\/owners|Added/, 'lists endpoint changes');
  // access rules still apply to the new pages
  assert.equal((await new Client().get(`/blueprints/${id}/changelog`)).status, 302, 'sign-in required');
  const stranger = new Client();
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('nolock@example.com','NL',(SELECT password_hash FROM users WHERE id=1),'guest') ON CONFLICT DO NOTHING`);
  await stranger.login('nolock@example.com', 'Admin1234');
  assert.equal((await stranger.get(`/blueprints/${id}/changelog`)).status, 403);
  assert.equal((await stranger.get(`/blueprints/${id}/postman.json`)).status, 404);
  // Postman collection
  const pm = await admin.get(`/blueprints/${id}/postman.json`);
  assert.equal(pm.status, 200);
  assert.match(pm.headers.get('content-disposition'), /pets-api\.postman_collection\.json/);
  const col = JSON.parse(pm.text);
  assert.match(col.info.schema, /collection\/v2\.1\.0/);
  assert.equal(col.variable[0].key, 'baseUrl');
  assert.ok(col.item.flatMap((f) => f.item).some((r) => r.request.method === 'GET' && r.request.url.raw.startsWith('{{baseUrl}}/pets')));

  // share link: create (admin only), read without signing in, then it is read-only and revocable
  assert.equal((await stranger.post(`/manage/blueprints/${id}/share`, { days: '7' })).status, 403);
  const made = await admin.post(`/manage/blueprints/${id}/share`, { days: '7', label: 'Acme team' });
  assert.equal(made.status, 302, 'creating redirects (so a refresh cannot create a second link)');
  assert.equal(made.location, `/manage/blueprints/${id}/share`);
  const shown = await admin.get(made.location);
  const url = shown.text.match(/value="[^"]*(\/s\/[\w-]+)"/)[1];
  assert.match(shown.text, /Link created/);
  const count = async () => (await db.one(`SELECT COUNT(*)::int AS n FROM share_links WHERE label='Acme team'`)).n;
  assert.equal(await count(), 1);
  const again = await admin.get(made.location); // a refresh
  assert.doesNotMatch(again.text, /Link created/, 'the URL is shown once');
  assert.equal(await count(), 1, 'refreshing did not create another link');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='blueprint.share_created'`));
  assert.ok(!(await db.one(`SELECT 1 FROM share_links WHERE token_hash=$1`, [url.slice(3)])), 'the token itself is not stored, only its hash');
  const anon = new Client();
  const page = await anon.get(url);
  assert.equal(page.status, 200);
  assert.match(page.text, /Shared, read-only/);
  assert.match(page.text, new RegExp(`data-spec="${url}/spec\\.json"`));
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.doesNotMatch(page.text, /name="q"/, 'no search box: it would reach other blueprints');
  assert.equal((await anon.get(`${url}/spec.json`)).status, 200);
  assert.equal((await anon.get(`${url}/postman.json`)).status, 200);
  assert.equal((await anon.get(`${url}/changelog`)).status, 200);
  assert.equal((await anon.get(`${url}/source`)).status, 200);
  assert.equal((await anon.get('/s/not-a-real-token')).status, 404);
  assert.equal((await anon.get('/manage/users')).status, 302, 'the link grants nothing else');
  assert.equal((await anon.get('/')).status, 302);
  assert.match((await admin.get(`/manage/blueprints/${id}/share`)).text, /Acme team/, 'links are listed on their own page');
  assert.doesNotMatch((await admin.get(`/manage/blueprints/${id}/access`)).text, /Acme team|Create share link/, 'and no longer on the access page');
  const before = (await db.one('SELECT COUNT(*)::int AS n FROM audit_log')).n;
  for (let i = 0; i < 3; i++) await anon.get(`${url}/spec.json`);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM audit_log')).n, before, 'reading a link writes nothing');
  // expiry and revocation
  await db.query(`UPDATE share_links SET expires_at = now() - interval '1 minute'`);
  assert.equal((await anon.get(url)).status, 404, 'expired link');
  await db.query(`UPDATE share_links SET expires_at = now() + interval '1 day'`);
  assert.equal((await anon.get(url)).status, 200);
  const sid = (await db.one(`SELECT id FROM share_links ORDER BY id DESC LIMIT 1`)).id;
  assert.equal((await admin.post(`/manage/blueprints/${id}/share/${sid}/revoke`, {})).status, 302);
  assert.equal((await anon.get(url)).status, 404, 'revoked link');
  assert.equal((await anon.get(`${url}/spec.json`)).status, 404);
  // deleting the blueprint kills its links too
});

test('active sessions: list devices, sign one out, sign out all the others', async () => {
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('sessions@example.com','Sess',$1,'member')`, [hash]);
  const a = new Client(), b = new Client(), c = new Client();
  for (const x of [a, b, c]) assert.equal((await x.login('sessions@example.com', 'Admin1234')).status, 302);
  const page = (await a.get('/account/sessions')).text;
  assert.equal((page.match(/This device/g) || []).length, 1, 'one row is marked as this device');
  assert.equal((page.match(/name="id" value="/g) || []).length, 2, 'the other two can be signed out');
  const otherId = page.match(/name="id" value="([0-9a-f]{16})"/)[1];
  assert.equal((await a.post('/account/sessions/revoke', { id: otherId })).status, 302);
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='sessions@example.com'`)).n, 2);
  assert.equal((await a.post('/account/sessions/revoke-others', {})).status, 302);
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='sessions@example.com'`)).n, 1);
  assert.equal((await a.get('/')).status, 200, 'this device stays signed in');
  assert.equal((await b.get('/')).status, 302);
  assert.equal((await c.get('/')).status, 302);
  assert.equal((await new Client().get('/account/sessions')).status, 302, 'sign-in required');
});

test('two-factor sign-in: set up, required at login, codes are single-use, recovery codes, admin reset', async () => {
  const totp = require('../../src/lib/totp');
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('mfa@example.com','Mfa',$1,'member')`, [hash]);
  const me = new Client();
  await me.login('mfa@example.com', 'Admin1234');
  assert.match((await me.get('/account/2fa')).text, /Set up two-factor sign-in/);
  assert.equal((await me.post('/account/2fa/start', {})).status, 302);
  const setup = await me.get('/account/2fa');
  assert.match(setup.text, /<svg/, 'QR code is shown');
  const secret = (await db.one(`SELECT totp_secret FROM users WHERE email='mfa@example.com'`)).totp_secret;
  assert.equal((await me.post('/account/2fa/enable', { code: '000000' })).status, 400, 'wrong code does not enable it');
  const now = totp.stepNow();
  const enabled = await me.post('/account/2fa/enable', { code: totp.codeAt(secret, now) });
  assert.equal(enabled.status, 302, 'enabling redirects, so a refresh cannot repeat it');
  const shownCodes = await me.get('/account/2fa');
  const codes = [...shownCodes.text.matchAll(/<li>([a-z2-7]{5}-[a-z2-7]{5})<\/li>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10, 'ten recovery codes are shown once');
  assert.equal([...(await me.get('/account/2fa')).text.matchAll(/<li>[a-z2-7]{5}-[a-z2-7]{5}<\/li>/g)].length, 0, 'and not again on refresh');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='auth.2fa_enabled'`));
  const stored = (await db.one(`SELECT recovery_codes FROM users WHERE email='mfa@example.com'`)).recovery_codes;
  assert.ok(stored.every((h) => /^[0-9a-f]{64}$/.test(h)) && !codes.some((c) => stored.includes(c)), 'only hashes of the codes are stored');

  // signing in now needs the code: the password alone gives no session
  const dev = new Client();
  const r = await dev.login('mfa@example.com', 'Admin1234');
  assert.equal(r.status, 302); assert.equal(r.location, '/login/2fa');
  assert.equal((await dev.get('/')).status, 302, 'no session yet');
  assert.equal((await dev.post('/login/2fa', { code: '123456' })).status, 401);
  const next = totp.codeAt(secret, now + 1); // the next time step is accepted (clock drift) and is newer than the one used to enable
  const ok = await dev.post('/login/2fa', { code: next });
  assert.equal(ok.status, 302); assert.equal(ok.location, '/');
  assert.equal((await dev.get('/')).status, 200, 'signed in after the second step');
  // the same code cannot be replayed
  const again = new Client(); await again.login('mfa@example.com', 'Admin1234');
  assert.equal((await again.post('/login/2fa', { code: next })).status, 401, 'a used code is refused');
  // a recovery code works once
  assert.equal((await again.post('/login/2fa', { code: codes[0] })).status, 302);
  const third = new Client(); await third.login('mfa@example.com', 'Admin1234');
  assert.equal((await third.post('/login/2fa', { code: codes[0] })).status, 401, 'recovery codes are single-use');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='auth.login' AND detail LIKE '%recovery code used%'`));
  // brute force: five wrong codes lock the second step
  const brute = new Client(); await brute.login('mfa@example.com', 'Admin1234');
  for (let i = 0; i < 4; i++) await brute.post('/login/2fa', { code: '111111' }); // 1 wrong already counted above for `third`
  const locked = await brute.post('/login/2fa', { code: '222222' });
  assert.ok([401, 429].includes(locked.status));
  await brute.post('/login/2fa', { code: totp.codeAt(secret, now + 1) });
  assert.equal((await brute.get('/')).status, 302, 'even a right code gives no session while locked');
  const retry = new Client(); await retry.login('mfa@example.com', 'Admin1234');
  assert.equal((await retry.post('/login/2fa', { code: totp.codeAt(secret, now + 1) })).status, 429, 'signing in again does not skip the lock');

  // new recovery codes: the old ones stop working, and a refresh of the result page does not generate yet another set
  assert.equal((await dev.post('/account/2fa/recovery', { password: 'wrong', code: codes[1] })).status, 400, 'a wrong password does not use up a code');
  assert.equal((await dev.post('/account/2fa/recovery', { password: 'Admin1234', code: codes[1] })).status, 302);
  const before = (await db.one(`SELECT recovery_codes FROM users WHERE email='mfa@example.com'`)).recovery_codes.join();
  const fresh = [...(await dev.get('/account/2fa')).text.matchAll(/<li>([a-z2-7]{5}-[a-z2-7]{5})<\/li>/g)].map((m) => m[1]);
  assert.equal(fresh.length, 10);
  await dev.get('/account/2fa'); await dev.get('/account/2fa'); // refreshes
  assert.equal((await db.one(`SELECT recovery_codes FROM users WHERE email='mfa@example.com'`)).recovery_codes.join(), before, 'refreshing did not regenerate the codes');
  const current = (await db.one(`SELECT recovery_codes FROM users WHERE email='mfa@example.com'`)).recovery_codes;
  assert.ok(!current.includes(totp.recoveryHash(codes[2])), 'old recovery codes no longer work');
  assert.ok(current.includes(totp.recoveryHash(fresh[3])), 'the new ones do');

  // turning it off needs the password and a code
  assert.equal((await dev.post('/account/2fa/disable', { password: 'wrong', code: fresh[0] })).status, 400);
  assert.equal((await dev.post('/account/2fa/disable', { password: 'Admin1234', code: fresh[0] })).status, 302);
  assert.equal((await db.one(`SELECT totp_enabled_at FROM users WHERE email='mfa@example.com'`)).totp_enabled_at, null);
  assert.equal((await new Client().login('mfa@example.com', 'Admin1234')).location, '/', 'back to password-only');

  // admin can switch it off for someone who lost their phone
  await db.query(`UPDATE users SET totp_secret=$1, totp_enabled_at=now() WHERE email='mfa@example.com'`, [secret]);
  const uid = (await db.one(`SELECT id FROM users WHERE email='mfa@example.com'`)).id;
  assert.match((await admin.get(`/manage/users/${uid}/edit`)).text, /Turn off two-factor/);
  assert.equal((await admin.post(`/manage/users/${uid}/2fa-reset`, {})).status, 302);
  assert.equal((await db.one(`SELECT totp_secret FROM users WHERE id=$1`, [uid])).totp_secret, null);
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action='user.2fa_reset'`));
});

test('the last active admin cannot be removed, even by two admins acting at the same moment', async () => {
  const { isLastActiveAdmin } = require('../../src/services/admins');
  const hash = (await db.one('SELECT password_hash FROM users WHERE id=1')).password_hash;
  // other admin accounts left over from earlier tests would make "the last admin" ambiguous: park them for this test
  const parked = (await db.query(`UPDATE users SET active=false WHERE role='admin' AND active AND id<>1 RETURNING id`)).map((r) => r.id);
  await db.query(`INSERT INTO users (email,name,password_hash,role) VALUES ('admin2@example.com','Admin Two',$1,'admin')`, [hash]);
  const b = new Client(); await b.login('admin2@example.com', 'Admin1234');
  const bId = (await db.one(`SELECT id FROM users WHERE email='admin2@example.com'`)).id;
  assert.equal(await db.tx((q) => isLastActiveAdmin(q, 1)), false, 'two admins: neither is the last');
  // A and B try to demote each other at the same time: exactly one may succeed
  const [r1, r2] = await Promise.all([
    admin.post(`/manage/users/${bId}`, { name: 'Admin Two', role: 'guest', active: 'on' }),
    b.post('/manage/users/1', { name: 'Administrator', role: 'guest', active: 'on' }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [302, 400], 'one succeeded, the other was refused');
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND active AND deleted_at IS NULL`)).n, 1, 'one admin is left');
  // restore the original state for the rest of the suite
  await db.query(`UPDATE users SET role='admin' WHERE id=1`);
  await db.query(`UPDATE users SET role='guest', active=false WHERE id=$1`, [bId]);
  if (parked.length) await db.query('UPDATE users SET active=true WHERE id = ANY($1)', [parked]);
});

test('share links have their own page and several can be revoked at once', async () => {
  const { id } = await db.one(`SELECT id FROM blueprints WHERE title='Pets API'`);
  const other = await db.one(`SELECT id FROM blueprints WHERE id <> $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [id]);
  const mk = async (label, bp) => { await admin.post(`/manage/blueprints/${bp}/share`, { days: '7', label }); return (await db.one(`SELECT id FROM share_links WHERE label=$1`, [label])).id; };
  const [a, b, c] = [await mk('Bulk A', id), await mk('Bulk B', id), await mk('Bulk C', id)];
  const foreign = other ? await mk('Bulk other', other.id) : null;
  const page = (await admin.get(`/manage/blueprints/${id}/share`)).text;
  assert.match(page, /Revoke selected/);
  for (const l of [a, b, c]) assert.ok(page.includes(`name="links" value="${l}"`), `link ${l} can be ticked`);

  const form = new URLSearchParams(); [a, b].concat(foreign ? [foreign] : []).forEach((l) => form.append('links', l));
  assert.equal((await admin.post(`/manage/blueprints/${id}/share/revoke`, form)).status, 302);
  const state = async (l) => !!(await db.one('SELECT revoked_at FROM share_links WHERE id=$1', [l])).revoked_at;
  assert.ok((await state(a)) && (await state(b)), 'both ticked links are revoked');
  assert.equal(await state(c), false, 'the unticked one still works');
  if (foreign) assert.equal(await state(foreign), false, "a link of another blueprint can't be revoked through this one");
  assert.match((await db.one(`SELECT detail FROM audit_log WHERE action='blueprint.share_revoked' ORDER BY id DESC LIMIT 1`)).detail, /Revoked 2 share links/);
  assert.match((await admin.post(`/manage/blueprints/${id}/share/revoke`, {})).headers.get('set-cookie') || '', /flash=error/, 'nothing selected is an error');
});

test('invitations: blueprint type-ahead needs 3 letters, returns the best 5 and skips the picked ones', async () => {
  const ask = async (qs) => JSON.parse((await admin.get(`/manage/invites/blueprint-options?${qs}`)).text).items;
  assert.deepEqual(await ask('q=pe'), [], 'under 3 characters: nothing');
  const hit = await ask('q=pets');
  assert.ok(hit.some((b) => b.title === 'Pets API'));
  assert.deepEqual(await ask(`q=pets&exclude=${hit.map((b) => b.id).join(',')}`), [], 'already picked ones are left out');
  for (let i = 0; i < 12; i++) await db.query(`INSERT INTO blueprints (title,version,format,spec) VALUES ($1,'1','yaml','{}')`, [`Typeahead ${i}`]);
  assert.equal((await ask('q=typeahead')).length, 5, 'capped at 5');
  await db.query(`UPDATE blueprints SET description='Matches only through its description zebra' WHERE title='Typeahead 3'`);
  assert.deepEqual((await ask('q=zebra')).map((b) => b.title), ['Typeahead 3'], 'descriptions are searched too and returned');
  await db.query(`UPDATE blueprints SET title='Zebra first' WHERE title='Typeahead 5'`);
  assert.equal((await ask('q=zebra'))[0].title, 'Zebra first', 'title matches rank above description matches');
  await db.query(`DELETE FROM blueprints WHERE title LIKE 'Typeahead %'`);
  assert.equal((await (await new Client().get('/manage/invites/blueprint-options?q=pets')).status), 302, 'admins only');
});

test('a blueprint can have at most 5 active share links; revoking or expiry frees a slot', async () => {
  const { id } = await db.one(`INSERT INTO blueprints (title, format, spec) VALUES ('Limit API','yaml','{"openapi":"3.0.3","info":{"title":"Limit API","version":"1"},"paths":{}}') RETURNING id`);
  const live = async () => (await db.one(`SELECT COUNT(*)::int AS n FROM share_links WHERE blueprint_id=$1 AND revoked_at IS NULL AND expires_at > now()`, [id])).n;
  for (let i = 1; i <= 5; i++) assert.equal((await admin.post(`/manage/blueprints/${id}/share`, { days: '7', label: `link ${i}` })).status, 302);
  assert.equal(await live(), 5);
  const page = (await admin.get(`/manage/blueprints/${id}/share`)).text;
  assert.match(page, /5 of 5 active/);
  assert.match(page, /limit is reached/);
  // the sixth is refused with an explanation, and nothing is created
  const sixth = await admin.post(`/manage/blueprints/${id}/share`, { days: '7', label: 'link 6' });
  assert.equal(sixth.status, 302);
  assert.equal(await live(), 5, 'still 5');
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM share_links WHERE label='link 6'`)).n, 0);
  assert.match((await admin.get(`/manage/blueprints/${id}/share`)).text, /already has 5 active share links/);
  // two admins racing for the last slot: only one wins
  const sid = (await db.one(`SELECT id FROM share_links WHERE blueprint_id=$1 ORDER BY id LIMIT 1`, [id])).id;
  await admin.post(`/manage/blueprints/${id}/share/${sid}/revoke`, {});
  assert.equal(await live(), 4, 'revoking frees a slot');
  await Promise.all([1, 2, 3].map((i) => admin.post(`/manage/blueprints/${id}/share`, { days: '7', label: `race ${i}` })));
  assert.equal(await live(), 5, 'concurrent requests cannot exceed the limit');
  // expired links do not count
  await db.query(`UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = (SELECT id FROM share_links WHERE blueprint_id=$1 AND revoked_at IS NULL ORDER BY id LIMIT 1)`, [id]);
  assert.equal(await live(), 4);
  assert.equal((await admin.post(`/manage/blueprints/${id}/share`, { days: '1', label: 'after expiry' })).status, 302);
  assert.equal(await live(), 5);
  // the limit is per blueprint
  const other = (await db.one(`SELECT id FROM blueprints WHERE id<>$1 ORDER BY id LIMIT 1`, [id])).id;
  const before = (await db.one(`SELECT COUNT(*)::int AS n FROM share_links WHERE blueprint_id=$1 AND revoked_at IS NULL AND expires_at > now()`, [other])).n;
  assert.ok(before < 5);
  await admin.post(`/manage/blueprints/${other}/share`, { days: '7', label: 'elsewhere' });
  assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM share_links WHERE blueprint_id=$1 AND revoked_at IS NULL AND expires_at > now()`, [other])).n, before + 1);
});
