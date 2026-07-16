// LinkedIn Lead Gen Forms — Lead Sync API client.
//
// IMPORTANT CAVEAT (read before touching endpoint paths/payload shapes
// below): unlike the Meta Graph API integration in lib/metaLeads.js, this
// code cannot be exercised end-to-end until LinkedIn approves this app for
// its Lead Sync API program — a separate, application-based review (business
// email + verified Company Page + written use case, days to several weeks,
// not guaranteed) on top of the standard OAuth app registration. See
// SETUP.md's "Lead integrations" section. Because of that, the exact
// field-fetch endpoint and webhook payload shape here are built from
// LinkedIn's public developer documentation rather than from a live test —
// LinkedIn has migrated this API's exact shape more than once (see their own
// "Migration Guide for Lead Sync APIs"), so re-check the current versioned
// docs at https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/
// once real API access is granted, before relying on this in production.
// The OAuth token exchange itself (this file's top half) is the stable,
// well-documented part and needs no such caveat.

const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202601";
const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
// Only the scopes this integration actually uses. r_marketing_leadgen_automation
// is the one gated behind Lead Sync API approval — granted to the app but
// inert (calls will 403) until that approval comes through.
const SCOPES = ["r_marketing_leadgen_automation", "r_organization_admin"];

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    scope: SCOPES.join(" "),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    client_id: process.env.LINKEDIN_CLIENT_ID,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error_description || `LinkedIn token exchange failed (${res.status})`);
  // access_token, expires_in (seconds) always present. refresh_token/
  // refresh_token_expires_in only present if this app has been granted
  // LinkedIn's separate "Programmatic Refresh Tokens" product — absent
  // otherwise, in which case the connection just needs re-authorizing
  // (owner clicks "Σύνδεση LinkedIn" again) before/after the access token
  // expires, same UX as GmailAccount.needsReconnect.
  return body;
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.LINKEDIN_CLIENT_ID,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error_description || `LinkedIn token refresh failed (${res.status})`);
  return body;
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// Fetches one lead form response by its id (as referenced in a webhook
// notification) — see the caveat at the top of this file re: confirming
// this path against current docs once real API access exists.
async function fetchLeadFormResponse(responseId, accessToken) {
  const url = `https://api.linkedin.com/rest/leadFormResponses/${encodeURIComponent(responseId)}`;
  const res = await fetch(url, { headers: authHeaders(accessToken) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `LinkedIn lead fetch failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Backup path for the reconciliation poll (see scheduler.js) — lists
// responses for an organization created since a given timestamp, so a missed
// webhook delivery still gets picked up on the next poll pass.
async function listLeadFormResponsesSince(organizationUrn, accessToken, sinceDate) {
  const params = new URLSearchParams({
    q: "owner",
    owner: organizationUrn,
    submittedAtAfter: String(sinceDate.getTime()),
  });
  const url = `https://api.linkedin.com/rest/leadFormResponses?${params.toString()}`;
  const res = await fetch(url, { headers: authHeaders(accessToken) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `LinkedIn lead list failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return Array.isArray(body?.elements) ? body.elements : [];
}

// LinkedIn's form response answers come back as a list of question/answer
// pairs rather than a flat object (same reason Meta's field_data needs
// flattening in lib/metaLeads.js) — flatten to the shape leadIntake's
// mapGenericPayload already knows how to guess field names from. Handles a
// couple of plausibly-shaped variants defensively since the exact schema
// hasn't been verified against a live payload (see file-level caveat).
function flattenLeadFormResponse(response) {
  const flat = {};
  const answers = response?.formResponse?.answers || response?.answers || [];
  for (const a of Array.isArray(answers) ? answers : []) {
    const key = a.questionId || a.question || a.name;
    const value = a.textQuestionAnswer?.answer ?? a.answer ?? a.value ?? (Array.isArray(a.values) ? a.values[0] : undefined);
    if (key && value !== undefined) flat[key] = value;
  }
  // Standard LinkedIn-profile-derived fields are sometimes top-level rather
  // than in the answers array.
  if (response?.firstName) flat.firstName = response.firstName;
  if (response?.lastName) flat.lastName = response.lastName;
  if (response?.email) flat.email = response.email;
  if (response?.phoneNumber) flat.phone = response.phoneNumber;
  if (response?.companyName) flat.company = response.companyName;
  return flat;
}

// Registers this backend's webhook URL to receive real-time lead
// notifications for one organization — a one-time call made right after
// OAuth connect completes (see routes/integrations.js's LinkedIn callback).
// LinkedIn validates the URL before activating the subscription (see the
// file-level caveat — the exact validation handshake should be confirmed
// against current docs once this app has real Lead Sync API access to test
// against).
async function registerWebhookSubscription(organizationUrn, accessToken) {
  const res = await fetch("https://api.linkedin.com/rest/leadNotifications", {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({
      owner: organizationUrn,
      hookUrl: `${process.env.BASE_URL}/integrations/linkedin/webhook`,
      leadType: "SPONSORED",
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `LinkedIn webhook registration failed (${res.status})`);
  }
}

// Same role as gmailClient.js#isAuthError — distinguishes "the token is
// dead, stop retrying and ask the owner to reconnect" from a transient
// failure (rate limit, LinkedIn hiccup) that's worth retrying next tick.
function isAuthError(err) {
  return err?.status === 401 || err?.status === 403;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  fetchLeadFormResponse,
  listLeadFormResponsesSince,
  flattenLeadFormResponse,
  registerWebhookSubscription,
  isAuthError,
};
