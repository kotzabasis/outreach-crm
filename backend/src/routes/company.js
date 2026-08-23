const express = require("express");
const { z } = require("zod");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireOwner = require("../lib/requireOwner");
const { DEFAULT_UNSUBSCRIBE_TEXT, DEFAULT_CONFIRM_TITLE, DEFAULT_CONFIRM_MESSAGE } = require("../lib/unsubscribeDefaults");

// Fill empty stored unsubscribe copy with the built-in defaults so the client
// always sees real, editable text (empty in the DB just means "not customized").
function withUnsubscribeDefaults(company) {
  return {
    ...company,
    unsubscribeText: company.unsubscribeText || DEFAULT_UNSUBSCRIBE_TEXT,
    unsubscribeConfirmTitle: company.unsubscribeConfirmTitle || DEFAULT_CONFIRM_TITLE,
    unsubscribeConfirmMessage: company.unsubscribeConfirmMessage || DEFAULT_CONFIRM_MESSAGE,
  };
}

const router = express.Router();
router.use(requireAuth);

// Fields exposed/edited here — the timezone-aware send window (see
// schema.prisma Company + lib/sendWindow.js). Kept in one place so GET and
// PATCH stay in sync.
const SETTINGS_SELECT = {
  id: true,
  name: true,
  sendWindowEnabled: true,
  sendWindowStart: true,
  sendWindowEnd: true,
  sendDays: true,
  sendTimezone: true,
  emailTrackingEnabled: true,
  unsubscribeEnabled: true,
  unsubscribeText: true,
  unsubscribeConfirmTitle: true,
  unsubscribeConfirmMessage: true,
  bookingLink: true,
};

// Readable by any member (the UI shows when automated sends go out); only an
// owner can change it (below).
router.get("/settings", async (req, res) => {
  if (!req.user.companyId) return res.status(404).json({ error: "not_found" });
  const company = await prisma.company.findUnique({
    where: { id: req.user.companyId },
    select: SETTINGS_SELECT,
  });
  if (!company) return res.status(404).json({ error: "not_found" });
  res.json(withUnsubscribeDefaults(company));
});

const sendWindowSchema = z.object({
  sendWindowEnabled: z.boolean().optional(),
  sendWindowStart: z.number().int().min(0).max(23).optional(),
  sendWindowEnd: z.number().int().min(1).max(24).optional(), // exclusive; 24 = end of day
  sendDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  sendTimezone: z.string().min(1).max(64).optional(),
  emailTrackingEnabled: z.boolean().optional(),
  unsubscribeEnabled: z.boolean().optional(),
  unsubscribeText: z.string().max(4000).optional(),
  unsubscribeConfirmTitle: z.string().max(200).optional(),
  unsubscribeConfirmMessage: z.string().max(1000).optional(),
  bookingLink: z.string().max(500).optional(),
});

router.patch("/settings", requireOwner, async (req, res) => {
  const parsed = sendWindowSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Reject an unknown timezone up front (Intl throws on a bad IANA name) so a
  // typo can't quietly make every send fail the window check.
  if (parsed.data.sendTimezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.sendTimezone });
    } catch {
      return res.status(400).json({ error: "invalid_timezone" });
    }
  }
  if (
    parsed.data.sendWindowStart != null &&
    parsed.data.sendWindowEnd != null &&
    parsed.data.sendWindowStart >= parsed.data.sendWindowEnd
  ) {
    return res.status(400).json({ error: "invalid_window_range" });
  }

  const updated = await prisma.company.update({
    where: { id: req.user.companyId },
    data: parsed.data,
    select: SETTINGS_SELECT,
  });
  res.json(withUnsubscribeDefaults(updated));
});

module.exports = router;
