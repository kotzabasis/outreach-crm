const express = require("express");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

const templateSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
});

router.get("/", async (req, res) => {
  const templates = await prisma.template.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: "desc" },
  });

  // sourceTemplateId is an informational string field (not a Prisma relation,
  // by design — see schema.prisma), so usage is counted with a groupBy rather
  // than an include. Lets the UI show "used in N sequence steps" per template.
  const counts = await prisma.sequenceStep.groupBy({
    by: ["sourceTemplateId"],
    where: { sourceTemplateId: { in: templates.map((t) => t.id) } },
    _count: { _all: true },
  });
  const countById = Object.fromEntries(counts.map((c) => [c.sourceTemplateId, c._count._all]));

  res.json(templates.map((t) => ({ ...t, usageCount: countById[t.id] || 0 })));
});

router.get("/:id", async (req, res) => {
  const template = await prisma.template.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!template) return res.status(404).json({ error: "not_found" });
  res.json(template);
});

router.post("/", async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const template = await prisma.template.create({ data: { ...parsed.data, userId: req.user.id } });
  res.status(201).json(template);
});

router.patch("/:id", async (req, res) => {
  const template = await prisma.template.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!template) return res.status(404).json({ error: "not_found" });

  const parsed = templateSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await prisma.template.update({ where: { id: template.id }, data: parsed.data });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const template = await prisma.template.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!template) return res.status(404).json({ error: "not_found" });
  await prisma.template.delete({ where: { id: template.id } });
  res.json({ ok: true });
});

module.exports = router;
