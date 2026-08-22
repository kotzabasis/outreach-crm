// Lightweight i18n for the app. Design goals:
// - No heavy dependency (fits the app's minimal-deps style).
// - The Greek string IS the key: t("Νέα επαφή") returns Greek in EL mode and
//   looks up an English translation in EN mode, falling back to the Greek if a
//   translation is missing — so nothing ever renders blank/broken while the
//   dictionary is still being filled in.
// - Language preference lives in localStorage (per browser), so no backend/DB
//   change is needed. Default is Greek (the app's original language).
//
// Re-render model: a tiny external store (module-level LANG + a listener set).
// Any component that calls useLang() subscribes and re-renders on a switch.
// The two top-level screens (App, SuperAdminApp) call useLang() at their top,
// and since they build their whole child tree inline during render, a language
// switch re-renders everything and every t() call re-evaluates.

import { useState, useEffect } from "react";
import { EN } from "./translations";

const STORAGE_KEY = "sdloop_lang";

function load() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "en" || v === "el" ? v : "el";
  } catch {
    return "el";
  }
}

let LANG = load();
const listeners = new Set();

export function getLang() {
  return LANG;
}

export function setLang(lang) {
  const next = lang === "en" ? "en" : "el";
  if (next === LANG) return;
  LANG = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore (private mode etc.) */
  }
  listeners.forEach((fn) => fn(next));
}

// Translate a Greek source string. `vars` interpolates {name}-style tokens, so
// dynamic strings work too: t("{n} επαφές", { n: 5 }).
export function t(el, vars) {
  let s = LANG === "en" ? (EN[el] ?? el) : el;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split(`{${k}}`).join(String(vars[k]));
    }
  }
  return s;
}

export function useLang() {
  const [lang, setLangState] = useState(LANG);
  useEffect(() => {
    const fn = (l) => setLangState(l);
    listeners.add(fn);
    // Sync in case LANG changed between render and effect.
    if (LANG !== lang) setLangState(LANG);
    return () => listeners.delete(fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { lang, setLang };
}

// Small EL/EN toggle for the header. `compact` renders a tighter version.
export function LanguageSwitcher({ compact = false }) {
  const { lang, setLang } = useLang();
  const opts = [
    ["el", "ΕΛ"],
    ["en", "EN"],
  ];
  return (
    <div
      className="inline-flex items-center rounded-lg border overflow-hidden"
      style={{ borderColor: "#E2E8F0" }}
      role="group"
      aria-label="Language"
    >
      {opts.map(([code, label]) => {
        const active = lang === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            className={`text-xs font-semibold ${compact ? "px-2 py-1" : "px-2.5 py-1.5"}`}
            style={{
              backgroundColor: active ? "#2E6EE8" : "#fff",
              color: active ? "#fff" : "#64748B",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
