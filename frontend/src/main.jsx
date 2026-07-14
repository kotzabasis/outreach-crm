import React from "react";
import ReactDOM from "react-dom/client";
import App, { SuperAdminApp, ResetPasswordPage } from "./App.jsx";
import "./index.css";

// /superadmin is a separate area for platform-admin-only work (creating
// companies, managing every user across companies) — deliberately kept out
// of the regular sidebar/nav so a normal company owner/member never even
// sees it exists. /reset-password is the destination of the "forgot
// password" email link — has to work with no existing session, so it's its
// own top-level screen too rather than something nested inside App's auth
// gate. Same deploy either way, just a different top-level screen based on
// the URL path.
const path = window.location.pathname;
const Screen = path.startsWith("/superadmin")
  ? SuperAdminApp
  : path.startsWith("/reset-password")
  ? ResetPasswordPage
  : App;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Screen />
  </React.StrictMode>
);
