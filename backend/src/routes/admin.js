const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireAdmin = require("../lib/requireAdmin");

const router = express.Router();
router.use(requireAuth, requireAdmin);

const newUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(200).optional(),
  isAdmin: z.boolean().optional().default(false),
});

function publicAdminUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.isAdmin,
    approved: u.approved,
    createdAt: u.createdAt,
  };
}

// Global list — admins manage access for the whole app, not just their own data.
router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  res.json(users.map(publicAdminUser));
});

// Admin-created accounts skip the approval queue entirely — the admin
// vouching for them by creating the account directly is the approval.
router.post("/users", async (req, res) => {
  const parsed = newUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, name, isAdmin } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(400).json({ error: "email_already_registered" });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), passwordHash, name, isAdmin, approved: true },
  });
  res.status(201).json(publicAdminUser(user));
});

router.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "cannot_delete_self" });
  }
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "not_found" });

  if (target.isAdmin) {
    const adminCount = await prisma.user.count({ where: { isAdmin: true } });
    if (adminCount <= 1) return res.status(400).json({ error: "cannot_delete_last_admin" });
  }

  // Cascades to their contacts/sequences/templates/offers/etc — see the
  // onDelete: Cascade relations in schema.prisma.
  await prisma.user.delete({ where: { id: target.id } });
  res.json({ ok: true });
});

router.post("/users/:id/approve", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });
  const updated = await prisma.user.update({ where: { id: user.id }, data: { approved: true } });
  res.json(publicAdminUser(updated));
});

router.post("/users/:id/revoke", async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "cannot_revoke_self" });
  }
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });
  const updated = await prisma.user.update({ where: { id: user.id }, data: { approved: false } });
  res.json(publicAdminUser(updated));
});

router.post("/users/:id/promote", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });
  // Promoting someone to admin implies approving them too.
  const updated = await prisma.user.update({ where: { id: user.id }, data: { isAdmin: true, approved: true } });
  res.json(publicAdminUser(updated));
});

router.post("/users/:id/demote", async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "cannot_demote_self" });
  }
  const adminCount = await prisma.user.count({ where: { isAdmin: true } });
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "not_found" });
  if (target.isAdmin && adminCount <= 1) {
    return res.status(400).json({ error: "cannot_demote_last_admin" });
  }
  const updated = await prisma.user.update({ where: { id: target.id }, data: { isAdmin: false } });
  res.json(publicAdminUser(updated));
});

// Aggregate, per-rep performance — admin-only. Deliberately returns rollups
// (counts/rates), never the underlying contact/offer records themselves, so
// this doesn't become a backdoor around the per-user data isolation used
// everywhere else (contacts.js, offers.js, sequences.js, etc.).
router.get("/team-overview", async (req, res) => {
  const [users, contactsByUser, sentByUser, offers] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.contact.groupBy({ by: ["userId"], _count: { _all: true } }),
    prisma.emailLog.groupBy({ by: ["userId"], _count: { _all: true } }),
    prisma.offer.findMany({ select: { userId: true, status: true, value: true } }),
  ]);

  const contactsMap = Object.fromEntries(contactsByUser.map((c) => [c.userId, c._count._all]));
  const sentMap = Object.fromEntries(sentByUser.map((s) => [s.userId, s._count._all]));

  const offersByUser = {};
  for (const o of offers) {
    const bucket = (offersByUser[o.userId] ||= { total: 0, accepted: 0, declined: 0, value: 0 });
    bucket.total++;
    if (o.status === "accepted") bucket.accepted++;
    if (o.status === "declined") bucket.declined++;
    bucket.value += o.value || 0;
  }

  const perUser = users.map((u) => {
    const ob = offersByUser[u.id] || { total: 0, accepted: 0, declined: 0, value: 0 };
    const decided = ob.accepted + ob.declined;
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      contacts: contactsMap[u.id] || 0,
      sent: sentMap[u.id] || 0,
      offers: ob.total,
      offersValue: ob.value,
      winRate: decided > 0 ? ob.accepted / decided : null,
    };
  });

  const totals = perUser.reduce(
    (acc, u) => ({
      contacts: acc.contacts + u.contacts,
      sent: acc.sent + u.sent,
      offers: acc.offers + u.offers,
      offersValue: acc.offersValue + u.offersValue,
    }),
    { contacts: 0, sent: 0, offers: 0, offersValue: 0 }
  );

  res.json({ totals, perUser });
});

module.exports = router;
