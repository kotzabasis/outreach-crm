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
    .replaceAll("{{company}}", contact.company || "εκεί");
}

// Wraps every http(s) link in the body with our /track/click redirect, and
// appends a 1x1 tracking pixel for opens. trackingId ties both back to one EmailLog row.
function injectTracking(html, trackingId) {
  const withWrappedLinks = html.replace(
    /https?:\/\/[^\s<]+/g,
    (url) => `${process.env.BASE_URL}/track/click/${trackingId}?url=${encodeURIComponent(url)}`
  );
  const pixel = `<img src="${process.env.BASE_URL}/track/open/${trackingId}.png" width="1" height="1" style="display:none" alt="" />`;
  return `${withWrappedLinks}<br/>${pixel}`;
}

function buildRawMessage({ from, to, subject, html }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    "Content-Type: text/html; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${subject}`,
    "",
    html,
  ];
  const message = messageParts.join("\n");
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sendTrackedEmail({ gmailAccount, contact, subject, body, trackingId }) {
  const client = await getAuthedClientForGmailAccount(gmailAccount);
  const gmail = google.gmail({ version: "v1", auth: client });

  const renderedSubject = renderTemplate(subject, contact);
  const renderedBodyHtml = renderTemplate(body, contact).replace(/\n/g, "<br/>");
  const htmlWithTracking = injectTracking(renderedBodyHtml, trackingId);

  const raw = buildRawMessage({
    from: gmailAccount.email,
    to: contact.email,
    subject: renderedSubject,
    html: htmlWithTracking,
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
