// Thin, fully-optional Sentry wrapper - the frontend counterpart to the
// backend's src/lib/sentry.js, same reasoning:
//   1. Without a VITE_SENTRY_DSN build-time env var, this is a complete
//      no-op - local dev and any deploy that hasn't configured it behaves
//      exactly as before, nothing here is required for the app to run.
//   2. Once configured, Sentry's own default browser integrations pick up
//      uncaught exceptions and unhandled promise rejections automatically -
//      no extra window.onerror wiring needed here. The one thing that DOES
//      need explicit wiring is React render errors (a broken component
//      crashing mid-render), which Sentry can only see via an ErrorBoundary
//      - see main.jsx.
import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Low sample rate - this is a low-traffic internal CRM, not a
    // high-volume consumer app. Errors are always captured regardless; this
    // only controls performance-trace volume.
    tracesSampleRate: 0.1,
  });
}

export { Sentry };
export const sentryEnabled = Boolean(dsn);
