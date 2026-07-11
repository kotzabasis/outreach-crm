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

module.exports = { sendPasswordResetEmail, isConfigured };
