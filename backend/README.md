# Outreach CRM — Backend

A Node.js/Express backend for a Gmail-based outreach CRM: contact
management, CSV import, multi-step email sequences with delays, open/click
tracking, and analytics — all sending through the user's own Gmail account
via the Gmail API (never a third-party SMTP relay).

- **Start here:** [`SETUP.md`](./SETUP.md) — Google Cloud setup, local run, deployment
- **Read before going live:** [`SECURITY.md`](./SECURITY.md) — what's already handled, what you must configure, and legal/compliance notes for cold email

## Stack

- Express + Prisma (SQLite locally, Postgres in production)
- `googleapis` for Gmail OAuth + sending
- `node-cron` for the sequence-sending scheduler
- AES-256-GCM for encrypting stored OAuth tokens

## Project layout

```
src/
  server.js         — app entry point, middleware, route mounting
  db.js             — Prisma client
  lib/
    crypto.js          — token encryption/decryption
    gmailClient.js      — OAuth flow + email sending + tracking injection
    mailer.js            — SMTP sender for system emails (password reset)
    scheduler.js          — cron job that sends due sequence steps
    requireAuth.js         — session auth middleware
  routes/
    auth.js               — register/login/logout, forgot/reset password, Google OAuth connect
    contacts.js             — contact CRUD + CSV upload
    sequences.js             — sequence/step CRUD, template-based or inline steps, enrollment
    templates.js               — reusable email template CRUD
    tracking.js                 — public open-pixel / click-redirect endpoints
    analytics.js                 — aggregate stats for the dashboard
prisma/schema.prisma  — data model
```
