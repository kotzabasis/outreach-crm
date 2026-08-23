const express = require("express");
const { v4: uuid } = require("uuid");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const { attachmentsSchema } = require("../lib/attachments");
const { sendTrackedEmail } = require("../lib/gmailClient");

const router = express.Router();
router.use(requireAuth);

// Combinable gating conditions — see SequenceStep.conditions in schema.prisma
// and lib/scheduler.js stepConditionsMet() for how they're evaluated.
const conditionsSchema = z
  .object({
    requireEvent: z.enum(["opened", "clicked", "not_opened", "not_clicked"]).optional().nullable(),
    requireTags: z.array(z.string()).max(20).optional().default([]),
  })
  .optional()
  .default({});

// A step is either written inline (subject+body) or created from a saved
// template (templateId) — the template's subject/body are copied in at
// creation time, not linked live, so editing the template later never
// changes steps that already exist (important once contacts are enrolled).
// A/B subject variants: up to 4 extra subject lines tested against the primary
// `subject`. Trimmed, empties dropped — so a blank variant input never becomes
// a real (empty) subject line in the random pool.
const subjectVariantsSchema = z
  .array(z.string().max(300))
  .max(4)
  .optional()
  .default([])
  .transform((arr) => arr.map((s) => s.trim()).filter(Boolean));

const stepSchema = z
  .object({
    // Per-step channel. Optional so single-channel sequences can omit it (the
    // step then inherits the sequence's channel); required-in-effect for
    // "multichannel" sequences, where each step must declare its own.
    channel: z.enum(["email", "linkedin", "linkedin_inmail"]).optional(),
    templateId: z.string().uuid().optional(),
    subject: z.string().min(1).max(300).optional(),
    subjectVariants: subjectVariantsSchema,
    body: z.string().min(1).max(20000).optional(),
    delayDays: z.number().int().min(0).max(60),
    conditions: conditionsSchema,
    attachments: attachmentsSchema,
  })
  // Inline steps need a body; subject requirements depend on the resolved
  // channel and are enforced in the create handler once we know it. LinkedIn
  // message steps are body-only.
  .refine((s) => s.templateId || s.body, {
    message: "Provide either templateId or a body",
  });

const sequenceSchema = z.object({
  name: z.string().min(1).max(200),
  channel: z.enum(["email", "linkedin", "linkedin_inmail", "multichannel"]).optional().default("email"),
  // LinkedIn only: connection-request note for not-yet-connected contacts.
  linkedinConnectionNote: z.string().max(300).optional().default(""),
  steps: z.array(stepSchema).min(1).max(20),
});

// The concrete channel a step will run on: its own if set (required for
// multichannel), otherwise the sequence's. Single-channel sequences leave
// step.channel unset and every step inherits the one value.
function stepChannel(step, sequenceChannel) {
  if (step.channel) return step.channel;
  return sequenceChannel === "multichannel" ? "email" : sequenceChannel;
}

// Resolves each step to concrete {subject, body, delayDays, sourceTemplateId,
// conditions, attachments} fields, fetching template content where needed.
// Throws if a templateId doesn't belong to this user (caller should catch
// and 400).
async function resolveSteps(steps, companyId, sequenceChannel = "email") {
  const resolved = [];
  for (const step of steps) {
    const channel = stepChannel(step, sequenceChannel);
    if (step.templateId) {
      const template = await prisma.template.findFirst({ where: { id: step.templateId, companyId } });
      if (!template) throw new Error(`template_not_found:${step.templateId}`);
      resolved.push({
        channel,
        subject: template.subject,
        subjectVariants: step.subjectVariants || [],
        body: template.body,
        delayDays: step.delayDays,
        sourceTemplateId: template.id,
        conditions: step.conditions,
        attachments: template.attachments,
      });
    } else {
      resolved.push({
        channel,
        subject: step.subject || "", // "" for LinkedIn message steps (no subject)
        subjectVariants: step.subjectVariants || [],
        body: step.body,
        delayDays: step.delayDays,
        sourceTemplateId: null,
        conditions: step.conditions,
        attachments: step.attachments,
      });
    }
  }
  return resolved;
}

router.get("/", async (req, res) => {
  const sequences = await prisma.sequence.findMany({
    where: { companyId: req.user.companyId },
    include: { steps: { orderBy: { order: "asc" } }, _count: { select: { enrollments: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(sequences);
});

router.post("/", async (req, res) => {
  const parsed = sequenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { channel, linkedinConnectionNote } = parsed.data;

  // Validate each step against the channel it will actually run on. Works for
  // both single-channel sequences (every step inherits `channel`) and
  // multichannel ones (each step declares its own).
  //   - email          → inline steps need a subject
  //   - linkedin_inmail → need subject AND body (InMail carries a subject line)
  //   - linkedin        → message only (body), no subject required
  for (const s of parsed.data.steps) {
    const ch = stepChannel(s, channel);
    if (ch === "email" && !s.templateId && !s.subject) {
      return res.status(400).json({ error: "email_steps_need_subject" });
    }
    if (ch === "linkedin_inmail" && (!s.subject || !s.body)) {
      return res.status(400).json({ error: "inmail_steps_need_subject_and_body" });
    }
  }

  let resolvedSteps;
  try {
    resolvedSteps = await resolveSteps(parsed.data.steps, req.user.companyId, channel);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const sequence = await prisma.sequence.create({
    data: {
      userId: req.user.id,
      companyId: req.user.companyId,
      name: parsed.data.name,
      channel,
      // The connection-request note is used whenever a LinkedIn *message* step
      // needs the contact connected first — so keep it for pure-LinkedIn and
      // multichannel sequences alike (email/InMail-only sequences ignore it).
      linkedinConnectionNote:
        channel === "linkedin" || channel === "multichannel" ? linkedinConnectionNote || "" : "",
      steps: {
        create: resolvedSteps.map((s, i) => ({ ...s, order: i })),
      },
    },
    include: { steps: true },
  });
  res.status(201).json(sequence);
});

router.patch("/:id", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!sequence) return res.status(404).json({ error: "not_found" });

  const data = {};
  if (typeof req.body.name === "string") data.name = req.body.name;
  if (typeof req.body.active === "boolean") data.active = req.body.active;

  const updated = await prisma.sequence.update({ where: { id: sequence.id }, data });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  await prisma.sequence.delete({ where: { id: sequence.id } });
  res.json({ ok: true });
});

// Add one step to an existing sequence (from a template or written inline).
router.post("/:id/steps", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: req.params.id, companyId: req.user.companyId },
    include: { steps: true },
  });
  if (!sequence) return res.status(404).json({ error: "not_found" });

  const parsed = stepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ch = stepChannel(parsed.data, sequence.channel);
  if (ch === "email" && !parsed.data.templateId && !parsed.data.subject) {
    return res.status(400).json({ error: "email_steps_need_subject" });
  }
  if (ch === "linkedin_inmail" && (!parsed.data.subject || !parsed.data.body)) {
    return res.status(400).json({ error: "inmail_steps_need_subject_and_body" });
  }

  let resolved;
  try {
    [resolved] = await resolveSteps([parsed.data], req.user.companyId, sequence.channel);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const step = await prisma.sequenceStep.create({
    data: { ...resolved, sequenceId: sequence.id, order: sequence.steps.length },
  });
  res.status(201).json(step);
});

router.delete("/:id/steps/:stepId", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  const step = await prisma.sequenceStep.findFirst({ where: { id: req.params.stepId, sequenceId: sequence.id } });
  if (!step) return res.status(404).json({ error: "not_found" });
  await prisma.sequenceStep.delete({ where: { id: step.id } });
  res.json({ ok: true });
});

// Edit an existing step's copy/timing in place (doesn't touch already-sent
// EmailLogs — those keep whatever was sent, which is correct history).
router.patch("/:id/steps/:stepId", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  const step = await prisma.sequenceStep.findFirst({ where: { id: req.params.stepId, sequenceId: sequence.id } });
  if (!step) return res.status(404).json({ error: "not_found" });

  const parsed = z
    .object({
      subject: z.string().min(1).max(300).optional(),
      subjectVariants: subjectVariantsSchema.optional(),
      body: z.string().min(1).max(20000).optional(),
      delayDays: z.number().int().min(0).max(60).optional(),
      conditions: conditionsSchema.optional(),
      attachments: attachmentsSchema.optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await prisma.sequenceStep.update({ where: { id: step.id }, data: parsed.data });
  res.json(updated);
});

// Sends the step's current subject/body to a test address (default: the
// user's own connected Gmail) against a fake sample contact, so merge tags
// render but nothing real gets touched — no EmailLog/enrollment created, so
// this never shows up in analytics or the recipient's real send history.
router.post("/:id/steps/:stepId/test-send", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  const step = await prisma.sequenceStep.findFirst({ where: { id: req.params.stepId, sequenceId: sequence.id } });
  if (!step) return res.status(404).json({ error: "not_found" });

  // Doesn't count against the daily cap or the round-robin cursor (no
  // EmailLog created either — see comment above), so just grab any healthy
  // connected mailbox rather than going through pickSendableMailbox's
  // cap-aware rotation.
  const gmailAccounts = await prisma.gmailAccount.findMany({ where: { companyId: req.user.companyId }, orderBy: { createdAt: "asc" } });
  if (gmailAccounts.length === 0) return res.status(400).json({ error: "gmail_not_connected" });
  const gmailAccount = gmailAccounts.find((g) => !g.needsReconnect) || gmailAccounts[0];

  const emailParsed = z.string().email().safeParse((req.body.testEmail || gmailAccount.email || "").trim());
  if (!emailParsed.success) return res.status(400).json({ error: "invalid_test_email" });

  const sampleContact = { name: "Δοκιμαστική Επαφή", company: "Η Εταιρεία Σου", email: emailParsed.data };
  const trackingId = uuid();

  // Optionally test a specific A/B subject variant instead of the primary —
  // the frontend passes the chosen line. Falls back to the step's primary
  // subject. Length-capped like any subject.
  const subjectToTest =
    typeof req.body.subject === "string" && req.body.subject.trim()
      ? req.body.subject.trim().slice(0, 300)
      : step.subject;

  const trackingCompany = await prisma.company.findUnique({
    where: { id: req.user.companyId },
    select: { emailTrackingEnabled: true, unsubscribeEnabled: true },
  });
  try {
    await sendTrackedEmail({
      gmailAccount,
      contact: sampleContact,
      subject: `[TEST] ${subjectToTest}`,
      body: step.body,
      trackingId,
      attachments: Array.isArray(step.attachments) ? step.attachments : [],
      trackingEnabled: trackingCompany?.emailTrackingEnabled !== false,
      unsubscribeEnabled: trackingCompany?.unsubscribeEnabled !== false,
    });
  } catch (err) {
    console.error("Test send failed:", err.message);
    return res.status(502).json({ error: "send_failed" });
  }

  res.json({ ok: true, sentTo: emailParsed.data });
});

// Reorder steps — the body must list exactly the sequence's current step ids,
// in the desired new order. Used by the up/down controls in the sequence
// editor so best-practice cadence tweaks don't require delete+recreate.
router.post("/:id/steps/reorder", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: req.params.id, companyId: req.user.companyId },
    include: { steps: true },
  });
  if (!sequence) return res.status(404).json({ error: "not_found" });

  const stepIds = Array.isArray(req.body.stepIds) ? req.body.stepIds : [];
  const validIds = new Set(sequence.steps.map((s) => s.id));
  const sameSet = stepIds.length === sequence.steps.length && stepIds.every((id) => validIds.has(id));
  if (!sameSet) {
    return res.status(400).json({ error: "stepIds_must_match_existing_steps" });
  }

  await prisma.$transaction(stepIds.map((id, i) => prisma.sequenceStep.update({ where: { id }, data: { order: i } })));

  const updated = await prisma.sequence.findFirst({
    where: { id: sequence.id },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  res.json(updated);
});

// Enroll one or more contacts. Each contact starts at step 0, sent ~immediately
// (staggered by a few seconds so the scheduler doesn't fire 500 sends at once).
router.post("/:id/enroll", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: req.params.id, companyId: req.user.companyId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  if (sequence.steps.length === 0) return res.status(400).json({ error: "sequence_has_no_steps" });

  const contactIds = Array.isArray(req.body.contactIds) ? req.body.contactIds : [];
  if (contactIds.length === 0) return res.status(400).json({ error: "no_contacts_provided" });
  if (contactIds.length > 500) return res.status(400).json({ error: "max_500_contacts_per_enroll" });

  const contacts = await prisma.contact.findMany({
    where: {
      id: { in: contactIds },
      companyId: req.user.companyId,
      unsubscribed: false,
      // LinkedIn sequences can only run against contacts that have a LinkedIn
      // profile URL to resolve — silently skip the rest (reported back).
      ...(sequence.channel === "linkedin" || sequence.channel === "linkedin_inmail"
        ? { NOT: { linkedinProfileUrl: "" }, linkedinProfileUrl: { not: null } }
        : {}),
    },
  });

  const now = Date.now();
  const created = await prisma.$transaction(
    contacts.map((contact, i) =>
      prisma.enrollment.create({
        data: {
          contactId: contact.id,
          sequenceId: sequence.id,
          currentStep: 0,
          status: "active",
          nextSendAt: new Date(now + i * 3000), // small stagger
        },
      })
    )
  );

  res.status(201).json({
    enrolled: created.length,
    skipped: contactIds.length - contacts.length,
    channel: sequence.channel,
  });
});

module.exports = router;
