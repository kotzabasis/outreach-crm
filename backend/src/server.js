require("dotenv").config();
const express = require("express");
const session = require("express-session");
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
const { startScheduler } = require("./lib/scheduler");

for (const required of ["SESSION_SECRET", "ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
  if (!process.env[required]) {
    console.error(`Missing required env var: ${required}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1); // needed behind Render/Railway/any reverse proxy for secure cookies to work

app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true, // required so the session cookie is sent cross-origin
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  session({
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

app.use("/auth/forgot-password", forgotPasswordLimiter);
app.use("/auth", authLimiter, authRoutes);
app.use("/contacts", contactRoutes);
app.use("/sequences", sequenceRoutes);
app.use("/templates", templateRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/track", trackingRoutes); // no auth — see routes/tracking.js for why

// Central error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: isProd ? "internal_error" : err.message });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Outreach CRM backend listening on port ${port}`);
  startScheduler();
});
