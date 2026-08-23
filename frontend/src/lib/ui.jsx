// Shared presentational primitives used by all three top-level screens
// (App, SuperAdminApp, ResetPasswordPage - see main.jsx). Pulled out of the
// old single App.jsx monolith specifically so those screens can be
// code-split: SuperAdminApp and ResetPasswordPage only need this small
// shared layer, not the entire main-app bundle (contacts/sequences/
// templates/campaigns/analytics/etc.), which used to ship to every visitor
// regardless of which screen they actually landed on.
import { useState, useEffect } from "react";
import { Loader2, AlertTriangle, PhoneCall, RefreshCw, Sun, Moon } from "lucide-react";
import { t } from "./i18n.jsx";

// ---------- Design tokens (theme-aware) ----------
// Two palettes, light and dark. `C` is a Proxy that always reads the CURRENTLY
// active palette, so every `style={{ color: C.ink }}` (and every `${C.coral}14`
// alpha concatenation) flips automatically when the theme changes — no need to
// thread a theme prop through the whole tree. Components re-render on toggle via
// useTheme() at the top-level screens (App/SuperAdminApp/AuthScreen/Reset), the
// same external-store pattern as i18n. Tailwind literal classes (bg-white,
// hover:bg-slate-50, …) are handled by `.theme-dark` overrides in index.css,
// since inline styles can't reach them.
const LIGHT = {
  navy: "#163B73",
  sky: "#2E6EE8",
  pale: "#EEF3FC",
  ink: "#10192B",
  slate: "#64748B",
  mint: "#1FA971",
  amber: "#D9860B",
  coral: "#E15353",
  line: "#E2E8F0",
  sidebar: "#0E1F3D",
  sidebarTop: "#14294B",
  onDark: "#AFC0DC",
  onDarkMuted: "#7E90AE",
  canvas: "#F4F7FB",
  surface: "#FFFFFF",
  zebra: "#FAFCFE",
  shadow: "0 1px 2px rgba(16,25,43,0.04), 0 4px 12px rgba(16,25,43,0.06)",
};
const DARK = {
  navy: "#A9C2EE",       // was a dark primary text/icon color → lightened for dark bg
  sky: "#4C86F5",
  pale: "#1B2740",       // tint/well backgrounds
  ink: "#E7EEF9",        // primary text
  slate: "#93A4BF",      // muted text
  mint: "#34C793",
  amber: "#E0A73B",
  coral: "#F06D6D",
  line: "#26324B",       // borders
  sidebar: "#0A1526",
  sidebarTop: "#0F1E36",
  onDark: "#AFC0DC",
  onDarkMuted: "#7E90AE",
  canvas: "#0B1220",     // page background
  surface: "#141E30",    // card/input background
  zebra: "rgba(255,255,255,0.03)", // subtle alternating row tint
  shadow: "0 1px 2px rgba(0,0,0,0.4), 0 6px 18px rgba(0,0,0,0.45)",
};

const THEME_KEY = "sdloop_theme";
function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
let THEME = loadTheme();
const themeListeners = new Set();

function applyThemeClass() {
  try {
    const el = document.documentElement;
    if (THEME === "dark") el.classList.add("theme-dark");
    else el.classList.remove("theme-dark");
  } catch { /* SSR/no-DOM guard */ }
}
applyThemeClass();

export function getTheme() {
  return THEME;
}
export function setTheme(next) {
  const v = next === "dark" ? "dark" : "light";
  if (v === THEME) return;
  THEME = v;
  try { localStorage.setItem(THEME_KEY, v); } catch { /* ignore */ }
  applyThemeClass();
  themeListeners.forEach((fn) => fn(v));
}
// Subscribe a top-level screen so a toggle re-renders the whole tree (which
// re-reads every C.* getter through the Proxy below).
export function useTheme() {
  const [theme, setThemeState] = useState(THEME);
  useEffect(() => {
    const fn = (v) => setThemeState(v);
    themeListeners.add(fn);
    if (THEME !== theme) setThemeState(THEME);
    return () => themeListeners.delete(fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { theme, setTheme };
}

// `C` reads the active palette on every property access.
export const C = new Proxy({}, {
  get(_t, prop) {
    const pal = THEME === "dark" ? DARK : LIGHT;
    return pal[prop];
  },
});

// Small light/dark toggle for the sidebar (mirrors LanguageSwitcher styling).
export function ThemeToggle({ dark = false }) {
  const { theme, setTheme: set } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={() => set(isDark ? "light" : "dark")}
      className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium"
      style={{
        borderColor: dark ? "rgba(255,255,255,0.16)" : C.line,
        color: dark ? "#AFC0DC" : C.slate,
        backgroundColor: dark ? "rgba(255,255,255,0.06)" : "transparent",
      }}
      title={isDark ? t("Φωτεινό θέμα") : t("Σκούρο θέμα")}
    >
      {isDark ? <Sun size={13} /> : <Moon size={13} />}
      {isDark ? t("Φωτεινό") : t("Σκούρο")}
    </button>
  );
}

export function fmtMoney(value, currency = "EUR") {
  if (value == null || value === "") return "-";
  const symbol = currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${Number(value).toLocaleString("el-GR", { maximumFractionDigits: 2 })}`;
}

export function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("el-GR", { day: "2-digit", month: "short" });
}

export function Card({ children, className = "", style }) {
  return (
    <div
      className={`rounded-2xl bg-white border ${className}`}
      style={{ borderColor: C.line, boxShadow: C.shadow, ...style }}
    >
      {children}
    </div>
  );
}

export function Spinner({ label }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm" style={{ color: C.slate }}>
      <Loader2 size={16} className="animate-spin" />
      {label || t("Φόρτωση…")}
    </div>
  );
}

export function ErrorNote({ message, onRetry }) {
  if (!message) return null;
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-4 py-3 text-sm mb-4"
      style={{ backgroundColor: `${C.coral}14`, color: C.coral }}
    >
      <AlertTriangle size={15} />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="font-medium underline shrink-0">{t("Δοκίμασε ξανά")}</button>
      )}
    </div>
  );
}

// A sticky view header bar. Pins to the top of the scrolling content pane so
// the page title/actions stay visible while a long list scrolls under it.
// Needs an opaque background (the canvas color) so scrolled content doesn't
// bleed through. Use as the first child of a `h-full overflow-auto` view.
export function PageHeader({ children, className = "" }) {
  return (
    <div
      className={`sticky top-0 z-20 border-b ${className}`}
      style={{ borderColor: C.line, backgroundColor: C.canvas }}
    >
      {children}
    </div>
  );
}

// Friendly empty state: an icon in a soft tinted disc, a title, an optional
// one-line hint, and an optional call-to-action button. Replaces bare "no data"
// text so dead ends become next steps.
export function EmptyState({ icon: Icon, title, hint, actionLabel, onAction, className = "" }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-16 px-6 ${className}`}>
      {Icon && (
        <div className="flex items-center justify-center rounded-2xl mb-3" style={{ width: 52, height: 52, backgroundColor: C.pale }}>
          <Icon size={24} strokeWidth={1.8} style={{ color: C.sky }} />
        </div>
      )}
      <div className="text-sm font-semibold" style={{ color: C.ink }}>{title}</div>
      {hint && <div className="text-xs mt-1 max-w-xs" style={{ color: C.slate }}>{hint}</div>}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white"
          style={{ backgroundColor: C.sky, boxShadow: "0 4px 12px rgba(46,110,232,0.25)" }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// Shimmering placeholder block for loading states — nicer than a spinner for
// tables/cards because it hints at the shape of what's coming and doesn't jump.
export function Skeleton({ className = "", style }) {
  return <div className={`animate-pulse rounded-md ${className}`} style={{ backgroundColor: "#E8EEF6", ...style }} />;
}

// A few skeleton table rows, matched to a column count.
export function SkeletonRows({ rows = 6, cols = 4 }) {
  return (
    <div className="divide-y" style={{ borderColor: C.line }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3" style={{ flex: c === 0 ? 2 : 1, opacity: 1 - r * 0.08 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StatCard({ label, value, sub, color }) {
  // A thin colored accent rail on the left ties the metric to its status color
  // and gives the stat row a more deliberate, dashboard-grade rhythm.
  return (
    <Card className="p-5 flex-1 relative overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: color || C.sky }} />
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.slate }}>{label}</div>
      <div className="text-[26px] leading-tight font-bold mt-2" style={{ color: C.ink, fontFamily: "IBM Plex Mono, monospace", letterSpacing: "-0.02em" }}>{value}</div>
      <div className="text-xs mt-1" style={{ color }}>{sub}</div>
    </Card>
  );
}

export function Logo({ size = 34 }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="w-full h-full rounded-xl flex items-center justify-center"
        style={{ background: `linear-gradient(135deg, ${C.sky}, ${C.navy})`, boxShadow: "0 3px 10px rgba(22,59,115,0.35)" }}
      >
        <PhoneCall size={size * 0.5} strokeWidth={2.2} className="text-white" />
      </div>
      <span
        className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full"
        style={{ width: size * 0.42, height: size * 0.42, backgroundColor: C.mint, border: "2px solid #fff" }}
      >
        <RefreshCw size={size * 0.22} strokeWidth={3} className="text-white" />
      </span>
    </div>
  );
}

export function Brand({ size = 34, textSize = "text-lg", light = false }) {
  return (
    <div className="flex items-center gap-2.5">
      <Logo size={size} />
      <span className={`${textSize} font-semibold`} style={{ color: light ? "#FFFFFF" : C.ink, fontFamily: "Sora, sans-serif", letterSpacing: "-0.01em" }}>
        SD<span style={{ color: light ? "#7FB0FF" : C.sky }}>Loop</span>
      </span>
    </div>
  );
}

// Shared status metadata/badges - used by App.jsx's Offers/Contacts/
// Campaigns/Analytics views alike, so they live here rather than in App.jsx
// itself (which would defeat lazy-loading AnalyticsView.jsx, since that file
// needs these too without pulling in the whole App.jsx module).
export const OFFER_STATUSES = [
  { key: "draft", label: "Πρόχειρο", color: C.slate },
  { key: "sent", label: "Στάλθηκε", color: C.sky },
  { key: "accepted", label: "Έγινε δεκτό", color: C.mint },
  { key: "declined", label: "Απορρίφθηκε", color: C.coral },
];

export const CAMPAIGN_STATUS_META = {
  draft:     { label: "Πρόχειρο", color: C.slate },
  running:   { label: "Σε εξέλιξη", color: C.mint },
  paused:    { label: "Σε παύση", color: C.amber },
  completed: { label: "Ολοκληρώθηκε", color: C.sky },
};

export function CampaignStatusBadge({ status }) {
  const meta = CAMPAIGN_STATUS_META[status] || CAMPAIGN_STATUS_META.draft;
  return (
    <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium" style={{ backgroundColor: `${meta.color}1A`, color: meta.color }}>
      {t(meta.label)}
    </span>
  );
}
