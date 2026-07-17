// Timezone-aware send windows. A company can restrict when the scheduler is
// allowed to send (business hours in a chosen timezone) so cold outreach lands
// at a sensible local time. This module is pure (no DB) — callers pass the
// company's window config and it answers "can I send right now?" and "when's
// the next allowed moment?". Uses the built-in Intl API for timezone math, so
// there's no dependency and DST is handled correctly.

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The local hour (0-23) and weekday (0=Sun..6=Sat) for an instant, as observed
// in the given IANA timezone.
function localHourAndWeekday(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const hourRaw = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const hour = hourRaw % 24; // hour12:false can render midnight as "24"
  const weekday = WEEKDAY_INDEX[parts.find((p) => p.type === "weekday")?.value] ?? 0;
  return { hour, weekday };
}

function allowedDays(company) {
  const days = company && company.sendDays;
  if (Array.isArray(days) && days.length) return days.filter((d) => Number.isInteger(d));
  return [1, 2, 3, 4, 5]; // sensible default: weekdays
}

// True if `now` falls inside the company's configured send window — or if the
// company has no window enabled (unrestricted). `overrideTz` lets a per-contact
// timezone (Contact.timezone) take precedence over the company default, so the
// window's hours/days are evaluated in the recipient's local time. Invalid
// config fails open (sends allowed) rather than silently halting all sending.
function withinSendWindow(company, now = new Date(), overrideTz = null) {
  if (!company || !company.sendWindowEnabled) return true;
  const tz = (overrideTz && String(overrideTz).trim()) || company.sendTimezone || "UTC";
  let hour, weekday;
  try {
    ({ hour, weekday } = localHourAndWeekday(now, tz));
  } catch {
    return true; // bad timezone string — don't block sending on a config typo
  }
  const start = Number.isInteger(company.sendWindowStart) ? company.sendWindowStart : 9;
  const end = Number.isInteger(company.sendWindowEnd) ? company.sendWindowEnd : 17;
  if (!allowedDays(company).includes(weekday)) return false;
  // end is exclusive; if start >= end (misconfigured) nothing is ever in-window,
  // so treat that as "unrestricted" to fail open.
  if (start >= end) return true;
  return hour >= start && hour < end;
}

// The next instant at/after `from` that falls inside the window. Steps forward
// in 15-minute increments (cheap — only runs when a send is actually being
// deferred) and is timezone/DST-correct because each probe goes back through
// withinSendWindow. Caps the search at 8 days as a safety net.
function nextSendWindowOpen(company, from = new Date(), overrideTz = null) {
  if (withinSendWindow(company, from, overrideTz)) return from;
  const STEP_MS = 15 * 60 * 1000;
  const limit = from.getTime() + 8 * 24 * 60 * 60 * 1000;
  for (let t = from.getTime() + STEP_MS; t <= limit; t += STEP_MS) {
    if (withinSendWindow(company, new Date(t), overrideTz)) return new Date(t);
  }
  return new Date(from.getTime() + 60 * 60 * 1000); // fallback: try again in an hour
}

module.exports = { withinSendWindow, nextSendWindowOpen };
