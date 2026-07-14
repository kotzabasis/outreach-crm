const { v4: uuid } = require("uuid");
const prisma = require("../db");
const { sendTrackedEmail } = require("./gmailClient");
const { DAILY_CAP, resetDailyCounterIfNeeded } = require("./emailCap");

async function processDueEnrollments() {
  const due = await prisma.enrollment.findMany({
    where: {
      status: "active",
      nextSendAt: { lte: new Date() },
      // Suspending a company (platform admin action) is meant to stop
      // everything for that company, not just interactive logins — without
      // this, a suspended company's already-running sequences kept quietly
      // sending emails through its Gmail connection in the background,
      // which defeats the point of suspending it. companyId: null is the
      // pre-migration legacy-data edge case (see ensureCompanyAssignment in
      // server.js) — never actually suspended, so it's let through as-is.
      sequence: { OR: [{ companyId: null }, { company: { status: "active" } }] },
    },
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

  return due.length > 0; // tells the caller whether this tick found anything to do — drives backoff
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

  let gmailAccount = await prisma.gmailAccount.findUnique({ where: { companyId: sequence.companyId } });
  if (!gmailAccount) {
    // Nobody on this company has connected Gmail yet — leave the enrollment
    // due as-is rather than failing it; it'll send as soon as someone connects.
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
        companyId: sequence.companyId,
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
  // Same reasoning as processDueEnrollments above — a suspended company's
  // running campaigns must stop actually sending, not just be unreachable
  // to its (locked-out) users.
  const campaigns = await prisma.campaign.findMany({
    where: { status: "running", OR: [{ companyId: null }, { company: { status: "active" } }] },
  });
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

  let gmailAccount = await prisma.gmailAccount.findUnique({ where: { companyId: campaign.companyId } });
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
        companyId: campaign.companyId,
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

// Both loops below are self-rescheduling via setTimeout rather than fixed
// node-cron intervals, so they can back off when there's nothing to do.
// Previously the campaign tick queried the DB every single minute forever,
// active or not — on a mostly-idle single-user CRM that's the thing that
// kept Neon's compute from ever hitting its 5-minute autosuspend, burning
// CU-hours for no reason. Now: while any enrollment/campaign is actually
// active, the tick stays at its normal fast interval (send timing/spacing is
// unaffected); once nothing is active, the interval doubles up to a capped
// ceiling, and resets to the fast interval the moment something becomes
// active again. The "is anything active" check is a cheap indexed count(),
// independent of the (potentially heavier) due-work query.

const ENROLLMENT_BASE_MS = 5 * 60 * 1000; // 5 min — matches the original fixed cron cadence
const ENROLLMENT_MAX_MS = 30 * 60 * 1000; // cap backoff at 30 min
let enrollmentIntervalMs = ENROLLMENT_BASE_MS;

async function enrollmentTick() {
  try {
    await processDueEnrollments();
  } catch (err) {
    console.error("Scheduler tick failed:", err.message);
  }
  try {
    const activeCount = await prisma.enrollment.count({ where: { status: "active" } });
    enrollmentIntervalMs = activeCount > 0 ? ENROLLMENT_BASE_MS : Math.min(enrollmentIntervalMs * 2, ENROLLMENT_MAX_MS);
  } catch (err) {
    console.error("Scheduler backoff check failed, resetting to base interval:", err.message);
    enrollmentIntervalMs = ENROLLMENT_BASE_MS; // fail safe — never get stuck backed off because of a transient DB error
  }
  setTimeout(enrollmentTick, enrollmentIntervalMs);
}

const CAMPAIGN_BASE_MS = 60 * 1000; // 1 min — campaign spacing is configured in minutes, needs at least this fine a tick
const CAMPAIGN_MAX_MS = 15 * 60 * 1000; // cap backoff at 15 min
let campaignIntervalMs = CAMPAIGN_BASE_MS;

async function campaignTick() {
  try {
    await processDueCampaigns();
  } catch (err) {
    console.error("Campaign scheduler tick failed:", err.message);
  }
  try {
    const runningCount = await prisma.campaign.count({ where: { status: "running" } });
    campaignIntervalMs = runningCount > 0 ? CAMPAIGN_BASE_MS : Math.min(campaignIntervalMs * 2, CAMPAIGN_MAX_MS);
  } catch (err) {
    console.error("Campaign backoff check failed, resetting to base interval:", err.message);
    campaignIntervalMs = CAMPAIGN_BASE_MS;
  }
  setTimeout(campaignTick, campaignIntervalMs);
}

function startScheduler() {
  enrollmentTick();
  console.log(`Sequence scheduler started (every ${ENROLLMENT_BASE_MS / 60000} min, backs off to ${ENROLLMENT_MAX_MS / 60000} min when idle).`);

  campaignTick();
  console.log(`Campaign scheduler started (every ${CAMPAIGN_BASE_MS / 60000} min, backs off to ${CAMPAIGN_MAX_MS / 60000} min when idle).`);
}

module.exports = { startScheduler, processDueEnrollments, processDueCampaigns };
