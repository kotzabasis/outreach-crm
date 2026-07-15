const prisma = require("../db");
const { resolveMembershipContext } = require("./membership");

async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
  if (!user) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  // A user can belong to more than one company now — this resolves which
  // one they're acting as for this request (explicit session switch, else
  // their home company, else a sane default) and folds it onto req.user so
  // every existing route (which just reads req.user.companyId/req.user.role)
  // keeps working unchanged. See lib/membership.js for the precedence rules.
  const context = await resolveMembershipContext(prisma, user, req.session);
  if (context.company && context.company.status === "suspended") {
    return res.status(403).json({ error: "company_suspended" });
  }

  req.user = {
    ...user,
    companyId: context.companyId,
    role: context.role,
    company: context.company,
    memberships: context.memberships,
  };
  next();
}

module.exports = requireAuth;
