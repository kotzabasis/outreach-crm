const { v4: uuid } = require("uuid");
const prisma = require("../db");
const { sendTrackedEmail, isAuthError, flagNeedsReconnect } = require("./gmailClient");
const { pickSendableMailbox, mailboxUsedUpdate } = require("./emailCap");
const { weeklyDigestTick } = require("./weeklyDigest");
const { decrypt } = require("./crypto");
const { listLeadFormResponsesSince, flattenLeadFormResponse, isAuthError: isLinkedInAuthError } = require("./linkedinLeads");
const { mapGenericPayload, upsertLeadContact } = require("./leadIntake");
const { logAction } = require("./auditLog");
const { captureException } = require("./sentry");
const { webhookRetryTick } = require("./webhookRetry");
const { withinSendWindow, nextSendWindowOpen } = require("./sendWindow");
const linkedinOutreach = require("./linkedinOutreach");

// How long to wait before re-checking a LinkedIn enrollment that's parked
// waiting for a connection request to be accepted. The accept normally arrives
// sooner via the Unipile webhook (which nudges nextSendAt to now); this is the
// polling floor so nothing gets stuck if a webhook is missed.
const LINKEDIN_ACCEPT_WAIT_MS = Number(process.env.LINKEDIN_ACCEPT_WAIT_MS || 6 * 60 * 60 * 1000);

// The company columns the send-window check needs — kept in one place so both
// the sequence and campaign queries select exactly these.
const SEND_WINDOW_SELECT = {
  sendWindowEnabled: true,
  sendWindowStart: true,
  sendWindowEnd: true,
  sendDays: true,
  sendTimezone: true,
  emailTrackingEnabled: true,
  unsubscribeEnabled: true,
};

// Space real sends apart by a randomized delay instead of firing a whole due
// batch back-to-back. Sending N emails from one mailbox in the same instant is
// a bot signature; a few seconds of human-like jitter between them protects
// deliverability. Applied only between *actual* sequence sends (skips don't
// wait). Campaign sends are already one-per-tick spaced by intervalMinutes, so
// they don't need this.
const SEND_JITTER_MIN_MS = Number(process.env.SEND_JITTER_MIN_MS || 2000);
const SEND_JITTER_MAX_MS = Number(process.env.SEND_JITTER_MAX_MS || 8000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function sendJitterMs() {
  const span = Math.max(0, SEND_JITTER_MAX_MS - SEND_JITTER_MIN_MS);
  return SEND_JITTER_MIN_MS + Math.floor(Math.random() * (span + 1));
}

// A/B subject testing: choose which subject line this particular send uses.
// The pool is the primary `subject` plus any `subjectVariants`; an empty/absent
// variants list just yields the primary. The caller stores the returned line in
// EmailLog.subject so open rates can be attributed per variant (see
// /analytics/ab-tests). Uniform random assignment keeps the split unbiased.
function pickSubject(primary, variants) {
  const extra = Array.isArray(variants) ? variants.filter((v) => typeof v === "string" && v.trim()) : [];
  const pool = [primary, ...extra];
  return pool[Math.floor(Math.random() * pool.length)];
}

// Body A/B counterpart to pickSubject: uniform-random pick from
// [primaryBody, ...bodyVariants]. Returns { body, index } so the chosen index
// can be recorded on EmailLog.bodyVariant for per-variant open-rate analytics.
function pickBody(primary, variants) {
  const extra = Array.isArray(variants) ? variants.filter((v) => typeof v === "string" && v.trim()) : [];
  const pool = [primary, ...extra];
  const index = Math.floor(Math.random() * pool.length);
  return { body: pool[index], index };
}

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
      sequence: {
        include: {
          steps: { orderBy: { order: "asc" } },
          company: { select: SEND_WINDOW_SELECT },
        },
      },
    },
    take: 100, // bounded batch per tick — avoids one huge run hammering the Gmail API
  });

  for (const enrollment of due) {
    try {
      const sent = await sendNextStep(enrollment);
      // Only wait between genuine sends — a skip (unsubscribed, condition
      // unmet, no sendable mailbox) shouldn't burn jitter time.
      if (sent) await sleep(sendJitterMs());
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

// Returns true if an email was actually sent, false for any no-op/skip — the
// caller uses this to decide whether to apply inter-send jitter.
async function sendNextStep(enrollment) {
  const { contact, sequence } = enrollment;

  if (contact.unsubscribed) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "paused" } });
    return false;
  }

  const step = sequence.steps[enrollment.currentStep];
  if (!step) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "completed" } });
    return false;
  }

  // Dispatch on the CURRENT step's channel, not the sequence's — this is what
  // makes a "multichannel" sequence work (each step can send on a different
  // channel). Single-channel sequences leave step.channel = "email" default and
  // the sequence's channel decides; multichannel steps each carry their own.
  const channel = step.channel || (sequence.channel === "multichannel" ? "email" : sequence.channel);
  if (channel === "linkedin") {
    return sendNextLinkedinStep(enrollment);
  }
  if (channel === "linkedin_inmail") {
    return sendNextInmailStep(enrollment);
  }

  if (!(await stepConditionsMet(step, enrollment, contact))) {
    // Condition (event/tag) not satisfied — skip this step immediately and
    // re-evaluate the next one on the next tick, rather than retrying this
    // one forever.
    await advanceEnrollment(enrollment, sequence);
    return false;
  }

  // Respect the company's send window: if we're outside allowed hours/days,
  // push this step to the next open time and leave it — it sends unchanged
  // when the window opens, rather than going out at, say, 3am. Deferring
  // (vs. just skipping the tick) also lets the scheduler's idle backoff kick
  // in overnight instead of re-checking every 5 minutes.
  if (!withinSendWindow(sequence.company, new Date(), contact.timezone)) {
    await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { nextSendAt: nextSendWindowOpen(sequence.company, new Date(), contact.timezone) },
    });
    return false;
  }

  // Picks whichever of this company's connected mailboxes is sendable right
  // now (healthy + under today's cap), rotating across the pool — see
  // lib/emailCap.js#pickSendableMailbox. Returns null for every reason a
  // single mailbox used to fail this check (none connected, all broken, all
  // capped) — same "leave it due, retry next tick" handling either way.
  const gmailAccount = await pickSendableMailbox(sequence.companyId);
  if (!gmailAccount) return false;

  // A/B: pick the subject line AND the body variant for this send; the exact
  // subject/body chosen is what's sent and logged, so per-variant open rates
  // line up.
  const chosenSubject = pickSubject(step.subject, step.subjectVariants);
  const { body: chosenBody, index: chosenBodyVariant } = pickBody(step.body, step.bodyVariants);
  const trackingId = uuid();

  // Claim before the Gmail call: advance the enrollment NOW, so that if the
  // process crashes between the send succeeding and the DB write below, the
  // next tick can't re-select this same step and send a duplicate. Deliberately
  // at-most-once — a rare transient failure after this point skips the step
  // rather than risking a second copy in the recipient's inbox, which is far
  // worse for a cold-outreach sender's reputation than an occasional miss.
  await advanceEnrollment(enrollment, sequence);

  let gmailMessageId;
  try {
    gmailMessageId = await sendTrackedEmail({
      gmailAccount,
      contact,
      subject: chosenSubject,
      body: chosenBody,
      trackingId,
      attachments: Array.isArray(step.attachments) ? step.attachments : [],
      trackingEnabled: sequence.company?.emailTrackingEnabled !== false,
      unsubscribeEnabled: sequence.company?.unsubscribeEnabled !== false,
    });
  } catch (err) {
    if (isAuthError(err)) await flagNeedsReconnect(gmailAccount.id);
    captureException(err, { scope: "scheduler.sendNextStep", enrollmentId: enrollment.id });
    throw err;
  }

  // Only a confirmed send gets an EmailLog — keeps "sent" analytics honest.
  await prisma.$transaction([
    prisma.emailLog.create({
      data: {
        enrollmentId: enrollment.id,
        stepId: step.id,
        contactId: contact.id,
        userId: sequence.userId,
        companyId: sequence.companyId,
        subject: chosenSubject,
        bodyVariant: chosenBodyVariant,
        source: "sequence",
        gmailMessageId,
        trackingId,
      },
    }),
    mailboxUsedUpdate(gmailAccount.id),
    prisma.contact.update({
      where: { id: contact.id },
      data: { status: contact.status === "new" ? "contacted" : contact.status, lastActivityAt: new Date() },
    }),
  ]);

  return true;
}

// LinkedIn channel: reuses the enrollment/step/nextSendAt machinery but sends
// via Unipile. Flow:
//   - contact not connected + not yet invited  -> send connection request
//     (sequence.linkedinConnectionNote), then park waiting for accept
//   - invited, still pending                   -> keep waiting (re-check later;
//     the accept event nudges nextSendAt to now)
//   - connected/accepted                       -> send the current step as a
//     direct message, then advance like an email step
// Rate limits are the DB-backed per-account daily caps in linkedinOutreach.
async function sendNextLinkedinStep(enrollment) {
  const { contact, sequence } = enrollment;

  if (contact.unsubscribed) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "paused" } });
    return false;
  }

  // Multichannel: a contact with no LinkedIn URL can't receive this step, but
  // the sequence's other (e.g. email) steps still should — so SKIP this one and
  // move on, rather than pausing the whole enrollment. Pure-LinkedIn sequences
  // never reach here for such contacts (the enroll filter excludes them).
  if (sequence.channel === "multichannel" && !contact.linkedinProfileUrl) {
    await advanceEnrollment(enrollment, sequence);
    return false;
  }

  const account = await linkedinOutreach.getSendableAccount(sequence.companyId);
  if (!account) return false; // not connected / paused / bad status — leave due, retry next tick

  // Same business-hours window as email, evaluated in the contact's timezone.
  if (!withinSendWindow(sequence.company, new Date(), contact.timezone)) {
    await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { nextSendAt: nextSendWindowOpen(sequence.company, new Date(), contact.timezone) },
    });
    return false;
  }

  const connected = ["connected", "accepted"].includes(contact.linkedinConnectionStatus);

  if (!connected) {
    if (contact.linkedinConnectionStatus === "pending") {
      // Invited, waiting for the accept event — park and re-check later.
      await prisma.enrollment.update({
        where: { id: enrollment.id },
        data: { nextSendAt: new Date(Date.now() + LINKEDIN_ACCEPT_WAIT_MS) },
      });
      return false;
    }
    if (!linkedinOutreach.canSendConnection(account)) return false; // daily cap — retry next tick
    try {
      const r = await linkedinOutreach.sendConnectionRequest({
        account, contact, note: sequence.linkedinConnectionNote,
        enrollmentId: enrollment.id,
        // Attribute the invite to the current LinkedIn step (in a multichannel
        // sequence that may not be step 0), falling back to the first step.
        stepId: sequence.steps[enrollment.currentStep]?.id || sequence.steps[0]?.id || null,
      });
      if (r.skipped && r.reason === "already_connected") {
        // Turned out to be a 1st-degree connection — go straight to messaging.
        await prisma.enrollment.update({ where: { id: enrollment.id }, data: { nextSendAt: new Date() } });
        return false;
      }
    } catch (err) {
      if (err.message === "contact_has_no_linkedin_url" || err.message === "could_not_resolve_profile") {
        await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "paused" } });
        return false;
      }
      captureException(err, { scope: "scheduler.linkedinConnect", enrollmentId: enrollment.id });
      throw err;
    }
    // Sent the invite — now wait for accept.
    await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { nextSendAt: new Date(Date.now() + LINKEDIN_ACCEPT_WAIT_MS) },
    });
    return true;
  }

  // Connected → send the current step as a direct message.
  const step = sequence.steps[enrollment.currentStep];
  if (!step) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "completed" } });
    return false;
  }
  if (!linkedinOutreach.canSendMessage(account)) return false; // daily message cap — retry next tick
  try {
    await linkedinOutreach.sendLinkedinMessage({
      account, contact, text: step.body, enrollmentId: enrollment.id, stepId: step.id,
    });
  } catch (err) {
    captureException(err, { scope: "scheduler.linkedinMessage", enrollmentId: enrollment.id });
    throw err;
  }
  await advanceEnrollment(enrollment, sequence);
  return true;
}

// InMail sequence: no connection prerequisite (InMail reaches non-connections),
// so each step just sends an InMail with the step's subject + body, then
// advances like an email step. Gated by the send window and the separate InMail
// daily cap.
async function sendNextInmailStep(enrollment) {
  const { contact, sequence } = enrollment;

  if (contact.unsubscribed) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "paused" } });
    return false;
  }

  // Multichannel: skip (don't pause) InMail steps for contacts with no LinkedIn
  // URL — see the matching note in sendNextLinkedinStep.
  if (sequence.channel === "multichannel" && !contact.linkedinProfileUrl) {
    await advanceEnrollment(enrollment, sequence);
    return false;
  }

  const account = await linkedinOutreach.getSendableAccount(sequence.companyId);
  if (!account) return false; // not connected / paused — leave due, retry next tick

  if (!withinSendWindow(sequence.company, new Date(), contact.timezone)) {
    await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { nextSendAt: nextSendWindowOpen(sequence.company, new Date(), contact.timezone) },
    });
    return false;
  }

  const step = sequence.steps[enrollment.currentStep];
  if (!step) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "completed" } });
    return false;
  }
  if (!linkedinOutreach.canSendInmail(account)) return false; // daily inmail cap — retry next tick

  try {
    await linkedinOutreach.sendInmailMessage({
      account, contact, subject: step.subject, text: step.body, enrollmentId: enrollment.id, stepId: step.id,
    });
  } catch (err) {
    if (err.message === "contact_has_no_linkedin_url" || err.message === "could_not_resolve_profile") {
      await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "paused" } });
      return false;
    }
    captureException(err, { scope: "scheduler.linkedinInmail", enrollmentId: enrollment.id });
    throw err;
  }
  await advanceEnrollment(enrollment, sequence);
  return true;
}

// Housekeeping tick for the LinkedIn module: rolls the per-account daily
// counters over. (Accept/reply state changes come in via the Unipile webhook;
// this is just the counter reset so the caps stay accurate over days.)
async function linkedinOutreachTick() {
  try {
    const accounts = await prisma.linkedInOutreachAccount.findMany();
    for (const acc of accounts) {
      await linkedinOutreach.resetCountersIfNeeded(acc).catch(() => {});
    }
  } catch (err) {
    console.error("LinkedIn outreach tick failed:", err.message);
    captureException(err, { scope: "scheduler.linkedinOutreachTick" });
  }
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
    include: { company: { select: SEND_WINDOW_SELECT } },
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

  // Respect the send window, evaluated in THIS recipient's timezone (falling
  // back to the company timezone). Outside it → skip this tick; the recipient
  // stays pending and goes out when the window reopens. Nothing is touched, so
  // spacing/bookkeeping is unaffected. Checked here (not at the top) because a
  // per-contact timezone means the answer can differ recipient to recipient.
  if (!withinSendWindow(campaign.company, new Date(), contact.timezone)) return;

  if (contact.unsubscribed) {
    // Skip immediately, don't touch lastSentAt/spacing for a skip — only a
    // genuine send should eat into the interval budget between real sends.
    await prisma.campaignRecipient.update({
      where: { id: nextRecipient.id },
      data: { status: "skipped", note: "unsubscribed" },
    });
    return;
  }

  const gmailAccount = await pickSendableMailbox(campaign.companyId);
  if (!gmailAccount) return; // no sendable mailbox right now — recipient stays pending, retried next tick

  const chosenSubject = pickSubject(campaign.subject, campaign.subjectVariants);
  const trackingId = uuid();

  // Claim before the Gmail call: mark this recipient sent and advance the
  // campaign's spacing clock now, so a crash between the send and the DB write
  // can't re-pick this recipient and double-send (at-most-once — see
  // sendNextStep). A send failure flips it to "failed" below; either way it's
  // no longer "pending", so it won't be selected again.
  await prisma.$transaction([
    prisma.campaignRecipient.update({ where: { id: nextRecipient.id }, data: { status: "sent", sentAt: new Date() } }),
    prisma.campaign.update({ where: { id: campaign.id }, data: { lastSentAt: new Date() } }),
  ]);

  let gmailMessageId;
  try {
    gmailMessageId = await sendTrackedEmail({
      gmailAccount,
      contact,
      subject: chosenSubject,
      body: campaign.body,
      trackingId,
      attachments: Array.isArray(campaign.attachments) ? campaign.attachments : [],
      trackingEnabled: campaign.company?.emailTrackingEnabled !== false,
      unsubscribeEnabled: campaign.company?.unsubscribeEnabled !== false,
    });
  } catch (err) {
    if (isAuthError(err)) await flagNeedsReconnect(gmailAccount.id);
    captureException(err, { scope: "scheduler.sendNextCampaignRecipient", campaignId: campaign.id });
    await prisma.campaignRecipient
      .update({ where: { id: nextRecipient.id }, data: { status: "failed", note: String(err.message || err).slice(0, 300) } })
      .catch(() => {});
    throw err;
  }

  await prisma.$transaction([
    prisma.emailLog.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        userId: campaign.userId,
        companyId: campaign.companyId,
        subject: chosenSubject,
        source: "campaign",
        gmailMessageId,
        trackingId,
      },
    }),
    mailboxUsedUpdate(gmailAccount.id),
    prisma.contact.update({
      where: { id: contact.id },
      data: { status: contact.status === "new" ? "contacted" : contact.status, lastActivityAt: new Date() },
    }),
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
    captureException(err, { scope: "scheduler.enrollmentTick" });
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
    captureException(err, { scope: "scheduler.campaignTick" });
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

// Backup path alongside the LinkedIn webhook (routes/integrations.js) — a
// missed/failed webhook delivery (server downtime, a bad deploy window,
// LinkedIn's own retry giving up) would otherwise silently lose that lead
// forever. This periodically asks the Lead Sync API for anything new since
// the last successful poll per connection and upserts it the same way the
// webhook does — pure belt-and-suspenders, not the primary path, so a wide
// interval is fine. Falls back to a 24h lookback window the first time a
// connection is ever polled (lastPolledAt is null right after connecting).
const LINKEDIN_RECONCILIATION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function linkedinReconciliationTick() {
  try {
    const connections = await prisma.linkedInLeadConnection.findMany({
      where: { active: true, needsReconnect: false },
    });
    for (const connection of connections) {
      try {
        const accessToken = decrypt(connection.encryptedAccessToken);
        const since = connection.lastPolledAt || new Date(Date.now() - LINKEDIN_RECONCILIATION_LOOKBACK_MS);
        const responses = await listLeadFormResponsesSince(connection.organizationUrn, accessToken, since);

        for (const response of responses) {
          const flat = flattenLeadFormResponse(response);
          const mapped = mapGenericPayload(flat);
          const result = await upsertLeadContact({ companyId: connection.companyId, mapped, sourceTag: "lead:linkedin" });
          if (result.ok) {
            await logAction(
              { user: null },
              "lead.received",
              `Νέο lead από LinkedIn (${connection.organizationName || connection.organizationUrn}) — reconciliation poll: ${result.contact.email}`,
              { companyId: connection.companyId }
            );
          }
        }

        await prisma.linkedInLeadConnection.update({
          where: { id: connection.id },
          data: {
            lastPolledAt: new Date(),
            ...(responses.length > 0 ? { lastReceivedAt: new Date(), receivedCount: { increment: responses.length } } : {}),
          },
        });
      } catch (err) {
        console.error(`LinkedIn reconciliation poll failed for connection ${connection.id}:`, err.message);
        captureException(err, { scope: "scheduler.linkedinReconciliationTick", connectionId: connection.id });
        if (isLinkedInAuthError(err)) {
          await prisma.linkedInLeadConnection.update({ where: { id: connection.id }, data: { needsReconnect: true } });
        }
      }
    }
  } catch (err) {
    console.error("LinkedIn reconciliation tick failed:", err.message);
    captureException(err, { scope: "scheduler.linkedinReconciliationTick" });
  }
}

// Weekly digest doesn't need backoff logic like the two ticks above — it's
// cheap (one query to find due companies, usually zero of them on any given
// check) and its own "due" window is already 7 days wide, so a fixed
// several-hour cadence is simply "check a few times a day, act on whichever
// companies cross the 7-day line since last send." No need for exact cron
// timing (see weeklyDigest.js's getCompaniesDueForDigest comment).
const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours
const LINKEDIN_RECONCILIATION_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const WEBHOOK_RETRY_INTERVAL_MS = 60 * 60 * 1000; // every 1 hour

async function webhookRetryTickWrapper() {
  try {
    await webhookRetryTick();
  } catch (err) {
    console.error("Webhook retry tick failed:", err.message);
    captureException(err, { scope: "scheduler.webhookRetryTick" });
  }
}

function startScheduler() {
  enrollmentTick();
  console.log(`Sequence scheduler started (every ${ENROLLMENT_BASE_MS / 60000} min, backs off to ${ENROLLMENT_MAX_MS / 60000} min when idle).`);

  campaignTick();
  console.log(`Campaign scheduler started (every ${CAMPAIGN_BASE_MS / 60000} min, backs off to ${CAMPAIGN_MAX_MS / 60000} min when idle).`);

  weeklyDigestTick();
  setInterval(weeklyDigestTick, DIGEST_INTERVAL_MS);
  console.log(`Weekly digest checker started (every ${DIGEST_INTERVAL_MS / 3600000} h).`);

  linkedinReconciliationTick();
  setInterval(linkedinReconciliationTick, LINKEDIN_RECONCILIATION_INTERVAL_MS);
  console.log(`LinkedIn lead reconciliation poll started (every ${LINKEDIN_RECONCILIATION_INTERVAL_MS / 60000} min).`);

  webhookRetryTickWrapper();
  setInterval(webhookRetryTickWrapper, WEBHOOK_RETRY_INTERVAL_MS);
  console.log(`Webhook retry processor started (every ${WEBHOOK_RETRY_INTERVAL_MS / 3600000} h).`);

  // LinkedIn outreach daily-counter reset (rate-limit hygiene). Every 30 min.
  linkedinOutreachTick();
  setInterval(linkedinOutreachTick, 30 * 60 * 1000);
  console.log("LinkedIn outreach housekeeping started (every 30 min).");
}

module.exports = { startScheduler, processDueEnrollments, processDueCampaigns };
