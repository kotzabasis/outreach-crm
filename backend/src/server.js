require("dotenv").config();
// Loaded before everything else so Sentry.init() (if SENTRY_DSN is set) can
// instrument as much of the app's startup/request lifecycle as possible —
// see lib/sentry.js for why this is a safe no-op without a DSN configured.
const { captureException, setupExpressErrorHandler } = require("./lib/sentry");
const express = require("express");
const compression = require("compression");
const session = require("express-session");
const { Pool } = require("pg");
const pgSessionStore = require("connect-pg-simple")(session);
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const contactRoutes = require("./routes/contacts");
const sequenceRoutes = require("./routes/sequences");
const templateRoutes = require("./routes/templates");
const trackingRoutes = require("./routes/tracking");
const analyticsRoutes = require("./routes/analytics");
const adminRoutes = require("./routes/admin");
const offerRoutes = require("./routes/offers");
const sendRoutes = require("./routes/send");
const campaignRoutes = require("./routes/campaigns");
const teamRoutes = require("./routes/team");
const dashboardRoutes = require("./routes/dashboard");
const integrationsRoutes = require("./routes/integrations");
const { startScheduler } = require("./lib/scheduler");
const prisma = require("./db");

for (const required of ["SESSION_SECRET", "ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DATABASE_URL"]) {
  if (!process.env[required]) {
    console.error(`Missing required env var: ${required}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1); // needed behind Render/Railway/any reverse proxy for secure cookies to work

app.use(helmet());
// Gzip every JSON response (contacts list, analytics, activity feed, etc.) —
// cheap CPU trade for meaningfully smaller payloads, which matters now that
// Render's free-tier egress cap was cut from 100GB to 5GB/month.
app.use(compression());
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true, // required so the session cookie is sent cross-origin
  })
);
// Bumped from 1mb: manual/sequence emails can carry base64 attachments
// (capped at ~2MB/file, a few files) since there's no external file storage.
// `verify` stashes the exact raw bytes onto req.rawBody — needed by
// lib/metaLeads.js#verifyMetaSignature, which has to HMAC the literal body
// Meta sent, not a re-serialized version of the parsed JSON (those two byte
// sequences aren't guaranteed to match, e.g. differing key order/whitespace).
app.use(express.json({ limit: "15mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
// Some WordPress webhook plugins (and a few other form tools) POST as
// x-www-form-urlencoded rather than JSON — accept either without the
// inbound integration setup depending on which one a given plugin defaults
// to. Harmless alongside express.json() above: each parser only acts when
// the request's Content-Type matches its own, so a JSON POST is untouched.
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Sessions are stored in Postgres (the same Neon DB Prisma already talks
// to), not the default in-memory store — express-session's MemoryStore
// prints an explicit "not designed for a production environment" warning on
// every boot (it leaks memory and can't be shared across processes), and
// concretely for this app it meant every deploy silently logged everyone
// out, since a fresh process starts with an empty in-memory session table.
// connect-pg-simple manages its own `session` table directly via SQL
// (independent of the Prisma schema/migrations) and creates it on first
// boot if missing.
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL; no local CA bundle to verify against here
});
pgPool.on("error", (err) => {
  // A dropped idle connection in the pool shouldn't crash the whole process —
  // pg's default behavior otherwise is to raise this as an unhandled error.
  console.error("Session store pool error:", err.message);
});

app.use(
  session({
    store: new pgSessionStore({ pool: pgPool, tableName: "session", createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd, // requires HTTPS in production — set NODE_ENV=production there
      sameSite: isProd ? "none" : "lax", // "none" needed if frontend/backend are on different domains
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// Global rate limit as a baseline; auth and tracking have their own tighter limits.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const forgotPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

// Previously just returned {ok:true} unconditionally — that only proves the
// Express process is up, not that the app actually works (Neon being down/
// unreachable would look identical to "healthy" to both this endpoint and
// the keep-alive ping that hits it every 5 min). A cheap round-trip query
// makes this a real health check instead of a liveness-only one.
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "ok" });
  } catch (err) {
    console.error("Health check: DB query failed:", err.message);
    res.status(503).json({ ok: false, db: "unreachable" });
  }
});

// This is an API-only server with no UI of its own — the actual app lives on
// Vercel. Visiting this bare URL in a browser used to 404 with Express's
// default "Cannot GET /", which looked like the backend was broken. It
// isn't — there's just nothing to serve at the root. Replace the confusing
// 404 with a short explanation instead.
app.get("/", (req, res) =>
  res.json({ ok: true, service: "SDLoop API", note: "This is the backend API. The app itself is at the Vercel URL." })
);

app.use("/auth/forgot-password", forgotPasswordLimiter);
app.use("/auth", authLimiter, authRoutes);
app.use("/contacts", contactRoutes);
app.use("/sequences", sequenceRoutes);
app.use("/templates", templateRoutes);
app.use("/admin", adminRoutes);
app.use("/offers", offerRoutes);
app.use("/send", sendRoutes);
app.use("/campaigns", campaignRoutes);
app.use("/team", teamRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/integrations", integrationsRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/track", trackingRoutes); // no auth — see routes/tracking.js for why

// Must be registered after all routes, before the app's own final error
// handler below — no-op if SENTRY_DSN isn't set (see lib/sentry.js).
setupExpressErrorHandler(app);

// Central error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err);
  captureException(err);
  res.status(err.status || 500).json({ error: isProd ? "internal_error" : err.message });
});

// Safety net for the invite/approval-gated signup model: if the DB somehow
// has zero admins (e.g. this feature shipped after the first account already
// existed), promote the oldest account so there's always someone who can
// approve everyone else. No-op once an admin exists. Runs on every boot —
// cheap, idempotent.
async function ensureBootstrapAdmin() {
  try {
    const adminExists = await prisma.user.findFirst({ where: { isAdmin: true } });
    if (adminExists) return;
    const oldest = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (!oldest) return; // no users yet — the next registration will bootstrap itself
    await prisma.user.update({ where: { id: oldest.id }, data: { isAdmin: true, approved: true } });
    console.log(`Bootstrapped admin access for ${oldest.email}`);
  } catch (err) {
    console.error("ensureBootstrapAdmin failed:", err.message);
    captureException(err, { scope: "ensureBootstrapAdmin" });
  }
}

// Round 16 introduced multi-tenant Companies: every User/Contact/Sequence/
// Template/Offer/ContactNote/Campaign/EmailLog/GmailAccount row now has a
// (nullable) companyId. This backfills any pre-existing rows from before
// that column existed into one shared "Legacy Workspace" Company, so the
// already-live account keeps working exactly as before without a manual
// migration step. Idempotent (no-ops once nothing is null) and safe to run
// on every boot, same pattern as ensureBootstrapAdmin below.
async function ensureCompanyAssignment() {
  try {
    const orphanedUsers = await prisma.user.findMany({ where: { companyId: null }, orderBy: { createdAt: "asc" } });
    if (orphanedUsers.length === 0) return; // already backfilled

    let legacyCompany = await prisma.company.findFirst({ where: { name: "Legacy Workspace" } });
    if (!legacyCompany) {
      legacyCompany = await prisma.company.create({ data: { name: "Legacy Workspace" } });
    }
    const companyId = legacyCompany.id;

    for (const user of orphanedUsers) {
      // Whoever was already a platform admin becomes the owner of this
      // workspace, so invite/Gmail-connect UX makes sense immediately.
      await prisma.user.update({
        where: { id: user.id },
        data: { companyId, role: user.isAdmin ? "owner" : "member" },
      });
    }

    await Promise.all([
      prisma.contact.updateMany({ where: { companyId: null }, data: { companyId } }),
      prisma.sequence.updateMany({ where: { companyId: null }, data: { companyId } }),
      prisma.template.updateMany({ where: { companyId: null }, data: { companyId } }),
      prisma.offer.updateMany({ where: { companyId: null }, data: { companyId } }),
      prisma.contactNote.updateMany({ where: { companyId: null }, data: { companyId } }),
      prisma.campaign.updateMany({ where: { companyId: null }, data: { companyId } }),
      prisma.emailLog.updateMany({ where: { companyId: null }, data: { companyId } }),
    ]);

    // A company can hold more than one connected mailbox now (see
    // schema.prisma's GmailAccount + lib/emailCap.js#pickSendableMailbox),
    // so every pre-existing orphaned connection can join the legacy
    // company's pool — nothing has to be picked/discarded the way a single
    // companyId slot used to force.
    const { count: reattachedGmailAccounts } = await prisma.gmailAccount.updateMany({
      where: { companyId: null },
      data: { companyId },
    });
    if (reattachedGmailAccounts > 0) {
      console.log(`ensureCompanyAssignment: reattached ${reattachedGmailAccounts} pre-existing Gmail connection(s) to company ${companyId}`);
    }

    console.log(`ensureCompanyAssignment: backfilled ${orphanedUsers.length} user(s) into company ${companyId}`);
  } catch (err) {
    console.error("ensureCompanyAssignment failed:", err.message);
    captureException(err, { scope: "ensureCompanyAssignment" });
  }
}

// Multi-company support: a user can now belong to more than one Company
// (Membership join table — see schema.prisma). This backfills a Membership
// row for every User that already has a companyId/role from before this
// round existed, so nothing about a single-company user's access changes —
// they end up with exactly one Membership, matching what User.companyId/
// role already said. Idempotent (upsert on the unique [userId, companyId]
// pair) and safe to run on every boot, same pattern as the two functions
// above. Must run after ensureCompanyAssignment, since that's what
// guarantees pre-existing users have a companyId to backfill from.
async function ensureMembershipsBackfilled() {
  try {
    const usersWithCompany = await prisma.user.findMany({
      where: { companyId: { not: null } },
      select: { id: true, companyId: true, role: true },
    });
    for (const u of usersWithCompany) {
      await prisma.membership.upsert({
        where: { userId_companyId: { userId: u.id, companyId: u.companyId } },
        update: {},
        create: { userId: u.id, companyId: u.companyId, role: u.role || "member" },
      });
    }
    console.log(`ensureMembershipsBackfilled: verified ${usersWithCompany.length} membership row(s)`);
  } catch (err) {
    console.error("ensureMembershipsBackfilled failed:", err.message);
    captureException(err, { scope: "ensureMembershipsBackfilled" });
  }
}

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Outreach CRM backend listening on port ${port}`);
  startScheduler();
  ensureBootstrapAdmin()
    .then(() => ensureCompanyAssignment())
    .then(() => ensureMembershipsBackfilled());
});
