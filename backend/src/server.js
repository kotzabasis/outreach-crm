require("dotenv").config();
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
app.use(express.json({ limit: "15mb" }));
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

app.get("/health", (req, res) => res.json({ ok: true }));

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
app.use("/analytics", analyticsRoutes);
app.use("/track", trackingRoutes); // no auth — see routes/tracking.js for why

// Central error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err);
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
  }
}

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Outreach CRM backend listening on port ${port}`);
  startScheduler();
  ensureBootstrapAdmin();
});
