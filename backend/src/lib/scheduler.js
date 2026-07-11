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
  });

  await prisma.$transaction([
    prisma.emailLog.create({
      data: { enrollmentId: enrollment.id, stepId: step.id, gmailMessageId, trackingId },
    }),
    prisma.gmailAccount.update({ where: { id: gmailAccount.id }, data: { emailsSentToday: { increment: 1 } } }),
    prisma.contact.update({
      where: { id: contact.id },
      data: { status: contact.status === "new" ? "contacted" : contact.status, lastActivityAt: new Date() },
    }),
  ]);

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

function startScheduler() {
  // Every 5 minutes. Fine-grained enough for reasonable delivery timing
  // without hammering the DB or Gmail API.
  cron.schedule("*/5 * * * *", () => {
    processDueEnrollments().catch((err) => console.error("Scheduler tick failed:", err));
  });
  console.log("Sequence scheduler started (every 5 minutes).");
}

module.exports = { startScheduler, processDueEnrollments };
