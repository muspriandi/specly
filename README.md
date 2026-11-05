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
    src/services/          auth, access rules, audit log, blueprints (save/versions/diff), mail, spec parsing
    src/routes/            public (auth flows), app (reading), admin/ (users, invites, requests, blueprints, audit)
    views/, public/        EJS templates, Tailwind source in src/input.css
    test/e2e.test.js       end-to-end tests

Run the tests with `npm test` (uses a temporary database that is dropped afterwards).

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

- **Invite**: Admin → Invites → email gets a 72h link → guest sets name + password.
- **Request/approval**: a member clicks *Request access* on Home → Admin → Requests → approve/reject. Guests cannot request; an admin assigns blueprints from Manage → Blueprints → Access (who can read this blueprint) or Manage → Users → Access (which blueprints this user can read). Both pages can un-assign several at once.
- **Forgot password**: `/forgot` → 1h email link → `/reset/:token` (signs out all sessions).
- **Change password**: any signed-in user (admin, member, guest) → account menu → Change password. Needs the current password and signs out the other devices.
- **Search**: top bar; matches blueprints and endpoints (path, method, summary, operationId), only within blueprints the user may read.

## Configuration

All settings live in `.env` (see `.env.example`): `PORT`, `BASE_URL` (used in email links), `DATABASE_URL`,
`ADMIN_EMAIL`/`ADMIN_PASSWORD`, `SMTP_*`/`MAIL_FROM` (without `SMTP_HOST`, emails are printed to the console)
and `TRUST_PROXY`.

Serve over HTTPS in production (the session cookie is `httpOnly`, `SameSite=Lax`).
