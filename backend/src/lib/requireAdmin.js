// Must run after requireAuth (needs req.user already set).
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: "admin_only" });
  }
  next();
}

module.exports = requireAdmin;
