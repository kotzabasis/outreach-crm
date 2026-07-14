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
    companyId: u.companyId,
    companyName: u.company?.name,
    role: u.role,
    createdAt: u.createdAt,
  };
}

function publicCompany(c) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    createdAt: c.createdAt,
    userCount: c._count?.users,
    contactCount: c._count?.contacts,
  };
}

// Global list — admins manage access for the whole app, not just their own
// company's data. Every user belongs to some company (or none yet, if
// they're a pending self-registration awaiting approval+assignment).
router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { company: true } });
  res.json(users.map(publicAdminUser));
});

// Admin-created accounts skip the approval queue entirely — the admin
// vouching for them by creating the account directly is the approval.
// Requires an existing company to attach them to (use POST /companies to
// create one first if this is a brand new pilot company).
router.post("/users", async (req, res) => {
  const parsed = newUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, name, isAdmin } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(400).json({ error: "email_already_registered" });

  let companyId = typeof req.body.companyId === "string" ? req.body.companyId : null;
  if (companyId) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(400).json({ error: "invalid_company" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), passwordHash, name, isAdmin, approved: true, companyId },
  });
  res.status(201).json(publicAdminUser(user));
});

// --- Companies (platform admin only) ---
// Each pilot company is a Company row; users on the same company share
// contacts/sequences/templates/campaigns/the connected Gmail account (see
// schema.prisma + the companyId-scoped queries throughout routes/*.js).

router.get("/companies", async (req, res) => {
  const companies = await prisma.company.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { users: true, contacts: true } } },
  });
  res.json(companies.map(publicCompany));
});

const createCompanySchema = z.object({
  companyName: z.string().min(1).max(200),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(10).max(200),
  ownerName: z.string().min(1).max(200).optional(),
});

// Creates a company AND its first user (the owner) in one step — the
// intended onboarding path for a new pilot company, rather than the public
// self-registration + approval queue.
router.post("/companies", async (req, res) => {
  const parsed = createCompanySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { companyName, ownerEmail, ownerPassword, ownerName } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: ownerEmail.toLowerCase() } });
  if (existing) return res.status(400).json({ error: "email_already_registered" });

  const passwordHash = await bcrypt.hash(ownerPassword, 12);
  const company = await prisma.company.create({ data: { name: companyName } });
  const owner = await prisma.user.create({
    data: {
      email: ownerEmail.toLowerCase(),
      passwordHash,
      name: ownerName,
      approved: true,
      companyId: company.id,
      role: "owner",
    },
  });

  res.status(201).json({ company: publicCompany({ ...company, _count: { users: 1, contacts: 0 } }), owner: publicAdminUser({ ...owner, company }) });
});

router.post("/companies/:id/suspend", async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not_found" });
  const updated = await prisma.company.update({ where: { id: company.id }, data: { status: "suspended" } });
  res.json(publicCompany(updated));
});

router.post("/companies/:id/activate", async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not_found" });
  const updated = await prisma.company.update({ where: { id: company.id }, data: { status: "active" } });
  res.json(publicCompany(updated));
});

// Per-company usage snapshot — shown when a platform admin clicks a company
// row in the Companies panel, to answer "how active is this pilot" without
// needing DB access. Read-only; every query below is filtered to this one
// companyId, so there's no cross-company leakage even though this route
// itself is platform-admin-only (same as everything else in this file).
router.get("/companies/:id/stats", async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not_found" });

  const companyId = company.id;
  const [
    users,
    gmailAccount,
    contactsTotal,
    contactsByStatus,
    sequencesTotal,
    sequencesActive,
    templatesTotal,
    campaignsByStatus,
    offers,
    emailsSent,
    opens,
    clicks,
  ] = await Promise.all([
    prisma.user.findMany({
      where: { companyId },
      select: { id: true, email: true, name: true, role: true, approved: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.gmailAccount.findUnique({ where: { companyId } }),
    prisma.contact.count({ where: { companyId } }),
    prisma.contact.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
    prisma.sequence.count({ where: { companyId } }),
    prisma.sequence.count({ where: { companyId, active: true } }),
    prisma.template.count({ where: { companyId } }),
    prisma.campaign.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
    prisma.offer.findMany({ where: { companyId }, select: { status: true, value: true } }),
    prisma.emailLog.count({ where: { companyId } }),
    prisma.trackingEvent.count({ where: { emailLog: { companyId }, type: "open", isBot: false } }),
    prisma.trackingEvent.count({ where: { emailLog: { companyId }, type: "click" } }),
  ]);

  const offersSummary = offers.reduce(
    (acc, o) => {
      acc.total++;
      if (o.status === "accepted") acc.accepted++;
      if (o.status === "declined") acc.declined++;
      acc.value += o.value || 0;
      return acc;
    },
    { total: 0, accepted: 0, declined: 0, value: 0 }
  );

  res.json({
    company: { id: company.id, name: company.name, status: company.status, createdAt: company.createdAt },
    users,
    gmail: gmailAccount ? { email: gmailAccount.email, connectedAt: gmailAccount.createdAt } : null,
    contacts: {
      total: contactsTotal,
      byStatus: Object.fromEntries(contactsByStatus.map((c) => [c.status, c._count._all])),
    },
    sequences: { total: sequencesTotal, active: sequencesActive },
    templates: { total: templatesTotal },
    campaigns: {
      total: campaignsByStatus.reduce((sum, c) => sum + c._count._all, 0),
      byStatus: Object.fromEntries(campaignsByStatus.map((c) => [c.status, c._count._all])),
    },
    offers: offersSummary,
    emails: { sent: emailsSent, opened: opens, clicked: clicks },
  });
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

// A self-registered pending user has no company yet — approving them now
// also requires saying which company they belong to (an existing one, via
// companyId, or leave it unset only if they're joining nobody in particular
// — not recommended, they won't see any shared data until assigned one).
router.post("/users/:id/approve", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });

  const data = { approved: true };
  if (typeof req.body.companyId === "string" && req.body.companyId) {
    const company = await prisma.company.findUnique({ where: { id: req.body.companyId } });
    if (!company) return res.status(400).json({ error: "invalid_company" });
    data.companyId = company.id;
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data, include: { company: true } });
  res.json(publicAdminUser(updated));
});

// Standalone assign/reassign — the general-purpose way to put an existing
// user (approved or still pending) into a company, independent of creation
// or approval time. Pass companyId: null to detach them from their current
// company (they'll see no shared data until assigned a new one).
router.post("/users/:id/assign-company", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });

  const companyId = typeof req.body.companyId === "string" && req.body.companyId ? req.body.companyId : null;
  if (companyId) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(400).json({ error: "invalid_company" });
  }

  const data = { companyId };
  // Optional: also set their role in the new company (owner | member) —
  // e.g. moving someone into a company as its owner. Defaults to leaving
  // whatever role they already had untouched if not provided.
  if (req.body.role === "owner" || req.body.role === "member") {
    data.role = req.body.role;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    include: { company: true },
  });
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
