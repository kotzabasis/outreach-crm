const cron = require("node-cron");
const { v4: uuid } = require("uuid");
const prisma = require("../db");
const { sendTrackedEmail } = require("./gmailClient");

const DAILY_CAP = Number(process.env.MAX_EMAILS_PER_DAY_PER_ACCOUNT || 300);

async function resetDailyCounterIfNeeded(gmailAccount) {
  const hoursSinceReset = (Date.now() - new Date(gmailAccount.sendCounterResetAt).getTime()) / 36e5;
  if (hoursSinceReset >= 24) {
    return prisma.gmailAccount.update({
      where: { id: gmailAccount.id },
      data: { emailsSentToday: 0, sendCounterResetAt: new Date() },
    });
  }
  return gmailAccount;
}

async function processDueEnrollments() {
  const due = await prisma.enrollment.findMany({
    where: { status: "active", nextSendAt: { lte: new Date() } },
    include: {
      contact: true,
      sequence: { include: { steps: { orderBy: { order: "asc" } } } },
    },
    take: 100, // bounded batch per tick — avoids one huge run hammering the Gmail API
  });

  for (const enrollment of due) {
    try {
      await sendNextStep(enrollment);
    } catch (err) {
      console.error(`Failed to send step for enrollment ${enrollment.id}:`, err.message);
      // Leave nextSendAt as-is; it'll be retried on the next tick rather than
      // silently dropped. If it keeps failing (e.g. revoked Gmail access),
      // this will show up in logs — worth alerting on in production.
    }
  }
}

// Combinable gating conditions on a step (on top of, not instead of,
// delayDays) — see SequenceStep.conditions in schema.prisma. If unmet, the
// step is skipped outright (not retried later) and the enrollment advances.
async function stepConditionsMet(step, enrollment, contact) {
  const conditions = step.conditions || {};

  if (Array.isArray(conditions.requireTags) && conditions.requireTags.length > 0) {
    const contactTags = (contact.tags || "").split(",").map((t) => t.trim());
    const hasAny = conditions.requireTags.some((t) => contactTags.includes(t));
    if (!hasAny) return false;
  }

  if (conditions.requireEvent) {
    const prevLog = await prisma.emailLog.findFirst({
      where: { enrollmentId: enrollment.id },
      orderBy: { sentAt: "desc" },
      include: { events: true },
    });
    // Bot/self opens (see isLikelyBotOpen in routes/tracking.js) don't count
    // — a "wait until opened" step shouldn't fire just because Gmail's
    // prefetch bot hit the pixel on delivery.
    const opened = prevLog ? prevLog.events.some((e) => e.type === "open" && !e.isBot) : false;
    const clicked = prevLog ? prevLog.events.some((e) => e.type === "click") : false;
    if (conditions.requireEvent === "opened" && !opened) return false;
    if (conditions.requireEvent === "clicked" && !clicked) return false;
    if (conditions.requireEvent === "not_opened" && opened) return false;
    if (conditions.requireEvent === "not_clicked" && clicked) return false;
  }

  return true;
}

async function advanceEnrollment(enrollment, sequence) {
  const nextStep = sequence.steps[enrollment.currentStep + 1];
  if (nextStep) {
    const nextSendAt = new Date(Date.now() + nextStep.delayDays * 24 * 60 * 60 * 1000);
    await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { currentStep: enrollment.currentStep + 1, nextSendAt },
    });
  } else {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "completed" } });
  }
}

async function sendNextStep(enrollment) {
  const { contact, sequence } = enrollment;

  if (contact.unsubscribed) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "paused" } });
    return;
  }

  const step = sequence.steps[enrollment.currentStep];
  if (!step) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "completed" } });
    return;
  }

  if (!(await stepConditionsMet(step, enrollment, contact))) {
    // Condition (event/tag) not satisfied — skip this step immediately and
    // re-evaluate the next one on the next tick, rather than retrying this
    // one forever.
    await advanceEnrollment(enrollment, sequence);
    return;
  }

  let gmailAccount = await prisma.gmailAccount.findUnique({ where: { userId: sequence.userId } });
  if (!gmailAccount) {
    // The app user hasn't connected Gmail yet — leave the enrollment due
    // as-is rather than failing it; it'll send as soon as they connect.
    return;
  }
  gmailAccount = await resetDailyCounterIfNeeded(gmailAccount);

  if (gmailAccount.emailsSentToday >= DAILY_CAP) {
    // Don't send, don't advance — just leave it due so it goes out once the
    // cap resets. Protects the connected Gmail account from being flagged
    // for high-volume sending.
    return;
  }

  const trackingId = uuid();
  const gmailMessageId = await sendTrackedEmail({
    gmailAccount,
    contact,
    subject: step.subject,
    body: step.body,
    trackingId,
    attachments: Array.isArray(step.attachments) ? step.attachments : [],
  });

  await prisma.$transaction([
    prisma.emailLog.create({
      data: {
        enrollmentId: enrollment.id,
        stepId: step.id,
        contactId: contact.id,
        userId: sequence.userId,
        subject: step.subject,
        source: "sequence",
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

  await advanceEnrollment(enrollment, sequence);
}

function startScheduler() {
  // Every 5 minutes. Fine-grained enough for reasonable delivery timing
  // without hammering the DB or Gmail API.
  cron.schedule("*/5 * * * *", () => {
    processDueEnrollments().catch((err) => console.error("Scheduler tick failed:", err));
  });
  console.log("Sequence scheduler started (every 5 minutes).");
}

module.exports = { startScheduler, processDueEnrollments };
