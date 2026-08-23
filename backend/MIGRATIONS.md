# Database migrations (Prisma Migrate)

This backend uses **Prisma Migrate** — a committed, reviewable migration history
in `prisma/migrations/`. It replaced the old destructive
`prisma db push --accept-data-loss` deploy step (which silently dropped any
table not in the schema, e.g. the connect-pg-simple `session` table — the cause
of the recurring "internal error on login").

## Deploy
Render **Build Command**:
```
npm install && npm run build
```
`npm run build` runs `prisma generate && prisma migrate deploy`. `migrate
deploy` applies only new, unapplied migrations and never drops anything outside
an explicit migration.

## One-time baseline (do this once, locally)
The prod DB already has tables (created by the old `db push`) but no migration
history. Baseline it so the first `migrate deploy` has a starting point. Use the
prod `DATABASE_URL` from Render → Environment.

```bash
cd backend
mkdir -p prisma/migrations/0_init

# Generate the initial migration SQL from the current schema (SQL only):
DATABASE_URL="postgresql://…neon…" npx prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql

# Mark it as already applied (tables already exist in prod):
DATABASE_URL="postgresql://…neon…" npx prisma migrate resolve --applied 0_init

# Commit prisma/migrations/ (including 0_init).
git add prisma/migrations && git commit -m "Baseline Prisma migrations"
```

> Tip: baseline against a **Neon branch** first to rehearse, then repeat on the
> primary branch. Neon's branching makes this zero-risk.

## Everyday changes
```bash
cd backend
# edit prisma/schema.prisma, then:
DATABASE_URL="postgresql://…neon-branch…" npx prisma migrate dev --name describe_change
# commit the new prisma/migrations/<timestamp>_describe_change/ folder, then push.
```
The deploy applies it via `migrate deploy`.

## Notes
- Additive changes (new table/column/index) are safe.
- Destructive changes (drop/rename) are written into the migration SQL for you
  to review before committing — no silent data loss on deploy.
- The `session` table (connect-pg-simple) is now declared in `schema.prisma`, so
  it is part of the managed schema and will never be dropped by a migration.
