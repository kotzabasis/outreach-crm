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

// website/reportLink get rendered as raw <a href> both in the app (contact
// drawer) and, via {{website}}/{{report_link}} merge tokens, inside real
// outgoing emails (see gmailClient.renderTemplate). A bare domain with no
// scheme is fine (the frontend prepends https:// at display time) — but an
// explicit *other* scheme (javascript:, data:, vbscript:, file:, ...) would
// execute when clicked. Strip it to empty rather than failing the whole
// contact/import row over one bad field — this runs on every write path
// (create, CSV upload, PATCH), so bad data can never reach storage.
function sanitizeUrlField(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return trimmed; // no scheme at all — bare domain/path, fine
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return trimmed;
  return "";
}

const contactSchema = z.object({
  name: z.string().min(1).max(200),
  firstName: z.string().max(100).optional().default(""),
  lastName: z.string().max(100).optional().default(""),
  email: z.string().email(),
  phone: z.string().max(50).optional().default(""),
  company: z.string().max(200).optional().default(""),
  category: z.string().max(100).optional().default(""),
  tags: z.string().max(300).optional().default(""),
  website: z.string().max(300).optional().default("").transform(sanitizeUrlField),
  reportLink: z.string().max(500).optional().default("").transform(sanitizeUrlField),
  // Freeform personalization notes, usable as {{comments}} in email bodies.
  // Rich-text HTML now (bold/italic/lists) — the cap is higher than a
  // plain-text field would need to leave room for markup overhead.
  comments: z.string().max(4000).optional().default(""),
  // Private, internal-only — never sent in an email, never a merge field.
  internalNotes: z.string().max(4000).optional().default(""),
});

router.get("/", async (req, res) => {
  const { status, q, category, tag, unsubscribed, hasFollowUp } = req.query;
  const contacts = await prisma.contact.findMany({
    where: {
      userId: req.user.id,
      ...(status && status !== "all" ? { status: String(status) } : {}),
      ...(category && category !== "all" ? { category: String(category) } : {}),
      // tags is a comma-separated string column — "contains" is good enough
      // filtering at this scale without a separate join table.
      ...(tag && tag !== "all" ? { tags: { contains: String(tag) } } : {}),
      ...(unsubscribed === "true" ? { unsubscribed: true } : {}),
      ...(unsubscribed === "false" ? { unsubscribed: false } : {}),
      ...(hasFollowUp === "true" ? { nextFollowUpAt: { not: null } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: String(q) } },
              { firstName: { contains: String(q) } },
              { lastName: { contains: String(q) } },
              { email: { contains: String(q) } },
              { company: { contains: String(q) } },
              { phone: { contains: String(q) } },
              { tags: { contains: String(q) } },
              { category: { contains: String(q) } },
              { website: { contains: String(q) } },
              { comments: { contains: String(q) } },
              { internalNotes: { contains: String(q) } },
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

// Literal GET paths must be registered before GET "/:id" so Express doesn't
// swallow them as an :id lookup.
router.get("/export", async (req, res) => {
  const contacts = await prisma.contact.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
  const header = [
    "name", "firstName", "lastName", "email", "phone", "company", "category", "tags",
    "website", "reportLink", "comments", "internalNotes", "status",
  ];
  // CSV/formula injection guard: Excel/Sheets treat a cell starting with
  // =, +, -, or @ as a formula to evaluate, not literal text — a comments
  // or company field containing something like =HYPERLINK(...) would
  // execute when the exported file is opened. Prefixing with a leading
  // apostrophe (the standard OWASP mitigation) forces it to be read as text.
  const needsFormulaGuard = (v) => /^[=+\-@]/.test(v);
  const escape = (v) => {
    let s = String(v ?? "");
    if (needsFormulaGuard(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = contacts.map((c) => header.map((h) => escape(c[h])).join(","));
  const csv = [header.join(","), ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="contacts.csv"');
  res.send(csv);
});

// Full detail for the contact drawer: send timeline across all sequences,
// plus offers and notes. Kept separate from the list endpoint (GET "/")
// which stays lightweight for the table view.
router.get("/:id", async (req, res) => {
  const contact = await prisma.contact.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: {
      // Queried directly off the contact (EmailLog.contactId is denormalized
      // — see schema.prisma) instead of through enrollments, so a manual,
      // one-off send (no enrollment at all) shows up in the history too.
      // The old enrollment-only query silently hid every manual send from a
      // contact's timeline.
      emailLogs: {
        include: {
          enrollment: { select: { sequence: { select: { name: true } } } },
          campaign: { select: { name: true } },
          events: { orderBy: { occurredAt: "asc" } },
        },
        orderBy: { sentAt: "desc" },
      },
      offers: { orderBy: { updatedAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!contact) return res.status(404).json({ error: "not_found" });

  // One row per actual send, with the full tracking-event trace attached
  // (not just collapsed opened/clicked booleans) — including bot-filtered
  // opens, flagged as such, so it's clear when something happened, and why
  // an open might not count toward "opened".
  const timeline = contact.emailLogs.map((log) => ({
    id: log.id,
    source: log.source,
    sequenceName: log.enrollment?.sequence?.name || log.campaign?.name || null,
    subject: log.subject,
    sentAt: log.sentAt,
    opened: log.events.some((e) => e.type === "open" && !e.isBot),
    clicked: log.events.some((e) => e.type === "click"),
    events: log.events.map((e) => ({ type: e.type, occurredAt: e.occurredAt, isBot: e.isBot, url: e.url })),
  }));

  const { emailLogs, ...rest } = contact;
  res.json({ ...rest, timeline });
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
      firstName: row.firstName || row.first_name || row["Όνομα"] || "",
      lastName: row.lastName || row.last_name || row["Επώνυμο"] || "",
      email: (row.email || row.Email || "").trim().toLowerCase(),
      phone: row.phone || row.Phone || row.telephone || row.Telephone || "",
      company: row.company || row.Company || "",
      category: row.category || row.Category || "",
      tags: row.tags || row.Tags || "",
      website: row.website || row.Website || "",
      reportLink: row.reportLink || row.report_link || row["Report link"] || "",
      comments: row.comments || row.Comments || row["σχόλια"] || row["Σχόλια"] || "",
      internalNotes: row.internalNotes || row.internal_notes || row["Internal Σχόλια"] || "",
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

// Bulk category/status update (+ optionally append one tag) across many
// contacts at once — e.g. selecting 40 rows and setting them all to
// category "Πελάτης". Tags are additive on purpose: bulk "replace all tags"
// would be too easy to fat-finger into wiping existing tags.
router.post("/bulk-update", async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "no_ids_provided" });
  if (ids.length > 1000) return res.status(400).json({ error: "max_1000_ids" });

  const allowed = ["category", "status", "unsubscribed"];
  const patch = {};
  const body = req.body.data || {};
  for (const key of allowed) if (key in body) patch[key] = body[key];
  if ("unsubscribed" in body) patch.unsubscribedAt = body.unsubscribed ? new Date() : null;
  const addTag = typeof req.body.addTag === "string" ? req.body.addTag.trim() : "";

  const contacts = await prisma.contact.findMany({ where: { id: { in: ids }, userId: req.user.id } });

  const updates = contacts.map((c) => {
    const data = { ...patch };
    if (addTag) {
      const existingTags = (c.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      if (!existingTags.includes(addTag)) data.tags = [...existingTags, addTag].join(", ");
    }
    return prisma.contact.update({ where: { id: c.id }, data });
  });

  await prisma.$transaction(updates);
  res.json({ updated: updates.length });
});

router.post("/bulk-delete", async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "no_ids_provided" });
  const result = await prisma.contact.deleteMany({ where: { id: { in: ids }, userId: req.user.id } });
  res.json({ deleted: result.count });
});

router.patch("/:id", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });

  const allowed = [
    "name", "firstName", "lastName", "phone", "company", "category", "tags",
    "website", "reportLink", "comments", "internalNotes", "status", "unsubscribed",
  ];
  const data = {};
  for (const key of allowed) if (key in req.body) data[key] = req.body[key];
  // PATCH doesn't go through contactSchema, so website/reportLink need the
  // same scheme sanitization applied here explicitly — otherwise editing a
  // contact from the drawer would bypass the guard that create/CSV-upload
  // already get.
  if ("website" in data) data.website = sanitizeUrlField(data.website);
  if ("reportLink" in data) data.reportLink = sanitizeUrlField(data.reportLink);
  // Manual follow-up reminder — independent of automatic sequence sends, so
  // it needs its own Date conversion rather than being passed through raw.
  if ("nextFollowUpAt" in req.body) {
    data.nextFollowUpAt = req.body.nextFollowUpAt ? new Date(req.body.nextFollowUpAt) : null;
  }
  // Keep the timestamp in lockstep with the flag, whichever direction it's
  // flipped from (the email-footer unsubscribe link does the same in
  // tracking.js) — so the UI always has a real "when" to show, not just a
  // boolean.
  if ("unsubscribed" in req.body) {
    data.unsubscribedAt = req.body.unsubscribed ? new Date() : null;
  }

  const updated = await prisma.contact.update({ where: { id: contact.id }, data });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });
  await prisma.contact.delete({ where: { id: contact.id } });
  res.json({ ok: true });
});

// We deliberately don't read the connected Gmail inbox (see gmailClient.js —
// only gmail.send is requested), so replies can't be detected automatically.
// This is the manual fallback: mark the contact as replied, and stop any
// in-flight sequence for them so they don't keep getting follow-ups.
router.post("/:id/mark-replied", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });

  await prisma.enrollment.updateMany({
    where: { contactId: contact.id, status: "active" },
    data: { status: "replied" },
  });

  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { status: "replied", lastActivityAt: new Date() },
  });
  res.json(updated);
});

// --- Notes (freeform CRM notes on a contact) ---
router.get("/:id/notes", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });
  const notes = await prisma.contactNote.findMany({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
  res.json(notes);
});

router.post("/:id/notes", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });

  const parsed = z.object({ body: z.string().min(1).max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const note = await prisma.contactNote.create({
    data: { contactId: contact.id, userId: req.user.id, body: parsed.data.body },
  });
  res.status(201).json(note);
});

router.delete("/:id/notes/:noteId", async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!contact) return res.status(404).json({ error: "not_found" });
  const note = await prisma.contactNote.findFirst({ where: { id: req.params.noteId, contactId: contact.id } });
  if (!note) return res.status(404).json({ error: "not_found" });
  await prisma.contactNote.delete({ where: { id: note.id } });
  res.json({ ok: true });
});

module.exports = router;
