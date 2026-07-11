# Security Notes

## What's already handled in the code

- **Password hashing with bcrypt (cost 12), never plaintext.** Login and registration compare against the hash, and a login attempt against a non-existent email still runs a dummy `bcrypt.compare` — this avoids a timing side-channel that would otherwise let someone tell "wrong password" from "no such account" by how fast the response comes back.
- **Same generic error for bad email or bad password** (`invalid_email_or_password`) — again so the API doesn't confirm which emails have accounts.
- **Gmail connection is decoupled from login.** A `GmailAccount` row is separate from `User`; connecting/reconnecting Gmail requires an existing logged-in session but never creates or changes login credentials. Losing Gmail access (revoked, expired) never locks anyone out of the app itself.
- **Password reset tokens are hashed, single-use, and short-lived.** The raw token only ever exists in the emailed link; the database stores a SHA-256 hash of it, expires it after 30 minutes, and marks it used after one successful reset — so a leaked database alone can't be used to take over accounts via reset tokens. Requesting a new reset link also invalidates any earlier outstanding one.
- **Forgot-password responses don't reveal account existence**, same as login, and the endpoint is rate-limited more tightly (5 requests / 15 min per IP) than the rest of `/auth/*` — it's the endpoint most useful for enumerating accounts or spamming someone's inbox.
- **System emails (password reset) use a separate credential from outreach sending** (`SMTP_*` env vars), not the recipient's own Gmail OAuth connection — intentionally, since a locked-out user by definition can't rely on their own Gmail connection to receive a reset link.
- **Token encryption at rest.** Gmail OAuth access/refresh tokens are encrypted with AES-256-GCM (`src/lib/crypto.js`) before being written to the database. The encryption key lives only in `ENCRYPTION_KEY`, never in the DB. If the database is ever leaked, the tokens inside it are useless without that key.
- **Least-privilege scope.** The app requests only `gmail.send` (plus basic profile info) — never `gmail.readonly` or `gmail.modify`. It cannot read your inbox, only send through it. This also keeps you out of Google's stricter verification tier that applies to broader mailbox access.
- **OAuth CSRF protection.** The `/auth/google` flow uses a random `state` value stored in the session and checked on callback, so an attacker can't trick a logged-in user into linking the attacker's Gmail account.
- **Session fixation protection.** The session is regenerated on login (right after Google auth succeeds), not reused.
- **Cookies:** `httpOnly` (unreadable by JS, so XSS can't steal the session), `secure` in production (HTTPS-only), `sameSite` set appropriately for cross-domain frontend/backend.
- **Rate limiting** on the global API, a tighter limit on `/auth/*`, and a separate limit on the public `/track/*` endpoints (the only unauthenticated surface in the app).
- **Input validation** with `zod` on contact and sequence creation; CSV upload is capped at 2MB / 5000 rows and only accepts `.csv`.
- **Scoped queries everywhere** — every contact/sequence/enrollment lookup is filtered by `userId`, so one connected account can never see or touch another's data, even by guessing an ID.
- **Daily send cap** (`MAX_EMAILS_PER_DAY_PER_ACCOUNT`, default 300) enforced by the scheduler, independent of how many sequence steps are technically due — this protects the Gmail account itself from being flagged for high-volume sending, which matters more than any App-level bug would.
- **No secrets in the repo.** `.env` is git-ignored; `.env.example` has placeholders only.
- **Errors never leak internals** — the central error handler returns a generic message in production instead of stack traces.

## Things you need to configure correctly (the code can't do this for you)

1. **Generate real secrets.** `SESSION_SECRET` and `ENCRYPTION_KEY` in `.env.example` are placeholders — actually run `openssl rand -hex 32` for each before deploying anywhere real.
2. **HTTPS everywhere in production.** `secure: true` on cookies means they simply won't be sent over plain HTTP — this is correct behavior, but it means the deployed backend and frontend both need real TLS (Render/Railway/Vercel give you this by default; don't route around it).
3. **Lock down `FRONTEND_URL` / CORS.** The CORS config only allows the one origin in `FRONTEND_URL`. Don't widen this to `*` — with `credentials: true`, a wildcard origin would let any website make authenticated requests using a logged-in user's cookie.
4. **Back up `ENCRYPTION_KEY` somewhere safe outside the app server** (a password manager or secret vault). If you lose it, every connected Gmail account needs to reconnect — but if it leaks, tokens become decryptable, so treat it like a password, not like a config value.
5. **Rotate it if you ever suspect a leak** — you'll need a small migration script to decrypt with the old key and re-encrypt with a new one; happy to write that if the need arises.
6. **Keep dependencies patched.** `npm audit` currently shows a few moderate transitive advisories in `googleapis`'s dependency chain (an old `uuid` version pulled in indirectly) — not exploitable in how this app uses them, but run `npm audit` periodically and update.
7. **Templates are a convenience layer, not a security boundary change** — they're scoped by `userId` exactly like contacts and sequences, so the same per-user isolation applies.

## Compliance — cold email is regulated, and this matters more than the code

I'm not a lawyer, and this isn't legal advice — but a few things are worth flagging before you point this at a real list, especially since you're in Greece/EU:

- **GDPR.** Storing someone's name/email/company as a contact is processing personal data. For cold B2B outreach, many people rely on "legitimate interest" as the legal basis, but this is genuinely contested — some EU data protection authorities take a stricter view than others, particularly for unsolicited commercial email. Worth a short conversation with someone versed in Greek/EU data protection law before running this at scale, not just skimming a blog post.
- **Unsubscribe / opt-out.** The `unsubscribed` field and check already exist in the schema and scheduler (an unsubscribed contact's active enrollments get paused automatically) — but nothing currently *sends* an unsubscribe link or handles a reply like "remove me." You'll want a real unsubscribe link in your templates and a way to process opt-outs before this goes to real recipients.
- **Sender identification.** Regulations in most jurisdictions (GDPR-adjacent ePrivacy rules in the EU, CAN-SPAM if you ever email into the US) require clear identification of who's sending and a working reply-to or physical address in commercial email.
- **Gmail's own sending limits and policies.** Regular Gmail accounts cap out around 500 sends/day (2000 for Workspace); Google can also flag or suspend accounts that send outreach-like volume through a personal inbox, independent of any legal question. The daily cap in this code helps, but the safer path for real volume is a Workspace account with a warmed-up sending reputation.

None of this blocks you from testing the tool — it matters once real people outside your own test list start receiving mail.
