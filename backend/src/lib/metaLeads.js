const crypto = require("crypto");

const GRAPH_VERSION = "v19.0";

// Meta signs every webhook POST body with the app's secret (X-Hub-Signature-256:
// "sha256=<hex>") so a request can be trusted to actually be from Meta and
// not a spoofed POST to the same public URL — this is checked BEFORE
// touching the payload at all. Needs the raw request body bytes, not the
// parsed JSON (HMAC is over the exact bytes sent) — see server.js's
// express.json({ verify }) capturing req.rawBody for this reason.
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false; // fail closed — never accept unsigned webhooks if not configured
  const signatureHeader = req.get("X-Hub-Signature-256") || "";
  const [scheme, providedHex] = signatureHeader.split("=");
  if (scheme !== "sha256" || !providedHex || !req.rawBody) return false;

  const expectedHex = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const provided = Buffer.from(providedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

// Meta's webhook only ever sends "a lead with this id exists" — the actual
// answers have to be pulled separately via the Graph API using a Page
// Access Token that has leads_retrieval permission on that specific page.
async function fetchLeadFieldData(leadgenId, pageAccessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(leadgenId)}?fields=field_data&access_token=${encodeURIComponent(pageAccessToken)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || `Graph API request failed (${res.status})`;
    throw new Error(message);
  }
  return body?.field_data || [];
}

module.exports = { verifyMetaSignature, fetchLeadFieldData };
