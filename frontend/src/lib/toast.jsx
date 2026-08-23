// Lightweight toast notifications. Design mirrors lib/i18n.jsx's tiny external
// store: a module-level listener set + a push function, so ANY code (event
// handlers, async callbacks, even non-component modules) can fire a toast via
// `toast.success("Saved")` without prop-drilling a context down the tree. The
// app renders a single <Toaster /> which subscribes and draws the stack.
import { useState, useEffect } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { C } from "./ui.jsx";

let seq = 0;
const listeners = new Set();
const live = [];

function push(message, type = "info", opts = {}) {
  if (!message) return;
  const id = ++seq;
  const item = { id, message, type, duration: opts.duration ?? 3800, action: opts.action || null };
  live.push(item);
  listeners.forEach((fn) => fn([...live]));
  if (item.duration > 0) {
    setTimeout(() => dismiss(id), item.duration);
  }
  return id;
}

function dismiss(id) {
  const i = live.findIndex((t) => t.id === id);
  if (i !== -1) {
    live.splice(i, 1);
    listeners.forEach((fn) => fn([...live]));
  }
}

// Public API: toast("...") or toast.success/error/info("...").
export function toast(message, opts) {
  return push(message, "info", opts);
}
toast.success = (m, o) => push(m, "success", o);
toast.error = (m, o) => push(m, "error", o);
toast.info = (m, o) => push(m, "info", o);
toast.dismiss = dismiss;

// Deferred destructive action with an Undo affordance. Instead of committing
// immediately, we show a toast with an "Undo" button and only run `commit`
// after the toast's lifetime elapses (unless the user undoes it). This gives a
// real safety net without needing server-side soft-delete. `undo` is optional
// (e.g. to restore optimistic UI). Labels are passed in so callers localize.
export function toastUndo(message, commit, { undoLabel = "Undo", duration = 5000, undo } = {}) {
  let undone = false;
  const id = push(message, "info", {
    duration,
    action: {
      label: undoLabel,
      onClick: () => { undone = true; dismiss(id); if (undo) undo(); },
    },
  });
  setTimeout(() => { if (!undone) { try { commit(); } catch (_) { /* swallow */ } } }, duration);
  return id;
}

const META = {
  success: { Icon: CheckCircle2, color: C.mint },
  error: { Icon: AlertTriangle, color: C.coral },
  info: { Icon: Info, color: C.sky },
};

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    listeners.add(setItems);
    return () => listeners.delete(setItems);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 items-end" style={{ pointerEvents: "none" }}>
      {items.map((it) => {
        const { Icon, color } = META[it.type] || META.info;
        return (
          <div
            key={it.id}
            className="flex items-center gap-2.5 rounded-xl pl-3.5 pr-2.5 py-2.5 text-sm bg-white border max-w-sm"
            style={{ borderColor: C.line, boxShadow: "0 10px 30px rgba(16,25,43,0.16)", pointerEvents: "auto", animation: "sdloop-toast-in 160ms ease-out" }}
          >
            <Icon size={17} style={{ color }} className="shrink-0" />
            <span className="flex-1 min-w-0" style={{ color: C.ink }}>{it.message}</span>
            {it.action && (
              <button
                onClick={it.action.onClick}
                className="shrink-0 text-xs font-semibold rounded-md px-2 py-1"
                style={{ color: C.sky, backgroundColor: `${C.sky}14` }}
              >
                {it.action.label}
              </button>
            )}
            <button onClick={() => dismiss(it.id)} className="shrink-0 text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          </div>
        );
      })}
      <style>{`@keyframes sdloop-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
