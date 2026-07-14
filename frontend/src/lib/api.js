// Thin fetch wrapper for the Outreach CRM backend.
//
// Security notes (see SECURITY.md / SETUP.md in the backend for the full picture):
// - Auth is a first-party session cookie, never a token in JS-readable storage
//   (no localStorage/sessionStorage involved) — so `credentials: "include"` is
//   required on every request, and is the one thing every call below shares.
// - The API base URL is a public value (not a secret) set at build time via
//   VITE_API_URL; it's fine for it to be visible in the bundle.
// - We never log request bodies (which may contain passwords) — only status
//   codes and the server's own error payloads make it into thrown errors.

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export class ApiError extends Error {
  constructor(status, data) {
    const message =
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
    res = await fetch(`${API_URL}${path}`, {
      method,
      credentials: "include",
      headers: isForm ? undefined : body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network-level failure (backend asleep/unreachable). Render's free tier
    // spins the backend down after 15 min idle and takes ~30-40s to wake up
    // on the next request — give it one silent retry before surfacing an
    // error, since the very next attempt a moment later usually succeeds.
    if (!_retried) {
      await new Promise((r) => setTimeout(r, 4000));
      return request(path, { method, body, isForm, _retried: true });
    }
    throw new ApiError(0, { error: "Δεν ήταν δυνατή η επικοινωνία με τον server. Δοκίμασε ξανά σε λίγο." });
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
    // error instead of a thrown network exception — while Render is waking
    // the instance back up, some requests (especially non-GET) come back as
    // a bare 404/502/503 with no real JSON error body (just an interstitial
    // page), rather than our own API's error shape. Retry once rather than
    // showing a confusing raw "HTTP 404" for what's really just the backend
    // still booting. A real API error always comes back as parsed JSON, so
    // this never masks an actual application error.
    const looksLikeColdStart = [404, 502, 503].includes(res.status) && (data === null || typeof data === "string");
    if (looksLikeColdStart && !_retried) {
      await new Promise((r) => setTimeout(r, 4000));
      return request(path, { method, body, isForm, _retried: true });
    }
    throw new ApiError(res.status, data);
  }
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
  // For file downloads (CSV export) — needs the session cookie like every
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
