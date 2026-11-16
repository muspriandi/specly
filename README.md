# Specly

A small portal for publishing API documentation from OpenAPI 3.x / Swagger 2.0 blueprints (YAML or JSON).

## Run

Needs Node 20+ and a PostgreSQL server (default `postgres:postgres@localhost:5432`).

    npm install
    cp .env.example .env     # edit if needed
    npm start                # builds the Tailwind CSS, then serves http://localhost:3000

The `specly` database and all tables are created automatically on first start, together with an
admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`) and a sample blueprint.
Forgot the admin password? `npm run reset-admin -- admin@specly.local NewPass123`.

UI is Tailwind CSS v4 (`src/input.css` → `public/app.css`). `npm run dev` rebuilds and restarts on changes.

## Project layout

    server.js              entry point (startup, shutdown)
    src/app.js             Express app factory (middleware order lives here)
    src/config.js          the only place environment variables are read
    src/db.js, db/schema.sql   PostgreSQL pool, transactions, idempotent schema
    src/lib/               http helpers, validation, security (CSRF, rate limits, headers)
    src/services/          auth, access rules, audit log, blueprints (save/versions/diff), share links, Postman export, mail, notifications
    src/routes/            public (auth flows), app (account reading), reader (viewer/spec/changelog/export, also behind share links),
                           account (password, sessions, two-factor), admin/ (users, invites, requests, blueprints, audit, trash)
    views/, public/        EJS templates, Tailwind source in src/input.css
    scripts/               seed, seed-users, reset-admin, backup
    test/                  e2e.test.js loads test/suites/* on the harness in test/support.js; viewer.test.js; browser.test.js

    npm test               end-to-end + viewer + browser smoke tests (temporary database, dropped afterwards;
                           the browser test is skipped without Chrome, or set CHROME_PATH)
    npm run lint           ESLint

## Security notes

CSRF tokens on every form, strict Content-Security-Policy (no inline scripts), hashed sessions and one-time
tokens, single-use reset/invite links, rate limits on login and forgot-password, `Secure` cookies when
`BASE_URL` is https or `NODE_ENV=production`.

## Roles

| Role   | Can do |
|--------|--------|
| admin  | Everything: users, blueprints, invites, approve/reject/revoke access requests |
| member | Read the blueprints assigned to them; can request access to others |
| guest  | Read only the blueprints an admin assigned; cannot request access |

## Flows

- **Invite**: Admin → Invites → pick the role (member or guest) and, optionally, blueprints → email gets a 72h link → they set name + password and the chosen blueprints are ready on first sign-in.
- **Request/approval**: a member clicks *Request access* on Home → Admin → Requests → approve/reject. Guests cannot request; an admin assigns blueprints from Manage → Blueprints → Access (who can read this blueprint) or Manage → Users → Access (which blueprints this user can read). Both pages can un-assign several at once.
- **Forgot password**: `/forgot` → 1h email link → `/reset/:token` (signs out all sessions).
- **Change password**: any signed-in user (admin, member, guest) → account menu → Change password. Needs the current password and signs out the other devices.
- **Emails about access**: admins are emailed when a member requests a blueprint; people are emailed when they are approved or assigned one (`NOTIFY_EMAILS=false` turns these off; invitations and resets always send).
- **Changelog and export**: every reader sees *what changed* per revision (endpoints added/changed/removed/deprecated) from the viewer's Changelog button, and can download the original file or a Postman collection (v2.1).
- **Share links**: Manage → Blueprints → Access → *Share link* creates a read-only URL (1–90 days) for people without an account. It exposes that one blueprint only (no search, no other pages), can be revoked at any time, is never indexed, and only a hash of it is stored. Opening a link writes nothing to the database.
- **Editing conflicts**: if someone saves a newer revision while you are editing, your save is refused with your text kept; tick *overwrite* to save on top anyway.
- **Two-factor sign-in** (account menu, any user; recommended for admins): TOTP authenticator app + 10 single-use recovery codes. An admin can turn it off for someone who lost their phone (Users → Edit), and `npm run reset-admin` clears it for the admin it resets.
- **Active sessions** (account menu): see signed-in devices, sign one out or all the others.
- **Last admin**: the last active admin cannot be demoted, disabled or deleted, even by two admins acting at once.
- **Search**: top bar; matches blueprints and endpoints (path, method, summary, operationId), only within blueprints the user may read.

## Configuration

All settings live in `.env` (see `.env.example`): `PORT`, `BASE_URL` (used in email links), `DATABASE_URL`,
`ADMIN_EMAIL`/`ADMIN_PASSWORD`, `SMTP_*`/`MAIL_FROM` (without `SMTP_HOST`, emails are printed to the console)
and `TRUST_PROXY`.

Serve over HTTPS in production (the session cookie is `httpOnly`, `SameSite=Lax`).

Optional tuning: `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS`, `DATABASE_SSL`, `LOGIN_RATE_MAX`, and the logging settings below.
With `NODE_ENV=production` the app refuses to start without `BASE_URL`, `DATABASE_URL` and `SMTP_HOST`
(`ALLOW_CONSOLE_MAIL=true` overrides the last one for demos only).

## Operations

- **Health**: `GET /healthz` returns 200 `{"status":"ok"}` when the database answers, 503 otherwise (no login needed).
- **Logs** (for monitoring): see "Logging and the audit log" below.
- **Docker**: `ADMIN_PASSWORD=choose-one docker compose up --build` runs the app and PostgreSQL (see `docker-compose.yml`). The image runs as a non-root user and has a health check.
- **Backups**: `npm run backup` writes `backups/specly-<timestamp>.dump` (keeps the newest `BACKUP_KEEP`, default 14; `BACKUP_DIR` to change the folder). Restore with `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" <file>`. Schedule it and copy the files off the machine.
- **CI**: `.github/workflows/ci.yml` runs lint, the tests and a Docker build on every push and pull request (move it to the repository root if this folder is not the root).
- **Schema**: `db/schema.sql` is idempotent and takes an advisory lock, so several instances can start at once.

## Logging and the audit log

**Application log** (`src/lib/log.js`): structured lines on stdout (warnings and errors on stderr), so any collector can read them
(Docker logs, journald, Loki, CloudWatch, Datadog…). JSON in production, readable text in development.
`LOG_LEVEL` (`error`/`warn`/`info`/`debug`/`silent`, default `info`), `LOG_FORMAT` (`json`/`pretty`), `SLOW_REQUEST_MS`, `SLOW_QUERY_MS`.

Every line has `t`, `level`, `msg`; most have a stable `event` name to filter and alert on:

| event | level | meaning |
|---|---|---|
| `server.started`, `server.stopping`, `server.stopped` | info | lifecycle, with version, port, database host (no credentials) and settings |
| `http.request` | info / warn / error | one per request: method, path, status, ms, user id, IP and `req` (also sent as `X-Request-Id` and shown on error pages). 5xx error; 401, 403, 429 and slow requests warn. Static files and `/healthz` are not logged |
| `http.error` | error | an unhandled exception, with `req` and a short stack |
| `db.slow_query` | warn | the SQL text (never the parameters) and how long it took |
| `db.pool_error`, `db.purge`, `mail.failed`, `job.failed` | error / info | infrastructure problems and housekeeping |
| `audit` | info | every administrative or account event, with `event` = the action, `actor`, `target`, `detail`, and `stored` (true if it is also in the audit table) |
| `security` | warn | `auth.login_failed` (with `reason`), `auth.login_locked`, `auth.2fa_failed`, `csrf.rejected`, `rate_limited`, `share.invalid`… for spotting brute force and probing |

Never logged: passwords, tokens, cookies, query strings, request bodies, SQL parameters. Emails in security events are masked (`j***@example.com`) and one-time tokens in URLs show as `/reset/:token`, `/invite/:token`, `/s/:token`.

**Audit table** (Manage → Audit log): the admin-facing record, kept small. Only security and administrative changes are stored: user and role changes,
access and share-link changes, access-request decisions, deletions and restores, credential and two-factor changes, and admin sign-ins.
High-volume or low-value events are **only logged**: other users' sign-ins, access requests, invitations sent, sessions ended, and blueprint saves
(those are already recorded, with author and note, in each blueprint's revision history). The list lives in `src/services/audit.js`
(`STORED`); `AUDIT_STORE=all` stores everything again. Stored details are cut to 300 characters (the log keeps 800), and
`AUDIT_RETENTION_DAYS=365`, for example, deletes older rows during the hourly cleanup (default: keep forever).
