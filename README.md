# Outreach CRM — Full Project (Backend + Frontend)

Two independent projects meant to be deployed separately:

```
backend/    Node.js/Express API — real Gmail sending, sequences, tracking, analytics
frontend/   React (Vite) CRM UI — contacts, sequences, analytics, Gmail-style compose
```

## Current status

Both halves are fully functional and wired together — this is one working product, deployed live.

- **`backend/`**: password auth + forgot/reset password, Gmail OAuth + real sending, contact CSV import, sequence engine with a cron scheduler, campaigns, open/click tracking + one-click unsubscribe, analytics, email templates, LinkedIn outreach (Unipile: connection requests, messages, InMail), webhooks, multi-company/team. See `backend/SETUP.md` and `backend/SECURITY.md`.
- **`frontend/`**: React (Vite) UI fully wired to the backend via `src/lib/api.js` — every view (login/register, contacts, sequences, templates, campaigns, analytics, team/settings, LinkedIn/InMail, SuperAdmin) makes real authenticated `fetch` calls (`credentials: "include"`, CSRF token, `VITE_API_URL`). There is **no** mock/seed data. EL/EN language switch via `src/lib/i18n.jsx`.

## Both build cleanly right now

- `backend`: dependencies installed and verified with `npm install`; all files pass `node --check`.
- `frontend`: `npm install && npm run build` completes successfully (Vite + Tailwind + Recharts + Lucide + Papaparse).

## Deployment

Full step-by-step instructions (Google Cloud OAuth setup, Render + Neon for the backend, Vercel for the frontend, custom domain/DNS) are in `backend/SETUP.md`.
