// Thin, fully-optional Sentry wrapper. Every call site in this codebase goes
// through captureException()/init() here rather than calling @sentry/node
// directly, so:
//   1. Without a SENTRY_DSN env var set, this is a complete no-op — local dev
//      and any deploy that hasn't configured Sentry yet behaves exactly as
//      before (console.error only), nothing crashes for lack of a DSN.
//   2. If Sentry itself throws (bad DSN, network issue during init), that
//      never takes down the actual app — this is monitoring, not a
//      dependency the app relies on to function.
let Sentry = null;

if (process.env.SENTRY_DSN) {
  try {
    Sentry = require("@sentry/node");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || "development",
      // Low sample rate — this is a low-traffic internal CRM, not a
      // high-volume consumer app. Errors are always captured regardless;
      // this only controls performance-tracing volume.
      tracesSampleRate: 0.1,
    });
    console.log("Sentry error monitoring initialized.");
  } catch (err) {
    console.error("Sentry init failed (continuing without it):", err.message);
    Sentry = null;
  }
}

function captureException(err, extra) {
  if (!Sentry) return;
  try {
    Sentry.captureException(err, extra ? { extra } : undefined);
  } catch (captureErr) {
    console.error("Sentry captureException failed:", captureErr.message);
  }
}

// Wires Sentry's automatic Express error capture (must be called after all
// routes are mounted, before the app's own final error handler — see
// server.js). No-op if Sentry isn't configured.
function setupExpressErrorHandler(app) {
  if (!Sentry) return;
  try {
    Sentry.setupExpressErrorHandler(app);
  } catch (err) {
    console.error("Sentry Express handler setup failed:", err.message);
  }
}

module.exports = { Sentry, captureException, setupExpressErrorHandler };
