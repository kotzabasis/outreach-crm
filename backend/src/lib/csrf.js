// Double-submit CSRF token validation. Since sameSite=none is required for the
// cross-domain Vercel/Render split (frontend on Vercel, backend on Render),
// we lose sameSite's built-in CSRF protection and must validate a token on
// every state-changing request. This is a simple double-submit implementation:
// frontend reads a token from a response header or cookie, includes it in
// X-CSRF-Token header on every POST/PATCH/DELETE, and we validate it matches
// the session's stored token.

const crypto = require("crypto");

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Middleware: ensure session has a CSRF token, and attach it to all responses
function csrfTokenMiddleware(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateToken();
  }
  // Attach to response header so frontend can read it on page load
  res.set("X-CSRF-Token", req.session.csrfToken);
  next();
}

// Middleware: validate CSRF token on state-changing requests
function csrfValidationMiddleware(req, res, next) {
  // GET/HEAD/OPTIONS never mutate — skip validation
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // Public, unauthenticated POST endpoints that are hit by external systems
  // (mailbox providers, Meta/LinkedIn/WordPress) which cannot carry our
  // session-based CSRF token. Each has its own auth instead — inbound webhooks
  // validate a per-source signature/token, and one-click unsubscribe only
  // toggles a boolean keyed on an unguessable tracking id. These are matched
  // against the *real* mounted paths (see server.js): tracking is under
  // /track, and the lead webhooks live under /integrations — the previous
  // list used "/tracking" and "/webhook" prefixes that matched nothing, which
  // meant the inbound webhooks were being rejected with csrf_token_invalid.
  const publicMutatingPaths = [
    "/track/unsubscribe",             // one-click List-Unsubscribe POST (RFC 8058)
    "/integrations/inbound",          // generic inbound lead webhook (/integrations/inbound/:token)
    "/integrations/meta/webhook",     // Meta Lead Ads webhook (validates X-Hub-Signature)
    "/integrations/linkedin/webhook", // LinkedIn Lead Sync webhook
  ];
  if (publicMutatingPaths.some((p) => req.path.startsWith(p))) {
    return next();
  }

  const token = req.get("X-CSRF-Token");
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: "csrf_token_invalid" });
  }

  next();
}

module.exports = { generateToken, csrfTokenMiddleware, csrfValidationMiddleware };
