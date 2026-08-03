const { getUnipileConfig } = require("./platformConfig");

// Unipile API client for the LinkedIn outreach module.
//
// IMPORTANT (same caveat as lib/linkedinLeads.js): the endpoint paths and
// payload shapes below are built from Unipile's public documentation
// (https://developer.unipile.com), not from a live integration test — this repo
// has no Unipile credentials wired in. Unipile is stable but versioned; before
// relying on this in production, connect a real account and confirm the exact
// request/response shapes for: hosted-auth link, GET account, resolve profile,
// send invitation, withdraw invitation, and send message. They're all funnelled
// through unipileRequest() so a shape fix is localized.
//
// Auth: every call uses the account's DSN as the base URL and the access token
// as the `X-API-KEY` header (both from PlatformSetting, set in the admin view).

const DEFAULT_TIMEOUT_MS = Number(process.env.UNIPILE_TIMEOUT_MS || 20000);

class UnipileError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "UnipileError";
    this.status = status;
    this.body = body;
    // Rate-limit / transient backend errors the caller should back off on and retry.
    this.retryable = status === 429 || status === 503 || status === 502 || status === 504;
  }
}

// Central request helper. Throws UnipileError (with .status/.retryable) on any
// non-2xx or network/timeout failure. Never logs the API key.
async function unipileRequest(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { dsn, accessToken } = await getUnipileConfig();
  if (!dsn || !accessToken) {
    throw new UnipileError("Unipile is not configured (missing DSN / access token).", 0, null);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${dsn}${path}`, {
      method,
      headers: {
        "X-API-KEY": accessToken,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new UnipileError(
      err.name === "AbortError" ? `Unipile request timed out after ${timeoutMs}ms` : err.message,
      503, // treat network/timeout as retryable
      null
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => "");
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = (data && (data.message || data.title || data.detail)) || `HTTP ${res.status}`;
    throw new UnipileError(`Unipile ${method} ${path} failed: ${detail}`, res.status, data);
  }
  return data;
}

// --- Hosted authentication -------------------------------------------------
// Returns a one-time URL the user visits to log into LinkedIn (Unipile handles
// login + 2FA/checkpoint). `notifyUrl` is our webhook that receives the
// resulting account_id + status; success/failure URLs bring the user back.
async function createHostedAuthLink({ successUrl, failureUrl, notifyUrl, expiresInMinutes = 30 }) {
  return unipileRequest("/api/v1/hosted/accounts/link", {
    method: "POST",
    body: {
      type: "create",
      providers: ["LINKEDIN"],
      api_url: (await getUnipileConfig()).dsn,
      expiresOn: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
      success_redirect_url: successUrl,
      failure_redirect_url: failureUrl,
      notify_url: notifyUrl,
    },
  });
}

// --- Account status --------------------------------------------------------
async function getAccount(unipileAccountId) {
  return unipileRequest(`/api/v1/accounts/${encodeURIComponent(unipileAccountId)}`);
}

// Map Unipile's account state to our LinkedInOutreachAccount.status enum.
function normalizeAccountStatus(account) {
  const s = String(account?.status || account?.state || "").toUpperCase();
  if (["OK", "CONNECTED", "ACTIVE"].includes(s)) return "ok";
  if (s.includes("CHECKPOINT") || s.includes("OTP") || s.includes("2FA") || s.includes("CREDENTIALS")) {
    return "checkpoint_needed";
  }
  if (!s) return "ok";
  return "error";
}

// --- Profile resolution ----------------------------------------------------
// Resolve a public LinkedIn profile URL (or public identifier) to the provider
// id used for invites/messages, plus the network distance so we know whether a
// connection request is needed (DISTANCE_1 = already connected). Unipile accepts
// the public identifier (the slug after /in/) as the {identifier} path param.
function publicIdentifierFromUrl(profileUrl) {
  const m = String(profileUrl || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : String(profileUrl || "").trim();
}

async function resolveProfile(unipileAccountId, profileUrl) {
  const identifier = publicIdentifierFromUrl(profileUrl);
  const data = await unipileRequest(
    `/api/v1/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(unipileAccountId)}`
  );
  const providerId = data?.provider_id || data?.id || null;
  const distance = String(data?.network_distance || data?.networkDistance || "").toUpperCase();
  return {
    providerId,
    networkDistance: distance, // e.g. DISTANCE_1 | DISTANCE_2 | DISTANCE_3 | OUT_OF_NETWORK
    alreadyConnected: distance === "DISTANCE_1",
    raw: data,
  };
}

// --- Connection requests ---------------------------------------------------
async function sendInvitation(unipileAccountId, providerId, note) {
  return unipileRequest("/api/v1/users/invite", {
    method: "POST",
    body: {
      account_id: unipileAccountId,
      provider_id: providerId,
      message: note ? String(note).slice(0, 300) : undefined, // LinkedIn note cap ~300 chars
    },
  });
}

async function withdrawInvitation(unipileAccountId, invitationId) {
  return unipileRequest(
    `/api/v1/users/invite/${encodeURIComponent(invitationId)}?account_id=${encodeURIComponent(unipileAccountId)}`,
    { method: "DELETE" }
  );
}

// --- Messaging -------------------------------------------------------------
// Starts (or continues) a 1:1 chat with the given provider id and posts `text`.
// Only valid once connected (LinkedIn blocks messaging non-connections without
// InMail, which is out of scope for the MVP).
async function sendMessage(unipileAccountId, providerId, text) {
  return unipileRequest("/api/v1/chats", {
    method: "POST",
    body: {
      account_id: unipileAccountId,
      attendees_ids: [providerId],
      text: String(text || "").slice(0, 8000),
    },
  });
}

// --- InMail (premium only) -------------------------------------------------
// Sends a LinkedIn InMail to a provider id — works on people you are NOT
// connected to (unlike sendMessage), but requires a premium seat (Sales
// Navigator / Recruiter) and consumes an InMail credit. Same POST /chats
// endpoint as a normal message, with the LinkedIn-specific `inmail` flag set
// and an `api` type that must match the account's premium tier
// (classic | recruiter | sales_navigator). InMails carry a subject line.
// Shape per https://developer.unipile.com/docs/send-messages — verify live.
async function sendInmail(unipileAccountId, providerId, { subject, text, api = "classic" } = {}) {
  return unipileRequest("/api/v1/chats", {
    method: "POST",
    body: {
      account_id: unipileAccountId,
      attendees_ids: [providerId],
      subject: subject ? String(subject).slice(0, 200) : undefined,
      text: String(text || "").slice(0, 8000),
      linkedin: { api: api || "classic", inmail: true },
    },
  });
}

// Recent inbound messages for reply detection (Unipile CAN read the mailbox —
// this is the LinkedIn advantage over the email channel). `since` is an ISO
// string; caller filters/acts on replies to pause enrollments.
async function listMessages(unipileAccountId, since) {
  const qs = new URLSearchParams({ account_id: unipileAccountId });
  if (since) qs.set("after", new Date(since).toISOString());
  return unipileRequest(`/api/v1/messages?${qs.toString()}`);
}

module.exports = {
  UnipileError,
  createHostedAuthLink,
  getAccount,
  normalizeAccountStatus,
  publicIdentifierFromUrl,
  resolveProfile,
  sendInvitation,
  withdrawInvitation,
  sendMessage,
  sendInmail,
  listMessages,
};
