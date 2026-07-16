const express = require("express");
const prisma = require("../db");
const requireAuth = require("../lib/requireAuth");

const router = express.Router();
router.use(requireAuth);

// "Due today" aggregation: the one view a rep opens each morning. Combines
// two independent kinds of "due" that otherwise live in separate places —
// (1) a contact's manual nextFollowUpAt reminder, and (2) an active
// enrollment's automatic nextSendAt — into a single list, scoped to the end
// of today so both "due today" and "overdue" (missed yesterday, still
// unhandled) show up rather than just an exact-day match.
router.get("/due-today", async (req, res) => {
  const companyId = req.user.companyId;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const [followUps, enrollments] = await Promise.all([
    prisma.contact.findMany({
      where: {
        companyId,
        unsubscribed: false,
        nextFollowUpAt: { not: null, lte: endOfToday },
      },
      orderBy: { nextFollowUpAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        company: true,
        nextFollowUpAt: true,
      },
    }),
    prisma.enrollment.findMany({
      where: {
        status: "active",
        nextSendAt: { lte: endOfToday },
        contact: { companyId, unsubscribed: false },
      },
      orderBy: { nextSendAt: "asc" },
      include: {
        contact: { select: { id: true, name: true, email: true, company: true } },
        sequence: {
          select: {
            id: true,
            name: true,
            steps: { select: { id: true, order: true, subject: true }, orderBy: { order: "asc" } },
          },
        },
      },
    }),
  ]);

  const dueFollowUps = followUps.map((c) => ({
    contactId: c.id,
    contactName: c.name,
    contactEmail: c.email,
    contactCompany: c.company,
    dueAt: c.nextFollowUpAt,
    overdue: c.nextFollowUpAt < new Date(new Date().setHours(0, 0, 0, 0)),
  }));

  const dueSends = enrollments.map((e) => {
    const step = e.sequence.steps[e.currentStep] || null;
    return {
      enrollmentId: e.id,
      contactId: e.contact.id,
      contactName: e.contact.name,
      contactEmail: e.contact.email,
      contactCompany: e.contact.company,
      sequenceId: e.sequence.id,
      sequenceName: e.sequence.name,
      stepOrder: step ? step.order : null,
      stepSubject: step ? step.subject : null,
      dueAt: e.nextSendAt,
      overdue: e.nextSendAt < new Date(new Date().setHours(0, 0, 0, 0)),
    };
  });

  res.json({
    followUps: dueFollowUps,
    sends: dueSends,
    counts: { followUps: dueFollowUps.length, sends: dueSends.length },
  });
});

module.exports = router;
