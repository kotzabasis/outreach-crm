const express = require("express");
const { v4: uuid } = require("uuid");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const { sendTrackedEmail } = require("../lib/gmailClient");
const { attachmentsSchema } = require("../lib/attachments");
const { DAILY_CAP, resetDailyCounterIfNeeded } = require("../lib/emailCap");

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

  let gmailAccount = await prisma.gmailAccount.findUnique({ where: { companyId: req.user.companyId } });
  if (!gmailAccount) return res.status(400).json({ error: "gmail_not_connected" });

  // Manual sends used to skip this entirely — only the scheduler (sequence/
  // campaign sends) enforced it, so someone could blow well past the daily
  // cap via Compose alone and get the shared Gmail account flagged by
  // Google. Same counter, same cap, all three send paths now share it (see
  // lib/emailCap.js).
  gmailAccount = await resetDailyCounterIfNeeded(gmailAccount);
  if (gmailAccount.emailsSentToday >= DAILY_CAP) {
    return res.status(429).json({ error: "daily_send_cap_reached", limit: DAILY_CAP });
  }

  const trackingId = uuid();
  let gmailMessageId;
  try {
    gmailMessageId = await sendTrackedEmail({
      gmailAccount,
      contact,
      subject: parsed.data.subject,
      body: parsed.data.body,
      trackingId,
      attachments: parsed.data.attachments,
    });
  } catch (err) {
    console.error("Manual send failed:", err.message);
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
    prisma.gmailAccount.update({ where: { id: gmailAccount.id }, data: { emailsSentToday: { increment: 1 } } }),
    prisma.contact.update({
      where: { id: contact.id },
      data: { status: contact.status === "new" ? "contacted" : contact.status, lastActivityAt: new Date() },
    }),
  ]);

  res.status(201).json(emailLog);
});

module.exports = router;
