const express = require("express");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

// Either templateId (subject/body/attachments copied in server-side, same
// "snapshot at creation time" rule as sequence steps — see sequences.js
// resolveSteps) or a direct subject+body for an inline-authored campaign.
const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  templateId: z.string().optional(),
  subject: z.string().max(300).optional(),
  body: z.string().optional(),
  attachments: z.array(z.any()).optional().default([]),
  contactIds: z.array(z.string()).min(1).max(2000),
  intervalMinutes: z.number().int().min(1).max(1440).optional().default(2),
});

function countByStatus(recipients) {
  const counts = { total: recipients.length, pending: 0, sent: 0, skipped: 0, failed: 0 };
  for (const r of recipients) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

// List view — lightweight recipient counts only (full per-recipient trace is
// GET /:id, fetched only when a campaign is actually opened).
router.get("/", async (req, res) => {
  const campaigns = await prisma.campaign.findMany({
    where: { userId: req.user.id },
    include: { recipients: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
  });

  const withCounts = campaigns.map(({ recipients, ...c }) => ({ ...c, counts: countByStatus(recipients) }));
  res.json(withCounts);
});

router.post("/", async (req, res) => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, templateId, contactIds, intervalMinutes } = parsed.data;

  let subject = parsed.data.subject;
  let body = parsed.data.body;
  let attachments = parsed.data.attachments;

  if (templateId) {
    const template = await prisma.template.findFirst({ where: { id: templateId, userId: req.user.id } });
    if (!template) return res.status(400).json({ error: "invalid_template" });
    subject = template.subject;
    body = template.body;
    attachments = template.attachments;
  }

  if (!subject || !body) return res.status(400).json({ error: "subject_and_body_required" });

  // Only real contacts belonging to this user, deduplicated — silently drop
  // anything else instead of failing the whole request over one bad id.
  const contacts = await prisma.contact.findMany({
    where: { id: { in: [...new Set(contactIds)] }, userId: req.user.id },
  });
  if (contacts.length === 0) return res.status(400).json({ error: "no_valid_contacts" });

  const campaign = await prisma.campaign.create({
    data: {
      userId: req.user.id,
      name,
      subject,
      body,
      attachments,
      intervalMinutes,
      recipients: { create: contacts.map((c, i) => ({ contactId: c.id, order: i })) },
    },
    include: { recipients: true },
  });

  res.status(201).json({ ...campaign, counts: countByStatus(campaign.recipients) });
});

router.get("/:id", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: {
      recipients: {
        include: { contact: { select: { id: true, name: true, email: true } } },
        orderBy: { order: "asc" },
      },
    },
  });
  if (!campaign) return res.status(404).json({ error: "not_found" });

  // Full per-recipient tracking trace — one EmailLog per genuinely-sent
  // recipient, joined back in here rather than embedded on
  // CampaignRecipient, since EmailLog + TrackingEvent are already the single
  // source of truth for send/open/click history everywhere else in the app.
  const emailLogs = await prisma.emailLog.findMany({
    where: { campaignId: campaign.id },
    include: { events: { orderBy: { occurredAt: "asc" } } },
  });
  const logByContactId = Object.fromEntries(emailLogs.map((l) => [l.contactId, l]));

  const recipients = campaign.recipients.map((r) => {
    const log = logByContactId[r.contactId];
    return {
      id: r.id,
      contactId: r.contactId,
      name: r.contact.name,
      email: r.contact.email,
      status: r.status,
      sentAt: r.sentAt,
      note: r.note,
      opened: log ? log.events.some((e) => e.type === "open" && !e.isBot) : false,
      clicked: log ? log.events.some((e) => e.type === "click") : false,
      events: log ? log.events.map((e) => ({ type: e.type, occurredAt: e.occurredAt, isBot: e.isBot, url: e.url })) : [],
    };
  });

  const { recipients: _omit, ...rest } = campaign;
  res.json({ ...rest, counts: countByStatus(campaign.recipients), recipients });
});

router.post("/:id/start", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!campaign) return res.status(404).json({ error: "not_found" });
  if (!["draft", "paused"].includes(campaign.status)) return res.status(400).json({ error: "cannot_start" });

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "running", startedAt: campaign.startedAt || new Date() },
  });
  res.json(updated);
});

router.post("/:id/pause", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!campaign) return res.status(404).json({ error: "not_found" });
  if (campaign.status !== "running") return res.status(400).json({ error: "not_running" });

  const updated = await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "paused" } });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!campaign) return res.status(404).json({ error: "not_found" });
  await prisma.campaign.delete({ where: { id: campaign.id } });
  res.json({ ok: true });
});

module.exports = router;
