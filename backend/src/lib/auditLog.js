const prisma = require("../db");
const { captureException } = require("./sentry");

// Fire-and-forget, same defensive pattern as captureException itself — a
// failure to WRITE the audit log must never break the actual request that
// triggered it, so every call site does `await logAction(...)` but this
// function itself swallows its own errors after reporting them.
//
// `summary` is a full, pre-rendered Greek sentence built by the caller
// (rather than assembled generically here from `action` + metadata) so the
// audit log panel can just display it directly with zero per-action
// formatting logic on the frontend.
async function logAction(req, action, summary, { companyId } = {}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: req.user?.id || null,
        actorEmail: req.user?.email || "unknown",
        action,
        summary,
        companyId: companyId || null,
      },
    });
  } catch (err) {
    console.error("logAction failed:", err.message);
    captureException(err, { scope: "logAction", action });
  }
}

module.exports = { logAction };
