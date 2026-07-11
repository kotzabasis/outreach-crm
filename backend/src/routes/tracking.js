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

// Pixel opens are notoriously unreliable, not just noisy: since ~2018 Gmail
// itself fetches every tracking pixel the instant a message is delivered
// (separate from the Google Image Proxy, which only fires on a genuine human
// open) via a well-documented, distinctive signature — a User-Agent string
// that impersonates Chrome, Safari AND the long-dead EdgeHTML 12 all at
// once, which no real browser has ever done. On top of that, Gmail sends
// leave an identical copy in the sender's own Sent folder (see
// gmailClient.js) — the *sender* opening that copy fires this exact same
// pixel, indistinguishable from the recipient opening it. Neither case is a
// real recipient looking at the email, so both get filtered out instead of
// silently inflating "opened".
const BOT_UA_SIGNATURE = /Chrome\/42\.0\.2311\.135.*Safari.*Edge\/12\.246/i;
// Belt-and-suspenders for the fast-self-open case (different/no UA): no
// human notices an email and opens it within a couple seconds of it landing
// — that's either the bot above or the sender glancing at their own Sent
// copy right after hitting send.
const FAST_OPEN_WINDOW_MS = 10 * 1000;

function isLikelyBotOpen(userAgent, sentAt) {
  if (BOT_UA_SIGNATURE.test(userAgent || "")) return true;
  return Date.now() - new Date(sentAt).getTime() < FAST_OPEN_WINDOW_MS;
}

router.get("/open/:trackingId.png", async (req, res) => {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  const { trackingId } = req.params;
  const emailLog = await prisma.emailLog.findUnique({ where: { trackingId } }).catch(() => null);
  if (emailLog) {
    const userAgent = req.headers["user-agent"] || "";
    const isBot = isLikelyBotOpen(userAgent, emailLog.sentAt);
    await prisma.trackingEvent.create({ data: { emailLogId: emailLog.id, type: "open", userAgent, isBot } }).catch(() => {});
    // contactId is denormalized directly onto EmailLog (see schema.prisma) —
    // works for both sequence and manual sends. Going through
    // enrollment.contactId here would throw for manual sends, which have no
    // enrollmentId. Only a confirmed-real open moves the contact's status —
    // a bot/self-open shouldn't make a contact look engaged when they aren't.
    if (!isBot) {
      await prisma.contact
        .update({ where: { id: emailLog.contactId }, data: { status: "opened", lastActivityAt: new Date() } })
        .catch(() => {});
    }
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
    await prisma.contact
      .update({ where: { id: emailLog.contactId }, data: { lastActivityAt: new Date() } })
      .catch(() => {});
  }

  res.redirect(302, target.toString());
});

// Public, unauthenticated, hit directly from the link in the email footer
// (see gmailClient.js injectTracking). Ties back to the specific send via
// trackingId, then flips the contact's unsubscribed flag — the scheduler
// already checks this before every sequence step, so no other bookkeeping
// is needed here.
router.get("/unsubscribe/:trackingId", async (req, res) => {
  const { trackingId } = req.params;
  const emailLog = await prisma.emailLog.findUnique({ where: { trackingId } }).catch(() => null);

  if (emailLog) {
    await prisma.contact
      .update({ where: { id: emailLog.contactId }, data: { unsubscribed: true, unsubscribedAt: new Date() } })
      .catch(() => {});
  }

  // Always show the same confirmation, whether or not the tracking id was
  // valid — never reveal anything about the underlying data to the visitor.
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="el"><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#10192B;">
  <h2>Έγινε η απεγγραφή σου.</h2>
  <p style="color:#64748B;">Δεν θα λαμβάνεις άλλα emails.</p>
</body></html>`);
});

module.exports = router;
