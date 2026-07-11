const express = require("express");
const { v4: uuid } = require("uuid");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const { sendTrackedEmail } = require("../lib/gmailClient");
const { attachmentsSchema } = require("../lib/attachments");

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

  const contact = await prisma.contact.findFirst({ where: { id: parsed.data.contactId, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "contact_not_found" });
  if (contact.unsubscribed) return res.status(400).json({ error: "contact_unsubscribed" });

  const gmailAccount = await prisma.gmailAccount.findUnique({ where: { userId: req.user.id } });
  if (!gmailAccount) return res.status(400).json({ error: "gmail_not_connected" });

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

  const emailLog = await prisma.emailLog.create({
    data: {
      contactId: contact.id,
      userId: req.user.id,
      subject: parsed.data.subject,
      source: "manual",
      attachments: parsed.data.attachments,
      gmailMessageId,
      trackingId,
    },
  });

  await prisma.contact.update({
    where: { id: contact.id },
    data: { status: contact.status === "new" ? "contacted" : contact.status, lastActivityAt: new Date() },
  });

  res.status(201).json(emailLog);
});

module.exports = router;
