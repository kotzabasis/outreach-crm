const express = require("express");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireAdmin = require("../lib/requireAdmin");

const router = express.Router();
router.use(requireAuth, requireAdmin);

function publicAdminUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.isAdmin,
    approved: u.approved,
    createdAt: u.createdAt,
  };
}

// Global list — admins manage access for the whole app, not just their own data.
router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  res.json(users.map(publicAdminUser));
});

router.post("/users/:id/approve", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "not_found" });
  const updated = await prisma.user.update({ where: { id: user.id }, data: { approved: true } });
  res.json(publicAdminUser(updated));
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

module.exports = router;
