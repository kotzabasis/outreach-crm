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
  // Unlike /open/:trackingId.png and /unsubscribe/:trackingId (which always
  // respond the same way regardless of validity, so as not to reveal
  // anything about a tracking id to whoever's requesting it), this route
  // must NOT redirect for an unknown trackingId — doing so would let anyone
  // turn this domain into a generic open-redirector (…/track/click/anything
  // ?url=https://phishing-site.example) for use in someone else's phishing
  // links, since the url param would be honored no matter what trackingId
  // is passed. A redirect here only ever makes sense for a click on a link
  // this app itself actually sent.
  if (!emailLog) return res.status(404).send("Unknown tracking id.");

  await prisma.trackingEvent
    .create({ data: { emailLogId: emailLog.id, type: "click", url: target.toString() } })
    .catch(() => {});
  await prisma.contact
    .update({ where: { id: emailLog.contactId }, data: { lastActivityAt: new Date() } })
    .catch(() => {});

  res.redirect(302, target.toString());
});

// Ties a tracking id back to its send and flips the contact's unsubscribed
// flag — the scheduler checks this before every sequence step, so no other
// bookkeeping is needed here. Safe to call for an unknown/invalid id (no-op)
// and idempotent for an already-unsubscribed contact.
async function applyUnsubscribe(trackingId) {
  const emailLog = await prisma.emailLog.findUnique({ where: { trackingId } }).catch(() => null);
  if (emailLog) {
    await prisma.contact
      .update({ where: { id: emailLog.contactId }, data: { unsubscribed: true, unsubscribedAt: new Date() } })
      .catch(() => {});
  }
}

// Minimal HTML escape so the owner-configured confirmation copy can't inject
// markup/script into this public page.
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// GET: the human-facing path — someone clicks the {{unsubscribe_link}} in the
// email body and lands on a confirmation page. The title/message are editable
// per workspace (Company settings); we resolve them from the tracking id's
// company, falling back to the built-in defaults.
router.get("/unsubscribe/:trackingId", async (req, res) => {
  await applyUnsubscribe(req.params.trackingId);

  let title = DEFAULT_CONFIRM_TITLE;
  let message = DEFAULT_CONFIRM_MESSAGE;
  try {
    const emailLog = await prisma.emailLog.findUnique({
      where: { trackingId: req.params.trackingId },
      select: { contact: { select: { company: { select: { unsubscribeConfirmTitle: true, unsubscribeConfirmMessage: true } } } } },
    });
    const company = emailLog?.contact?.company;
    if (company?.unsubscribeConfirmTitle) title = company.unsubscribeConfirmTitle;
    if (company?.unsubscribeConfirmMessage) message = company.unsubscribeConfirmMessage;
  } catch {
    // fall back to defaults — never fail the confirmation page over a lookup
  }

  // Always show a confirmation, whether or not the tracking id was valid —
  // never reveal anything about the underlying data to the visitor.
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="el"><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#10192B;">
  <h2>${escapeHtml(title)}</h2>
  <p style="color:#64748B;">${escapeHtml(message)}</p>
</body></html>`);
});

// POST: the one-click path (RFC 8058). The recipient's mail provider POSTs
// here directly (body: "List-Unsubscribe=One-Click") when they hit the native
// "Unsubscribe" button — no page is rendered, so just do the work and return
// 200. CSRF is intentionally skipped for this path (see lib/csrf.js): the
// caller is an external mail server that can't carry our session token, and
// the action is a harmless, idempotent opt-out keyed on an unguessable id.
router.post("/unsubscribe/:trackingId", async (req, res) => {
  await applyUnsubscribe(req.params.trackingId);
  res.sendStatus(200);
});

module.exports = router;
