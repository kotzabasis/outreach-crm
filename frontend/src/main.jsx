import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { Sentry } from "./lib/sentry"; // side-effect: initializes Sentry if VITE_SENTRY_DSN is set (no-op otherwise)
import { Brand, C, Card } from "./lib/ui.jsx";

// /superadmin is a separate area for platform-admin-only work (creating
// companies, managing every user across companies) — deliberately kept out
// of the regular sidebar/nav so a normal company owner/member never even
// sees it exists. /reset-password is the destination of the "forgot
// password" email link — has to work with no existing session, so it's its
// own top-level screen too rather than something nested inside App's auth
// gate. Same deploy either way, just a different top-level screen based on
// the URL path.
//
// Each screen now lives in its own file (App.jsx, SuperAdminApp.jsx,
// ResetPasswordPage.jsx) and is lazy-loaded here, so a visitor only
// downloads the JS for the screen they actually land on — a regular company
// user's browser never fetches the platform-admin-only SuperAdminApp code,
// and vice versa.
const App = lazy(() => import("./App.jsx"));
const SuperAdminApp = lazy(() => import("./SuperAdminApp.jsx"));
const ResetPasswordPage = lazy(() => import("./ResetPasswordPage.jsx"));

// After a new deploy, a tab that's been open on the old build still references
// the previous hashed chunk filenames; the next lazy import (navigating to a
// code-split screen/view) then 404s with a ChunkLoadError, which React surfaces
// as the ErrorBoundary's "Κάτι πήγε στραβά" screen. Almost always the fix is
// simply to reload and fetch the current build — so do it automatically, once,
// guarded against a reload loop if the failure is something other than a stale
// chunk. Vite fires `vite:preloadError` for exactly this case.
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("chunkReloaded")) return; // already tried — don't loop
  sessionStorage.setItem("chunkReloaded", "1");
  window.location.reload();
});
// A clean load means we're on the current build — clear the guard so a future
// deploy can auto-recover again.
window.addEventListener("load", () => sessionStorage.removeItem("chunkReloaded"));

const path = window.location.pathname;
const Screen = path.startsWith("/superadmin")
  ? SuperAdminApp
  : path.startsWith("/reset-password")
  ? ResetPasswordPage
  : App;

// Before this, a crash mid-render anywhere in the app (any of the three
// screens above) was invisible to us — the backend had Sentry, but nothing
// caught a broken component on the frontend; the user just saw a blank
// white page with no way for it to reach us. Sentry.ErrorBoundary reports
// the crash (when VITE_SENTRY_DSN is configured — a no-op otherwise, same as
// the backend) and swaps in this friendly screen instead of a blank one.
function ErrorFallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center px-6" style={{ backgroundColor: "#F7F9FC", fontFamily: "Inter, sans-serif" }}>
      <Card className="max-w-sm w-full p-6 text-center space-y-3">
        <div className="flex justify-center mb-1">
          <Brand size={30} textSize="text-base" />
        </div>
        <p className="text-sm" style={{ color: C.ink }}>
          Κάτι πήγε στραβά. Δοκίμασε να ανανεώσεις τη σελίδα.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white"
          style={{ backgroundColor: C.sky }}
        >
          Ανανέωση σελίδας
        </button>
      </Card>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />} showDialog={false}>
      <Suspense fallback={null}>
        <Screen />
      </Suspense>
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
