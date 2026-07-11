const { z } = require("zod");

// No external file storage (S3/Cloudinary) is set up, so attachments are
// stored as base64 directly on the row (Template.attachments,
// SequenceStep.attachments, EmailLog.attachments) — fine for small files,
// capped hard here so nobody accidentally stuffs a 50MB video into Postgres.
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // ~2MB raw per file
const MAX_ATTACHMENTS = 5;

const attachmentSchema = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  contentBase64: z.string().min(1),
});

const attachmentsSchema = z
  .array(attachmentSchema)
  .max(MAX_ATTACHMENTS, `Max ${MAX_ATTACHMENTS} attachments`)
  .refine(
    (arr) => arr.every((a) => Buffer.from(a.contentBase64, "base64").length <= MAX_ATTACHMENT_BYTES),
    { message: `Each attachment must be under ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB` }
  )
  .optional()
  .default([]);

module.exports = { attachmentSchema, attachmentsSchema, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS };
