// Thin fetch wrapper for the Outreach CRM backend.
//
// Security notes (see SECURITY.md / SETUP.md in the backend for the full picture):
// - Auth is a first-party session cookie, never a token in JS-readable storage
//   (no localStorage/sessionStorage involved) - so `credentials: "include"` is
//   required on every request, and is the one thing every call below shares.
// - CSRF protection uses double-submit tokens: the backend sends a token in
//   the X-CSRF-Token response header, and we include it in that same header
//   on all state-changing requests (POST/PATCH/DELETE). Stored in memory only
//   (no persistent storage), so a page refresh clears it and the next server
//   interaction repopulates it.
// - The API base URL is a public value (not a secret) set at build time via
//   VITE_API_URL; it's fine for it to be visible in the bundle.
// - We never log request bodies (which may contain passwords) - only status
//   codes and the server's own error payloads make it into thrown errors.

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

// CSRF token stored in memory (cleared on page reload). On the first request,
// the server sends it in X-CSRF-Token header; we read it from the response
// and include it in the same header on all subsequent state-changing requests.
let csrfToken = null;

// Tiny event bus for the cold-start indicator: the backend on Render's free
// tier spins down after ~15 min idle and takes 30-40s to wake, during which
// the first request(s) get retried below. We fire "api:waking" when a retry is
// in flight and "api:awake" once things resolve, so a small UI banner (see
// main.jsx) can reassure the user instead of leaving them staring at a blank
// wait. No-ops outside the browser.
function emitApi(name) {
  try { window.dispatchEvent(new Event(name)); } catch { /* non-browser */ }
}

// The backend returns error codes as raw snake_case strings (e.g.
// { error: "email_already_registered" }) - without this, ApiError.message
// WAS that raw code, shown verbatim in the UI wherever a catch block falls
// back to `err.message` (which is most of them). Translates every known code
// to a proper Greek sentence; anything not listed here still falls through to
// the raw code below rather than breaking, so a new/rare backend error code
// degrades gracefully instead of throwing.
const ERROR_MESSAGES = {
  not_found: "Δεν βρέθηκε.",
  email_already_registered: "Υπάρχει ήδη λογαριασμός με αυτό το email.",
  invalid_company: "Μη έγκυρη εταιρεία.",
  invalid_user: "Μη έγκυρος χρήστης.",
  cannot_delete_self: "Δεν μπορείς να διαγράψεις τον εαυτό σου.",
  cannot_delete_last_admin: "Δεν μπορεί να διαγραφεί ο τελευταίος διαχειριστής.",
  would_leave_company_ownerless: "Η ενέργεια θα άφηνε την εταιρεία χωρίς ιδιοκτήτη.",
  not_a_member: "Ο χρήστης δεν ανήκει σε αυτή την εταιρεία.",
  not_a_member_of_that_company: "Δεν ανήκεις σε αυτή την εταιρεία.",
  cannot_revoke_self: "Δεν μπορείς να ανακαλέσεις την πρόσβαση του εαυτού σου.",
  cannot_demote_self: "Δεν μπορείς να υποβιβάσεις τον εαυτό σου.",
  cannot_demote_last_admin: "Δεν μπορεί να υποβιβαστεί ο τελευταίος διαχειριστής.",
  cannot_remove_self: "Δεν μπορείς να αφαιρέσεις τον εαυτό σου.",
  cannot_remove_owner: "Δεν μπορείς να αφαιρέσεις τον ιδιοκτήτη.",
  no_ids_provided: "Δεν επιλέχθηκαν επαφές.",
  no_contacts_provided: "Δεν επιλέχθηκαν επαφές.",
  gmail_not_connected: "Δεν έχει συνδεθεί λογαριασμός Gmail.",
  gmail_needs_reconnect: "Χρειάζεται επανασύνδεση του Gmail.",
  invalid_test_email: "Μη έγκυρο email δοκιμής.",
  send_failed: "Η αποστολή απέτυχε.",
  sequence_has_no_steps: "Το sequence δεν έχει βήματα.",
  invalid_email_or_password: "Λάθος email ή κωδικός.",
  session_error: "Σφάλμα σύνδεσης - δοκίμασε ξανά.",
  account_pending_approval: "Ο λογαριασμός εκκρεμεί έγκρισης από διαχειριστή.",
  company_suspended: "Η εταιρεία είναι ανεσταλμένη.",
  invalid_request: "Μη έγκυρο αίτημα.",
  invalid_or_expired_token: "Ο σύνδεσμος έληξε ή δεν είναι πλέον έγκυρος.",
  not_authenticated: "Η σύνδεση έληξε - συνδέσου ξανά.",
  invalid_template: "Μη έγκυρο template.",
  subject_and_body_required: "Χρειάζονται θέμα και κείμενο.",
  no_valid_contacts: "Δεν υπάρχουν έγκυρες επαφές για αποστολή.",
  cannot_start: "Δεν μπορεί να ξεκινήσει.",
  not_running: "Δεν εκτελείται αυτή τη στιγμή.",
  contact_not_found: "Η επαφή δεν βρέθηκε.",
  contact_unsubscribed: "Η επαφή έχει γίνει unsubscribe.",
  daily_send_cap_reached: "Συμπληρώθηκε το ημερήσιο όριο αποστολών.",
  admin_only: "Απαιτούνται δικαιώματα διαχειριστή πλατφόρμας.",
  owner_only: "Απαιτούνται δικαιώματα ιδιοκτήτη εταιρείας.",
  page_already_connected: "Αυτή η σελίδα Meta είναι ήδη συνδεδεμένη.",
};

export class ApiError extends Error {
  constructor(status, data) {
    const rawCode = data && typeof data === "object" && typeof data.error === "string" ? data.error : null;
    const message =
      (rawCode && ERROR_MESSAGES[rawCode]) ||
      (data && typeof data === "object" && (data.error?.formErrors?.[0] || data.error)) ||
      `Αίτημα απέτυχε (HTTP ${status})`;
    super(typeof message === "string" ? message : "Αίτημα απέτυχε");
    this.status = status;
    this.data = data;
  }
}

async function request(path, { method = "GET", body, isForm = false, _retried = false } = {}) {
  let res;
  try {
    const headers = {};
    // Include CSRF token on state-changing requests
    if (!isForm && body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (csrfToken && method !== "GET") {
      headers["X-CSRF-Token"] = csrfToken;
    }
    res = await fetch(`${API_URL}${path}`, {
      method,
      credentials: "include",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network-level failure (backend asleep/unreachable). Render's free tier
    // spins the backend down after 15 min idle and takes ~30-40s to wake up
    // on the next request - give it one silent retry before surfacing an
    // error, since the very next attempt a moment later usually succeeds.
    if (!_retried) {
      emitApi("api:waking");
      await new Promise((r) => setTimeout(r, 4000));
      return request(path, { method, body, isForm, _retried: true });
    }
    emitApi("api:awake");
    throw new ApiError(0, { error: "Δεν ήταν δυνατή η επικοινωνία με τον server. Δοκίμασε ξανά σε λίγο." });
  }

  // Read CSRF token from response header if present (sent by server on all responses)
  const newToken = res.headers.get("X-CSRF-Token");
  if (newToken) {
    csrfToken = newToken;
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    // Same cold-start situation as above, but manifesting as an HTTP-level
    // error instead of a thrown network exception - while Render is waking
    // the instance back up, some requests (especially non-GET) come back as
    // a bare 404/502/503 with no real JSON error body (just an interstitial
    // page), rather than our own API's error shape. Retry once rather than
    // showing a confusing raw "HTTP 404" for what's really just the backend
    // still booting. A real API error always comes back as parsed JSON, so
    // this never masks an actual application error.
    const looksLikeColdStart = [404, 502, 503].includes(res.status) && (data === null || typeof data === "string");
    if (looksLikeColdStart && !_retried) {
      emitApi("api:waking");
      await new Promise((r) => setTimeout(r, 4000));
      return request(path, { method, body, isForm, _retried: true });
    }
    emitApi("api:awake");
    throw new ApiError(res.status, data);
  }
  emitApi("api:awake");
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
  del: (path) => request(path, { method: "DELETE" }),
  uploadCsv: (path, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(path, { method: "POST", body: form, isForm: true });
  },
  // For file downloads (CSV export) - needs the session cookie like every
  // other call, but returns a Blob instead of parsed JSON.
  async downloadBlob(path) {
    let res;
    try {
      res = await fetch(`${API_URL}${path}`, { credentials: "include" });
    } catch {
      throw new ApiError(0, { error: "Δεν ήταν δυνατή η επικοινωνία με τον server. Δοκίμασε ξανά σε λίγο." });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      throw new ApiError(res.status, data);
    }
    return res.blob();
  },
};
