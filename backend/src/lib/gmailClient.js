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

function renderTemplate(template, contact) {
  return template
    .replaceAll("{{first_name}}", contact.name?.split(" ")[0] || "εκεί")
    .replaceAll("{{name}}", contact.name || "")
    .replaceAll("{{company}}", contact.company || "εκεί")
    .replaceAll("{{email}}", contact.email || "")
    // Free-form per-contact notes (Contact.comments) usable as merge content —
    // e.g. "hey, saw you {{comments}}" for something specific to that lead.
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
function injectTracking(html, trackingId) {
  const withWrappedLinks = html.replace(
    /href=(["'])(https?:\/\/[^"']+)\1/g,
    (match, quote, url) =>
      `href=${quote}${process.env.BASE_URL}/track/click/${trackingId}?url=${encodeURIComponent(url)}${quote}`
  );
  const unsubscribeUrl = `${process.env.BASE_URL}/track/unsubscribe/${trackingId}`;
  const withUnsubscribeLink = withWrappedLinks.replaceAll("{{unsubscribe_link}}", unsubscribeUrl);
  const pixel = `<img src="${process.env.BASE_URL}/track/open/${trackingId}.png" width="1" height="1" style="display:none" alt="" />`;
  return `${withUnsubscribeLink}${pixel}`;
}

// attachments: [{filename, mimeType, contentBase64}] — plain (unwrapped)
// base64, size-validated upstream by lib/attachments.js.
function buildRawMessage({ from, to, subject, html, attachments = [] }) {
  const encodedSubject = encodeSubject(subject);

  if (!attachments.length) {
    const messageParts = [
      `From: ${from}`,
      `To: ${to}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "MIME-Version: 1.0",
      `Subject: ${encodedSubject}`,
      "",
      html,
    ];
    return toBase64Url(messageParts.join("\r\n"));
  }

  const boundary = `bnd_${crypto.randomBytes(12).toString("hex")}`;
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    "MIME-Version: 1.0",
    `Subject: ${encodedSubject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
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

async function sendTrackedEmail({ gmailAccount, contact, subject, body, trackingId, attachments = [] }) {
  const client = await getAuthedClientForGmailAccount(gmailAccount);
  const gmail = google.gmail({ version: "v1", auth: client });

  const renderedSubject = renderTemplate(subject, contact);
  const renderedBodyHtml = renderTemplate(body, contact);
  const htmlWithTracking = injectTracking(renderedBodyHtml, trackingId);

  const raw = buildRawMessage({
    from: gmailAccount.email,
    to: contact.email,
    subject: renderedSubject,
    html: htmlWithTracking,
    attachments,
  });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return res.data.id; // Gmail message id
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  sendTrackedEmail,
  renderTemplate,
};
