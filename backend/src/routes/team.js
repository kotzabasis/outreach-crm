const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireOwner = require("../lib/requireOwner");

const router = express.Router();
router.use(requireAuth);

function publicTeamMember(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt };
}

// Any teammate can see who else is on their company's team.
router.get("/", async (req, res) => {
  const members = await prisma.user.findMany({
    where: { companyId: req.user.companyId },
    orderBy: { createdAt: "asc" },
  });
  res.json(members.map(publicTeamMember));
});

const inviteSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(200).optional(),
});

// Only an owner can add teammates — bypasses the public register+approve
// queue entirely: the owner vouching for them is the approval, same
// principle as the platform admin's POST /admin/users.
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
  res.status(201).json(publicTeamMember(member));
});

// Owners can remove a member (but not another owner, and not themselves —
// keeps this endpoint from ever leaving a company with zero owners; transfer
// ownership isn't supported yet, only one owner per company in this round).
router.delete("/:id", requireOwner, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "cannot_remove_self" });
  }
  const target = await prisma.user.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
  if (!target) return res.status(404).json({ error: "not_found" });
  if (target.role === "owner") {
    return res.status(400).json({ error: "cannot_remove_owner" });
  }
  await prisma.user.delete({ where: { id: target.id } });
  res.json({ ok: true });
});

module.exports = router;
