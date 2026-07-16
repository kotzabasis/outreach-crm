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

  // Webhook/public routes (GitHub, stripe, meta, generic webhook handlers)
  // use signature-based auth, not CSRF tokens — skip validation for these
  const publicMutatingPaths = [
    "/tracking/click",    // public tracking link
    "/tracking/open",     // public tracking pixel
    "/webhook/generic",   // generic webhook (validates signature)
    "/webhook/meta",      // meta webhook (validates signature)
    "/webhook/linkedin",  // linkedin webhook (validates signature)
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
