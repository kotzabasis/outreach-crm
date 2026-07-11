const express = require("express");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["draft", "sent", "accepted", "declined"];

const offerSchema = z.object({
  contactId: z.string().uuid(),
  title: z.string().min(1).max(200),
  value: z.number().nonnegative().max(100000000).optional().nullable(),
  currency: z.string().max(10).optional().default("EUR"),
  status: z.enum(STATUSES).optional().default("draft"),
  notes: z.string().max(5000).optional().nullable(),
  // Freeform "why" behind an accepted/declined outcome — feeds the CRM
  // business reporting breakdown, not just email open/click metrics.
  outcomeReason: z.string().max(500).optional().nullable(),
});

router.get("/", async (req, res) => {
  const offers = await prisma.offer.findMany({
    where: { userId: req.user.id },
    include: { contact: { select: { id: true, name: true, email: true } } },
    orderBy: { updatedAt: "desc" },
  });
  res.json(offers);
});

router.post("/", async (req, res) => {
  const parsed = offerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const contact = await prisma.contact.findFirst({ where: { id: parsed.data.contactId, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "contact_not_found" });

  const offer = await prisma.offer.create({
    data: { ...parsed.data, userId: req.user.id },
    include: { contact: { select: { id: true, name: true, email: true } } },
  });
  res.status(201).json(offer);
});

router.patch("/:id", async (req, res) => {
  const offer = await prisma.offer.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!offer) return res.status(404).json({ error: "not_found" });

  const parsed = offerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await prisma.offer.update({
    where: { id: offer.id },
    data: parsed.data,
    include: { contact: { select: { id: true, name: true, email: true } } },
  });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const offer = await prisma.offer.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!offer) return res.status(404).json({ error: "not_found" });
  await prisma.offer.delete({ where: { id: offer.id } });
  res.json({ ok: true });
});

module.exports = router;
