const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

// 2MB cap, memory storage (never written to disk), CSV only.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "text/csv" && !file.originalname.endsWith(".csv")) {
      return cb(new Error("Only .csv files are accepted"));
    }
    cb(null, true);
  },
});

const contactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  company: z.string().max(200).optional().default(""),
  tags: z.string().max(300).optional().default(""),
});

router.get("/", async (req, res) => {
  const { status, q } = req.query;
  const contacts = await prisma.contact.findMany({
    where: {
      userId: req.user.id,
      ...(status && status !== "all" ? { status: String(status) } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: String(q) } },
              { email: { contains: String(q) } },
              { company: { contains: String(q) } },
            ],
          }
        : {}),
    },
    include: {
      // Only the most recent enrollment, just to show "which sequence /
      // which step" in the contacts table — full history isn't needed here.
      enrollments: {
        include: { sequence: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const withEnrollment = contacts.map(({ enrollments, ...c }) => ({
    ...c,
    currentSequence: enrollments[0] ? enrollments[0].sequence.name : null,
    currentStep: enrollments[0] ? enrollments[0].currentStep : null,
  }));

  res.json(withEnrollment);
});

router.post("/", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const contact = await prisma.contact.create({
    data: { ...parsed.data, userId: req.user.id },
  });
  res.status(201).json(contact);
});

router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });

  let rows;
  try {
    rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: "Could not parse CSV: " + err.message });
  }

  if (rows.length > 5000) {
    return res.status(400).json({ error: "Max 5000 rows per upload. Split your list into smaller files." });
  }

  const results = { created: 0, skipped: 0, errors: [] };

  for (const [i, row] of rows.entries()) {
    const candidate = {
      name: row.name || row.Name || row.email || row.Email || "",
      email: (row.email || row.Email || "").trim().toLowerCase(),
      company: row.company || row.Company || "",
      tags: row.tags || row.Tags || "",
    };
    const parsed = contactSchema.safeParse(candidate);
    if (!parsed.success) {
      results.skipped++;
      if (results.errors.length < 20) results.errors.push(`Row ${i + 2}: invalid email or name`);
      continue;
    }
    // Skip duplicates for this user rather than erroring the whole batch.
    const existing = await prisma.contact.findFirst({
      where: { userId: req.user.id, email: parsed.data.email },
    });
    if (existing) {
      results.skipped++;
      continue;
    }
    await prisma.contact.create({ data: { ...parsed.data, userId: req.user.id } });
    results.created++;
  }

  res.json(results);
});

router.patch("/:id", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });

  const allowed = ["name", "company", "tags", "status", "unsubscribed"];
  const data = {};
  for (const key of allowed) if (key in req.body) data[key] = req.body[key];

  const updated = await prisma.contact.update({ where: { id: contact.id }, data });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });
  await prisma.contact.delete({ where: { id: contact.id } });
  res.json({ ok: true });
});

module.exports = router;
