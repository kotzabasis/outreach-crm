const express = require("express");
const crypto = require("crypto");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireOwner = require("../lib/requireOwner");
const { encrypt, decrypt } = require("../lib/crypto");
const { mapGenericPayload, mapMetaFieldData, upsertLeadContact } = require("../lib/leadIntake");
const { verifyMetaSignature, fetchLeadFieldData } = require("../lib/metaLeads");
const {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchLeadFormResponse,
  flattenLeadFormResponse,
  registerWebhookSubscription,
  isAuthError,
} = require("../lib/linkedinLeads");
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
  const [webhooks, metaConnections, linkedinConnections] = await Promise.all([
    prisma.integration.findMany({ where: { companyId: req.user.companyId }, orderBy: { createdAt: "asc" } }),
    prisma.metaLeadConnection.findMany({ where: { companyId: req.user.companyId }, orderBy: { createdAt: "asc" } }),
    prisma.linkedInLeadConnection.findMany({ where: { companyId: req.user.companyId }, orderBy: { createdAt: "asc" } }),
  ]);
  res.json({
    webhooks,
    // Never return encrypted tokens to the client.
    metaConnections: metaConnections.map((c) => ({
      id: c.id,
      pageId: c.pageId,
      pageName: c.pageName,
      active: c.active,
      lastReceivedAt: c.lastReceivedAt,
      receivedCount: c.receivedCount,
      createdAt: c.createdAt,
    })),
    linkedinConnections: linkedinConnections.map((c) => ({
      id: c.id,
      organizationUrn: c.organizationUrn,
      organizationName: c.organizationName,
      active: c.active,
      needsReconnect: c.needsReconnect,
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

// ---------- LinkedIn Lead Gen Forms (direct Lead Sync API) ----------
// Standard 3-legged OAuth (unlike Meta's manual token paste) but split into
// two steps: /connect + /callback obtain the token, then /finalize attaches
// it to a specific LinkedIn organization the owner enters manually — actual
// org discovery would need the same r_organization_admin API access this
// whole integration is already waiting on Lead Sync API approval for, so
// there's no reliable way to offer a dropdown of "your orgs" yet.

router.get("/linkedin/connect", requireAuth, requireOwner, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.linkedinOAuthState = state;
  res.redirect(buildAuthorizeUrl(state));
});

router.get("/linkedin/callback", requireAuth, requireOwner, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${process.env.FRONTEND_URL}/?linkedin_connected=0&reason=${encodeURIComponent(String(error))}`);
  if (!code || !state || state !== req.session.linkedinOAuthState) {
    return res.redirect(`${process.env.FRONTEND_URL}/?linkedin_connected=0&reason=invalid_state`);
  }
  delete req.session.linkedinOAuthState;

  try {
    const tokenData = await exchangeCodeForToken(code);
    // Held server-side in the session (never in a URL) until /finalize below
    // attaches it to an organization — see routes comment above for why that
    // extra step exists.
    req.session.linkedinPendingToken = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: Date.now() + Number(tokenData.expires_in || 0) * 1000,
    };
    res.redirect(`${process.env.FRONTEND_URL}/?linkedin_connected=pending`);
  } catch (err) {
    console.error("LinkedIn token exchange failed:", err.message);
    captureException(err, { scope: "integrations.linkedin_callback" });
    res.redirect(`${process.env.FRONTEND_URL}/?linkedin_connected=0&reason=token_exchange_failed`);
  }
});

router.post("/linkedin/finalize", requireAuth, requireOwner, async (req, res) => {
  const pending = req.session.linkedinPendingToken;
  if (!pending) return res.status(400).json({ error: "no_pending_linkedin_token" });

  const organizationUrn = typeof req.body.organizationUrn === "string" ? req.body.organizationUrn.trim() : "";
  const organizationName = typeof req.body.organizationName === "string" ? req.body.organizationName.trim().slice(0, 200) : "";
  if (!organizationUrn) return res.status(400).json({ error: "invalid_request" });

  const tokenData = {
    encryptedAccessToken: encrypt(pending.accessToken),
    encryptedRefreshToken: pending.refreshToken ? encrypt(pending.refreshToken) : null,
    tokenExpiry: new Date(pending.expiresAt),
    needsReconnect: false,
  };

  try {
    const existing = await prisma.linkedInLeadConnection.findUnique({ where: { organizationUrn } });
    if (existing && existing.companyId !== req.user.companyId) {
      return res.status(409).json({ error: "organization_already_connected" });
    }

    const connection = existing
      ? await prisma.linkedInLeadConnection.update({
          where: { id: existing.id },
          data: { ...tokenData, organizationName: organizationName || existing.organizationName },
        })
      : await prisma.linkedInLeadConnection.create({
          data: { companyId: req.user.companyId, organizationUrn, organizationName: organizationName || null, ...tokenData },
        });

    delete req.session.linkedinPendingToken;

    try {
      await registerWebhookSubscription(organizationUrn, pending.accessToken);
    } catch (err) {
      // Expected to fail until this app has real Lead Sync API approval —
      // the connection is still saved so the reconciliation poll can pick up
      // leads once approval comes through (see scheduler.js), and webhook
      // registration can be retried by disconnecting/reconnecting then.
      console.error("LinkedIn webhook registration failed:", err.message);
      captureException(err, { scope: "integrations.linkedin_finalize_webhook" });
    }

    await logAction(
      req,
      "integration.linkedin_connect",
      `${req.user.email} connected LinkedIn organization ${organizationName || organizationUrn}`,
      { companyId: req.user.companyId }
    );
    res.status(201).json({ id: connection.id, organizationUrn: connection.organizationUrn, organizationName: connection.organizationName });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "organization_already_connected" });
    throw err;
  }
});

router.delete("/linkedin/connections/:id", requireAuth, requireOwner, async (req, res) => {
  const existing = await prisma.linkedInLeadConnection.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!existing) return res.status(404).json({ error: "not_found" });
  await prisma.linkedInLeadConnection.delete({ where: { id: existing.id } });
  await logAction(
    req,
    "integration.linkedin_disconnect",
    `${req.user.email} disconnected LinkedIn organization ${existing.organizationName || existing.organizationUrn}`,
    { companyId: req.user.companyId }
  );
  res.json({ ok: true });
});

// LinkedIn's webhook validation handshake shape isn't fully confirmed
// against a live payload yet (see lib/linkedinLeads.js's file-level caveat)
// — this handles both a GET-style handshake and a POST body that includes a
// validationToken to echo back, defensively, alongside real notifications.
router.get("/linkedin/webhook", (req, res) => {
  res.sendStatus(200);
});

router.post("/linkedin/webhook", async (req, res) => {
  if (req.body && req.body.validationToken && !req.body.leadNotification) {
    return res.status(200).json({ validationToken: req.body.validationToken });
  }

  res.sendStatus(200); // ack fast — same reasoning as the Meta webhook above

  try {
    const notification = req.body?.leadNotification || req.body || {};
    const organizationUrn = notification.owner || notification.organization || notification.organizationUrn;
    const responseId = notification.leadFormResponse || notification.responseId || notification.id;
    if (!organizationUrn || !responseId) return;
    await processLinkedInLead(organizationUrn, responseId);
  } catch (err) {
    console.error("LinkedIn lead processing failed:", err.message);
    captureException(err, { scope: "integrations.linkedin_webhook" });
  }
});

async function processLinkedInLead(organizationUrn, responseId) {
  const connection = await prisma.linkedInLeadConnection.findUnique({ where: { organizationUrn } });
  if (!connection || !connection.active || connection.needsReconnect) return;

  const accessToken = decrypt(connection.encryptedAccessToken);
  let response;
  try {
    response = await fetchLeadFormResponse(responseId, accessToken);
  } catch (err) {
    if (isAuthError(err)) {
      await prisma.linkedInLeadConnection.update({ where: { id: connection.id }, data: { needsReconnect: true } });
    }
    throw err;
  }
  const flat = flattenLeadFormResponse(response);
  const mapped = mapGenericPayload(flat);
  const result = await upsertLeadContact({ companyId: connection.companyId, mapped, sourceTag: "lead:linkedin" });

  await prisma.linkedInLeadConnection.update({
    where: { id: connection.id },
    data: { lastReceivedAt: new Date(), receivedCount: { increment: 1 } },
  });

  if (result.ok) {
    await logAction(
      { user: null },
      "lead.received",
      `Νέο lead από LinkedIn (${connection.organizationName || connection.organizationUrn}): ${result.contact.email}`,
      { companyId: connection.companyId }
    );
  }
}

module.exports = router;
