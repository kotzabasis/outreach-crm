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

// Sends at most one recipient per running campaign per tick, gated by
// "has intervalMinutes elapsed since this campaign's lastSentAt" — this is
// what makes sends go out spaced one-by-one instead of in one batch. Needs a
// tighter tick than the 5-minute sequence one below (campaign spacing is
// meant to be minutes, not hours/days), so it gets its own faster cron.
async function processDueCampaigns() {
  const campaigns = await prisma.campaign.findMany({ where: { status: "running" } });
  for (const campaign of campaigns) {
    try {
      await sendNextCampaignRecipient(campaign);
    } catch (err) {
      console.error(`Failed to send campaign recipient for campaign ${campaign.id}:`, err.message);
    }
  }
}

async function sendNextCampaignRecipient(campaign) {
  const intervalMs = campaign.intervalMinutes * 60 * 1000;
  if (campaign.lastSentAt && Date.now() - new Date(campaign.lastSentAt).getTime() < intervalMs) {
    return; // not due yet — this is the actual spacing mechanism
  }

  const nextRecipient = await prisma.campaignRecipient.findFirst({
    where: { campaignId: campaign.id, status: "pending" },
    orderBy: { order: "asc" },
    include: { contact: true },
  });

  if (!nextRecipient) {
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "completed", completedAt: new Date() } });
    return;
  }

  const { contact } = nextRecipient;

  if (contact.unsubscribed) {
    // Skip immediately, don't touch lastSentAt/spacing for a skip — only a
    // genuine send should eat into the interval budget between real sends.
    await prisma.campaignRecipient.update({
      where: { id: nextRecipient.id },
      data: { status: "skipped", note: "unsubscribed" },
    });
    return;
  }

  let gmailAccount = await prisma.gmailAccount.findUnique({ where: { userId: campaign.userId } });
  if (!gmailAccount) return; // not connected — recipient stays pending, retried next tick

  gmailAccount = await resetDailyCounterIfNeeded(gmailAccount);
  if (gmailAccount.emailsSentToday >= DAILY_CAP) return; // leave pending, retry once the cap resets

  const trackingId = uuid();
  let gmailMessageId;
  try {
    gmailMessageId = await sendTrackedEmail({
      gmailAccount,
      contact,
      subject: campaign.subject,
      body: campaign.body,
      trackingId,
      attachments: Array.isArray(campaign.attachments) ? campaign.attachments : [],
    });
  } catch (err) {
    await prisma.campaignRecipient.update({
      where: { id: nextRecipient.id },
      data: { status: "failed", note: String(err.message || err).slice(0, 300) },
    });
    throw err;
  }

  await prisma.$transaction([
    prisma.emailLog.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        userId: campaign.userId,
        subject: campaign.subject,
        source: "campaign",
        gmailMessageId,
        trackingId,
      },
    }),
    prisma.gmailAccount.update({ where: { id: gmailAccount.id }, data: { emailsSentToday: { increment: 1 } } }),
    prisma.contact.update({
      where: { id: contact.id },
      data: { status: contact.status === "new" ? "contacted" : contact.status, lastActivityAt: new Date() },
    }),
    prisma.campaignRecipient.update({ where: { id: nextRecipient.id }, data: { status: "sent", sentAt: new Date() } }),
    prisma.campaign.update({ where: { id: campaign.id }, data: { lastSentAt: new Date() } }),
  ]);
}

function startScheduler() {
  // Every 5 minutes. Fine-grained enough for reasonable delivery timing
  // without hammering the DB or Gmail API.
  cron.schedule("*/5 * * * *", () => {
    processDueEnrollments().catch((err) => console.error("Scheduler tick failed:", err));
  });
  console.log("Sequence scheduler started (every 5 minutes).");

  // Every 1 minute — campaign spacing is configured in minutes, so it needs
  // a tick at least that fine-grained to actually feel spaced-out rather
  // than batched.
  cron.schedule("* * * * *", () => {
    processDueCampaigns().catch((err) => console.error("Campaign scheduler tick failed:", err));
  });
  console.log("Campaign scheduler started (every 1 minute).");
}

module.exports = { startScheduler, processDueEnrollments, processDueCampaigns };
