const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { v4: uuid } = require("uuid");
const { getAuthUrl, exchangeCodeForTokens } = require("../lib/gmailClient");
const { sendPasswordResetEmail } = require("../lib/mailer");
const { encrypt } = require("../lib/crypto");
const { DAILY_CAP } = require("../lib/emailCap");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");
const requireOwner = require("../lib/requireOwner");

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
  let gmail = null;
  if (gmailAccount) {
    // Read-only "as of right now" view of the same counter scheduler.js/
    // send.js actually enforce — computed here rather than written, so
    // simply loading this page never mutates the send counter. The
    // authoritative reset+increment only ever happens at actual send time.
    const hoursSinceReset = (Date.now() - new Date(gmailAccount.sendCounterResetAt).getTime()) / 36e5;
    gmail = {
      email: gmailAccount.email,
      connectedAt: gmailAccount.createdAt,
      sentToday: hoursSinceReset >= 24 ? 0 : gmailAccount.emailsSentToday,
      dailyCap: DAILY_CAP,
      // True once a send has failed with a Gmail auth error (revoked/expired
      // access) — see lib/gmailClient.js#isAuthError. The scheduler stops
      // trying to send for this account until an owner reconnects.
      needsReconnect: gmailAccount.needsReconnect,
    };
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    approved: user.approved,
    role: user.role, // owner | member — within their own company
    company: user.company ? { id: user.company.id, name: user.company.name, status: user.company.status } : null,
    // The connected Gmail account is now shared company-wide, not per-person
    // — every teammate sees the same "gmail" block once anyone on the team
    // has connected it.
    gmail,
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

  // The very first user also bootstraps their own Company (they become its
  // owner) — see also ensureCompanyAssignment in server.js, which does the
  // equivalent backfill for data that predates Companies existing at all.
  // Anyone registering after this is intentionally left with no company —
  // for a pilot with hand-picked companies, the real onboarding path is a
  // platform admin creating the company (routes/companies.js) or an
  // existing owner inviting them directly, not the open approval queue.
  let companyId = null;
  if (isFirstUser) {
    const company = await prisma.company.create({ data: { name: name ? `${name}'s Workspace` : "My Workspace" } });
    companyId = company.id;
  }

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      name,
      isAdmin: isFirstUser,
      approved: isFirstUser,
      companyId,
      role: isFirstUser ? "owner" : "member",
    },
  });

  if (!isFirstUser) {
    // Account created but not approved yet — no session, can't log in until
    // an admin approves them from the Admin view (which now also assigns a
    // company at approval time, since a pending user doesn't have one yet).
    return res.status(201).json({
      pending: true,
      message: "Ο λογαριασμός δημιουργήθηκε. Περιμένει έγκριση από διαχειριστή πριν μπορέσεις να συνδεθείς.",
    });
  }

  const userWithCompany = await prisma.user.findUnique({ where: { id: user.id }, include: { company: true } });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "session_error" });
    req.session.userId = user.id;
    res.status(201).json(publicUser(userWithCompany, null));
  });
});

router.post("/login", async (req, res) => {
  const parsed = credentialsSchema.pick({ email: true, password: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_email_or_password" });

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, include: { company: true } });

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

  if (user.company && user.company.status === "suspended") {
    return res.status(403).json({ error: "company_suspended" });
  }

  // Shared per-company mailbox now, not per-person — every teammate logging
  // in sees the same connected Gmail account.
  const gmailAccount = user.companyId
    ? await prisma.gmailAccount.findUnique({ where: { companyId: user.companyId } })
    : null;

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
  const user = await prisma.user.findUnique({ where: { id: req.session.userId }, include: { company: true } });
  if (!user) return res.status(401).json({ error: "not_authenticated" });
  if (user.company && user.company.status === "suspended") {
    return res.status(403).json({ error: "company_suspended" });
  }
  const gmailAccount = user.companyId
    ? await prisma.gmailAccount.findUnique({ where: { companyId: user.companyId } })
    : null;
  res.json(publicUser(user, gmailAccount));
});

// --- Gmail connection (separate from app login) ---
// The connected mailbox is shared company-wide (one GmailAccount per
// company — see schema.prisma), so only an "owner" can (re)connect or
// disconnect it; any member can send once it's connected. Requires an
// existing app session; this only links a Gmail account for sending, it
// does not log anyone in.
router.get("/google", requireAuth, requireOwner, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  // The callback below only has the session to work with (Google redirects
  // here with no app-specific params) — stash which company this connect is
  // for now, rather than re-deriving it from a session.userId that may not
  // even be needed at that point.
  req.session.oauthCompanyId = req.user.companyId;
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
  const companyId = req.session.oauthCompanyId;
  delete req.session.oauthState;
  delete req.session.oauthCompanyId;

  if (!companyId) {
    return res.redirect(`${process.env.FRONTEND_URL}/?gmail_connected=0&reason=no_company`);
  }
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
      where: { companyId },
      update: {
        userId: req.session.userId, // who (re)connected it — audit only
        googleId: profile.id,
        email: profile.email,
        encryptedAccessToken: encrypt(tokens.access_token),
        encryptedRefreshToken: encrypt(tokens.refresh_token),
        tokenExpiry: new Date(tokens.expiry_date),
        // A fresh, successful OAuth grant means access is good again — clear
        // any earlier auth-failure flag (see lib/gmailClient.js#isAuthError)
        // so the scheduler resumes sending for this company.
        needsReconnect: false,
        authErrorAt: null,
      },
      create: {
        id: uuid(),
        companyId,
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

router.post("/google/disconnect", requireAuth, requireOwner, async (req, res) => {
  await prisma.gmailAccount.deleteMany({ where: { companyId: req.user.companyId } });
  res.json({ ok: true });
});

module.exports = router;
