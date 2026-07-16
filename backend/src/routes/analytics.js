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

  // Three aggregation queries (instead of 6 + 4N + 4M): totals, per-sequence, per-campaign.
  // Using raw SQL to aggregate in one pass per group, avoiding N+1 problem.
  const [totalStats, perSequence, perCampaign] = await Promise.all([
    // Company totals: sent, opened, clicked, and contacts with replied status who have been emailed
    prisma.$queryRaw`
      SELECT
        COUNT(DISTINCT el.id) as sent,
        COUNT(DISTINCT CASE WHEN te.type = 'open' AND te."isBot" = false THEN el.id END) as opened,
        COUNT(DISTINCT CASE WHEN te.type = 'click' THEN el.id END) as clicked,
        COUNT(DISTINCT c.id) as replied
      FROM "EmailLog" el
      LEFT JOIN "TrackingEvent" te ON el.id = te."emailLogId"
      LEFT JOIN "Contact" c ON el."contactId" = c.id AND c.status = 'replied'
      WHERE el."companyId" = ${companyId}
    `.then((rows) => ({
      sent: Number(rows[0]?.sent || 0),
      opened: Number(rows[0]?.opened || 0),
      clicked: Number(rows[0]?.clicked || 0),
      replied: Number(rows[0]?.replied || 0),
    })),
    // Per-sequence stats: aggregate all EmailLogs and events per sequence in one query
    prisma.$queryRaw`
      SELECT
        s.id,
        s.name,
        COUNT(DISTINCT el.id) as sent,
        COUNT(DISTINCT CASE WHEN te.type = 'open' AND te."isBot" = false THEN el.id END) as opened,
        COUNT(DISTINCT CASE WHEN te.type = 'click' THEN el.id END) as clicked,
        COUNT(DISTINCT CASE WHEN e.status = 'replied' THEN e.id END) as replied
      FROM "Sequence" s
      LEFT JOIN "Enrollment" e ON s.id = e."sequenceId"
      LEFT JOIN "EmailLog" el ON e.id = el."enrollmentId"
      LEFT JOIN "TrackingEvent" te ON el.id = te."emailLogId"
      WHERE s."companyId" = ${companyId}
      GROUP BY s.id, s.name
      ORDER BY s.name
    `.then((rows) =>
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        sent: Number(row.sent || 0),
        opened: Number(row.opened || 0),
        clicked: Number(row.clicked || 0),
        replied: Number(row.replied || 0),
      }))
    ),
    // Per-campaign stats: aggregate all EmailLogs and events per campaign in one query
    prisma.$queryRaw`
      SELECT
        c.id,
        c.name,
        c.status,
        COUNT(DISTINCT el.id) as sent,
        COUNT(DISTINCT CASE WHEN te.type = 'open' AND te."isBot" = false THEN el.id END) as opened,
        COUNT(DISTINCT CASE WHEN te.type = 'click' THEN el.id END) as clicked,
        COUNT(DISTINCT CASE WHEN ct.status = 'replied' AND el.id IS NOT NULL THEN ct.id END) as replied
      FROM "Campaign" c
      LEFT JOIN "EmailLog" el ON c.id = el."campaignId"
      LEFT JOIN "TrackingEvent" te ON el.id = te."emailLogId"
      LEFT JOIN "Contact" ct ON el."contactId" = ct.id AND ct.status = 'replied'
      WHERE c."companyId" = ${companyId}
      GROUP BY c.id, c.name, c.status
      ORDER BY c.name
    `.then((rows) =>
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        sent: Number(row.sent || 0),
        opened: Number(row.opened || 0),
        clicked: Number(row.clicked || 0),
        replied: Number(row.replied || 0),
      }))
    ),
  ]);

  res.json({ totals: totalStats, perSequence, perCampaign });
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
