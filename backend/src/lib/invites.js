const prisma = require("../db");

// Shared between auth.js (surfacing invites the logged-in user can respond
// to, on /me, /login, /switch-company) and team.js (an owner managing
// invites their own company has sent) — kept in one place so the "pending,
// matched by lowercased email" query can't drift between the two call sites.
async function pendingInvitesForEmail(email) {
  const invites = await prisma.companyInvite.findMany({
    where: { email: email.toLowerCase(), status: "pending" },
    include: { company: { select: { name: true } }, invitedBy: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return invites.map((i) => ({
    id: i.id,
    companyId: i.companyId,
    companyName: i.company.name,
    role: i.role,
    invitedByName: i.invitedBy?.name || i.invitedBy?.email || null,
    createdAt: i.createdAt,
  }));
}

module.exports = { pendingInvitesForEmail };
