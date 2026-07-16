const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { v4: uuid } = require("uuid");
const { getAuthUrl, exchangeCodeForTokens } = require("../lib/gmailClient");
const { sendPasswordResetEmail } = require("../lib/mailer");
const { encrypt } = require("../lib/crypto");
const { DAILY_CAP } = require("../lib/emailCap");
const { resolveMembershipContext } = require("../lib/membership");
const { pendingInvitesForEmail } = require("../lib/invites");
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

// Read-only "as of right now" view of the same counter scheduler.js/send.js
// actually enforce — computed here rather than written, so simply loading
// this page never mutates the send counter. The authoritative reset+
// increment only ever happens at actual send time (lib/emailCap.js).
function summarizeMailbox(gmailAccount) {
  const hoursSinceReset = (Date.now() - new Date(gmailAccount.sendCounterResetAt).getTime()) / 36e5;
  return {
    id: gmailAccount.id,
    email: gmailAccount.email,
    connectedAt: gmailAccount.createdAt,
    sentToday: hoursSinceReset >= 24 ? 0 : gmailAccount.emailsSentToday,
    dailyCap: DAILY_CAP,
    needsReconnect: gmailAccount.needsReconnect,
  };
}

// `context` is the resolved active-company info from
// resolveMembershipContext (companyId/role/company/memberships) — always
// pass it rather than reading company/role straight off the raw User row,
// since a user can now belong to more than one company and this is what
// decides which one is "active" for them right now.
//
// `gmailAccounts` is every connected mailbox for the active company (a
// company can have more than one now — see schema.prisma's GmailAccount).
// `gmail` stays as a single aggregate object for backward compat with
// GmailBanner and anything else that only cares about "can we send / are we
// close to a limit," summed across the whole pool; `gmailAccounts` is the
// detailed per-mailbox list the Team page's mailbox-management UI needs.
function publicUser(user, gmailAccounts, context, pendingInvites = []) {
  const accounts = (gmailAccounts || []).map(summarizeMailbox);
  const gmail =
    accounts.length === 0
      ? null
      : {
          sentToday: accounts.reduce((sum, a) => sum + a.sentToday, 0),
          dailyCap: DAILY_CAP * accounts.length,
          // Only a company-wide "nothing can send" situation blocks things —
          // one broken mailbox out of three just means less rotation, not a
          // dead connection, so this is true only once EVERY mailbox is broken.
          needsReconnect: accounts.every((a) => a.needsReconnect),
        };
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    approved: user.approved,
    role: context.role, // owner | member — within the currently active company
    company: context.company
      ? { id: context.company.id, name: context.company.name, status: context.company.status }
      : null,
    // Every company this user belongs to, so the frontend can offer a
    // switcher once there's more than one — see POST /auth/switch-company.
    memberships: context.memberships,
    // Invites addressed to this user's email, still awaiting a yes/no — the
    // frontend shows these as an accept/decline prompt right after login
    // (see App.jsx). Not company-scoped like `memberships` above, since an
    // invite can be for a company this user has no relationship with yet.
    pendingInvites,
    // Aggregate summary (backward-compat shape) + the detailed per-mailbox
    // list — see the function comment above.
    gmail,
    gmailAccounts: accounts,
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

  // Bootstrap owner's Membership row — every other path that assigns a
  // companyId (admin create-company, team invite, admin approve) does the
  // same, so Membership always has a matching row for whatever
  // companyId/role a User was given directly.
  await prisma.membership.create({ data: { userId: user.id, companyId, role: "owner" } });

  const context = await resolveMembershipContext(prisma, user, req.session);
  const pendingInvites = await pendingInvitesForEmail(user.email);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "session_error" });
    req.session.userId = user.id;
    res.status(201).json(publicUser(user, [], context, pendingInvites));
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

  // A fresh login always starts from the user's home company (no
  // session.activeCompanyId yet at this point) — resolveMembershipContext
  // falls back to user.companyId, or a sane default if they have
  // memberships but no home company set.
  const context = await resolveMembershipContext(prisma, user, req.session);
  if (context.company && context.company.status === "suspended") {
    return res.status(403).json({ error: "company_suspended" });
  }

  // Shared per-company mailbox pool now, not per-person — every teammate
  // logging in sees the same connected mailboxes for whichever company is
  // active (a company can have more than one — see schema.prisma).
  const gmailAccounts = context.companyId
    ? await prisma.gmailAccount.findMany({ where: { companyId: context.companyId } })
    : [];
  const pendingInvites = await pendingInvitesForEmail(user.email);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "session_error" });
    req.session.userId = user.id;
    res.json(publicUser(user, gmailAccounts, context, pendingInvites));
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

  const context = await resolveMembershipContext(prisma, user, req.session);
  if (context.company && context.company.status === "suspended") {
    return res.status(403).json({ error: "company_suspended" });
  }
  const gmailAccounts = context.companyId
    ? await prisma.gmailAccount.findMany({ where: { companyId: context.companyId } })
    : [];
  const pendingInvites = await pendingInvitesForEmail(user.email);
  res.json(publicUser(user, gmailAccounts, context, pendingInvites));
});

// Lets a user with more than one Membership pick which company they're
// acting as — persists in the session (not on the User row), so it's
// per-login-session rather than a permanent "home company" change. Rejects
// switching into a company the user isn't actually a member of, and into a
// suspended one (same rule as login).
router.post("/switch-company", requireAuth, async (req, res) => {
  const targetCompanyId = typeof req.body.companyId === "string" ? req.body.companyId : "";
  const membership = req.user.memberships.find((m) => m.companyId === targetCompanyId);
  if (!membership) {
    return res.status(400).json({ error: "not_a_member_of_that_company" });
  }
  if (membership.companyStatus === "suspended") {
    return res.status(403).json({ error: "company_suspended" });
  }

  req.session.activeCompanyId = targetCompanyId;

  const context = await resolveMembershipContext(prisma, req.user, req.session);
  const gmailAccounts = context.companyId
    ? await prisma.gmailAccount.findMany({ where: { companyId: context.companyId } })
    : [];
  const pendingInvites = await pendingInvitesForEmail(req.user.email);
  res.json(publicUser(req.user, gmailAccounts, context, pendingInvites));
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

    const tokenData = {
      userId: req.session.userId, // who (re)connected it — audit only
      email: profile.email,
      encryptedAccessToken: encrypt(tokens.access_token),
      encryptedRefreshToken: encrypt(tokens.refresh_token),
      tokenExpiry: new Date(tokens.expiry_date),
      // A fresh, successful OAuth grant means access is good again — clear
      // any earlier auth-failure flag (see lib/gmailClient.js#isAuthError)
      // so sending resumes for this mailbox.
      needsReconnect: false,
      authErrorAt: null,
    };

    // A company can have more than one connected mailbox now (see
    // schema.prisma's GmailAccount) — googleId, not companyId, is what
    // identifies "is this the SAME Gmail account being reconnected, or a
    // brand-new one being added to the pool." Matching on companyId alone
    // (the old, one-mailbox-per-company behavior) would silently overwrite
    // a DIFFERENT already-connected mailbox the instant a second Google
    // account tried to connect.
    const existing = await prisma.gmailAccount.findUnique({ where: { googleId: profile.id } });
    if (existing && existing.companyId !== companyId) {
      // This exact Google account is already connected to a different
      // company — refuse rather than silently moving it out from under
      // whoever's using it there.
      return res.redirect(`${process.env.FRONTEND_URL}/?gmail_connected=0&reason=already_connected_elsewhere`);
    }

    if (existing) {
      await prisma.gmailAccount.update({ where: { id: existing.id }, data: tokenData });
    } else {
      await prisma.gmailAccount.create({ data: { id: uuid(), companyId, googleId: profile.id, ...tokenData } });
    }

    res.redirect(`${process.env.FRONTEND_URL}/?gmail_connected=1`);
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.redirect(`${process.env.FRONTEND_URL}/?gmail_connected=0`);
  }
});

// Disconnects one specific mailbox from the pool — needs its id now that a
// company can have more than one (see GmailAccount in schema.prisma); a bare
// "disconnect everything for my company" would take out every other
// connected mailbox along with the one the owner actually meant to remove.
router.post("/google/disconnect", requireAuth, requireOwner, async (req, res) => {
  const gmailAccountId = typeof req.body.gmailAccountId === "string" ? req.body.gmailAccountId : "";
  if (!gmailAccountId) return res.status(400).json({ error: "invalid_request" });
  await prisma.gmailAccount.deleteMany({ where: { id: gmailAccountId, companyId: req.user.companyId } });
  res.json({ ok: true });
});

module.exports = router;
