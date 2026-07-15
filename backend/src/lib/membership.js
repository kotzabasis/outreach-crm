// Central place that turns "this user, this session" into "which company are
// they acting as right now, and what's their role there." Used by
// requireAuth (every authenticated request) and by auth.js's login/me/
// switch-company handlers, so there's exactly one place that decides how the
// active company is picked — no risk of the rules drifting apart between
// call sites.
//
// A user can have multiple Memberships (owner of one company, member of
// another). Precedence for picking the "active" one on a given request:
//   1. session.activeCompanyId, if the user actually has a membership there
//      (set by POST /auth/switch-company — an explicit choice always wins)
//   2. user.companyId (the legacy "home" company), if a membership exists
//      for it — keeps every existing single-company user's behavior
//      unchanged with zero session writes needed
//   3. the membership where role is "owner", or otherwise just the first
//      one (oldest) — a reasonable default for a user who somehow has
//      memberships but no matching home company
//   4. no memberships at all — companyId/role/company all null, same as a
//      pending self-registered user today
async function resolveMembershipContext(prisma, user, session) {
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { company: true },
    orderBy: { createdAt: "asc" },
  });

  if (memberships.length === 0) {
    return { companyId: null, role: user.role, company: null, memberships: [] };
  }

  let active = null;
  if (session?.activeCompanyId) {
    active = memberships.find((m) => m.companyId === session.activeCompanyId);
  }
  if (!active && user.companyId) {
    active = memberships.find((m) => m.companyId === user.companyId);
  }
  if (!active) {
    active = memberships.find((m) => m.role === "owner") || memberships[0];
  }

  return {
    companyId: active.companyId,
    role: active.role,
    company: active.company,
    memberships: memberships.map((m) => ({
      companyId: m.companyId,
      companyName: m.company.name,
      companyStatus: m.company.status,
      role: m.role,
    })),
  };
}

module.exports = { resolveMembershipContext };
