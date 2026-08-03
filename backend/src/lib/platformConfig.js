const prisma = require("../db");
const { encrypt, decrypt } = require("./crypto");

// Platform-wide key/value config (PlatformSetting), edited by platform admins.
// Secret values are AES-256-GCM encrypted at rest (same as Gmail tokens).
// Cached in-process to avoid a DB hit on every Unipile call; the cache is
// invalidated whenever a value is written (setMany) so a settings change takes
// effect on the next read without a restart.
let cache = null;

function safeDecrypt(v) {
  try {
    return v ? decrypt(v) : "";
  } catch {
    // Undecryptable (e.g. ENCRYPTION_KEY rotated) — treat as unset rather than throw.
    return "";
  }
}

async function loadAll() {
  if (cache) return cache;
  const rows = await prisma.platformSetting.findMany();
  const out = {};
  for (const r of rows) out[r.key] = r.isSecret ? safeDecrypt(r.value) : r.value;
  cache = out;
  return out;
}

async function get(key) {
  return (await loadAll())[key] || "";
}

// entries: [{ key, value, isSecret }]. A value of undefined is skipped (so a
// blank secret field in the UI means "keep the existing one", never "erase").
async function setMany(entries) {
  for (const e of entries) {
    if (e.value === undefined) continue;
    const stored = e.isSecret ? encrypt(e.value) : e.value;
    await prisma.platformSetting.upsert({
      where: { key: e.key },
      update: { value: stored, isSecret: !!e.isSecret },
      create: { key: e.key, value: stored, isSecret: !!e.isSecret },
    });
  }
  cache = null; // invalidate
}

// Convenience for the LinkedIn module. dsn is the Unipile API base URL for this
// account (e.g. https://api8.unipile.com:13111); accessToken is the X-API-KEY.
async function getUnipileConfig() {
  const all = await loadAll();
  return {
    dsn: (all.unipile_dsn || "").replace(/\/+$/, ""), // trim trailing slash
    accessToken: all.unipile_access_token || "",
  };
}

async function isUnipileConfigured() {
  const { dsn, accessToken } = await getUnipileConfig();
  return Boolean(dsn && accessToken);
}

// Which Unipile "api" tier to use for InMail — must match the account's premium
// seat: classic | recruiter | sales_navigator. Defaults to classic (works for
// most Sales Navigator InMail). Set via the owner's Unipile settings.
const INMAIL_API_VALUES = ["classic", "recruiter", "sales_navigator"];
async function getInmailApi() {
  const v = await get("unipile_inmail_api");
  return INMAIL_API_VALUES.includes(v) ? v : "classic";
}

function invalidate() {
  cache = null;
}

module.exports = { get, setMany, getUnipileConfig, isUnipileConfigured, getInmailApi, INMAIL_API_VALUES, invalidate };
