import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

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

const path = window.location.pathname;
const Screen = path.startsWith("/superadmin")
  ? SuperAdminApp
  : path.startsWith("/reset-password")
  ? ResetPasswordPage
  : App;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Screen />
    </Suspense>
  </React.StrictMode>
);
