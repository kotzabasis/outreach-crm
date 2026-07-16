const express = require("express");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

// Rewritten to aggregate in Postgres (count()/relation-filter EXISTS
// queries) instead of loading every EmailLog + TrackingEvent for the whole
// company into JS and counting there — the old version got linearly slower
// and heavier as email history grew, with no bound at all, and this endpoint
// is hit on every Analytics-tab open plus the background poll. Same pattern
// admin.js's company-stats endpoint already used well; this brings
// analytics in line with it. Semantics are preserved exactly: "opened" means
// distinct EmailLogs with at least one non-bot open event (not a raw event
// count — one email can be opened multiple times), and "replied" means
// contacts marked replied who have actually been emailed at least once.
router.get("/overview", async (req, res) => {
  const companyId = req.user.companyId;

  const [sent, opened, clicked, replied, sequences, campaigns] = await Promise.all([
    prisma.emailLog.count({ where: { companyId } }),
    prisma.emailLog.count({ where: { companyId, events: { some: { type: "open", isBot: false } } } }),
    prisma.emailLog.count({ where: { companyId, events: { some: { type: "click" } } } }),
    prisma.contact.count({ where: { companyId, status: "replied", emailLogs: { some: {} } } }),
    prisma.sequence.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.campaign.findMany({ where: { companyId }, select: { id: true, name: true, status: true } }),
  ]);

  const perSequence = await Promise.all(
    sequences.map(async (seq) => {
      const [seqSent, seqOpened, seqClicked, seqReplied] = await Promise.all([
        prisma.emailLog.count({ where: { companyId, enrollment: { sequenceId: seq.id } } }),
        prisma.emailLog.count({ where: { companyId, enrollment: { sequenceId: seq.id }, events: { some: { type: "open", isBot: false } } } }),
        prisma.emailLog.count({ where: { companyId, enrollment: { sequenceId: seq.id }, events: { some: { type: "click" } } } }),
        prisma.enrollment.count({ where: { sequenceId: seq.id, status: "replied" } }),
      ]);
      return { id: seq.id, name: seq.name, sent: seqSent, opened: seqOpened, clicked: seqClicked, replied: seqReplied };
    })
  );

  // Campaign reporting, same shape as perSequence — lets the frontend filter
  // Analytics down to "just this campaign" the same way it already does for
  // sequences.
  const perCampaign = await Promise.all(
    campaigns.map(async (camp) => {
      const [campSent, campOpened, campClicked, campReplied] = await Promise.all([
        prisma.emailLog.count({ where: { companyId, campaignId: camp.id } }),
        prisma.emailLog.count({ where: { companyId, campaignId: camp.id, events: { some: { type: "open", isBot: false } } } }),
        prisma.emailLog.count({ where: { companyId, campaignId: camp.id, events: { some: { type: "click" } } } }),
        prisma.contact.count({ where: { companyId, status: "replied", emailLogs: { some: { campaignId: camp.id } } } }),
      ]);
      return { id: camp.id, name: camp.name, status: camp.status, sent: campSent, opened: campOpened, clicked: campClicked, replied: campReplied };
    })
  );

  res.json({ totals: { sent, opened, clicked, replied }, perSequence, perCampaign });
});

// Recent sends — manual and sequence-driven alike — for the "Sent" / inbox
// view. companyId is denormalized directly onto EmailLog now, so this no
// longer needs to go through the enrollment/contact chain, and every
// teammate on the same company sees the same shared send history.
router.get("/activity", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  const logs = await prisma.emailLog.findMany({
    where: { companyId: req.user.companyId },
    include: {
      contact: { select: { email: true, name: true } },
      enrollment: { select: { status: true, sequence: { select: { name: true } } } },
      campaign: { select: { name: true } },
      events: { select: { type: true, isBot: true, occurredAt: true, url: true }, orderBy: { occurredAt: "asc" } },
    },
    orderBy: { sentAt: "desc" },
    take: limit,
  });

  const activity = logs.map((log) => {
    const opened = log.events.some((e) => e.type === "open" && !e.isBot);
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
      sequenceName: log.enrollment?.sequence?.name || log.campaign?.name || null,
      // Full per-send trace (not just the collapsed opened/clicked booleans
      // above) — including bot-filtered opens, flagged as such, so it's
      // visible *why* a given open didn't count instead of it just silently
      // not showing up. This is what backs the expandable trace in the
      // Inbox row on the frontend.
      events: log.events.map((e) => ({ type: e.type, occurredAt: e.occurredAt, isBot: e.isBot, url: e.url })),
    };
  });

  res.json(activity);
});

router.get("/timeline", async (req, res) => {
  const days = Math.min(Number(req.query.days) || 14, 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const events = await prisma.trackingEvent.findMany({
    where: { occurredAt: { gte: since }, emailLog: { companyId: req.user.companyId } },
    select: { type: true, occurredAt: true, isBot: true },
  });

  const byDay = {};
  for (const e of events) {
    const day = e.occurredAt.toISOString().slice(0, 10);
    byDay[day] = byDay[day] || { day, opens: 0, clicks: 0 };
    if (e.type === "open" && !e.isBot) byDay[day].opens++;
    if (e.type === "click") byDay[day].clicks++;
  }

  res.json(Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)));
});

// Business-side CRM reporting, separate from the email-metrics overview
// above: how many contacts have actually been engaged, how the offer
// pipeline is doing, win rate, and why offers were won/lost.
router.get("/crm-overview", async (req, res) => {
  const [contactsTotal, contactedCount, offers] = await Promise.all([
    prisma.contact.count({ where: { companyId: req.user.companyId } }),
    prisma.contact.count({ where: { companyId: req.user.companyId, status: { not: "new" } } }),
    prisma.offer.findMany({ where: { companyId: req.user.companyId } }),
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
