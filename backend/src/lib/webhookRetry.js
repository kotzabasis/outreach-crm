// Retry logic for failed webhook deliveries from external sources (Meta Lead Ads,
// generic webhooks, etc.). Called hourly by scheduler.js to process pending retries.
// LinkedIn webhooks don't use this — their reconciliation poll is the belt-and-suspenders.

const prisma = require("../db");
const { captureException } = require("./sentry");
const { upsertLeadContact } = require("./leadIntake");
const { mapGenericPayload } = require("./leadIntake");
const { flattenLeadFormResponse } = require("./linkedinLeads");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 60 * 60 * 1000; // 1 hour between retries

// Main ticker: called hourly from scheduler.js
async function webhookRetryTick() {
  try {
    const now = new Date();
    const pending = await prisma.failedWebhookDelivery.findMany({
      where: {
        status: "pending",
        nextRetryAt: { lte: now },
      },
      orderBy: { createdAt: "asc" },
      take: 100, // batch process up to 100 at a time to avoid memory spike
    });

    for (const delivery of pending) {
      await retryDelivery(delivery);
    }
  } catch (err) {
    console.error("webhookRetryTick failed:", err.message);
    captureException(err);
  }
}

// Attempt to process a single failed delivery
async function retryDelivery(delivery) {
  try {
    const payload = JSON.parse(delivery.payload);

    let processed = false;
    if (delivery.type === "meta") {
      processed = await processMetaWebhook(payload);
    } else if (delivery.type === "generic") {
      processed = await processGenericWebhook(payload);
    } else if (delivery.type === "linkedin") {
      processed = await processLinkedInWebhook(payload);
    }

    if (processed) {
      // Success: mark as no longer pending
      await prisma.failedWebhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "failed", updatedAt: new Date() }, // actually means "no longer pending, was retried successfully"
      });
      return;
    }

    // Transient error or retryable (e.g. 503) — schedule next retry
    const nextRetryCount = delivery.retryCount + 1;
    if (nextRetryCount >= MAX_RETRIES) {
      // Exhausted retries
      await prisma.failedWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "retry_exhausted",
          retryCount: nextRetryCount,
          lastError: "Max retries exhausted",
          updatedAt: new Date(),
        },
      });
    } else {
      // Schedule next retry
      const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS);
      await prisma.failedWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          retryCount: nextRetryCount,
          nextRetryAt,
          updatedAt: new Date(),
        },
      });
    }
  } catch (err) {
    console.error(`webhookRetryTick: failed to retry delivery ${delivery.id}:`, err.message);
    captureException(err);

    // Record the error for debugging
    const nextRetryCount = delivery.retryCount + 1;
    if (nextRetryCount >= MAX_RETRIES) {
      await prisma.failedWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "retry_exhausted",
          retryCount: nextRetryCount,
          lastError: err.message,
          updatedAt: new Date(),
        },
      }).catch(() => {}); // best effort — if this fails too, just move on
    } else {
      const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS);
      await prisma.failedWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          retryCount: nextRetryCount,
          nextRetryAt,
          lastError: err.message,
          updatedAt: new Date(),
        },
      }).catch(() => {});
    }
  }
}

// Handler helpers — reuse the same logic as the original webhook routes
async function processMetaWebhook(payload) {
  if (!payload.object || payload.object !== "page") return false;

  for (const entry of payload.entry || []) {
    for (const messaging of entry.messaging || []) {
      if (!messaging.message?.form?.id) continue;

      // Extract and process lead
      const lead = {
        firstName: messaging.message.form.first_name || "",
        lastName: messaging.message.form.last_name || "",
        email: messaging.message.form.email || "",
        phone: messaging.message.form.phone_number || "",
        company: "",
      };

      // Find the company that owns this Meta page
      const metaConnection = await prisma.metaLeadConnection.findFirst({
        where: { pageId: messaging.message.form.page_id },
        include: { company: true },
      });

      if (metaConnection) {
        const mapped = mapGenericPayload(lead);
        await upsertLeadContact(metaConnection.companyId, mapped);
        return true; // mark as processed
      }
    }
  }
  return false;
}

async function processGenericWebhook(payload) {
  // Generic webhooks come in via a pre-configured mapping
  // For now, just try to map and upsert — if there's no company context,
  // we can't proceed, so return false to retry later
  // (This would need a companyId embedded in the payload or a lookup key)

  // Placeholder: generic webhooks would need more context to route properly
  return false;
}

async function processLinkedInWebhook(payload) {
  // LinkedIn webhooks should use the reconciliation poll, not retry logic
  // But if one does land here, try to process it
  if (!payload.leadFormResponse?.id) return false;

  const flattened = flattenLeadFormResponse(payload.leadFormResponse);
  const mapped = mapGenericPayload(flattened);

  // Need to find which company owns this LinkedIn connection (by organizationUrn)
  const linkedinConnection = await prisma.linkedInLeadConnection.findFirst({
    where: { organizationUrn: payload.organizationUrn || "" },
  });

  if (linkedinConnection) {
    await upsertLeadContact(linkedinConnection.companyId, mapped);
    return true;
  }

  return false;
}

// Public API: store a failed delivery for retry
async function storeFailedDelivery(type, payload) {
  try {
    await prisma.failedWebhookDelivery.create({
      data: {
        type,
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
        status: "pending",
        nextRetryAt: new Date(Date.now() + RETRY_DELAY_MS), // retry in 1 hour
      },
    });
  } catch (err) {
    console.error(`storeFailedDelivery failed for type ${type}:`, err.message);
    captureException(err);
  }
}

module.exports = { webhookRetryTick, storeFailedDelivery };
