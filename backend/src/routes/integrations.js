const express = require("express");
const crypto = require("crypto");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireOwner = require("../lib/requireOwner");
const { encrypt, decrypt } = require("../lib/crypto");
const { mapGenericPayload, mapMetaFieldData, upsertLeadContact } = require("../lib/leadIntake");
const { verifyMetaSignature, fetchLeadFieldData } = require("../lib/metaLeads");
const { logAction } = require("../lib/auditLog");
const { captureException } = require("../lib/sentry");

const router = express.Router();

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

// ---------- Owner-facing management (session-authenticated) ----------
// Everything below requireAuth+requireOwner mirrors the Gmail-connection
// management pattern in routes/auth.js — company-scoped, owner-only.

router.get("/", requireAuth, requireOwner, async (req, res) => {
  const [webhooks, metaConnections] = await Promise.all([
    prisma.integration.findMany({ where: { companyId: req.user.companyId }, orderBy: { createdAt: "asc" } }),
    prisma.metaLeadConnection.findMany({ where: { companyId: req.user.companyId }, orderBy: { createdAt: "asc" } }),
  ]);
  res.json({
    webhooks,
    // Never return encryptedPageAccessToken to the client.
    metaConnections: metaConnections.map((c) => ({
      id: c.id,
      pageId: c.pageId,
      pageName: c.pageName,
      active: c.active,
      lastReceivedAt: c.lastReceivedAt,
      receivedCount: c.receivedCount,
      createdAt: c.createdAt,
    })),
  });
});

router.post("/", requireAuth, requireOwner, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 200) : "";
  const integration = await prisma.integration.create({
    data: { companyId: req.user.companyId, name: name || null, token: generateToken() },
  });
  await logAction(req, "integration.create", `${req.user.email} created a webhook integration${name ? ` (${name})` : ""}`, { companyId: req.user.companyId });
  res.status(201).json(integration);
});

router.post("/:id/rotate", requireAuth, requireOwner, async (req, res) => {
  const existing = await prisma.integration.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!existing) return res.status(404).json({ error: "not_found" });
  const updated = await prisma.integration.update({ where: { id: existing.id }, data: { token: generateToken() } });
  await logAction(req, "integration.rotate", `${req.user.email} rotated a webhook token`, { companyId: req.user.companyId });
  res.json(updated);
});

router.delete("/:id", requireAuth, requireOwner, async (req, res) => {
  const existing = await prisma.integration.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!existing) return res.status(404).json({ error: "not_found" });
  await prisma.integration.delete({ where: { id: existing.id } });
  await logAction(req, "integration.delete", `${req.user.email} removed a webhook integration`, { companyId: req.user.companyId });
  res.json({ ok: true });
});

router.post("/meta/connections", requireAuth, requireOwner, async (req, res) => {
  const pageId = typeof req.body.pageId === "string" ? req.body.pageId.trim() : "";
  const pageName = typeof req.body.pageName === "string" ? req.body.pageName.trim().slice(0, 200) : "";
  const pageAccessToken = typeof req.body.pageAccessToken === "string" ? req.body.pageAccessToken.trim() : "";
  if (!pageId || !pageAccessToken) return res.status(400).json({ error: "invalid_request" });

  try {
    const connection = await prisma.metaLeadConnection.create({
      data: { companyId: req.user.companyId, pageId, pageName: pageName || null, encryptedPageAccessToken: encrypt(pageAccessToken) },
    });
    await logAction(req, "integration.meta_connect", `${req.user.email} connected Meta page ${pageName || pageId}`, { companyId: req.user.companyId });
    res.status(201).json({ id: connection.id, pageId: connection.pageId, pageName: connection.pageName, active: connection.active });
  } catch (err) {
    // Unique constraint on pageId — this page is already connected somewhere
    // (this company or, deliberately, any other — a page shouldn't feed
    // leads to two different companies' contact lists at once).
    if (err.code === "P2002") return res.status(409).json({ error: "page_already_connected" });
    throw err;
  }
});

router.delete("/meta/connections/:id", requireAuth, requireOwner, async (req, res) => {
  const existing = await prisma.metaLeadConnection.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!existing) return res.status(404).json({ error: "not_found" });
  await prisma.metaLeadConnection.delete({ where: { id: existing.id } });
  await logAction(req, "integration.meta_disconnect", `${req.user.email} disconnected Meta page ${existing.pageName || existing.pageId}`, { companyId: req.user.companyId });
  res.json({ ok: true });
});

// Lightweight debug trail — reuses AuditLog rather than a dedicated table,
// same "lead.received" action written by both inbound handlers below.
router.get("/recent-leads", requireAuth, requireOwner, async (req, res) => {
  const logs = await prisma.auditLog.findMany({
    where: { companyId: req.user.companyId, action: "lead.received" },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  res.json(logs);
});

// ---------- Public inbound endpoints (no session — third-party callers) ----------
// Deliberately NOT behind requireAuth — the caller is a WordPress site, a
// Zapier/Make step, or Meta's own servers, none of which have a session. The
// token in the URL (generic) or the app-secret HMAC signature (Meta) is the
// auth instead — same posture as routes/tracking.js's pixel/click endpoints.

// Generic inbound webhook — covers WordPress form plugins and any other
// leadgen/landing-page tool with an outgoing-webhook option. Always
// responds 200 (even on a malformed/unrecognized payload) since most
// webhook senders treat non-2xx as "delivery failed" and will retry/alert,
// which isn't useful noise for "we got it, just couldn't find an email."
router.post("/inbound/:token", async (req, res) => {
  try {
    const integration = await prisma.integration.findUnique({ where: { token: req.params.token } });
    if (!integration || !integration.active) return res.status(404).json({ error: "not_found" });

    const mapped = mapGenericPayload(req.body);
    const result = await upsertLeadContact({
      companyId: integration.companyId,
      mapped,
      sourceTag: integration.name ? `lead:${integration.name}` : "lead:webhook",
    });

    await prisma.integration.update({
      where: { id: integration.id },
      data: { lastReceivedAt: new Date(), receivedCount: { increment: 1 } },
    });

    if (result.ok) {
      await logAction(
        req,
        "lead.received",
        `Νέο lead από webhook${integration.name ? ` (${integration.name})` : ""}: ${result.contact.email}`,
        { companyId: integration.companyId }
      );
    }

    res.json({ ok: result.ok, reason: result.reason });
  } catch (err) {
    console.error("Inbound webhook processing failed:", err.message);
    captureException(err, { scope: "integrations.inbound_webhook" });
    res.status(500).json({ ok: false });
  }
});

// Meta webhook verification handshake — Meta calls this once (GET) when you
// register/save the webhook URL in the App dashboard, to prove you control
// this endpoint before it'll ever send real POSTs to it.
router.get("/meta/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (process.env.META_VERIFY_TOKEN && mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta webhook notifications — one app-level URL for every connected page
// across every company (unlike the generic webhook, Meta has no concept of a
// per-tenant URL). Each notification only carries a leadgen_id + page_id;
// pageId is how it's mapped back to which company's MetaLeadConnection owns
// it, and the actual answers are fetched separately via the Graph API.
router.post("/meta/webhook", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);

  // Ack fast — Meta retries aggressively on slow/failed responses. Process
  // every entry but never let one bad page/lead fail the whole batch.
  res.sendStatus(200);

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== "leadgen") continue;
      const { leadgen_id: leadgenId, page_id: pageId } = change.value || {};
      if (!leadgenId || !pageId) continue;
      try {
        await processMetaLead(pageId, leadgenId);
      } catch (err) {
        console.error(`Meta lead processing failed for leadgen ${leadgenId}:`, err.message);
        captureException(err, { scope: "integrations.meta_webhook", leadgenId, pageId });
      }
    }
  }
});

async function processMetaLead(pageId, leadgenId) {
  const connection = await prisma.metaLeadConnection.findUnique({ where: { pageId } });
  if (!connection || !connection.active) return; // unrecognized/inactive page — nothing to do

  const pageAccessToken = decrypt(connection.encryptedPageAccessToken);
  const fieldData = await fetchLeadFieldData(leadgenId, pageAccessToken);
  const mapped = mapMetaFieldData(fieldData);
  const result = await upsertLeadContact({ companyId: connection.companyId, mapped, sourceTag: "lead:meta" });

  await prisma.metaLeadConnection.update({
    where: { id: connection.id },
    data: { lastReceivedAt: new Date(), receivedCount: { increment: 1 } },
  });

  if (result.ok) {
    await logAction(
      { user: null },
      "lead.received",
      `Νέο lead από Meta (${connection.pageName || connection.pageId}): ${result.contact.email}`,
      { companyId: connection.companyId }
    );
  }
}

module.exports = router;
