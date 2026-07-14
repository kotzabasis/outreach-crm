const prisma = require("../db");

async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  // include: company so req.user.company.status is available to every route
  // without a second query — this is also the one central place that blocks
  // a suspended company's users from doing anything at all.
  const user = await prisma.user.findUnique({
    where: { id: req.session.userId },
    include: { company: true },
  });
  if (!user) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  if (user.company && user.company.status === "suspended") {
    return res.status(403).json({ error: "company_suspended" });
  }
  req.user = user; // req.user.companyId (scalar) + req.user.company (nested, may be null pre-backfill) + req.user.role
  next();
}

module.exports = requireAuth;
