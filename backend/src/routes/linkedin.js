const express = require("express");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireOwner = require("../lib/requireOwner");
const unipile = require("../lib/unipileClient");
const { isUnipileConfigured } = require("../lib/platformConfig");
const outreach = require("../lib/linkedinOutreach");
const { logAction } = require("../lib/auditLog");
const { captureException } = require("../lib/sentry");

const router = express.Router();

// --- PUBLIC: Unipile notify webhook ----------------------------------------
// Hosted-auth completion + account status changes are POSTed here by Unipile.
// No auth (external caller), CSRF-exempt (see lib/csrf.js). We associate the
// account with a company via the ?company= param we put on the notify_url.
router.post("/webhook", async (req, res) => {
  // NOTE: Unipile sends several event kinds to the notify URL and to messaging/
  // relation webhooks. The exact field names differ per event and per Unipile
  // version, so this reads defensively from the common shapes and should be
  // confirmed against a live payload before relying on it. All bookkeeping is
  // best-effort; we always answer 200 so Unipile doesn't retry-storm us.
  try {
    const companyId = typeof req.query.company === "string" ? req.query.company : null;
    const body = req.body || {};
    const kind = String(body.event || body.type || body.status || "").toUpperCase();
    const unipileAccountId = body.account_id || body.accountId || null;
    const providerId = body.provider_id || body.user_id || body.attendee_provider_id || body.from?.provider_id || null;

    // 1) Account creation / status (hosted-auth notify + credential/checkpoint events)
    if (unipileAccountId && (kind.includes("CREATION") || kind.includes("ACCOUNT") || kind.includes("CREDENTIAL") || kind.includes("CHECKPOINT") || kind.includes("SUCCESS") || kind.includes("ERROR") || kind === "")) {
      const status = unipile.normalizeAccountStatus({ status: body.status || body.state || kind });
      const data = { unipileAccountId, status, statusMessage: kind.slice(0, 300) };
      if (companyId) {
        await prisma.linkedInOutreachAccount.upsert({ where: { companyId }, update: data, create: { companyId, ...data } });
      } else {
        await prisma.linkedInOutreachAccount.updateMany({ where: { unipileAccountId }, data: { status: data.status, statusMessage: data.statusMessage } });
      }
    }

    // 2) New relation = our connection request was ACCEPTED → wake the enrollment.
    if (providerId && (kind.includes("RELATION") || kind.includes("CONNECTION") || kind.includes("ACCEPTED") || kind.includes("INVITATION_ACCEPTED"))) {
      const contact = await prisma.contact.findFirst({ where: { linkedinProviderId: providerId } });
      if (contact) {
        await prisma.contact.update({ where: { id: contact.id }, data: { linkedinConnectionStatus: "accepted", lastActivityAt: new Date() } });
        await prisma.linkedInAction.updateMany({ where: { contactId: contact.id, type: "connection_request", status: "sent" }, data: { status: "accepted" } });
        // Fire the follow-up message on the next tick instead of waiting out the poll window.
        await prisma.enrollment.updateMany({
          where: { contactId: contact.id, status: "active", sequence: { channel: "linkedin" } },
          data: { nextSendAt: new Date() },
        });
      }
    }

    // 3) Inbound message = the contact REPLIED → pause the LinkedIn sequence
    //    (the LinkedIn advantage over email: Unipile can read the mailbox).
    const isInbound = body.is_sender === false || body.direction === "inbound" || kind.includes("MESSAGE_RECEIVED") || (kind.includes("MESSAGE") && body.is_sender !== true);
    if (providerId && isInbound && kind.includes("MESSAGE")) {
      const contact = await prisma.contact.findFirst({ where: { linkedinProviderId: providerId } });
      if (contact) {
        await prisma.enrollment.updateMany({
          where: { contactId: contact.id, status: "active", sequence: { channel: "linkedin" } },
          data: { status: "replied" },
        });
        await prisma.contact.update({ where: { id: contact.id }, data: { status: "replied", lastActivityAt: new Date() } }).catch(() => {});
      }
    }
  } catch (err) {
    captureException(err, { scope: "linkedin.webhook" });
  }
  res.json({ ok: true });
});

// Everything below requires an authenticated app user.
router.use(requireAuth);

function publicAccount(acc) {
  if (!acc) return null;
  return {
    id: acc.id,
    status: acc.status, // ok | checkpoint_needed | error | paused
    statusMessage: acc.statusMessage || null,
    paused: acc.paused,
    connectionsSentToday: acc.connectionsSentToday,
    messagesSentToday: acc.messagesSentToday,
    maxConnectionsPerDay: outreach.MAX_CONNECTIONS_PER_DAY,
    maxMessagesPerDay: outreach.MAX_MESSAGES_PER_DAY,
    connectedAt: acc.connectedAt,
  };
}

// Current company's LinkedIn outreach account (+ whether the platform is configured).
router.get("/account", async (req, res) => {
  const [configured, acc] = await Promise.all([
    isUnipileConfigured(),
    prisma.linkedInOutreachAccount.findUnique({ where: { companyId: req.user.companyId } }),
  ]);
  res.json({ configured, account: publicAccount(acc) });
});

// Start the hosted-auth flow → returns a URL the owner opens to log into LinkedIn.
router.post("/connect", requireOwner, async (req, res) => {
  if (!(await isUnipileConfigured())) return res.status(400).json({ error: "unipile_not_configured" });
  try {
    const notifyUrl = `${process.env.BASE_URL}/linkedin/webhook?company=${encodeURIComponent(req.user.companyId)}`;
    const link = await unipile.createHostedAuthLink({
      successUrl: `${process.env.FRONTEND_URL}/?linkedin_connected=1`,
      failureUrl: `${process.env.FRONTEND_URL}/?linkedin_connected=0`,
      notifyUrl,
    });
    res.json({ url: link.url || link.link || null });
  } catch (err) {
    captureException(err, { scope: "linkedin.connect" });
    res.status(502).json({ error: "unipile_error", detail: err.message });
  }
});

// Poll Unipile for the latest account status (fallback to the webhook).
router.post("/account/refresh", requireOwner, async (req, res) => {
  const acc = await prisma.linkedInOutreachAccount.findUnique({ where: { companyId: req.user.companyId } });
  if (!acc) return res.status(404).json({ error: "not_connected" });
  try {
    const remote = await unipile.getAccount(acc.unipileAccountId);
    const status = unipile.normalizeAccountStatus(remote);
    const updated = await prisma.linkedInOutreachAccount.update({ where: { id: acc.id }, data: { status } });
    res.json({ account: publicAccount(updated) });
  } catch (err) {
    res.status(502).json({ error: "unipile_error", detail: err.message });
  }
});

// Manual kill-switch (safety requirement) + resume.
router.post("/account/pause", requireOwner, async (req, res) => {
  const acc = await prisma.linkedInOutreachAccount.findUnique({ where: { companyId: req.user.companyId } });
  if (!acc) return res.status(404).json({ error: "not_connected" });
  const updated = await prisma.linkedInOutreachAccount.update({ where: { id: acc.id }, data: { paused: true } });
  await logAction(req, "linkedin.account.paused", "LinkedIn outreach account σε παύση (manual).", { companyId: req.user.companyId });
  res.json({ account: publicAccount(updated) });
});
router.post("/account/resume", requireOwner, async (req, res) => {
  const acc = await prisma.linkedInOutreachAccount.findUnique({ where: { companyId: req.user.companyId } });
  if (!acc) return res.status(404).json({ error: "not_connected" });
  const updated = await prisma.linkedInOutreachAccount.update({ where: { id: acc.id }, data: { paused: false } });
  res.json({ account: publicAccount(updated) });
});

router.delete("/account", requireOwner, async (req, res) => {
  await prisma.linkedInOutreachAccount.deleteMany({ where: { companyId: req.user.companyId } });
  res.json({ ok: true });
});

// --- Contact-level actions (any member) ------------------------------------
async function loadContact(req, res, next) {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!contact) return res.status(404).json({ error: "not_found" });
  req.contact = contact;
  next();
}

// Resolve a contact's LinkedIn URL → provider id (cached on the contact).
router.post("/contacts/:id/resolve", loadContact, async (req, res) => {
  const account = await outreach.getSendableAccount(req.user.companyId);
  if (!account) return res.status(400).json({ error: "linkedin_not_connected_or_paused" });
  if (!req.contact.linkedinProfileUrl) return res.status(400).json({ error: "contact_has_no_linkedin_url" });
  try {
    const r = await outreach.ensureResolved(account, req.contact);
    res.json({ providerId: r.providerId, alreadyConnected: r.alreadyConnected });
  } catch (err) {
    res.status(502).json({ error: "resolve_failed", detail: err.message });
  }
});

// Send a connection request now (manual, one-off — respects the daily cap).
router.post("/contacts/:id/connect", loadContact, async (req, res) => {
  const parsed = z.object({ note: z.string().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = await outreach.getSendableAccount(req.user.companyId);
  if (!account) return res.status(400).json({ error: "linkedin_not_connected_or_paused" });
  if (!outreach.canSendConnection(account)) return res.status(429).json({ error: "daily_connection_cap_reached", limit: outreach.MAX_CONNECTIONS_PER_DAY });

  try {
    const result = await outreach.sendConnectionRequest({ account, contact: req.contact, note: parsed.data.note });
    res.json(result.skipped ? { skipped: true, reason: result.reason } : { ok: true, status: "pending" });
  } catch (err) {
    const map = { contact_has_no_linkedin_url: 400, could_not_resolve_profile: 422 };
    res.status(map[err.message] || 502).json({ error: err.message || "connect_failed" });
  }
});

router.post("/contacts/:id/withdraw", loadContact, async (req, res) => {
  const account = await prisma.linkedInOutreachAccount.findUnique({ where: { companyId: req.user.companyId } });
  if (!account) return res.status(400).json({ error: "linkedin_not_connected" });
  try {
    await outreach.withdrawConnectionRequest({ account, contact: req.contact });
    res.json({ ok: true, status: "withdrawn" });
  } catch (err) {
    res.status(502).json({ error: "withdraw_failed", detail: err.message });
  }
});

module.exports = router;
