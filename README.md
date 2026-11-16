<h1 align="center">Specly</h1>

<p align="center"><strong>Publish API documentation from OpenAPI / Swagger, and control who can read it.</strong><br>
Upload a spec, preview it, review what changed, publish. Readers get a clean, searchable reference with ready-to-copy examples.</p>

<p align="center">
  <a href="https://github.com/muspriandi/specly/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/muspriandi/specly/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/postgresql-14%2B-4169E1?logo=postgresql&logoColor=white">
  <img alt="OpenAPI 3.x and Swagger 2.0" src="https://img.shields.io/badge/openapi-3.x%20%7C%20swagger%202.0-6BA539?logo=openapiinitiative&logoColor=white">
</p>

<p align="center"><img src="docs/screenshots/viewer.png" alt="An endpoint in Specly: description, headers, body schema, and example request and response" width="100%"></p>

## What you get

- **A reference people enjoy reading.** Folders and endpoints, request and response schemas, and example calls in cURL, JavaScript and Python. Light and dark, works on a phone.
- **A publish flow with a safety net.** Edit, preview on desktop/tablet/phone, review exactly which endpoints were added, changed or removed (and which changes can **break clients**), then publish. Every save is a revision you can read, compare, download or restore. Pipelines can publish too.
- **Access you control.** Admins, members and guests; blueprints are assigned per person, optionally until a date; members can request more; read-only share links for people outside your team.
- **An audit trail and sensible security.** Two-factor sign-in, active sessions, rate limits, a small audit log of the changes that matter and structured logs for everything else.

## Tour

### Read

<table>
<tr>
<td width="50%"><img src="docs/screenshots/viewer-wip.png" alt="An endpoint marked WIP, with its status note"></td>
<td width="50%"><img src="docs/screenshots/viewer-dark.png" alt="The same reference in dark mode"></td>
</tr>
<tr>
<td><sub><b>Work in progress, deprecated, beta.</b> Share a contract before the endpoint exists: add <code>x-status: wip</code> (and <code>x-status-description</code>) and readers see a badge and your note.</sub></td>
<td><sub><b>Dark mode</b> and a command palette (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>). Search covers paths, methods, summaries and operation ids, and only ever looks inside what the reader may open.</sub></td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/home.png" alt="The list of blueprints"></td>
<td width="50%"><img src="docs/screenshots/changelog.png" alt="A changelog listing what changed in each revision, with breaking changes called out"></td>
</tr>
<tr>
<td><sub><b>Your blueprints</b>, filtered to what you are allowed to read. Download the original file or a Postman collection from the viewer.</sub></td>
<td><sub><b>What changed.</b> Every revision lists the endpoints added, changed, removed and newly deprecated, and calls out the <b>breaking changes</b>, so integrators do not have to diff a spec.</sub></td>
</tr>
</table>

### Publish

<table>
<tr>
<td width="50%"><img src="docs/screenshots/publish-edit.png" alt="Step 1: edit the spec"></td>
<td width="50%"><img src="docs/screenshots/publish-preview.png" alt="Step 2: preview the draft as readers will see it"></td>
</tr>
<tr>
<td><sub><b>1. Edit.</b> Type, paste or drop a YAML/JSON file. It is validated and linted as you go, with the line number of any error.</sub></td>
<td><sub><b>2. Preview</b> the unsaved draft with the real viewer, at desktop, tablet or phone width, in light or dark.</sub></td>
</tr>
</table>

<p align="center"><img src="docs/screenshots/publish-review.png" alt="Step 3: review the changes against the current revision" width="80%"><br>
<sub><b>3. Review changes</b> against the current revision, add a note, publish. If someone saved a newer revision while you were editing, your save is refused and your text is kept.</sub></p>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/compare.png" alt="Comparing two revisions: breaking changes listed first"></td>
<td width="50%"><img src="docs/screenshots/api-tokens.png" alt="Publish-from-CI tokens and a curl example"></td>
</tr>
<tr>
<td><sub><b>Compare any two revisions.</b> Breaking changes first: a parameter that became required, a field that disappeared, a response that changed type. Admins can also open any old revision as documentation.</sub></td>
<td><sub><b>Publish from CI.</b> A token that can publish one blueprint and nothing else. A broken spec fails the pipeline instead of reaching readers.</sub></td>
</tr>
</table>

### Control access

<table>
<tr>
<td width="50%"><img src="docs/screenshots/access.png" alt="Who can read a blueprint, with an Assign users panel"></td>
<td width="50%"><img src="docs/screenshots/share-links.png" alt="Share links for a blueprint"></td>
</tr>
<tr>
<td><sub><b>Who can read this blueprint.</b> Assign and un-assign people one by one or in bulk, and filter by role. The same view exists per user.</sub></td>
<td><sub><b>Share links</b> for people without an account: read-only, expiring, revocable, shown once, at most five active per blueprint.</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/users.png" alt="User management"></td>
<td><img src="docs/screenshots/audit.png" alt="The audit log"></td>
</tr>
<tr>
<td><sub><b>Users.</b> Roles, status, search, sorting, invitations with a role and blueprints pre-assigned, and a trash with restore.</sub></td>
<td><sub><b>Audit log.</b> Account, access and credential changes, kept small on purpose; high-volume events go to the application log.</sub></td>
</tr>
</table>

<p align="center"><img src="docs/screenshots/mobile-home.png" alt="Specly on a phone" width="260"></p>

## Quick start

Needs Node 22+ (24 LTS recommended, see `.nvmrc`) and a PostgreSQL server (default `postgres:postgres@localhost:5432`).

```sh
npm install
cp .env.example .env        # set ADMIN_EMAIL / ADMIN_PASSWORD, and DATABASE_URL if yours differs
npm run migrate             # creates the database and all tables
npm run seed                # the first admin + five sample blueprints
npm run seed -- --demo      # optional: a demo member and guest to try the roles (development only)
npm start                   # builds the CSS, then serves http://localhost:3000
```

Sign in with the admin from `.env`; if `ADMIN_PASSWORD` is empty a password is generated and printed once.
`npm start` also migrates and, on a completely empty database, creates the admin and one sample blueprint by itself,
so `npm install && npm start` is enough to look around. `npm run dev` rebuilds the CSS and restarts on changes.

**Docker:** `ADMIN_PASSWORD=choose-one docker compose up --build` runs the app and PostgreSQL (see `docker-compose.yml`).
The image runs as a non-root user and has a health check.

Locked out? Use *Forgot password* (needs SMTP; in development the link is printed in the server console), or ask another admin to reset your password or two-factor sign-in in Manage → Users.

## Roles

| Role | Can do |
|------|--------|
| **admin** | Everything: users, blueprints, invitations, access decisions, share links, trash, audit log |
| **member** | Read the blueprints assigned to them; can request access to others |
| **guest** | Read only the blueprints an admin assigned; cannot request access |

## How people get access

- **Invite:** Manage → Invitations → choose a role and, optionally, blueprints → the person gets a 72-hour link, sets a name and password, and finds their blueprints ready.
- **Request:** a member clicks *Request access* on a blueprint → admins are emailed → approve or reject in Manage → Access requests → the member is emailed.
- **Assign:** Manage → Blueprints → Access (who can read this blueprint) or Manage → Users → Access (what this person can read). Both un-assign in bulk.
- **Share link:** for someone without an account: read-only access to that one blueprint (no search, no other pages), 1 to 90 days, revocable, never indexed. Only a hash of the link is stored, and opening one writes nothing to the database.
- **Single sign-on:** optional OpenID Connect (Google, Microsoft Entra, Okta, Keycloak, Auth0, …). A *Sign in with …* button appears next to the password form. Authorization code flow with PKCE, state and nonce; the ID token's signature, issuer, audience, expiry and nonce are all checked; and only an email the provider has **verified** is accepted. Accounts are matched by email, and with `OIDC_ALLOWED_DOMAINS` only those domains can sign in this way. `OIDC_AUTO_CREATE=true` creates a **guest** on first sign-in (who sees nothing until an admin assigns blueprints). The provider is trusted to apply its own second factor, so the local authenticator step is skipped for SSO sign-ins.
- **Time-limited access:** when assigning, pick an end date: the person can read until the end of that day (UTC), then it stops everywhere and they can request it again.
- **Sign-in:** optional two-factor sign-in (authenticator app plus single-use recovery codes), a page of active sessions, idle sessions end after 24 hours, and the last active admin can never be demoted, disabled or deleted.

## Publish from CI

Manage → Blueprints → ⋯ → *Publish from CI* creates a token that can publish **one blueprint** and nothing else (it cannot read documents or reach any other blueprint). It is shown once, can expire, can be revoked, and only its hash is stored.

```sh
curl --fail-with-body -X PUT "https://docs.example.com/api/v1/blueprints/12" \
  -H "Authorization: Bearer $SPECLY_TOKEN" \
  -H "Content-Type: application/yaml" \
  -H "X-Change-Note: Release $GITHUB_SHA" \
  --data-binary @openapi.yaml
```

The answer is JSON: `unchanged`, the new `revision`, counts of `added` / `changed` / `removed` / `deprecated` endpoints, and a `breaking` list. An invalid document is refused with 400 and the line of the error, so a broken spec fails the pipeline instead of reaching readers. Limits: 5 MB per document, 60 publishes a minute per token, 10 active tokens per blueprint.

**Breaking changes** are worked out field by field (OpenAPI 3.x and Swagger 2.0, local `$ref`s resolved): a parameter that became required or changed type, a request field that became required, a success response or response field that disappeared or changed type, a removed endpoint. They are shown before you publish, in the changelog and in the API answer. Admins can open any old revision as documentation and compare any two (Manage → Blueprints → History).

## Configuration

Everything is read from `.env` in one place, `src/config.js` (copy `.env.example`).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `BASE_URL` | – | Public URL for links in emails and share links (required in production) |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/specly` | PostgreSQL connection (required in production) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@specly.local`, generated | The first admin, used by `npm run seed` and the first start |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | – | Email. Without `SMTP_HOST`, emails are printed to the console (development only) |
| `NOTIFY_EMAILS` | `true` | Emails about access requests, and assignments (invitations and resets always send) |
| `APP_SECRET` | – | 32+ characters; encrypts two-factor secrets in the database. **Required in production**: `openssl rand -base64 32` |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | – | Turn on single sign-on (all three). Register `<BASE_URL>/auth/oidc/callback` as the redirect URI. The issuer must be `https://` |
| `OIDC_NAME`, `OIDC_SCOPE` | `single sign-on`, `openid email profile` | Button label and requested scopes |
| `OIDC_ALLOWED_DOMAINS`, `OIDC_AUTO_CREATE` | – , `false` | Which email domains may sign in with SSO (comma-separated), and whether to create a guest account on first sign-in (needs the list) |
| `AUTO_MIGRATE`, `AUTO_SEED` | `true` | Apply migrations on start; create the admin and a sample on a first start |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS`, `DATABASE_SSL` | `10`, `15000`, `5000`, `false` | Database tuning |
| `LOGIN_RATE_MAX` | `30` | Sign-in attempts per IP per 15 minutes |
| `SESSION_IDLE_HOURS` | `24` | Sessions end after this long without activity (`0` = never); the hard limit is 7 days |
| `TRASH_RETENTION_DAYS` | `30` | Deleted blueprints and users are removed for good after this many days (`0` = never); each removal is audited |
| `BCRYPT_COST` | `12` | Password hashing cost (4 to 15); hashes are upgraded at sign-in when you raise it |
| `LOG_LEVEL`, `LOG_FORMAT`, `SLOW_REQUEST_MS`, `SLOW_QUERY_MS` | `info`, `json`/`pretty`, `1000`, `500` | Logging, see below |
| `AUDIT_STORE`, `AUDIT_RETENTION_DAYS` | `important`, `0` (forever) | What the audit table keeps, and for how long |

With `NODE_ENV=production` the app refuses to start without `BASE_URL`, `DATABASE_URL`, `SMTP_HOST` (`ALLOW_CONSOLE_MAIL=true` overrides this one, for demos only) and `APP_SECRET`, and refuses an `ADMIN_PASSWORD` shorter than 12 characters or a well-known example. Serve it over HTTPS: sessions are `httpOnly`, `SameSite=Lax`, and `Secure` on https.

## Database migrations and seed data

The schema is versioned: `db/migrations/NNN_name.sql` files are applied in number order, each in its own transaction, and recorded in the
`schema_migrations` table with a checksum (an edited migration is refused). Forward-only; several instances can start at once.

```sh
npm run migrate                    # apply pending migrations (creates the database if needed)
npm run migrate:status             # what is applied and what is pending
npm run migrate:new -- add_tags    # create the next numbered, empty migration
```

`001_baseline.sql` is the whole schema as of today and is safe on databases created before migrations existed (they simply get it recorded).
Change the schema by adding a migration, never by editing an applied one. `AUTO_MIGRATE=false` makes the server refuse to start while
migrations are pending, so you can run `npm run migrate` as a deliberate step, for example before a deploy.

`npm run seed` (`src/seed.js`) only adds what is missing and never overwrites: the admin, the five example blueprints in `samples/` (matched by title)
and, with `--demo`, `demo.member@specly.local` and `demo.guest@specly.local` with generated passwords printed once
(`DEMO_PASSWORD` sets one for both; refused in production). `--no-samples` skips the blueprints.

## Operations

- **Health:** `GET /healthz` returns 200 `{"status":"ok"}` when the database answers and 503 otherwise, with no login needed.
- **Backups:** `npm run backup` writes `backups/specly-<timestamp>.dump` and keeps the newest `BACKUP_KEEP` (default 14; `BACKUP_DIR` changes the folder). Restore with `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" <file>`. Schedule it and copy the files off the machine, and encrypt them: a dump holds personal data. In the Docker image (which has no npm) run `node scripts/backup.js` instead.
- **CI:** `.github/workflows/ci.yml` runs lint, the onboarding path (migrate and seed on a fresh database), the tests and a Docker build on every push and pull request.
- **Logs and the audit log:** see below.

<details>
<summary><strong>Logging and the audit log</strong></summary>

**Application log** (`src/lib/log.js`): structured lines on stdout (warnings and errors on stderr), so any collector can read them
(Docker logs, journald, Loki, CloudWatch, Datadog…). JSON in production, readable text in development.
`LOG_LEVEL` is `error`, `warn`, `info`, `debug` or `silent`.

Every line has `t`, `level` and `msg`; most have a stable `event` name to filter and alert on:

| event | level | meaning |
|---|---|---|
| `server.started`, `server.stopping`, `server.stopped` | info | lifecycle, with version, port, database host (no credentials) and settings |
| `http.request` | info / warn / error | one per request: method, path, status, ms, user id, IP and `req`, which is also sent as `X-Request-Id` and shown on error pages. 5xx is an error; 401, 403, 429 and slow requests warn. Static files and `/healthz` are not logged |
| `http.error` | error | an unhandled exception, with `req` and a short stack |
| `db.slow_query` | warn | the SQL text (never the parameters) and how long it took |
| `db.pool_error`, `db.purge`, `db.migration`, `mail.failed`, `job.failed` | error / info | infrastructure problems and housekeeping |
| `audit` | info | every administrative or account event: `event` is the action, plus `actor`, `target`, `detail` and `stored` (true if it is also in the audit table) |
| `security` | warn | `auth.login_failed` (with `reason`), `auth.login_locked`, `auth.2fa_failed`, `csrf.rejected`, `rate_limited`, `share.invalid`… for spotting brute force and probing |

Never logged: passwords, tokens, cookies, query strings, request bodies or SQL parameters. Emails in security events are masked (`j***@example.com`) and one-time tokens in URLs show as `/reset/:token`, `/invite/:token` and `/s/:token`.

**Audit table** (Manage → Audit log) is the admin-facing record and is kept small. It stores security and administrative changes: user and role changes,
access and share-link changes, access-request decisions, deletions and restores, credential and two-factor changes, and admin sign-ins.
High-volume or low-value events are **only logged**: other users' sign-ins, access requests, invitations sent, sessions ended and blueprint saves
(those are already recorded, with author and note, in each blueprint's revision history). The list is `STORED` in `src/services/audit.js`;
`AUDIT_STORE=all` stores everything again. Stored details are cut to 300 characters (the log keeps 800), and
`AUDIT_RETENTION_DAYS=365`, for example, deletes older rows during the hourly cleanup.

</details>

## Security notes

- **Requests:** CSRF tokens on every form, a strict Content-Security-Policy (no inline scripts, no framing by other sites), `Permissions-Policy`, `nosniff`, and `Cache-Control: no-store` on every dynamic page. The machine API has no cookies and no sessions, only bearer tokens.
- **Accounts:** passwords hashed with bcrypt (cost 12, upgraded at sign-in), trivial passwords refused, rate limits on sign-in, password reset, two-factor codes and search, failed sign-ins logged but never stored, and a password reset that answers at the same speed whether or not the account exists. Two-factor secrets are encrypted at rest; recovery codes, sessions, one-time links, share links and API tokens are stored as hashes only.
- **Documents:** specs are parsed as plain data (no YAML types, so no code execution), and a document that expands enormously through YAML aliases ("billion laughs"), nests too deeply or loops is rejected before anything walks it. Everything a spec contains is escaped when shown, and descriptions are sanitised markdown.
- **Supply chain:** `npm audit` runs in CI (any known vulnerability, production or development, fails the build), Dependabot opens weekly updates, and the image runs on the current Node LTS as a non-root user. Node 20 reached end of life in March 2026 and is not supported.
- **Your part:** serve it over HTTPS, set `TRUST_PROXY=true` behind a proxy so rate limits see real addresses, keep `APP_SECRET` out of the repository, and encrypt backups: a database dump contains personal data.

## Development

```sh
npm test                # end-to-end, viewer and browser smoke tests (a temporary database, dropped afterwards)
npm run lint            # ESLint
npm run screenshots     # regenerates docs/screenshots/* from a throwaway database (needs Chrome, or CHROME_PATH)
```

The browser test is skipped when Chrome is not available. The UI is Tailwind CSS v4 (`src/input.css` → `public/app.css`).
Design notes are in [`docs/ux`](docs/ux/README.md).

```
server.js                      entry point (startup, shutdown)
src/app.js                     Express app factory (middleware order lives here)
src/config.js                  the only place environment variables are read
src/db.js, src/migrate.js      PostgreSQL pool and transactions; versioned SQL migrations (db/migrations)
src/seed.js                    starter data (admin, samples, demo accounts)
src/lib/                       logging, http helpers, validation, security (CSRF, rate limits, headers), TOTP
src/services/                  auth, access rules, audit, blueprints (save, versions, diff), share links, Postman export, mail, notifications
src/routes/                    public (sign-in flows), app (home, search), reader (viewer, spec, changelog, export; also behind share links),
                               account (password, sessions, two-factor), admin/ (users, invitations, requests, blueprints, audit, trash)
views/, public/                EJS templates and browser scripts
scripts/                       migrate, seed, backup, screenshots
test/                          e2e.test.js loads test/suites/* on the harness in test/support.js; viewer.test.js; browser.test.js
```
