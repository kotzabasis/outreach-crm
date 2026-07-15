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
    // companyId/companyName is the "home" company (User.companyId) — kept
    // for backward compat with anything still reading a single company off
    // a user. `memberships` is the real, complete picture now that a user
    // can belong to more than one company — see schema.prisma's Membership.
    companyId: u.companyId,
    companyName: u.company?.name,
    role: u.role,
    memberships: (u.memberships || []).map((m) => ({
      companyId: m.companyId,
      companyName: m.company.name,
      role: m.role,
    })),
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
    legalName: c.legalName,
    taxId: c.taxId,
    taxOffice: c.taxOffice,
    gemhNumber: c.gemhNumber,
    address: c.address,
    phone: c.phone,
    email: c.email,
  };
}

// Global list — admins manage access for the whole app, not just their own
// company's data. Every user belongs to some company (or none yet, if
// they're a pending self-registration awaiting approval+assignment).
router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: { company: true, memberships: { include: { company: true } } },
  });
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
  if (companyId) {
    await prisma.membership.create({ data: { userId: user.id, companyId, role: "member" } });
  }
  res.status(201).json(publicAdminUser({ ...user, memberships: [] }));
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

// Either create a brand-new owner account (ownerEmail+ownerPassword) or hand
// ownership to an existingOwnerUserId — exactly one of the two, enforced
// below. Letting a platform admin pick an existing person avoids the
// "email_already_registered" dead end that happens if someone (sensibly)
// tries to reuse an existing account's email to make them owner of a second
// company — that's a Membership to add, not a new account to create.
const createCompanySchema = z
  .object({
    companyName: z.string().min(1).max(200),
    existingOwnerUserId: z.string().min(1).optional(),
    ownerEmail: z.string().email().optional(),
    ownerPassword: z.string().min(10).max(200).optional(),
    ownerName: z.string().min(1).max(200).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.existingOwnerUserId) return; // existing-user path — email/password not needed
    if (!data.ownerEmail || !data.ownerPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either existingOwnerUserId or ownerEmail+ownerPassword",
        path: ["ownerEmail"],
      });
    }
  });

// Creates a company and assigns its first owner in one step — the intended
// onboarding path for a new pilot company, rather than the public
// self-registration + approval queue. The owner is either a brand-new
// account, or (existingOwnerUserId) an existing person elsewhere on the
// platform who's simply gaining an additional company — same additive rule
// as POST /users/:id/assign-company: their "home" company only changes if
// they didn't already have one.
router.post("/companies", async (req, res) => {
  const parsed = createCompanySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { companyName, existingOwnerUserId, ownerEmail, ownerPassword, ownerName } = parsed.data;

  let existingUser = null;
  if (existingOwnerUserId) {
    existingUser = await prisma.user.findUnique({ where: { id: existingOwnerUserId } });
    if (!existingUser) return res.status(400).json({ error: "invalid_user" });
  } else {
    const existing = await prisma.user.findUnique({ where: { email: ownerEmail.toLowerCase() } });
    if (existing) return res.status(400).json({ error: "email_already_registered" });
  }

  const company = await prisma.company.create({ data: { name: companyName } });

  let owner;
  if (existingUser) {
    await prisma.membership.upsert({
      where: { userId_companyId: { userId: existingUser.id, companyId: company.id } },
      update: { role: "owner" },
      create: { userId: existingUser.id, companyId: company.id, role: "owner" },
    });
    const data = {};
    if (!existingUser.companyId) {
      data.companyId = company.id;
      data.role = "owner";
    }
    owner = Object.keys(data).length
      ? await prisma.user.update({ where: { id: existingUser.id }, data, include: { company: true } })
      : await prisma.user.findUnique({ where: { id: existingUser.id }, include: { company: true } });
  } else {
    const passwordHash = await bcrypt.hash(ownerPassword, 12);
    owner = await prisma.user.create({
      data: {
        email: ownerEmail.toLowerCase(),
        passwordHash,
        name: ownerName,
        approved: true,
        companyId: company.id,
        role: "owner",
      },
      include: { company: true },
    });
    await prisma.membership.create({ data: { userId: owner.id, companyId: company.id, role: "owner" } });
  }

  const memberships = await prisma.membership.findMany({ where: { userId: owner.id }, include: { company: true } });

  res.status(201).json({
    company: publicCompany({ ...company, _count: { users: 1, contacts: 0 } }),
    owner: publicAdminUser({ ...owner, memberships }),
  });
});

// Everything besides `name` is optional business/legal profile info (see
// schema.prisma's Company model) — a company can be created and used
// indefinitely with just a name. Empty strings are normalized to null rather
// than stored as-is, so "cleared the field" reads the same as "never filled
// in" everywhere else that checks `company.taxId` etc. for truthiness.
const editCompanySchema = z.object({
  name: z.string().min(1).max(200),
  legalName: z.string().max(300).optional(),
  taxId: z.string().max(50).optional(),
  taxOffice: z.string().max(150).optional(),
  gemhNumber: z.string().max(50).optional(),
  address: z.string().max(300).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().max(200).optional(),
});

router.patch("/companies/:id", async (req, res) => {
  const parsed = editCompanySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) return res.status(404).json({ error: "not_found" });

  const norm = (v) => (v && v.trim() ? v.trim() : null);
  const updated = await prisma.company.update({
    where: { id: company.id },
    data: {
      name: parsed.data.name.trim(),
      legalName: norm(parsed.data.legalName),
      taxId: norm(parsed.data.taxId),
      taxOffice: norm(parsed.data.taxOffice),
      gemhNumber: norm(parsed.data.gemhNumber),
      address: norm(parsed.data.address),
      phone: norm(parsed.data.phone),
      email: norm(parsed.data.email),
    },
    include: { _count: { select: { users: true, contacts: true } } },
  });
  res.json(publicCompany(updated));
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
    memberships,
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
    // Sourced from Membership, not User.companyId — a user can be a member
    // of this company without it being their "home" company (see
    // schema.prisma), so scanning User.companyId alone would miss them.
    prisma.membership.findMany({
      where: { companyId },
      include: { user: { select: { id: true, email: true, name: true, approved: true, createdAt: true } } },
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

  const members = memberships.map((m) => ({
    id: m.user.id,
    email: m.user.email,
    name: m.user.name,
    role: m.role,
    approved: m.user.approved,
    createdAt: m.createdAt,
  }));

  res.json({
    company: { id: company.id, name: company.name, status: company.status, createdAt: company.createdAt },
    users: members,
    gmail: gmailAccount
      ? { email: gmailAccount.email, connectedAt: gmailAccount.createdAt, needsReconnect: gmailAccount.needsReconnect }
      : null,
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
  if (data.companyId) {
    await prisma.membership.upsert({
      where: { userId_companyId: { userId: user.id, companyId: data.companyId } },
      update: {},
      create: { userId: user.id, companyId: data.companyId, role: user.role || "member" },
    });
  }
  res.json(publicAdminUser({ ...updated, memberships: [] }));
});

// Additive: adds (or updates the role on) a Membership for this user in the
// given company — a user can belong to more than one company now (owner of
// one, member of another), so this no longer moves them out of any company
// they're already in. Their "home" company (User.companyId/role, used as
// the default active company on login — see lib/membership.js) is only set
// here if they didn't already have one, so an existing single-company
// user's default experience never changes just because someone assigns them
// a second company later.
router.post("/users/:id/assign-company", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });

  const companyId = typeof req.body.companyId === "string" && req.body.companyId ? req.body.companyId : "";
  if (!companyId) return res.status(400).json({ error: "invalid_company" });
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return res.status(400).json({ error: "invalid_company" });

  const nextRole = req.body.role === "owner" || req.body.role === "member" ? req.body.role : "member";

  // Guard against demoting the last owner of a company they're ALREADY in —
  // only relevant when this call is changing an existing membership's role
  // from owner to member in place, not when adding a brand new membership.
  const existingMembership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } },
  });
  if (existingMembership?.role === "owner" && nextRole === "member") {
    const otherOwners = await prisma.membership.count({
      where: { companyId, role: "owner", userId: { not: user.id } },
    });
    if (otherOwners === 0) {
      return res.status(400).json({ error: "would_leave_company_ownerless" });
    }
  }

  await prisma.membership.upsert({
    where: { userId_companyId: { userId: user.id, companyId } },
    update: { role: nextRole },
    create: { userId: user.id, companyId, role: nextRole },
  });

  // First company ever assigned to this user becomes their home company —
  // every subsequent assign-company call only touches Membership.
  const data = {};
  if (!user.companyId) {
    data.companyId = companyId;
    data.role = nextRole;
  }
  const updated = Object.keys(data).length
    ? await prisma.user.update({ where: { id: user.id }, data, include: { company: true } })
    : await prisma.user.findUnique({ where: { id: user.id }, include: { company: true } });

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { company: true },
  });
  res.json(publicAdminUser({ ...updated, memberships }));
});

// Removes one specific company membership — the counterpart to
// assign-company's additive behavior. Guards against removing a user's last
// "owner" membership on a company (same rule as demoting them in place
// above). If the removed membership was their home company (User.companyId),
// falls back to another remaining membership, or null if they have none
// left — matches what a brand new, not-yet-assigned user looks like.
router.delete("/users/:id/companies/:companyId", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });

  const { companyId } = req.params;
  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } },
  });
  if (!membership) return res.status(404).json({ error: "not_a_member" });

  if (membership.role === "owner") {
    const otherOwners = await prisma.membership.count({
      where: { companyId, role: "owner", userId: { not: user.id } },
    });
    if (otherOwners === 0) {
      return res.status(400).json({ error: "would_leave_company_ownerless" });
    }
  }

  await prisma.membership.delete({ where: { userId_companyId: { userId: user.id, companyId } } });

  if (user.companyId === companyId) {
    const fallback = await prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: fallback ? { companyId: fallback.companyId, role: fallback.role } : { companyId: null },
    });
  }

  const updated = await prisma.user.findUnique({ where: { id: user.id }, include: { company: true } });
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { company: true },
  });
  res.json(publicAdminUser({ ...updated, memberships }));
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
//
// Optional ?companyId= scopes everything to one company: only members of
// that company appear in perUser, and contacts/sends/offers are filtered to
// that companyId (not by the viewed user's home company — a rep can be a
// member of several companies, so scoping by companyId scalar is the only
// way to get numbers that add up for one specific pilot). Omitting it keeps
// the original cross-platform rollup (every user, every company).
router.get("/team-overview", async (req, res) => {
  const companyId = typeof req.query.companyId === "string" && req.query.companyId ? req.query.companyId : null;

  const [users, contactsByUser, sentByUser, offers] = await Promise.all([
    companyId
      ? prisma.membership
          .findMany({ where: { companyId }, include: { user: true }, orderBy: { createdAt: "asc" } })
          .then((memberships) => memberships.map((m) => m.user))
      : prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.contact.groupBy({ by: ["userId"], where: companyId ? { companyId } : undefined, _count: { _all: true } }),
    prisma.emailLog.groupBy({ by: ["userId"], where: companyId ? { companyId } : undefined, _count: { _all: true } }),
    prisma.offer.findMany({ where: companyId ? { companyId } : undefined, select: { userId: true, status: true, value: true } }),
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
