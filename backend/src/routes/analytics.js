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

router.get("/timeline", async (req, res) => {
  const days = Math.min(Number(req.query.days) || 14, 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const events = await prisma.trackingEvent.findMany({
    where: { occurredAt: { gte: since }, emailLog: { enrollment: { contact: { userId: req.user.id } } } },
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

module.exports = router;
