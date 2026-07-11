const express = require("express");
const rateLimit = require("express-rate-limit");
const prisma = require("../db");

const router = express.Router();

// These endpoints are hit by mail clients loading images / people clicking
// links, so they can't require a login — but that also makes them the most
// exposed surface in the app. Rate-limit generously per-IP to blunt scraping
// or abuse without breaking normal use.
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(trackingLimiter);

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
  "base64"
);

router.get("/open/:trackingId.png", async (req, res) => {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  const { trackingId } = req.params;
  const emailLog = await prisma.emailLog.findUnique({ where: { trackingId } }).catch(() => null);
  if (emailLog) {
    await prisma.trackingEvent.create({ data: { emailLogId: emailLog.id, type: "open" } }).catch(() => {});
    await prisma.contact
      .findFirst({ where: { id: (await prisma.enrollment.findUnique({ where: { id: emailLog.enrollmentId } }))?.contactId } })
      .then((contact) =>
        contact
          ? prisma.contact.update({
              where: { id: contact.id },
              data: { status: "opened", lastActivityAt: new Date() },
            })
          : null
      )
      .catch(() => {});
  }
  // Always return the pixel, even for an unknown id — never reveal whether a
  // tracking id is valid to whoever's requesting it.
  res.send(TRANSPARENT_GIF);
});

router.get("/click/:trackingId", async (req, res) => {
  const { trackingId } = req.params;
  const rawUrl = req.query.url;

  let target;
  try {
    target = new URL(String(rawUrl));
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("bad protocol");
  } catch {
    return res.status(400).send("Invalid redirect target.");
  }

  const emailLog = await prisma.emailLog.findUnique({ where: { trackingId } }).catch(() => null);
  if (emailLog) {
    await prisma.trackingEvent
      .create({ data: { emailLogId: emailLog.id, type: "click", url: target.toString() } })
      .catch(() => {});
    const enrollment = await prisma.enrollment.findUnique({ where: { id: emailLog.enrollmentId } });
    if (enrollment) {
      await prisma.contact
        .update({ where: { id: enrollment.contactId }, data: { lastActivityAt: new Date() } })
        .catch(() => {});
    }
  }

  res.redirect(302, target.toString());
});

module.exports = router;
