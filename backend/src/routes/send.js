const express = require("express");
const { v4: uuid } = require("uuid");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const { sendTrackedEmail, isAuthError, flagNeedsReconnect } = require("../lib/gmailClient");
const { attachmentsSchema } = require("../lib/attachments");
const { DAILY_CAP, pickSendableMailbox, mailboxUsedUpdate } = require("../lib/emailCap");
const { captureException } = require("../lib/sentry");

const router = express.Router();
router.use(requireAuth);

const sendSchema = z.object({
  contactId: z.string().uuid(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(50000),
  attachments: attachmentsSchema,
});

// One-off manual send — same Gmail account, tracking, and attachment support
// as sequence steps, just triggered immediately instead of by the scheduler.
router.post("/", async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const contact = await prisma.contact.findFirst({ where: { id: parsed.data.contactId, companyId: req.user.companyId } });
  if (!contact) return res.status(404).json({ error: "contact_not_found" });
  if (contact.unsubscribed) return res.status(400).json({ error: "contact_unsubscribed" });

  // A company can have more than one connected mailbox now (see
  // schema.prisma's GmailAccount + lib/emailCap.js#pickSendableMailbox) — it
  // picks whichever is healthy and under today's cap, rotating across the
  // pool. If nothing's sendable, figure out which of the three reasons it
  // is (never connected / every mailbox broken / every mailbox capped) so
  // the error stays as specific as it was with a single mailbox.
  const gmailAccounts = await prisma.gmailAccount.findMany({ where: { companyId: req.user.companyId } });
  if (gmailAccounts.length === 0) return res.status(400).json({ error: "gmail_not_connected" });

  const gmailAccount = await pickSendableMailbox(req.user.companyId);
  if (!gmailAccount) {
    if (gmailAccounts.every((g) => g.needsReconnect)) {
      return res.status(400).json({ error: "gmail_needs_reconnect" });
    }
    return res.status(429).json({ error: "daily_send_cap_reached", limit: DAILY_CAP });
  }

  const trackingId = uuid();
  const company = await prisma.company.findUnique({
    where: { id: req.user.companyId },
    select: { emailTrackingEnabled: true, unsubscribeEnabled: true },
  });
  let gmailMessageId;
  try {
    gmailMessageId = await sendTrackedEmail({
      gmailAccount,
      contact,
      subject: parsed.data.subject,
      body: parsed.data.body,
      trackingId,
      attachments: parsed.data.attachments,
      trackingEnabled: company?.emailTrackingEnabled !== false,
      unsubscribeEnabled: company?.unsubscribeEnabled !== false,
    });
  } catch (err) {
    console.error("Manual send failed:", err.message);
    if (isAuthError(err)) {
      await flagNeedsReconnect(gmailAccount.id);
      captureException(err, { scope: "send.manual", reason: "auth_error" });
      return res.status(400).json({ error: "gmail_needs_reconnect" });
    }
    captureException(err, { scope: "send.manual" });
    return res.status(502).json({ error: "send_failed" });
  }

  const [emailLog] = await prisma.$transaction([
    prisma.emailLog.create({
      data: {
        contactId: contact.id,
        userId: req.user.id,
        companyId: req.user.companyId,
        subject: parsed.data.subject,
        source: "manual",
        attachments: parsed.data.attachments,
        gmailMessageId,
        trackingId,
      },
    }),
    mailboxUsedUpdate(gmailAccount.id),
    prisma.contact.update({
      where: { id: contact.id },
      data: { status: contact.status === "new" ? "contacted" : contact.status, lastActivityAt: new Date() },
    }),
  ]);

  res.status(201).json(emailLog);
});

module.exports = router;
