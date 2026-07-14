const prisma = require("../db");

// Shared by every send path — the background scheduler (sequence/campaign
// sends, scheduler.js) AND the manual one-off send route (routes/send.js).
// There's exactly one Gmail connection per company (see GmailAccount in
// schema.prisma), so all three send paths have to draw from — and be capped
// by — the same daily counter, or a company could just route around the cap
// via whichever path doesn't happen to check it. Protects the shared Gmail
// account from being flagged/suspended by Google for high-volume sending.
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

module.exports = { DAILY_CAP, resetDailyCounterIfNeeded };
