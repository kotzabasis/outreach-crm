// Must run after requireAuth (needs req.user already set). Company-scoped
// permission — an "owner" can invite/remove teammates and (re)connect the
// shared Gmail account for their own company only. Distinct from
// requireAdmin (platform-wide, manages Companies themselves across the
// whole app) — a company owner has no special access outside their own
// company's data.
function requireOwner(req, res, next) {
  if (req.user?.role !== "owner") {
    return res.status(403).json({ error: "owner_only" });
  }
  next();
}

module.exports = requireOwner;
