const prisma = require("../db");
const unipile = require("./unipileClient");
const { renderTemplate } = require("./gmailClient");
const { captureException } = require("./sentry");

// Core LinkedIn outreach service — shared by the routes (manual actions) and the
// scheduler (sequenced actions), so rate limiting and status bookkeeping live in
// exactly one place.
//
// SAFETY: rate limits are DB-backed (columns on LinkedInOutreachAccount), never
// in memory, so a scheduler restart/redeploy can't reset them and blow past the
// daily cap — the fastest way to get a LinkedIn account flagged/banned. Keep the
// defaults conservative.
const MAX_CONNECTIONS_PER_DAY = Number(process.env.LINKEDIN_MAX_CONNECTIONS_PER_DAY || 12); // 10–15 recommended
const MAX_MESSAGES_PER_DAY = Number(process.env.LINKEDIN_MAX_MESSAGES_PER_DAY || 40);

// A sample contact object used only to render merge tokens for a test/preview.
function renderText(template, contact) {
  // Reuse the email merge engine, plus a {{linkedin}} token. asHtml:false since
  // LinkedIn notes/messages are plain text, not HTML.
  const withLinkedin = String(template || "").replaceAll("{{linkedin}}", contact.linkedinProfileUrl || "");
  return renderTemplate(withLinkedin, contact, { asHtml: false });
}

// Roll the per-day counters over once 24h have passed since the last reset.
async function resetCountersIfNeeded(account) {
  const hours = (Date.now() - new Date(account.counterResetAt).getTime()) / 36e5;
  if (hours >= 24) {
    return prisma.linkedInOutreachAccount.update({
      where: { id: account.id },
      data: { connectionsSentToday: 0, messagesSentToday: 0, counterResetAt: new Date() },
    });
  }
  return account;
}

// The one sendable account for a company (MVP: at most one). Returns null if
// none connected, paused, or in a non-ok status.
async function getSendableAccount(companyId) {
  if (!companyId) return null;
  const raw = await prisma.linkedInOutreachAccount.findUnique({ where: { companyId } });
  if (!raw || raw.paused || raw.status !== "ok") return null;
  return resetCountersIfNeeded(raw);
}

function canSendConnection(account) {
  return account && !account.paused && account.status === "ok" && account.connectionsSentToday < MAX_CONNECTIONS_PER_DAY;
}
function canSendMessage(account) {
  return account && !account.paused && account.status === "ok" && account.messagesSentToday < MAX_MESSAGES_PER_DAY;
}

// Ensure the contact has a resolved provider id (resolving once and caching it
// on the contact). Returns { providerId, alreadyConnected } or throws.
async function ensureResolved(account, contact) {
  if (contact.linkedinProviderId) {
    return { providerId: contact.linkedinProviderId, alreadyConnected: contact.linkedinConnectionStatus === "connected" };
  }
  if (!contact.linkedinProfileUrl) throw new Error("contact_has_no_linkedin_url");
  const resolved = await unipile.resolveProfile(account.unipileAccountId, contact.linkedinProfileUrl);
  if (!resolved.providerId) throw new Error("could_not_resolve_profile");
  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      linkedinProviderId: resolved.providerId,
      ...(resolved.alreadyConnected ? { linkedinConnectionStatus: "connected" } : {}),
    },
  });
  return { providerId: resolved.providerId, alreadyConnected: resolved.alreadyConnected };
}

// Send a connection request (invite) with an optional note. Records a
// LinkedInAction, advances the contact status, and increments the daily counter
// — all only after Unipile confirms. Returns the created action.
async function sendConnectionRequest({ account, contact, note, enrollmentId = null, stepId = null }) {
  const { providerId, alreadyConnected } = await ensureResolved(account, contact);

  // Already connected → no invite needed; caller (sequence) can go straight to a message.
  if (alreadyConnected) {
    return { skipped: true, reason: "already_connected" };
  }

  const renderedNote = note ? renderText(note, contact) : "";
  let result;
  try {
    result = await unipile.sendInvitation(account.unipileAccountId, providerId, renderedNote);
  } catch (err) {
    await prisma.linkedInAction.create({
      data: {
        companyId: account.companyId, type: "connection_request", contactId: contact.id, accountId: account.id,
        enrollmentId, stepId, text: renderedNote, status: "failed", errorMessage: String(err.message || err).slice(0, 400),
      },
    }).catch(() => {});
    throw err;
  }

  const action = await prisma.$transaction([
    prisma.linkedInAction.create({
      data: {
        companyId: account.companyId, type: "connection_request", contactId: contact.id, accountId: account.id,
        enrollmentId, stepId, text: renderedNote, status: "sent", sentAt: new Date(),
        unipileId: result?.invitation_id || result?.id || null,
      },
    }),
    prisma.contact.update({ where: { id: contact.id }, data: { linkedinConnectionStatus: "pending", lastActivityAt: new Date() } }),
    prisma.linkedInOutreachAccount.update({ where: { id: account.id }, data: { connectionsSentToday: { increment: 1 } } }),
  ]);
  return { skipped: false, action: action[0] };
}

// Send a direct LinkedIn message (only valid for connections).
async function sendLinkedinMessage({ account, contact, text, enrollmentId = null, stepId = null }) {
  const { providerId } = await ensureResolved(account, contact);
  const rendered = renderText(text, contact);
  let result;
  try {
    result = await unipile.sendMessage(account.unipileAccountId, providerId, rendered);
  } catch (err) {
    await prisma.linkedInAction.create({
      data: {
        companyId: account.companyId, type: "message", contactId: contact.id, accountId: account.id,
        enrollmentId, stepId, text: rendered, status: "failed", errorMessage: String(err.message || err).slice(0, 400),
      },
    }).catch(() => {});
    throw err;
  }
  const action = await prisma.$transaction([
    prisma.linkedInAction.create({
      data: {
        companyId: account.companyId, type: "message", contactId: contact.id, accountId: account.id,
        enrollmentId, stepId, text: rendered, status: "sent", sentAt: new Date(),
        unipileId: result?.message_id || result?.chat_id || result?.id || null,
      },
    }),
    prisma.contact.update({ where: { id: contact.id }, data: { lastActivityAt: new Date() } }),
    prisma.linkedInOutreachAccount.update({ where: { id: account.id }, data: { messagesSentToday: { increment: 1 } } }),
  ]);
  return { action: action[0] };
}

// Withdraw a still-pending invitation.
async function withdrawConnectionRequest({ account, contact }) {
  const lastInvite = await prisma.linkedInAction.findFirst({
    where: { contactId: contact.id, type: "connection_request", status: "sent" },
    orderBy: { createdAt: "desc" },
  });
  if (lastInvite?.unipileId) {
    await unipile.withdrawInvitation(account.unipileAccountId, lastInvite.unipileId).catch((err) =>
      captureException(err, { scope: "linkedin.withdraw", contactId: contact.id })
    );
    await prisma.linkedInAction.update({ where: { id: lastInvite.id }, data: { status: "withdrawn" } }).catch(() => {});
  }
  await prisma.contact.update({ where: { id: contact.id }, data: { linkedinConnectionStatus: "withdrawn" } });
}

module.exports = {
  MAX_CONNECTIONS_PER_DAY,
  MAX_MESSAGES_PER_DAY,
  getSendableAccount,
  resetCountersIfNeeded,
  canSendConnection,
  canSendMessage,
  ensureResolved,
  sendConnectionRequest,
  sendLinkedinMessage,
  withdrawConnectionRequest,
};
