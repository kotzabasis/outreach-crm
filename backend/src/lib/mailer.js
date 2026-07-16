const nodemailer = require("nodemailer");

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendPasswordResetEmail(to, resetLink) {
  const subject = "Επαναφορά κωδικού — Outreach CRM";
  const html = `
    <p>Ζητήθηκε επαναφορά κωδικού για τον λογαριασμό σου.</p>
    <p><a href="${resetLink}">Πάτησε εδώ για να ορίσεις νέο κωδικό</a> (ισχύει για 30 λεπτά).</p>
    <p>Αν δεν το ζήτησες εσύ, αγνόησε αυτό το email — ο κωδικός σου παραμένει ίδιος.</p>
  `;

  if (!isConfigured()) {
    // Dev fallback: no SMTP configured, so just log the link instead of
    // silently failing. Never do this in production — set SMTP_* instead.
    console.log(`\n[DEV] Password reset link for ${to}:\n${resetLink}\n`);
    return;
  }

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"Outreach CRM" <no-reply@localhost>`,
    to,
    subject,
    html,
  });
}

// Sent by lib/weeklyDigest.js's scheduler tick, not from a logged-in
// request — always goes out via this transactional SMTP sender, never the
// company's own connected Gmail mailbox (that pool exists purely for
// outbound outreach sends, see lib/emailCap.js).
async function sendWeeklyDigestEmail(to, companyName, stats) {
  const subject = `Εβδομαδιαία σύνοψη — ${companyName}`;
  const money = stats.offersWonValue ? `€${stats.offersWonValue.toLocaleString("el-GR")}` : "€0";
  const html = `
    <p>Σύνοψη της τελευταίας εβδομάδας για το <strong>${companyName}</strong>:</p>
    <ul>
      <li>Emails που στάλθηκαν: <strong>${stats.sent}</strong></li>
      <li>Ανοίχτηκαν: <strong>${stats.opened}</strong></li>
      <li>Clicks: <strong>${stats.clicked}</strong></li>
      <li>Απαντήσεις: <strong>${stats.repliedContacts}</strong></li>
      <li>Νέες επαφές: <strong>${stats.newContacts}</strong></li>
      <li>Προσφορές που κερδήθηκαν: <strong>${stats.offersWonCount}</strong> (${money})</li>
      <li>Ενεργά sequences: <strong>${stats.activeSequences}</strong></li>
      <li>Εκκρεμή follow-ups αυτή τη στιγμή: <strong>${stats.dueToday}</strong></li>
    </ul>
    <p style="color:#6b7280;font-size:12px;">Αυτόματο εβδομαδιαίο email — δεν χρειάζεται σύνδεση στο app για να το δεις.</p>
  `;

  if (!isConfigured()) {
    console.log(`\n[DEV] Weekly digest for ${to} (${companyName}):\n${JSON.stringify(stats)}\n`);
    return;
  }

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"Outreach CRM" <no-reply@localhost>`,
    to,
    subject,
    html,
  });
}

module.exports = { sendPasswordResetEmail, sendWeeklyDigestEmail, isConfigured };
