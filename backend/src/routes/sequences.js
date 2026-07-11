const express = require("express");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

// A step is either written inline (subject+body) or created from a saved
// template (templateId) — the template's subject/body are copied in at
// creation time, not linked live, so editing the template later never
// changes steps that already exist (important once contacts are enrolled).
const stepSchema = z
  .object({
    templateId: z.string().uuid().optional(),
    subject: z.string().min(1).max(300).optional(),
    body: z.string().min(1).max(20000).optional(),
    delayDays: z.number().int().min(0).max(60),
  })
  .refine((s) => s.templateId || (s.subject && s.body), {
    message: "Provide either templateId or both subject and body",
  });

const sequenceSchema = z.object({
  name: z.string().min(1).max(200),
  steps: z.array(stepSchema).min(1).max(20),
});

// Resolves each step to concrete {subject, body, delayDays, sourceTemplateId}
// fields, fetching template content where needed. Throws if a templateId
// doesn't belong to this user (caller should catch and 400).
async function resolveSteps(steps, userId) {
  const resolved = [];
  for (const step of steps) {
    if (step.templateId) {
      const template = await prisma.template.findFirst({ where: { id: step.templateId, userId } });
      if (!template) throw new Error(`template_not_found:${step.templateId}`);
      resolved.push({
        subject: template.subject,
        body: template.body,
        delayDays: step.delayDays,
        sourceTemplateId: template.id,
      });
    } else {
      resolved.push({ subject: step.subject, body: step.body, delayDays: step.delayDays, sourceTemplateId: null });
    }
  }
  return resolved;
}

router.get("/", async (req, res) => {
  const sequences = await prisma.sequence.findMany({
    where: { userId: req.user.id },
    include: { steps: { orderBy: { order: "asc" } }, _count: { select: { enrollments: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(sequences);
});

router.post("/", async (req, res) => {
  const parsed = sequenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let resolvedSteps;
  try {
    resolvedSteps = await resolveSteps(parsed.data.steps, req.user.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const sequence = await prisma.sequence.create({
    data: {
      userId: req.user.id,
      name: parsed.data.name,
      steps: {
        create: resolvedSteps.map((s, i) => ({ ...s, order: i })),
      },
    },
    include: { steps: true },
  });
  res.status(201).json(sequence);
});

router.patch("/:id", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!sequence) return res.status(404).json({ error: "not_found" });

  const data = {};
  if (typeof req.body.name === "string") data.name = req.body.name;
  if (typeof req.body.active === "boolean") data.active = req.body.active;

  const updated = await prisma.sequence.update({ where: { id: sequence.id }, data });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  await prisma.sequence.delete({ where: { id: sequence.id } });
  res.json({ ok: true });
});

// Add one step to an existing sequence (from a template or written inline).
router.post("/:id/steps", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { steps: true },
  });
  if (!sequence) return res.status(404).json({ error: "not_found" });

  const parsed = stepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let resolved;
  try {
    [resolved] = await resolveSteps([parsed.data], req.user.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const step = await prisma.sequenceStep.create({
    data: { ...resolved, sequenceId: sequence.id, order: sequence.steps.length },
  });
  res.status(201).json(step);
});

router.delete("/:id/steps/:stepId", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  const step = await prisma.sequenceStep.findFirst({ where: { id: req.params.stepId, sequenceId: sequence.id } });
  if (!step) return res.status(404).json({ error: "not_found" });
  await prisma.sequenceStep.delete({ where: { id: step.id } });
  res.json({ ok: true });
});

// Edit an existing step's copy/timing in place (doesn't touch already-sent
// EmailLogs — those keep whatever was sent, which is correct history).
router.patch("/:id/steps/:stepId", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  const step = await prisma.sequenceStep.findFirst({ where: { id: req.params.stepId, sequenceId: sequence.id } });
  if (!step) return res.status(404).json({ error: "not_found" });

  const parsed = z
    .object({
      subject: z.string().min(1).max(300).optional(),
      body: z.string().min(1).max(20000).optional(),
      delayDays: z.number().int().min(0).max(60).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await prisma.sequenceStep.update({ where: { id: step.id }, data: parsed.data });
  res.json(updated);
});

// Reorder steps — the body must list exactly the sequence's current step ids,
// in the desired new order. Used by the up/down controls in the sequence
// editor so best-practice cadence tweaks don't require delete+recreate.
router.post("/:id/steps/reorder", async (req, res) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: req.params.id, userId: req.user.id },
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
    where: { id: req.params.id, userId: req.user.id },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!sequence) return res.status(404).json({ error: "not_found" });
  if (sequence.steps.length === 0) return res.status(400).json({ error: "sequence_has_no_steps" });

  const contactIds = Array.isArray(req.body.contactIds) ? req.body.contactIds : [];
  if (contactIds.length === 0) return res.status(400).json({ error: "no_contacts_provided" });
  if (contactIds.length > 500) return res.status(400).json({ error: "max_500_contacts_per_enroll" });

  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds }, userId: req.user.id, unsubscribed: false },
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

  res.status(201).json({ enrolled: created.length, skippedUnsubscribed: contactIds.length - contacts.length });
});

module.exports = router;
