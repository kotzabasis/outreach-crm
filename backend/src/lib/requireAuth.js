const prisma = require("../db");

async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
  if (!user) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  req.user = user;
  next();
}

module.exports = requireAuth;
