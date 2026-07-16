const prisma = require("../db");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Third-party form plugins/tools all name their fields slightly differently
// (WordPress plugins especially — Contact Form 7 vs Gravity Forms vs WPForms
// all pick their own key casing/naming), so this guesses at the common
// shapes rather than requiring one exact schema. Same "check several likely
// keys" approach already used by the CSV upload path in routes/contacts.js.
function mapGenericPayload(body) {
  const b = body || {};
  const get = (...keys) => {
    for (const k of keys) {
      if (b[k] !== undefined && b[k] !== null && String(b[k]).trim() !== "") return String(b[k]).trim();
    }
    return "";
  };

  const email = get("email", "Email", "your-email", "your_email", "e-mail", "mail").toLowerCase();
  const firstName = get("firstName", "first_name", "your-first-name", "fname");
  const lastName = get("lastName", "last_name", "your-last-name", "lname");
  const fullName = get("name", "Name", "your-name", "your_name", "full_name", "fullName");
  const phone = get("phone", "Phone", "your-phone", "phone_number", "tel", "telephone");
  const company = get("company", "Company", "your-company", "organization", "business_name");
  const message = get("message", "Message", "your-message", "comments", "notes");

  const name = fullName || [firstName, lastName].filter(Boolean).join(" ") || email;

  return { name, firstName, lastName, email, phone, company, message };
}

// Meta's Graph API returns lead answers as an array of {name, values[]}
// pairs (the question keys are the form's own field names, e.g. "email",
// "full_name", "phone_number") rather than a flat object — flatten it first,
// then reuse the exact same guessing logic as the generic webhook path so
// both sources share one mapping implementation.
function mapMetaFieldData(fieldData) {
  const flat = {};
  for (const field of Array.isArray(fieldData) ? fieldData : []) {
    if (field && field.name) flat[field.name] = Array.isArray(field.values) ? field.values[0] : field.values;
  }
  return mapGenericPayload(flat);
}

// Shared by both intake paths: upsert-by-email within the company, tagging
// which integration the lead came from. Duplicates are updated (tag
// added, lastActivityAt bumped) rather than skipped outright like the CSV
// upload path — a returning lead re-submitting the same form is still a
// signal worth recording, not just an ignorable dupe.
async function upsertLeadContact({ companyId, mapped, sourceTag }) {
  const email = (mapped.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, reason: "missing_or_invalid_email" };
  }

  const existing = await prisma.contact.findFirst({ where: { companyId, email } });

  if (existing) {
    const tags = (existing.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!tags.includes(sourceTag)) tags.push(sourceTag);
    const updated = await prisma.contact.update({
      where: { id: existing.id },
      data: { tags: tags.join(","), lastActivityAt: new Date() },
    });
    return { ok: true, contact: updated, created: false };
  }

  const created = await prisma.contact.create({
    data: {
      companyId,
      name: (mapped.name || email).slice(0, 200),
      firstName: (mapped.firstName || "").slice(0, 100),
      lastName: (mapped.lastName || "").slice(0, 100),
      email,
      phone: (mapped.phone || "").slice(0, 50),
      company: (mapped.company || "").slice(0, 200),
      tags: sourceTag,
      comments: mapped.message ? mapped.message.slice(0, 4000) : "",
      status: "new",
      lastActivityAt: new Date(),
    },
  });
  return { ok: true, contact: created, created: true };
}

module.exports = { mapGenericPayload, mapMetaFieldData, upsertLeadContact };
