# Outreach CRM — Full Project (Backend + Frontend)

Two independent projects meant to be deployed separately:

```
backend/    Node.js/Express API — real Gmail sending, sequences, tracking, analytics
frontend/   React (Vite) CRM UI — contacts, sequences, analytics, Gmail-style compose
```

## Current status — important

- **`backend/` is fully functional**: password auth + forgot/reset password, Gmail OAuth connection, contact CSV import, sequence engine with a cron scheduler, open/click tracking, analytics endpoints, email templates. See `backend/SETUP.md` and `backend/SECURITY.md`.
- **`frontend/` is currently a working UI *demo* using mock/seed data** — it renders and looks/behaves like the final product, but it is **not yet wired to the backend's API**. Nothing you do in it (upload a CSV, create a sequence, send a "compose" email) hits the real backend or sends real email yet.

## What's left before this is one working product

The frontend's `src/App.jsx` needs its mock data (`seedContacts`, `seedSequences`, etc.) replaced with real calls to the backend:

- Login/register screen → `POST /auth/register`, `POST /auth/login`
- "Connect Gmail" banner when not connected → link to `GET /auth/google`
- Contacts view → `GET /contacts`, `POST /contacts/upload` (CSV)
- Sequences view → `GET /sequences`, `POST /sequences`, `POST /sequences/:id/enroll`, `POST /sequences/:id/steps`
- Templates → `GET/POST/PATCH/DELETE /templates`
- Analytics view → `GET /analytics/overview`, `GET /analytics/timeline`
- All `fetch` calls need `credentials: "include"` so the session cookie is sent, and an env var (e.g. `VITE_API_URL`) pointing at the deployed backend URL.

This is a well-defined, scoped task — happy to do it in a follow-up. Deploying the frontend as-is will give you a good-looking, non-functional demo; deploying the backend as-is gives you a fully working API with no UI yet.

## Both build cleanly right now

- `backend`: dependencies installed and verified with `npm install`; all files pass `node --check`.
- `frontend`: `npm install && npm run build` completes successfully (Vite + Tailwind + Recharts + Lucide + Papaparse).

## Deployment

Full step-by-step instructions (Google Cloud OAuth setup, Render + Neon for the backend, Vercel for the frontend, custom domain/DNS) are in `backend/SETUP.md`.
