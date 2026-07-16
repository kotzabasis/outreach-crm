const prisma = require("../db");
const { sendWeeklyDigestEmail } = require("./mailer");
const { captureException } = require("./sentry");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// A company is due for its next digest if it's never had one, or its last
// one was sent more than 7 days ago. Deliberately checked on a loose
// periodic tick (see weeklyDigestTick below) rather than an exact
// once-a-week cron — "roughly weekly, checked every few hours" is enough for
// a summary email and needs no timezone/cron-schedule reasoning at all.
async function getCompaniesDueForDigest() {
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);
  return prisma.company.findMany({
    where: {
      status: "active",
      OR: [{ lastDigestSentAt: null }, { lastDigestSentAt: { lte: cutoff } }],
    },
  });
}

// Same 7-day-window analytics shape as routes/analytics.js's /overview, just
// scoped to the trailing week instead of all-time, and computed for one
// company rather than read from the request's session — the digest is sent
// asynchronously from a background tick, not a logged-in request.
async function computeWeeklyStats(companyId) {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);

  const logs = await prisma.emailLog.findMany({
    where: { companyId, sentAt: { gte: since } },
    include: { events: true },
  });
  const sent = logs.length;
  const opened = logs.filter((l) => l.events.some((e) => e.type === "open" && !e.isBot)).length;
  const clicked = logs.filter((l) => l.events.some((e) => e.type === "click")).length;

  const newContacts = await prisma.contact.count({ where: { companyId, createdAt: { gte: since } } });

  const repliedContacts = await prisma.contact.count({
    where: { companyId, status: "replied", lastActivityAt: { gte: since } },
  });

  const offersWon = await prisma.offer.findMany({
    where: { companyId, status: "accepted", updatedAt: { gte: since } },
    select: { value: true, currency: true },
  });
  const offersWonValue = offersWon.reduce((sum, o) => sum + (o.value || 0), 0);

  const activeSequences = await prisma.sequence.count({ where: { companyId, active: true } });

  const dueToday = await prisma.contact.count({
    where: { companyId, unsubscribed: false, nextFollowUpAt: { not: null, lte: new Date() } },
  });

  return {
    sent,
    opened,
    clicked,
    newContacts,
    repliedContacts,
    offersWonCount: offersWon.length,
    offersWonValue,
    activeSequences,
    dueToday,
  };
}

async function sendDigestForCompany(company) {
  const owners = await prisma.user.findMany({
    where: { companyId: company.id, role: "owner", approved: true },
    select: { email: true },
  });
  if (owners.length === 0) return; // nothing to send to, but still mark as attempted below so this company isn't retried every tick

  const stats = await computeWeeklyStats(company.id);

  for (const owner of owners) {
    try {
      await sendWeeklyDigestEmail(owner.email, company.name, stats);
    } catch (err) {
      console.error(`Weekly digest send failed for ${owner.email} (company ${company.id}):`, err.message);
      captureException(err, { scope: "weeklyDigest.sendDigestForCompany", companyId: company.id });
    }
  }
}

async function weeklyDigestTick() {
  try {
    const companies = await getCompaniesDueForDigest();
    for (const company of companies) {
      try {
        await sendDigestForCompany(company);
      } finally {
        // Always stamp lastDigestSentAt, even if sending above failed or
        // there were no owners to send to — otherwise a company with a
        // persistently broken/unconfigured mailer gets retried every single
        // tick forever instead of just weekly like everything else.
        await prisma.company.update({ where: { id: company.id }, data: { lastDigestSentAt: new Date() } });
      }
    }
  } catch (err) {
    console.error("Weekly digest tick failed:", err.message);
    captureException(err, { scope: "weeklyDigest.weeklyDigestTick" });
  }
}

module.exports = { weeklyDigestTick, computeWeeklyStats, getCompaniesDueForDigest };
