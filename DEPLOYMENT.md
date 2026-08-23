# Deployment & Infrastructure

How this project is hosted, what it depends on, and how to ship changes safely.
This is a **monorepo** with two independently deployed apps: `backend/` (the API)
and `frontend/` (the React UI).

```
GitHub: github.com/kotzabasis/outreach-crm   (branch: main — push = auto-deploy)
        │
        ├── backend/   ──►  Render  (web service)   https://outreach-crm-a22j.onrender.com
        │                      │
        │                      └──►  Neon  (Postgres: app data + sessions)
        │
        └── frontend/  ──►  Vercel  (React/Vite SPA)   → calls the Render API
```

## Backend — Render

- **Service URL:** `https://outreach-crm-a22j.onrender.com`
- **Source:** GitHub `kotzabasis/outreach-crm`, branch `main`. Render auto-deploys
  on every push to `main`.
- **Root directory:** `backend/` (set in the Render dashboard — this is a monorepo).
- **Build command:** `npm install && npx prisma generate`
- **Start command:** `npm start` (`node src/server.js`)
- **Plan:** free web service — **sleeps after ~15 min idle** and cold-starts in
  ~30–40s on the next request. The in-process cron scheduler
  (`backend/src/lib/scheduler.js`) is paused while asleep.
- **Config lives in the Render dashboard, not in this repo** — there is no
  `render.yaml`. Env vars, build/start commands, and the root directory are all
  set there.

### Keep-alive
`.github/workflows/keep-alive.yml` (GitHub Actions) pings `/health` every 5
minutes so Render doesn't spin the service down and stall scheduled sends. The
`/health` endpoint does a real `SELECT 1` against Neon, so a failing ping also
signals DB trouble, not just a sleeping process.

### Backend environment variables (set in Render → Environment)
Required (the server refuses to boot without these):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (also backs sessions) |
| `SESSION_SECRET` | signs session cookies — `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | AES-256-GCM key for Gmail tokens at rest — `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail API OAuth |

Also expected in production:

| Var | Purpose |
|---|---|
| `NODE_ENV=production` | enables secure, `sameSite=none` cookies + generic error messages |
| `BASE_URL` | the Render URL — used to build tracking pixel/link URLs |
| `FRONTEND_URL` | the Vercel URL — required for CORS, cross-site cookies, OAuth redirect |
| `GOOGLE_REDIRECT_URI` | `https://outreach-crm-a22j.onrender.com/auth/google/callback` |

Optional integrations (leave blank to disable — see `backend/SETUP.md`):
`SENTRY_DSN`, `SMTP_*` (password-reset email), `META_APP_SECRET` /
`META_VERIFY_TOKEN`, `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` /
`LINKEDIN_REDIRECT_URI` / `LINKEDIN_API_VERSION`, `MAX_EMAILS_PER_DAY_PER_ACCOUNT`.

> `.env` is git-ignored and does **not** exist locally — production values live
> only in Render. This matters for schema commands (see below).

## Database — Neon

- **Neon** free-tier Postgres. Requires SSL (the app sets
  `ssl: { rejectUnauthorized: false }` for the session pool).
- Holds all application data **and** the express-session store
  (`connect-pg-simple`, table `session`, auto-created on first boot).
- The connection string is `DATABASE_URL`, stored in Render's env.

## Frontend — Vercel

- **Vercel** Hobby, React + Vite SPA built from `frontend/`.
- `frontend/vercel.json` rewrites all routes to `/index.html` (SPA routing).
- Talks to the backend via **`VITE_API_URL`** (a build-time env var set in
  Vercel; defaults to `http://localhost:4000` if unset). Because the frontend
  and backend are on **different domains**, the backend uses `sameSite=none`
  cookies + double-submit CSRF tokens (see "CSRF" under Troubleshooting).

## External services

| Service | Used for | Env |
|---|---|---|
| Google Cloud / Gmail API | OAuth connect + sending outreach email | `GOOGLE_*` |
| Neon | Postgres (data + sessions) | `DATABASE_URL` |
| Sentry | error monitoring (optional) | `SENTRY_DSN` |
| SMTP provider | password-reset system email (optional) | `SMTP_*` |
| Meta Lead Ads | inbound lead capture (optional) | `META_*` |
| LinkedIn Lead Gen | inbound lead capture (optional) | `LINKEDIN_*` |

## Shipping a code change

1. Commit and push to `main`.
2. Render (backend) and Vercel (frontend) each auto-deploy the parts that
   changed. Zero-downtime; expect one cold start on the backend after it
   restarts.
3. Frontend env changes (like `VITE_API_URL`) require a Vercel redeploy to take
   effect, since they're baked in at build time.

## Shipping a database (schema) change

This project uses **Prisma Migrations** (`prisma migrate`) — a reviewable,
version-controlled migration history under `backend/prisma/migrations/`. This
replaces the old `prisma db push --accept-data-loss` build step, which was
destructive (it silently dropped any table not in the schema — that's what kept
dropping the connect-pg-simple `session` table and breaking login).

**Schema changes are applied automatically on every deploy.** Set the Render
**Build Command** (dashboard, not in this repo) to:

```
npm install && npm run build
```

where `npm run build` = `prisma generate && prisma migrate deploy`. On each
deploy, `migrate deploy` applies any *new, unapplied* migration files to Neon —
and only those. It never drops anything that isn't part of an explicit
migration, so unmanaged tables (like `session`) are always safe.

### Making a schema change (the normal loop)
1. Edit `backend/prisma/schema.prisma`.
2. Generate a migration locally against a dev/branch DB (supply the URL; there's
   no committed `.env`):
   ```bash
   cd backend
   DATABASE_URL="postgresql://…neon-branch…" npx prisma migrate dev --name describe_change
   ```
   This writes a new folder under `prisma/migrations/` — **commit it**.
3. Push. The deploy runs `prisma migrate deploy` and applies it to prod.

Additive changes (new tables/columns/indexes) are safe. For a **destructive**
change (drop/rename a column), Prisma writes the `DROP`/`ALTER` into the
migration SQL where you can review it before committing — no more silent data
loss on deploy. Take a Neon backup/branch first when a change might lose data.

### ⚠️ One-time baseline (migrating an existing db-push database)
The production DB was previously managed by `db push`, so it has tables but **no
migration history**. Before the first `migrate deploy` can run, baseline it once
(run locally, with the prod `DATABASE_URL` from Render → Environment):

```bash
cd backend
# 1. Snapshot the CURRENT schema as the initial migration (SQL only, not applied):
mkdir -p prisma/migrations/0_init
DATABASE_URL="postgresql://…neon…" npx prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
# 2. Mark it as already-applied (the tables already exist in prod):
DATABASE_URL="postgresql://…neon…" npx prisma migrate resolve --applied 0_init
# 3. Commit the prisma/migrations/ folder.
```
After that, every subsequent `prisma migrate dev` (local) + `migrate deploy`
(on deploy) works normally. See `backend/MIGRATIONS.md` for the same steps.

Running a `prisma` command locally **without** `DATABASE_URL` set produces the
`P1012 / Environment variable not found: DATABASE_URL` error.

## Troubleshooting

- **`csrf_token_invalid` on every POST/PATCH/DELETE (cross-origin).** The backend
  sends the CSRF token in the `X-CSRF-Token` response header; the frontend must
  be able to read it. This requires `exposedHeaders: ["X-CSRF-Token"]` in the
  backend CORS config (`backend/src/server.js`) — without it, cross-origin JS
  can't see the header, never sends a token, and every mutating request 403s.
  (Fixed in commit `4a3837b`.) After deploying, hard-refresh the frontend so it
  drops the stale in-memory token.
- **Random logouts / "invalid OAuth state" on Gmail connect.** Caused by
  in-memory sessions being wiped on restart. Already handled: sessions are
  persisted in Neon via `connect-pg-simple`.
- **First request after idle fails, second works.** Render cold start (~30–40s).
  The frontend API client (`frontend/src/lib/api.js`) already retries once
  automatically; the keep-alive workflow minimizes how often this happens.
- **`Prisma schema validation - (get-config wasm)` / "Environment variable not
  found: DATABASE_URL".** You ran a `prisma` command locally with no
  `DATABASE_URL` set (there's no local `.env`). You usually don't need to run
  Prisma locally at all — schema syncs automatically on deploy (see above). If
  you do need to, prefix the command with the Neon `DATABASE_URL`. Note: the
  free Render tier has **no Shell**, so the "run it on the server" option isn't
  available here.
