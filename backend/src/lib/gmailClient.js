const crypto = require("crypto");
const { google } = require("googleapis");
const { encrypt, decrypt } = require("./crypto");
const prisma = require("../db");

// Minimum scope needed to send mail. We deliberately do NOT request
// gmail.readonly or gmail.modify — this app never reads the user's mailbox.
// (Reply-detection, if you add it later, needs a broader scope and pushes
// this into Google's "sensitive scope" verification process — see SECURITY.md.)
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

function newOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // needed to get a refresh_token
    prompt: "consent", // forces refresh_token on every connect, not just the first
    scope: SCOPES,
    state, // CSRF protection for the OAuth callback — see routes/auth.js
  });
}

async function exchangeCodeForTokens(code) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const { data: profile } = await oauth2.userinfo.get();

  return { tokens, profile };
}

// Returns an authenticated OAuth2 client for a given GmailAccount row,
// refreshing the access token transparently if it's expired.
async function getAuthedClientForGmailAccount(gmailAccount) {
  const client = newOAuthClient();
  client.setCredentials({
    access_token: decrypt(gmailAccount.encryptedAccessToken),
    refresh_token: decrypt(gmailAccount.encryptedRefreshToken),
    expiry_date: new Date(gmailAccount.tokenExpiry).getTime(),
  });

  client.on("tokens", async (tokens) => {
    const data = { encryptedAccessToken: encrypt(tokens.access_token) };
    if (tokens.refresh_token) data.encryptedRefreshToken = encrypt(tokens.refresh_token);
    if (tokens.expiry_date) data.tokenExpiry = new Date(tokens.expiry_date);
    await prisma.gmailAccount.update({ where: { id: gmailAccount.id }, data }).catch(() => {});
  });

  return client;
}

// Merge substitution is plain string replacement into the middle of an
// already-built HTML email, so *where* a value lands matters:
// name/company/email/first_name/last_name normally sit in text content —
// HTML-entity-escaped so a contact whose name contains "<" or "&" can't
// break out of its surrounding tag and inject markup into a real outgoing
// email. website/report_link normally sit inside an href="..." attribute —
// escaping alone wouldn't stop an explicit javascript:/data: scheme from
// executing on click, so they're routed through the same scheme allowlist
// used when the contact is saved (routes/contacts.js sanitizeUrlField) as a
// second, independent check, plus quote-escaping so a literal `"` in the
// value can't break out of the attribute itself. comments is deliberately
// left as raw HTML — it's meant to render as rich-text formatting, same as
// any other template body, and is sanitized client-side before it's ever
// saved (see sanitizeRichHtml in App.jsx).
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeMergeUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  const isSafeScheme = !schemeMatch || ["http", "https", "mailto"].includes(schemeMatch[1].toLowerCase());
  if (!isSafeScheme) return "";
  return trimmed.replace(/"/g, "%22");
}

// `asHtml` controls whether the text-content tokens get HTML-escaped —
// true for the body (it's HTML), false for the subject (it's a plain-text
// mail header: escaping "&" to "&amp;" there would show up literally as
// "&amp;" in the recipient's inbox instead of being decoded by anything).
// The URL tokens go through the same scheme allowlist either way — a
// javascript:/data: value isn't safe in a subject either, even if it can't
// execute there, and this keeps the two contexts from silently diverging.
function renderTemplate(template, contact, { asHtml = true, bookingLink = "" } = {}) {
  const text = asHtml ? escapeHtml : (v) => String(v || "");
  return template
    // Company-level scheduling link (Calendly/Cal.com/etc.). Usable as a bare
    // token or inside an <a href="{{booking_link}}">book a call</a>.
    .replaceAll("{{booking_link}}", sanitizeMergeUrl(bookingLink))
    // Prefer the dedicated firstName column when set — falls back to
    // splitting `name` on whitespace for contacts created before that field
    // existed (or imported without it).
    .replaceAll("{{first_name}}", text(contact.firstName || contact.name?.split(" ")[0] || "εκεί"))
    .replaceAll("{{last_name}}", text(contact.lastName || ""))
    .replaceAll("{{name}}", text(contact.name || ""))
    .replaceAll("{{company}}", text(contact.company || "εκεί"))
    .replaceAll("{{email}}", text(contact.email || ""))
    .replaceAll("{{website}}", sanitizeMergeUrl(contact.website))
    .replaceAll("{{gmb}}", sanitizeMergeUrl(contact.gmb))
    .replaceAll("{{facebook}}", sanitizeMergeUrl(contact.facebook))
    .replaceAll("{{instagram}}", sanitizeMergeUrl(contact.instagram))
    .replaceAll("{{google_reviews}}", sanitizeMergeUrl(contact.googleReviews))
    // A link to a personalized report/proposal for this contact — usable as
    // e.g. <a href="{{report_link}}">δείτε την αναφορά σας</a>.
    .replaceAll("{{report_link}}", sanitizeMergeUrl(contact.reportLink))
    // Free-form per-contact notes (Contact.comments) usable as merge content —
    // e.g. "hey, saw you {{comments}}" for something specific to that lead.
    // Internal-only notes (Contact.internalNotes) are deliberately NOT a
    // merge field — they must never be able to leak into an outgoing email.
    .replaceAll("{{comments}}", contact.comments || "");
}

// Non-ASCII (Greek, etc.) subject lines need RFC 2047 encoding — Gmail's raw
// message format doesn't reliably round-trip a bare UTF-8 header otherwise.
function encodeSubject(subject) {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function toBase64Url(str) {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Wraps every http(s) link in the body with our /track/click redirect,
// resolves the {{unsubscribe_link}} token to the real unsubscribe URL, and
// appends a 1x1 tracking pixel for opens. trackingId ties all three back to
// one EmailLog row.
//
// The unsubscribe line itself is no longer force-appended here — it's now
// part of the editable body (the frontend seeds new drafts with it, see
// DEFAULT_DISCLAIMER_HTML in App.jsx), so the user can reword/move/remove it
// like any other text. {{unsubscribe_link}} is the placeholder href it's
// seeded with; whatever the user leaves in the body when they send is what
// goes out — this just fills in the one token that has to be resolved
// server-side (the actual trackingId isn't known until send time). If
// they've deleted it entirely, no unsubscribe link goes out — same tradeoff
// as any other content they choose to remove.
//
// Link-wrapping only rewrites real href="..." attributes (from the rich-text
// editor's link button) — NOT a blind scan for "http(s)://" anywhere in the
// string. An earlier version did the latter and it corrupted every <a href>
// tag: the naive regex matched past the closing quote and into the visible
// link text (stopping only at the next "<" or whitespace), mangling the
// markup and producing broken links plus garbled rendering downstream.
// When `trackingEnabled` is false (workspace setting), the email goes out
// "clean": no click-link rewriting and no open pixel — the two things that add
// our tracking domain into the body and hurt deliverability. The unsubscribe
// link is NOT tracking (it's a functional, compliance link) so it's always
// resolved; the List-Unsubscribe header is likewise always sent (see
// sendTrackedEmail) so one-click unsubscribe keeps working regardless.
function injectTracking(html, trackingId, { trackingEnabled = true, unsubscribeEnabled = true } = {}) {
  const unsubscribeUrl = `${process.env.BASE_URL}/track/unsubscribe/${trackingId}`;
  // The {{unsubscribe_link}} body token resolves to the working URL when
  // unsubscribe is on, or to empty (token removed) when off — so a "clean" send
  // never leaves a broken placeholder or a dead link behind.
  const resolveUnsub = (s) => s.replaceAll("{{unsubscribe_link}}", unsubscribeEnabled ? unsubscribeUrl : "");

  if (!trackingEnabled) {
    // Clean send: leave real links untouched, no pixel.
    return resolveUnsub(html);
  }

  const withWrappedLinks = html.replace(
    /href=(["'])(https?:\/\/[^"']+)\1/g,
    (match, quote, url) =>
      `href=${quote}${process.env.BASE_URL}/track/click/${trackingId}?url=${encodeURIComponent(url)}${quote}`
  );
  const withUnsubscribeLink = resolveUnsub(withWrappedLinks);
  const pixel = `<img src="${process.env.BASE_URL}/track/open/${trackingId}.png" width="1" height="1" style="display:none" alt="" />`;
  return `${withUnsubscribeLink}${pixel}`;
}

// One-click unsubscribe headers (RFC 8058). Gmail/Yahoo bulk-sender guidance
// now effectively requires these: the recipient's mail client shows a native
// "Unsubscribe" button, and clicking it makes the provider POST to the URL
// directly (no page load, no human on our side) — see the POST handler in
// routes/tracking.js. This lives in the message *headers*, independent of
// whatever the sender did or didn't leave in the body's {{unsubscribe_link}},
// so a compliant unsubscribe path is always present. Both headers must be sent
// together for one-click to be honored.
function unsubscribeHeaders(listUnsubscribeUrl) {
  if (!listUnsubscribeUrl) return [];
  return [
    `List-Unsubscribe: <${listUnsubscribeUrl}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ];
}

// A readable plain-text rendering of the HTML body, used as the text/plain
// alternative (below). Not a full HTML parser — just enough to turn the
// rich-text editor's output into sensible text: block tags become line breaks,
// list items get a bullet, tags are stripped, and the common entities are
// decoded. The tracking pixel (<img>) and wrapped links collapse to nothing /
// their visible text, which is exactly what a text fallback should show.
function htmlToText(html) {
  return String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A multipart/alternative block (text/plain + text/html). Returned as a line
// array so it can be used standalone (no attachments) or nested as the first
// sub-part inside a multipart/mixed (with attachments). Sending both parts —
// with text first, html second (clients prefer the last supported) — is a mild
// but real deliverability win: an HTML-only email is a weak spam signal.
function alternativePart(text, html) {
  const b = `alt_${crypto.randomBytes(9).toString("hex")}`;
  return [
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${b}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${b}--`,
  ];
}

// attachments: [{filename, mimeType, contentBase64}] — plain (unwrapped)
// base64, size-validated upstream by lib/attachments.js.
function buildRawMessage({ from, to, subject, html, text, attachments = [], listUnsubscribeUrl = null, textOnly = false }) {
  const encodedSubject = encodeSubject(subject);
  const unsubHeaders = unsubscribeHeaders(listUnsubscribeUrl);
  const plain = text && text.trim() ? text : htmlToText(html);
  // Plain-text mode: a single text/plain part, no HTML alternative at all — an
  // email indistinguishable from one typed by hand in Gmail, with zero of our
  // markup. Otherwise the usual multipart/alternative (text + html).
  const contentLines = textOnly
    ? ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", plain]
    : alternativePart(plain, html);
  const altLines = contentLines;

  if (!attachments.length) {
    const parts = [
      `From: ${from}`,
      `To: ${to}`,
      "MIME-Version: 1.0",
      `Subject: ${encodedSubject}`,
      ...unsubHeaders,
      ...altLines, // top-level content type is the multipart/alternative
    ];
    return toBase64Url(parts.join("\r\n"));
  }

  const boundary = `bnd_${crypto.randomBytes(12).toString("hex")}`;
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    "MIME-Version: 1.0",
    `Subject: ${encodedSubject}`,
    ...unsubHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...altLines, // the text+html alternative as the first mixed sub-part
    "",
  ];
  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "",
      att.contentBase64.replace(/\s/g, ""),
      ""
    );
  }
  parts.push(`--${boundary}--`);
  return toBase64Url(parts.join("\r\n"));
}

async function sendTrackedEmail({ gmailAccount, contact, subject, body, trackingId, attachments = [], trackingEnabled = true, unsubscribeEnabled = true, plainText = false, bookingLink = null }) {
  const client = await getAuthedClientForGmailAccount(gmailAccount);
  const gmail = google.gmail({ version: "v1", auth: client });

  // Resolve the company's booking link lazily — only worth a query when the
  // {{booking_link}} token is actually present, so this adds no cost to the
  // vast majority of sends. Callers may also pass it in to skip the lookup.
  let resolvedBooking = bookingLink;
  if (resolvedBooking == null && /\{\{booking_link\}\}/.test(`${body}${subject}`)) {
    resolvedBooking = "";
    if (gmailAccount.companyId) {
      const company = await prisma.company
        .findUnique({ where: { id: gmailAccount.companyId }, select: { bookingLink: true, bookingLinks: true, bookingLinkCursor: true } })
        .catch(() => null);
      if (company) {
        const extras = Array.isArray(company.bookingLinks) ? company.bookingLinks.filter((s) => typeof s === "string" && s.trim()) : [];
        const pool = [company.bookingLink, ...extras].filter((s) => s && s.trim());
        if (pool.length > 0) {
          const cursor = Number(company.bookingLinkCursor) || 0;
          resolvedBooking = pool[cursor % pool.length];
          // Advance the round-robin pointer for the next booking-link send.
          if (pool.length > 1) {
            await prisma.company
              .update({ where: { id: gmailAccount.companyId }, data: { bookingLinkCursor: cursor + 1 } })
              .catch(() => {});
          }
        }
      }
    }
  }

  const renderedSubject = renderTemplate(subject, contact, { asHtml: false, bookingLink: resolvedBooking || "" });

  let htmlWithTracking = null;
  let textBody;
  const unsubUrl = `${process.env.BASE_URL}/track/unsubscribe/${trackingId}`;
  if (plainText) {
    // True plain-text send: no HTML part, no tracking (pixel/link-rewrite are
    // HTML-only concepts). Render tokens as plain text, strip the editor's
    // markup, and resolve the unsubscribe token to a visible URL (or drop it).
    const rendered = renderTemplate(body, contact, { asHtml: false, bookingLink: resolvedBooking || "" });
    textBody = htmlToText(rendered).split("{{unsubscribe_link}}").join(unsubscribeEnabled ? unsubUrl : "");
  } else {
    const renderedBodyHtml = renderTemplate(body, contact, { bookingLink: resolvedBooking || "" });
    htmlWithTracking = injectTracking(renderedBodyHtml, trackingId, { trackingEnabled, unsubscribeEnabled });
    // Plain-text alternative from the body BEFORE tracking injection — so it has
    // the real link text and no 1x1 pixel.
    textBody = htmlToText(renderedBodyHtml);
  }

  const raw = buildRawMessage({
    from: gmailAccount.email,
    to: contact.email,
    subject: renderedSubject,
    html: htmlWithTracking,
    text: textBody,
    attachments,
    textOnly: plainText,
    // Same URL the {{unsubscribe_link}} body token resolves to — surfaced in
    // the headers too so one-click unsubscribe works even if the sender edited
    // or removed the in-body link. Omitted entirely when unsubscribe is off.
    // (Kept even in plain-text mode: the header is compliance, not tracking.)
    listUnsubscribeUrl: unsubscribeEnabled ? unsubUrl : null,
  });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return res.data.id; // Gmail message id
}

// Distinguishes "Gmail access is actually broken" (revoked/expired refresh
// token, disabled account) from a transient failure (rate limit, network
// blip, temporary Google-side 5xx) — only the former should stop the
// scheduler from retrying and prompt the owner to reconnect. googleapis
// surfaces auth failures inconsistently depending on where they occur (token
// refresh vs. the actual send call), so this checks every shape observed:
// a 401/403 HTTP status, google-auth-library's `invalid_grant`/
// `unauthorized_client` error codes, or the equivalent text in err.message.
function isAuthError(err) {
  const status = err?.response?.status || err?.code;
  if (status === 401 || status === 403) return true;
  const reason = err?.response?.data?.error || err?.errors?.[0]?.reason;
  if (reason === "invalid_grant" || reason === "unauthorized_client" || reason === "deleted_client") return true;
  const msg = String(err?.message || "");
  return /invalid_grant|invalid credentials|unauthorized_client|invalid_client/i.test(msg);
}

// Best-effort — never let a failure to record the flag mask the original
// send error (callers still throw/log that separately).
async function flagNeedsReconnect(gmailAccountId) {
  await prisma.gmailAccount
    .update({ where: { id: gmailAccountId }, data: { needsReconnect: true, authErrorAt: new Date() } })
    .catch((updateErr) => console.error("flagNeedsReconnect failed:", updateErr.message));
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  sendTrackedEmail,
  renderTemplate,
  isAuthError,
  flagNeedsReconnect,
};
