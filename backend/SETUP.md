# Setup Guide — Outreach CRM Backend

This gets the backend running locally, connects it to a real Gmail account,
and then covers deploying it so it runs continuously.

## 1. Prerequisites

- Node.js 18+ and npm
- A Google account (Gmail or Google Workspace) to send from
- (For production) a Postgres database — Railway, Render, and Supabase all offer free/cheap managed Postgres

## 2. Google Cloud setup (Gmail API)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project.
2. **APIs & Services > Library** → search "Gmail API" → Enable.
3. **APIs & Services > OAuth consent screen**:
   - User type: **External**
   - Fill in app name, support email, developer email
   - Scopes: add `.../auth/gmail.send`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
   - Under **Test users**, add your own Gmail address (and anyone else who'll use the tool). While the app is in "Testing" mode, only these listed users can connect — this is fine and expected for personal/internal use.
4. **APIs & Services > Credentials > Create Credentials > OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:4000/auth/google/callback` (add your production URL here too once deployed)
   - Copy the **Client ID** and **Client Secret**.

> **Note on verification:** Google requires an app review ("verification") before *any* user outside your test-user list can connect an account, because `gmail.send` is a sensitive scope. For personal use or a small internal team, staying in Testing mode with test users added is the right call — verification is a formal process meant for public-facing apps.

## 3. Local setup

```bash
git clone <your-repo-or-copy-these-files>
cd outreach-crm
npm install
cp .env.example .env
```

Edit `.env`:
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from step 2
- `GOOGLE_REDIRECT_URI` — `http://localhost:4000/auth/google/callback` for now
- `SESSION_SECRET` and `ENCRYPTION_KEY` — generate each with:
  ```bash
  openssl rand -hex 32
  ```
- Leave `DATABASE_URL="file:./dev.db"` for local dev (SQLite)

Then:

```bash
npx prisma migrate dev --name init
npm run dev
```

The API is now running at `http://localhost:4000`. Health check: `GET /health`.

## 4. Log in and connect Gmail

The app now has its own login, separate from Gmail:

1. **Create an account:** `POST /auth/register` with `{ "email": "...", "password": "...", "name": "..." }` (password: 10+ characters). This logs you in (sets a session cookie) — it does **not** touch Gmail yet.
2. **Connect Gmail for sending:** while logged in, visit `http://localhost:4000/auth/google` in the browser. This is what actually authorizes Gmail sending — you can register without ever connecting Gmail, and reconnect a different Gmail account later via the same URL (it upserts).
3. Check `GET /auth/me` — it returns your account plus `gmail: { email, connectedAt }` if connected, or `gmail: null` if not.

From here, `/contacts`, `/sequences`, and `/analytics` all work against your logged-in app account. Sending only works once Gmail is connected — until then, the scheduler leaves due sequence steps pending rather than failing them.

### Forgot password

`POST /auth/forgot-password` with `{ "email": "..." }` always returns the same generic success message, whether or not that email has an account — this is intentional (see SECURITY.md). If it exists, a reset link is generated.

**Without SMTP configured** (the local default): the reset link is printed to the server console — check your terminal running `npm run dev`.

**With SMTP configured:** set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` in `.env`. Any of these work and have free tiers: Resend, SendGrid, Postmark, or a dedicated Gmail account with an [App Password](https://myaccount.google.com/apppasswords) (don't reuse your outreach-sending Gmail's normal password here — this is a separate, lower-privilege credential just for system emails).

Then `POST /auth/reset-password` with `{ "token": "...", "password": "..." }` (token comes from the link) sets the new password. Tokens expire after 30 minutes and can only be used once.

## 5. Email templates

Templates are reusable subject/body pairs you can either send from directly or use to build sequence steps:

- `GET /templates`, `POST /templates` `{ name, subject, body }`, `PATCH /templates/:id`, `DELETE /templates/:id`
- When creating a sequence step, pass either `{ templateId, delayDays }` or `{ subject, body, delayDays }` — see the next section.
- Templates support the same `{{first_name}}`, `{{name}}`, `{{company}}` placeholders as inline sequence steps.
- Using a template copies its subject/body into the step at that moment — editing the template afterward won't change steps that already exist, so a sequence mid-flight for enrolled contacts never changes under them. Edit the step directly (or the sequence) if you want to update in-progress messaging.

## 6. Wire up the frontend

The React CRM UI from earlier (contacts/sequences/analytics/compose screens)
is a great starting point but currently uses mock data. To connect it:

- Set an API base URL (e.g. `VITE_API_URL=http://localhost:4000`) and use `fetch(url, { credentials: "include" })` on every request, so the session cookie is sent.
- Add a login/register screen calling `POST /auth/register` and `POST /auth/login`.
- Add a "Connect Gmail" button/banner (shown when `gmail` is `null` on `/auth/me`) that links to `${API_URL}/auth/google`.
- Replace the seed arrays with calls to `GET /contacts`, `GET /sequences`, `GET /analytics/overview`, `GET /analytics/timeline`.
- Point CSV upload at `POST /contacts/upload` (multipart form, field name `file`).
- Point "Νέο sequence" at `POST /sequences`, and enrolling contacts at `POST /sequences/:id/enroll`.

Happy to write this integration layer for you as a next step if you want — just say the word.

## 7. Deploying so it runs continuously

As of mid-2026, Railway no longer offers a lasting free tier (only a
one-time trial credit), so the recommended free starting stack is:

| Piece | Where | Why |
|---|---|---|
| Backend (this API) | **Render** free web service | 750 free hours/month, sleeps after ~15 min idle (fine to start) |
| Database | **Neon** free Postgres | Permanent free tier; Render's free Postgres expires after a limited window |
| Frontend | **Vercel** free Hobby | 100GB bandwidth/month, auto-HTTPS |

You don't need a custom domain to start — Render and Vercel both give you a
free `*.onrender.com` / `*.vercel.app` URL immediately. Add a domain later
once you're happy with it.

**Backend (Render):**
1. Push this folder to a GitHub repo (`.env` is git-ignored — don't commit it).
2. Create a Neon project, copy its Postgres connection string.
3. In `prisma/schema.prisma`, change the datasource:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```
4. On Render: New → Web Service → connect the repo. Build command `npm install && npx prisma generate`, start command `npm start`.
5. Set all env vars from `.env` in Render's dashboard (never in the repo): `DATABASE_URL` (the Neon string), `NODE_ENV=production`, real `SESSION_SECRET`/`ENCRYPTION_KEY`, Google OAuth vars, and update `BASE_URL`/`GOOGLE_REDIRECT_URI` to the Render URL.
6. Run `npx prisma migrate deploy` once (Render lets you run one-off shell commands from the dashboard).
7. In Google Cloud Console, add the Render URL's callback (`https://your-api.onrender.com/auth/google/callback`) as an authorized redirect URI.

**Frontend (Vercel):**
1. Deploy the React app, set `VITE_API_URL` to the Render backend URL.
2. Set `FRONTEND_URL` in the backend's env to the deployed Vercel URL (needed for CORS + session cookies + the post-connect redirect).
3. Since frontend and backend are on different domains, cookies use `sameSite: "none"` in production, which requires HTTPS on both sides — Render and Vercel give you this by default.

**Custom domain (optional, once it's working):**
1. Buy/already own a domain — configure DNS either at your registrar or move nameservers to Cloudflare (free, easier UI).
2. Add `app.yourdomain.gr` as a custom domain in Vercel's dashboard — it'll show you a CNAME to add.
3. Add `api.yourdomain.gr` as a custom domain in Render's dashboard — same thing, a CNAME to add.
4. Update `BASE_URL`, `FRONTEND_URL`, `GOOGLE_REDIRECT_URI`, and the Google Cloud OAuth client's redirect URI to the new domains.

## 8. Before you send to real people

- Read `SECURITY.md` — a few of the items there (consent, unsubscribe links, sending limits) matter as much as the code.
- Test the full flow — connect, upload a small CSV of your own test addresses, create a 1-step sequence, enroll, confirm the email arrives with tracking working — before pointing it at a real list.

## 9. Lead integrations (Integrations tab)

Every company can automatically turn form submissions into Contacts, from two kinds of source: a generic inbound webhook, and a direct Meta Lead Ads connection. Both live under the app's "Integrations" tab (owner-only) and both upsert-by-email — a lead that submits twice updates the same Contact rather than creating a duplicate.

### Generic webhook (WordPress, Zapier/Make, any leadgen form)

No setup on this side at all — it works the moment an owner clicks "Νέο webhook" in the Integrations tab, which hands them a URL like `https://your-api.onrender.com/integrations/inbound/<token>`. Paste that URL into:

- **WordPress**: any form plugin with an outgoing-webhook option — WP Webhooks, Gravity Forms' Webhooks add-on, Fluent Forms' native webhook action, or Contact Form 7 paired with a webhook add-on. Set the method to `POST` and the format to JSON (form-urlencoded also works, but JSON is preferred if the plugin offers a choice).
- **Meta Lead Ads, the fast way**: instead of the Facebook App setup below, connect a Zapier or Make "New Lead" trigger (both have a ready-made, already-reviewed Meta Lead Ads connector) and set its action to a webhook POST at the same URL. Ships immediately, small ongoing Zapier/Make cost, no App Review wait.
- **Anything else with an outgoing webhook** — Typeform, Unbounce, Instapage, etc. — same idea.

The endpoint looks for common field-name variants (`email`/`Email`/`your-email`, `name`/`full_name`/`your-name`, `phone`/`phone_number`, etc. — see `src/lib/leadIntake.js`) so it works with most tools' default field naming without extra configuration. A submission with no usable email is acknowledged but doesn't create a Contact.

### Meta Lead Ads — direct Graph API integration

This is the "skip Zapier entirely" path, and it requires real setup on Meta's side before it'll work for any page beyond your own test pages:

1. Go to [developers.facebook.com](https://developers.facebook.com/apps) and create an App (type: Business).
2. Add the **Webhooks** product. Subscribe to object type **Page**, field **leadgen**.
3. Callback URL: `https://your-api.onrender.com/integrations/meta/webhook`. Verify token: any string you choose — put the same value in this backend's `META_VERIFY_TOKEN` env var before clicking Verify and Save (Meta calls the URL once to confirm you control it).
4. **Settings > Basic** — copy the App Secret into this backend's `META_APP_SECRET` env var. Every webhook POST is HMAC-signed with this secret and rejected if it doesn't match (see `src/lib/metaLeads.js#verifyMetaSignature`).
5. Add the **`leads_retrieval`** permission (App Review > Permissions and Features). **This is the same kind of gate the Gmail integration hit with sensitive scopes**: in Development Mode, it only works for pages that an admin/tester of this specific Facebook App also administers. To receive leads from a page you don't personally run — i.e. an actual customer's page — the app needs to pass Meta's App Review for `leads_retrieval` (privacy policy URL, a written use-case description, usually a screencast; typically takes days to a couple of weeks) and the page's Business Manager needs to explicitly grant this app access to it.
6. Once a page is authorized, generate a **Page Access Token** for it (Graph API Explorer, or your own long-lived token exchange) and paste it into the "Meta Lead Ads" card in the Integrations tab along with the Page ID. This is a manual paste, not an in-app OAuth "Connect" button — building that would additionally require the `pages_show_list` permission, gated behind the same App Review.
7. From then on, every new lead on that page triggers Meta's webhook → this backend fetches the full answers via the Graph API → upserts a Contact, tagged `lead:meta`.

Until App Review is approved, this integration is genuinely limited to pages you administer yourself — use the Zapier/Make path above for a customer's page in the meantime, and switch them over once your app's review comes through.
