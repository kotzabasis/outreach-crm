const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireOwner = require("../lib/requireOwner");
const { logAction } = require("../lib/auditLog");

const router = express.Router();
router.use(requireAuth);

function publicTeamMember(u, role, createdAt) {
  return { id: u.id, email: u.email, name: u.name, role, createdAt };
}

// Any teammate can see who else is on their company's team. Sourced from
// Membership (not User.companyId/role directly) — a user's role here is
// their role IN THIS company specifically, which can differ from their home
// company's role now that someone can be owner of one company and a member
// of another (see schema.prisma's Membership). Reading User.role directly
// used to show a person's global/home role even when viewing a different
// company's team, which was wrong.
router.get("/", async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { companyId: req.user.companyId },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(memberships.map((m) => publicTeamMember(m.user, m.role, m.createdAt)));
});

const inviteSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(200).optional(),
});

// Only an owner can add teammates — bypasses the public register+approve
// queue entirely: the owner vouching for them is the approval, same
// principle as the platform admin's POST /admin/users. This path only ever
// creates a brand-new account (rejected below if the email already exists);
// see POST /invite-existing for adding someone who already has an account.
router.post("/", requireOwner, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, name } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(400).json({ error: "email_already_registered" });

  const passwordHash = await bcrypt.hash(password, 12);
  const member = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      name,
      approved: true,
      companyId: req.user.companyId,
      role: "member",
    },
  });
  // Keep Membership in sync with the legacy companyId/role fields — see
  // schema.prisma's Membership model. This invite path only ever creates a
  // brand-new account (rejected above if the email already exists), so
  // there's never a prior membership to worry about here.
  await prisma.membership.create({ data: { userId: member.id, companyId: req.user.companyId, role: "member" } });
  await logAction(req, "team.invite", `${req.user.email} added ${member.email} to the team`, { companyId: req.user.companyId });
  res.status(201).json(publicTeamMember(member, "member", member.createdAt));
});

const inviteExistingSchema = z.object({
  email: z.string().email(),
  role: z.enum(["member", "owner"]).optional().default("member"),
});

// Invites an EXISTING account to join this company — unlike POST / above,
// this can't just create a Membership outright: the target already has
// their own password/account elsewhere, so an owner attaching them to a
// company without asking would be adding someone to a workspace they never
// agreed to join. Instead this creates a pending CompanyInvite; the
// Membership is only created once the invitee accepts it themselves (see
// POST /invites/:id/accept below).
router.post("/invite-existing", requireOwner, async (req, res) => {
  const parsed = inviteExistingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { role } = parsed.data;
  const normEmail = parsed.data.email.toLowerCase();

  const target = await prisma.user.findUnique({ where: { email: normEmail } });
  if (!target) return res.status(404).json({ error: "no_account_with_that_email" });

  const alreadyMember = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: target.id, companyId: req.user.companyId } },
  });
  if (alreadyMember) return res.status(400).json({ error: "already_a_member" });

  const existingInvite = await prisma.companyInvite.findFirst({
    where: { companyId: req.user.companyId, email: normEmail, status: "pending" },
  });
  if (existingInvite) return res.status(400).json({ error: "invite_already_pending" });

  const invite = await prisma.companyInvite.create({
    data: { companyId: req.user.companyId, email: normEmail, role, invitedById: req.user.id },
  });
  await logAction(req, "invite.send", `${req.user.email} invited ${normEmail} (existing account) to join as ${role === "owner" ? "owner" : "member"}`, { companyId: req.user.companyId });
  res.status(201).json({ id: invite.id, email: invite.email, role: invite.role, status: invite.status, createdAt: invite.createdAt });
});

// Pending invites THIS company has sent — so an owner can see what's
// outstanding and revoke one if they invited the wrong person.
router.get("/invites", requireOwner, async (req, res) => {
  const invites = await prisma.companyInvite.findMany({
    where: { companyId: req.user.companyId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  res.json(invites);
});

router.delete("/invites/:id", requireOwner, async (req, res) => {
  const invite = await prisma.companyInvite.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!invite) return res.status(404).json({ error: "not_found" });
  await prisma.companyInvite.update({ where: { id: invite.id }, data: { status: "revoked", respondedAt: new Date() } });
  await logAction(req, "invite.revoke", `${req.user.email} revoked the invite to ${invite.email}`, { companyId: req.user.companyId });
  res.json({ ok: true });
});

// --- Responding to an invite addressed to ME — any authenticated user, not
// owner-only, since this is the invitee acting on their own behalf, possibly
// regarding a company they have nothing to do with yet. ---

router.post("/invites/:id/accept", async (req, res) => {
  const invite = await prisma.companyInvite.findUnique({ where: { id: req.params.id } });
  if (!invite || invite.status !== "pending") return res.status(404).json({ error: "not_found" });
  if (invite.email !== req.user.email.toLowerCase()) return res.status(403).json({ error: "not_your_invite" });

  await prisma.membership.upsert({
    where: { userId_companyId: { userId: req.user.id, companyId: invite.companyId } },
    update: { role: invite.role },
    create: { userId: req.user.id, companyId: invite.companyId, role: invite.role },
  });
  // First company ever assigned becomes their home company — same additive
  // rule as everywhere else a Membership can be a user's very first one.
  const freshUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!freshUser.companyId) {
    await prisma.user.update({ where: { id: req.user.id }, data: { companyId: invite.companyId, role: invite.role } });
  }
  await prisma.companyInvite.update({ where: { id: invite.id }, data: { status: "accepted", respondedAt: new Date() } });
  await logAction(req, "invite.accept", `${req.user.email} accepted the invite to join a company`, { companyId: invite.companyId });
  res.json({ ok: true });
});

router.post("/invites/:id/decline", async (req, res) => {
  const invite = await prisma.companyInvite.findUnique({ where: { id: req.params.id } });
  if (!invite || invite.status !== "pending") return res.status(404).json({ error: "not_found" });
  if (invite.email !== req.user.email.toLowerCase()) return res.status(403).json({ error: "not_your_invite" });

  await prisma.companyInvite.update({ where: { id: invite.id }, data: { status: "declined", respondedAt: new Date() } });
  await logAction(req, "invite.decline", `${req.user.email} declined an invite to join a company`, { companyId: invite.companyId });
  res.json({ ok: true });
});

// Owner-only, read-only export of everything this company owns — contacts,
// sequences+steps, templates, offers, campaigns, notes, and the team roster
// — as a single JSON download. Exists for portability/GDPR requests ("give
// me my data"): a company can always get a full copy of what SDLoop holds
// for them without needing to ask us directly. Email send HISTORY (EmailLog)
// is included as metadata (subject/recipient/timestamps/status) but not
// attachment contents, to keep this a reasonable size.
router.get("/export", requireOwner, async (req, res) => {
  const companyId = req.user.companyId;
  const [company, members, contacts, sequences, templates, offers, campaigns, notes, emailLogs] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId } }),
    prisma.membership.findMany({ where: { companyId }, include: { user: { select: { email: true, name: true } } } }),
    prisma.contact.findMany({ where: { companyId } }),
    prisma.sequence.findMany({ where: { companyId }, include: { steps: true } }),
    prisma.template.findMany({ where: { companyId } }),
    prisma.offer.findMany({ where: { companyId } }),
    prisma.campaign.findMany({ where: { companyId } }),
    prisma.contactNote.findMany({ where: { companyId } }),
    prisma.emailLog.findMany({
      where: { companyId },
      select: { id: true, contactId: true, subject: true, source: true, sentAt: true, gmailMessageId: true },
    }),
  ]);

  const exportPayload = {
    exportedAt: new Date().toISOString(),
    company: company ? { id: company.id, name: company.name, createdAt: company.createdAt } : null,
    members: members.map((m) => ({ email: m.user.email, name: m.user.name, role: m.role, since: m.createdAt })),
    contacts,
    sequences,
    templates,
    offers,
    campaigns,
    contactNotes: notes,
    emailLogs,
  };

  await logAction(req, "company.export", `${req.user.email} exported the company's data`, { companyId });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="sdloop-export-${companyId}.json"`);
  res.send(JSON.stringify(exportPayload, null, 2));
});

// Owners can remove a member (but not another owner, and not themselves —
// keeps this endpoint from ever leaving a company with zero owners; transfer
// ownership isn't supported yet, only one owner per company in this round).
// Removes only THIS company's Membership, not the account itself — a user
// can belong to other companies too now, so deleting the User row here
// would silently wipe their access/data everywhere, not just this one
// company. (Deleting an account entirely is what platform-admin's DELETE
// /admin/users/:id is for — a deliberate, global, destructive action.)
router.delete("/:id", requireOwner, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "cannot_remove_self" });
  }
  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: req.params.id, companyId: req.user.companyId } },
  });
  if (!membership) return res.status(404).json({ error: "not_found" });
  if (membership.role === "owner") {
    return res.status(400).json({ error: "cannot_remove_owner" });
  }

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  await prisma.membership.delete({ where: { userId_companyId: { userId: req.params.id, companyId: req.user.companyId } } });

  // If this was their home company, fall back to another remaining
  // membership (or null) — same rule as admin.js's remove-membership route.
  if (target && target.companyId === req.user.companyId) {
    const fallback = await prisma.membership.findFirst({ where: { userId: target.id }, orderBy: { createdAt: "asc" } });
    await prisma.user.update({
      where: { id: target.id },
      data: fallback ? { companyId: fallback.companyId, role: fallback.role } : { companyId: null },
    });
  }
  await logAction(req, "team.remove", `${req.user.email} removed ${target?.email || req.params.id} from the team`, { companyId: req.user.companyId });
  res.json({ ok: true });
});

module.exports = router;
