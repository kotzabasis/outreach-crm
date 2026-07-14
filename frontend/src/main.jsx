import React from "react";
import ReactDOM from "react-dom/client";
import App, { SuperAdminApp } from "./App.jsx";
import "./index.css";

// /superadmin is a separate area for platform-admin-only work (creating
// companies, managing every user across companies) — deliberately kept out
// of the regular sidebar/nav so a normal company owner/member never even
// sees it exists. Same deploy, same session cookie, just a different
// top-level screen based on the URL path.
const isSuperAdmin = window.location.pathname.startsWith("/superadmin");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isSuperAdmin ? <SuperAdminApp /> : <App />}
  </React.StrictMode>
);
