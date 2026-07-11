const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { v4: uuid } = require("uuid");
const { getAuthUrl, exchangeCodeForTokens } = require("../lib/gmailClient");
const { sendPasswordResetEmail } = require("../lib/mailer");
const { encrypt } = require("../lib/crypto");
const prisma = require("../db");

const router = express.Router();

const credentialsSchema = z.object({
  email: z.string().email(),
  // Deliberately not requiring symbols/numbers — length matters far more
  // than composition rules, and composition rules push people toward
  // predictable substitutions. 10 chars is a reasonable floor.
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(200).optional(),
});

function publicUser(user, gmailAccount) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    approved: user.approved,
    gmail: gmailAccount ? { email: gmailAccount.email, connectedAt: gmailAccount.createdAt } : null,
  };
}

router.post("/register", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, name } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    // Same message as a failed login, on purpose — don't reveal which
    // emails already have an account.
    return res.status(400).json({ error: "invalid_email_or_password" });
  }

  // Access is invite/approval-gated: nobody can self-serve their way in.
  // Exception: the very first account ever created bootstraps itself as
  // admin+approved, so there's always someone able to approve everyone else.
  const isFirstUser = (await prisma.user.count()) === 0;

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), passwordHash, name, isAdmin: isFirstUser, approved: isFirstUser },
  });

  if (!isFirstUser) {
    // Account created but not approved yet — no session, can't log in until
    // an admin approves them from the Admin view.
    return res.status(201).json({
      pending: true,
      message: "Ο λογαριασμός δημιουργήθηκε. Περιμένει έγκριση από διαχειριστή πριν μπορέσεις να συνδεθείς.",
    });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "session_error" });
    req.session.userId = user.id;
    res.status(201).json(publicUser(user, null));
  });
});

router.post("/login", async (req, res) => {
  const parsed = credentialsSchema.pick({ email: true, password: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_email_or_password" });

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Always run bcrypt.compare, even on a missing user, against a dummy hash —
  // otherwise a missing-user response returns faster than a wrong-password
  // response, which leaks which emails have accounts (timing side-channel).
  const hashToCheck = user?.passwordHash || "$2a$12$invalidsaltinvalidsaltinvalidsaltinval";
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!user || !valid) {
    return res.status(401).json({ error: "invalid_email_or_password" });
  }

  if (!user.approved) {
    return res.status(403).json({ error: "account_pending_approval" });
  }

  const gmailAccount = await prisma.gmailAccount.findUnique({ where: { userId: user.id } });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "session_error" });
    req.session.userId = user.id;
    res.json(publicUser(user, gmailAccount));
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

router.post("/forgot-password", async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  // Always return the same generic response, whether or not the email
  // exists — this is the one place it'd be easy to leak account existence
  // via response shape/timing, since it's unauthenticated by nature.
  const genericResponse = { ok: true, message: "Αν υπάρχει λογαριασμός με αυτό το email, στάλθηκε σύνδεσμος επαναφοράς." };
  if (!parsed.success) return res.json(genericResponse);

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (user) {
    // Invalidate any still-usable outstanding tokens before issuing a new one.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
    });

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, resetLink).catch((err) =>
      console.error("Failed to send password reset email:", err.message)
    );
  }

  res.json(genericResponse);
});

router.post("/reset-password", async (req, res) => {
  const parsed = z
    .object({ token: z.string().min(10), password: z.string().min(10).max(200) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    return res.status(400).json({ error: "invalid_or_expired_token" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
  ]);

  res.json({ ok: true });
});

router.get("/me", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
  const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
  if (!user) return res.status(401).json({ error: "not_authenticated" });
  const gmailAccount = await prisma.gmailAccount.findUnique({ where: { userId: user.id } });
  res.json(publicUser(user, gmailAccount));
});

// --- Gmail connection (separate from app login) ---
// Requires an existing app session; this only links a Gmail account for
// sending, it does not log anyone in.
router.get("/google", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "log_in_first" });
  }
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(getAuthUrl(state));
});

router.get("/google/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!req.session.userId) {
    return res.redirect(`${process.env.FRONTEND_URL}/?gmail_connected=0&reason=not_logged_in`);
  }
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send("Invalid or expired OAuth state. Please try connecting again.");
  }
  delete req.session.oauthState;

  if (!code) {
    return res.status(400).send("Missing authorization code from Google.");
  }

  try {
    const { tokens, profile } = await exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send("Google didn't return a refresh token. Revoke access at myaccount.google.com/permissions and try again.");
    }

    await prisma.gmailAccount.upsert({
      where: { userId: req.session.userId },
      update: {
        googleId: profile.id,
        email: profile.email,
        encryptedAccessToken: encrypt(tokens.access_token),
        encryptedRefreshToken: encrypt(tokens.refresh_token),
        tokenExpiry: new Date(tokens.expiry_date),
      },
      create: {
        id: uuid(),
        userId: req.session.userId,
        googleId: profile.id,
        email: profile.email,
        encryptedAccessToken: encrypt(tokens.access_token),
        encryptedRefreshToken: encrypt(tokens.refresh_token),
        tokenExpiry: new Date(tokens.expiry_date),
      },
    });

    res.redirect(`${process.env.FRONTEND_URL}/?gmail_connected=1`);
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.redirect(`${process.env.FRONTEND_URL}/?gmail_connected=0`);
  }
});

router.post("/google/disconnect", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
  await prisma.gmailAccount.deleteMany({ where: { userId: req.session.userId } });
  res.json({ ok: true });
});

module.exports = router;
