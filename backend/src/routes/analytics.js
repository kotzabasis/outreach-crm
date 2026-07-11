const express = require("express");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

router.get("/overview", async (req, res) => {
  const sequences = await prisma.sequence.findMany({
    where: { userId: req.user.id },
    include: {
      enrollments: {
        include: { emailLogs: { include: { events: true } } },
      },
    },
  });

  const perSequence = sequences.map((seq) => {
    const logs = seq.enrollments.flatMap((e) => e.emailLogs);
    const sent = logs.length;
    const opened = logs.filter((l) => l.events.some((e) => e.type === "open")).length;
    const clicked = logs.filter((l) => l.events.some((e) => e.type === "click")).length;
    const replied = seq.enrollments.filter((e) => e.status === "replied").length;
    return { id: seq.id, name: seq.name, sent, opened, clicked, replied };
  });

  const totals = perSequence.reduce(
    (acc, s) => ({
      sent: acc.sent + s.sent,
      opened: acc.opened + s.opened,
      clicked: acc.clicked + s.clicked,
      replied: acc.replied + s.replied,
    }),
    { sent: 0, opened: 0, clicked: 0, replied: 0 }
  );

  res.json({ totals, perSequence });
});

// Recent sends — manual and sequence-driven alike — for the "Sent" / inbox
// view. userId is denormalized directly onto EmailLog now, so this no longer
// needs to go through the enrollment/contact chain.
router.get("/activity", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  const logs = await prisma.emailLog.findMany({
    where: { userId: req.user.id },
    include: {
      contact: { select: { email: true, name: true } },
      enrollment: { select: { status: true, sequence: { select: { name: true } } } },
      events: { select: { type: true } },
    },
    orderBy: { sentAt: "desc" },
    take: limit,
  });

  const activity = logs.map((log) => {
    const opened = log.events.some((e) => e.type === "open");
    const clicked = log.events.some((e) => e.type === "click");
    let status = "contacted";
    if (log.enrollment?.status === "bounced") status = "bounced";
    else if (log.enrollment?.status === "replied") status = "replied";
    else if (opened || clicked) status = "opened";

    return {
      id: log.id,
      to: log.contact.email,
      toName: log.contact.name,
      subject: log.subject,
      sentAt: log.sentAt,
      status,
      source: log.source,
      sequenceName: log.enrollment?.sequence?.name || null,
    };
  });

  res.json(activity);
});

router.get("/timeline", async (req, res) => {
  const days = Math.min(Number(req.query.days) || 14, 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const events = await prisma.trackingEvent.findMany({
    where: { occurredAt: { gte: since }, emailLog: { userId: req.user.id } },
    select: { type: true, occurredAt: true },
  });

  const byDay = {};
  for (const e of events) {
    const day = e.occurredAt.toISOString().slice(0, 10);
    byDay[day] = byDay[day] || { day, opens: 0, clicks: 0 };
    if (e.type === "open") byDay[day].opens++;
    if (e.type === "click") byDay[day].clicks++;
  }

  res.json(Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)));
});

// Business-side CRM reporting, separate from the email-metrics overview
// above: how many contacts have actually been engaged, how the offer
// pipeline is doing, win rate, and why offers were won/lost.
router.get("/crm-overview", async (req, res) => {
  const [contactsTotal, contactedCount, offers] = await Promise.all([
    prisma.contact.count({ where: { userId: req.user.id } }),
    prisma.contact.count({ where: { userId: req.user.id, status: { not: "new" } } }),
    prisma.offer.findMany({ where: { userId: req.user.id } }),
  ]);

  const offersByStatus = { draft: 0, sent: 0, accepted: 0, declined: 0 };
  const valueByStatus = { draft: 0, sent: 0, accepted: 0, declined: 0 };
  const reasonCounts = {};

  for (const o of offers) {
    offersByStatus[o.status] = (offersByStatus[o.status] || 0) + 1;
    valueByStatus[o.status] = (valueByStatus[o.status] || 0) + (o.value || 0);
    if ((o.status === "accepted" || o.status === "declined") && o.outcomeReason?.trim()) {
      const key = o.outcomeReason.trim();
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
  }

  const decided = offersByStatus.accepted + offersByStatus.declined;
  const winRate = decided > 0 ? offersByStatus.accepted / decided : null;

  const declineReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  res.json({
    contactsTotal,
    contactsContacted: contactedCount,
    offersTotal: offers.length,
    offersByStatus,
    valueByStatus,
    winRate,
    declineReasons,
  });
});

module.exports = router;
