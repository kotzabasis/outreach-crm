const prisma = require("../db");

// Shared by every send path — the background scheduler (sequence/campaign
// sends, scheduler.js) AND the manual one-off send route (routes/send.js).
// The cap is PER MAILBOX, not per company — a company can now connect more
// than one Gmail mailbox (see GmailAccount in schema.prisma), each with its
// own independent daily counter, so a company's real capacity is
// DAILY_CAP × (number of connected, healthy mailboxes). Protects each
// individual Gmail account from being flagged/suspended by Google for
// high-volume sending; it was never meant to cap the company's total output,
// just what any single mailbox pushes through it in a day.
const DAILY_CAP = Number(process.env.MAX_EMAILS_PER_DAY_PER_ACCOUNT || 300);

async function resetDailyCounterIfNeeded(gmailAccount) {
  const hoursSinceReset = (Date.now() - new Date(gmailAccount.sendCounterResetAt).getTime()) / 36e5;
  if (hoursSinceReset >= 24) {
    return prisma.gmailAccount.update({
      where: { id: gmailAccount.id },
      data: { emailsSentToday: 0, sendCounterResetAt: new Date() },
    });
  }
  return gmailAccount;
}

// Picks which of a company's connected mailboxes should send the NEXT
// email — the round-robin at the heart of multi-mailbox sending. Skips
// anything broken (needsReconnect) or already at today's cap, then prefers
// whichever remaining mailbox was used longest ago (nulls — never used —
// sort first, so a freshly connected mailbox gets its first send
// immediately rather than waiting behind ones with send history). Returns
// null if there's nothing sendable right now (no mailboxes, all broken, or
// all capped) — callers already know how to handle "nothing to send from"
// since that's exactly what a single missing/capped mailbox looked like
// before this round.
async function pickSendableMailbox(companyId) {
  if (!companyId) return null;
  const accounts = await prisma.gmailAccount.findMany({ where: { companyId } });
  if (accounts.length === 0) return null;

  const candidates = [];
  for (const raw of accounts) {
    if (raw.needsReconnect) continue;
    const acc = await resetDailyCounterIfNeeded(raw);
    if (acc.needsReconnect) continue; // resetDailyCounterIfNeeded never sets this, but stay defensive
    if (acc.emailsSentToday >= DAILY_CAP) continue;
    candidates.push(acc);
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const at = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return at - bt;
  });
  return candidates[0];
}

// Records a successful send against the chosen mailbox — bumps its daily
// counter (same counter DAILY_CAP checks) and its round-robin cursor in one
// place, so every send path stays in sync with pickSendableMailbox above.
// Returns the (unawaited) Prisma promise rather than the resolved result, on
// purpose: every call site needs this update to land atomically alongside
// its own EmailLog write, so it gets pushed into the same
// prisma.$transaction([...]) array instead of being awaited standalone —
// see routes/send.js and lib/scheduler.js.
function mailboxUsedUpdate(gmailAccountId) {
  return prisma.gmailAccount.update({
    where: { id: gmailAccountId },
    data: { emailsSentToday: { increment: 1 }, lastUsedAt: new Date() },
  });
}

module.exports = { DAILY_CAP, resetDailyCounterIfNeeded, pickSendableMailbox, mailboxUsedUpdate };
