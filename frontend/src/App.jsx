import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  Mail, Send, Users, BarChart3, Layers, Search, Upload, Plus, X,
  Clock, Tag, ChevronRight, Trash2, Pencil, MoreVertical, Paperclip,
  Minus, Maximize2, ChevronDown, Building2, CircleCheck, CircleDot,
  CircleX, Reply, LogOut, MailCheck, Loader2, AlertTriangle
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Funnel, FunnelChart, LabelList
} from "recharts";
import { api, API_URL, ApiError } from "./lib/api";

// ---------- Design tokens ----------
// Color: navy #163B73 (primary), sky #2E6EE8 (accent/action), pale #EEF3FC (tint bg),
// ink #10192B (text), slate #64748B (muted), mint #1FA971 (positive), amber #D9860B (pending), coral #E15353 (negative)
const C = {
  navy: "#163B73",
  sky: "#2E6EE8",
  pale: "#EEF3FC",
  ink: "#10192B",
  slate: "#64748B",
  mint: "#1FA971",
  amber: "#D9860B",
  coral: "#E15353",
  line: "#E2E8F0",
};

const statusMeta = {
  new:         { label: "Νέο",        color: C.slate, Icon: CircleDot },
  contacted:   { label: "Στάλθηκε",   color: C.sky,   Icon: Send },
  opened:      { label: "Άνοιξε",     color: C.amber, Icon: CircleDot },
  replied:     { label: "Απάντησε",   color: C.mint,  Icon: Reply },
  bounced:     { label: "Bounce",     color: C.coral, Icon: CircleX },
  unsubscribed:{ label: "Unsubscribed", color: C.slate, Icon: CircleX },
};

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("el-GR", { day: "2-digit", month: "short" });
}

// ---------- Small building blocks ----------
function Pill({ status }) {
  const meta = statusMeta[status] || statusMeta.new;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ backgroundColor: `${meta.color}1A`, color: meta.color }}
    >
      <meta.Icon size={12} strokeWidth={2.5} />
      {meta.label}
    </span>
  );
}

function TagChip({ children }) {
  return (
    <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: C.pale, color: C.navy }}>
      {children}
    </span>
  );
}

function NavItem({ icon: Icon, label, active, onClick, count }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"
      style={{
        backgroundColor: active ? C.pale : "transparent",
        color: active ? C.navy : "#475569",
      }}
    >
      <Icon size={17} strokeWidth={2} />
      <span className="flex-1 text-left">{label}</span>
      {count != null && (
        <span className="text-xs font-semibold" style={{ color: active ? C.navy : C.slate }}>{count}</span>
      )}
    </button>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl bg-white border ${className}`} style={{ borderColor: C.line }}>
      {children}
    </div>
  );
}

function Spinner({ label }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm" style={{ color: C.slate }}>
      <Loader2 size={16} className="animate-spin" />
      {label || "Φόρτωση…"}
    </div>
  );
}

function ErrorNote({ message, onRetry }) {
  if (!message) return null;
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-4 py-3 text-sm mb-4"
      style={{ backgroundColor: `${C.coral}14`, color: C.coral }}
    >
      <AlertTriangle size={15} />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="font-medium underline shrink-0">Δοκίμασε ξανά</button>
      )}
    </div>
  );
}

// ---------- Auth ----------
function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user =
        mode === "login"
          ? await api.post("/auth/login", { email, password })
          : await api.post("/auth/register", { email, password, name: name || undefined });
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Κάτι πήγε στραβά. Δοκίμασε ξανά.");
    } finally {
      // Never leave the password sitting in memory longer than necessary,
      // success or failure.
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full items-center justify-center" style={{ backgroundColor: "#F7F9FC", fontFamily: "Inter, sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-8">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: C.navy }}>
            <Layers size={18} className="text-white" />
          </div>
          <span className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Loop</span>
        </div>

        <Card className="p-6">
          <div className="flex rounded-lg p-1 mb-5" style={{ backgroundColor: C.pale }}>
            {["login", "register"].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(""); }}
                className="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
                style={{ backgroundColor: mode === m ? "#fff" : "transparent", color: mode === m ? C.navy : C.slate }}
              >
                {m === "login" ? "Σύνδεση" : "Εγγραφή"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === "register" && (
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Όνομα</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm border outline-none"
                  style={{ borderColor: C.line, color: C.ink }}
                  autoComplete="name"
                />
              </div>
            )}
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none"
                style={{ borderColor: C.line, color: C.ink }}
                autoComplete="email"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Κωδικός</label>
              <input
                type="password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none"
                style={{ borderColor: C.line, color: C.ink }}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
              {mode === "register" && (
                <p className="text-[11px] mt-1" style={{ color: C.slate }}>Τουλάχιστον 10 χαρακτήρες.</p>
              )}
            </div>

            {error && (
              <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white mt-2"
              style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {mode === "login" ? "Σύνδεση" : "Δημιουργία λογαριασμού"}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function GmailBanner({ user }) {
  if (!user || user.gmail) return null;
  return (
    <div className="flex items-center justify-between px-6 py-2.5 text-sm" style={{ backgroundColor: `${C.amber}14`, color: "#7A5206" }}>
      <span>Δεν έχεις συνδέσει Gmail ακόμα — η αποστολή μέσω sequences δεν θα δουλέψει χωρίς αυτό.</span>
      <a
        href={`${API_URL}/auth/google`}
        className="font-medium rounded-lg px-3 py-1.5 text-white shrink-0"
        style={{ backgroundColor: C.amber }}
      >
        Σύνδεση Gmail
      </a>
    </div>
  );
}

// ---------- Views ----------
function NewContactModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: "", email: "", company: "", tags: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onCreate(form);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η δημιουργία επαφής.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέα επαφή</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required placeholder="Όνομα" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Εταιρεία" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Ετικέτες (χωρισμένες με κόμμα)" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Προσθήκη
          </button>
        </form>
      </Card>
    </div>
  );
}

function ContactsView({ contacts, loading, error, onReload, sequences, onUpload, onCreate, onEnroll }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      const matchesQuery = (c.name + c.email + (c.company || "")).toLowerCase().includes(query.toLowerCase());
      const matchesStatus = statusFilter === "all" || c.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [contacts, query, statusFilter]);

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUploadNote("");
    try {
      const result = await onUpload(file);
      setUploadNote(`Προστέθηκαν ${result.created}, αγνοήθηκαν ${result.skipped}.`);
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Το ανέβασμα απέτυχε.");
    } finally {
      setUploading(false);
    }
  }

  async function handleEnroll() {
    if (!enrollSeqId || selected.size === 0) return;
    try {
      await onEnroll(Array.from(selected), enrollSeqId);
      setSelected(new Set());
      setEnrollSeqId("");
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Η εγγραφή απέτυχε.");
    }
  }

  return (
    <div className="flex flex-col h-full">
      {showNew && <NewContactModal onClose={() => setShowNew(false)} onCreate={onCreate} />}
      <div className="flex items-center justify-between px-6 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Επαφές</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>{contacts.length} επαφές συνολικά</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border"
            style={{ borderColor: C.line, color: C.ink, opacity: uploading ? 0.6 : 1 }}
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Ανέβασμα CSV
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}
          >
            <Plus size={15} /> Νέα επαφή
          </button>
        </div>
      </div>

      {uploadNote && (
        <div className="px-6 pt-3">
          <p className="text-xs rounded-lg px-3 py-2 inline-block" style={{ backgroundColor: C.pale, color: C.navy }}>{uploadNote}</p>
        </div>
      )}

      <div className="flex items-center gap-3 px-6 py-3 border-b" style={{ borderColor: C.line }}>
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 flex-1 max-w-sm" style={{ backgroundColor: C.pale }}>
          <Search size={15} style={{ color: C.slate }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Αναζήτηση ονόματος, email, εταιρείας…"
            className="bg-transparent outline-none text-sm flex-1"
            style={{ color: C.ink }}
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm border outline-none"
          style={{ borderColor: C.line, color: C.ink }}
        >
          <option value="all">Όλες οι καταστάσεις</option>
          {Object.entries(statusMeta).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs font-medium" style={{ color: C.slate }}>{selected.size} επιλεγμένες</span>
            <select
              value={enrollSeqId}
              onChange={(e) => setEnrollSeqId(e.target.value)}
              className="rounded-lg px-2 py-1.5 text-sm border outline-none"
              style={{ borderColor: C.line, color: C.ink }}
            >
              <option value="">Εγγραφή σε sequence…</option>
              {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button
              onClick={handleEnroll}
              disabled={!enrollSeqId}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
              style={{ backgroundColor: C.sky, opacity: enrollSeqId ? 1 : 0.5 }}
            >
              Εγγραφή
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση επαφών…" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: C.slate }}>
                <th className="font-medium pb-3 w-8"></th>
                <th className="font-medium pb-3">Όνομα</th>
                <th className="font-medium pb-3">Εταιρεία</th>
                <th className="font-medium pb-3">Κατάσταση</th>
                <th className="font-medium pb-3">Sequence</th>
                <th className="font-medium pb-3">Ετικέτες</th>
                <th className="font-medium pb-3">Τελ. ενέργεια</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: C.line }}>
                  <td className="py-3">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelected(c.id)} />
                  </td>
                  <td className="py-3">
                    <div className="font-medium" style={{ color: C.ink }}>{c.name}</div>
                    <div className="text-xs" style={{ color: C.slate }}>{c.email}</div>
                  </td>
                  <td className="py-3" style={{ color: C.ink }}>
                    <div className="flex items-center gap-1.5">
                      <Building2 size={13} style={{ color: C.slate }} />
                      {c.company || "—"}
                    </div>
                  </td>
                  <td className="py-3"><Pill status={c.status} /></td>
                  <td className="py-3" style={{ color: C.ink }}>
                    {c.currentSequence ? `${c.currentSequence} · βήμα ${c.currentStep}` : "—"}
                  </td>
                  <td className="py-3">
                    <div className="flex gap-1 flex-wrap">
                      {(c.tags || "").split(",").filter(Boolean).map((t) => <TagChip key={t}>{t.trim()}</TagChip>)}
                    </div>
                  </td>
                  <td className="py-3 text-xs" style={{ color: C.slate }}>{fmtDate(c.lastActivityAt)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: C.slate }}>Καμία επαφή δεν ταιριάζει.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SequenceStep({ step, index, isLast }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white" style={{ backgroundColor: C.navy }}>
          {index + 1}
        </div>
        {!isLast && <div className="w-px flex-1 mt-1" style={{ backgroundColor: C.line, minHeight: 32 }} />}
      </div>
      <div className="flex-1 pb-6">
        <div className="flex items-center gap-2 text-xs mb-1.5" style={{ color: C.slate }}>
          <Clock size={12} />
          {step.delayDays === 0 ? "Άμεση αποστολή" : `${step.delayDays} ημέρες μετά`}
        </div>
        <Card className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium" style={{ color: C.ink }}>{step.subject}</span>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: C.slate }}>{step.body}</p>
        </Card>
      </div>
    </div>
  );
}

function NewSequenceModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delayDays, setDelayDays] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onCreate({ name, steps: [{ subject, body, delayDays: Number(delayDays) || 0 }] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η δημιουργία sequence.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέο sequence</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required placeholder="Όνομα sequence" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <p className="text-xs font-medium" style={{ color: C.slate }}>Πρώτο βήμα</p>
          <input required placeholder="Θέμα (π.χ. Γρήγορη ιδέα για το {{company}})" value={subject} onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <textarea required placeholder="Κείμενο μηνύματος" value={body} onChange={(e) => setBody(e.target.value)} rows={4}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none" style={{ borderColor: C.line, color: C.ink }} />
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Καθυστέρηση (ημέρες)</label>
            <input type="number" min={0} max={60} value={delayDays} onChange={(e) => setDelayDays(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Δημιουργία
          </button>
        </form>
      </Card>
    </div>
  );
}

function SequencesView({ sequences, loading, error, onReload, onCreate }) {
  const [activeId, setActiveId] = useState(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (sequences.length > 0 && !sequences.some((s) => s.id === activeId)) {
      setActiveId(sequences[0].id);
    }
  }, [sequences, activeId]);

  const active = sequences.find((s) => s.id === activeId);

  return (
    <div className="flex h-full">
      {showNew && <NewSequenceModal onClose={() => setShowNew(false)} onCreate={onCreate} />}
      <div className="w-72 border-r flex flex-col" style={{ borderColor: C.line }}>
        <div className="flex items-center justify-between px-5 py-5 border-b" style={{ borderColor: C.line }}>
          <h2 className="text-base font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Sequences</h2>
          <button onClick={() => setShowNew(true)} className="rounded-lg p-1.5" style={{ backgroundColor: C.pale }}><Plus size={15} style={{ color: C.navy }} /></button>
        </div>
        <div className="flex-1 overflow-auto px-3 py-2">
          {loading && <Spinner label="Φόρτωση…" />}
          {!loading && sequences.length === 0 && (
            <p className="text-sm text-center py-8" style={{ color: C.slate }}>Δεν υπάρχουν sequences ακόμα.</p>
          )}
          {sequences.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className="w-full text-left rounded-xl px-3 py-3 mb-1"
              style={{ backgroundColor: activeId === s.id ? C.pale : "transparent" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: C.ink }}>{s.name}</span>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.active ? C.mint : C.slate }} />
              </div>
              <div className="text-xs mt-1" style={{ color: C.slate }}>
                {s.steps.length} βήματα · {s.stats?.sent ?? 0} αποστολές
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <ErrorNote message={error} onRetry={onReload} />
        {active ? (
          <>
            <div className="flex items-center justify-between px-8 py-5 border-b" style={{ borderColor: C.line }}>
              <div>
                <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{active.name}</h1>
                <p className="text-sm mt-0.5" style={{ color: C.slate }}>
                  {active.stats?.sent ?? 0} στάλθηκαν · {active.stats?.opened ?? 0} ανοίχτηκαν · {active.stats?.replied ?? 0} απαντήσεις
                </p>
              </div>
            </div>
            <div className="px-8 py-8 max-w-2xl">
              {active.steps.map((step, i) => (
                <SequenceStep key={step.id} step={step} index={i} isLast={i === active.steps.length - 1} />
              ))}
            </div>
          </>
        ) : (
          !loading && <div className="p-8 text-sm" style={{ color: C.slate }}>Διάλεξε ή φτιάξε ένα sequence.</div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }) {
  return (
    <Card className="p-5 flex-1">
      <div className="text-xs font-medium uppercase tracking-wide" style={{ color: C.slate }}>{label}</div>
      <div className="text-2xl font-semibold mt-2" style={{ color: C.ink, fontFamily: "IBM Plex Mono, monospace" }}>{value}</div>
      <div className="text-xs mt-1" style={{ color }}>{sub}</div>
    </Card>
  );
}

function pct(numerator, denominator) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function AnalyticsView({ overview, timeline, loading, error, onReload }) {
  const totals = overview?.totals || { sent: 0, opened: 0, clicked: 0, replied: 0 };
  const funnelData = [
    { name: "Στάλθηκαν", value: totals.sent, fill: C.navy },
    { name: "Ανοίχτηκαν", value: totals.opened, fill: C.sky },
    { name: "Κλικ", value: totals.clicked, fill: C.amber },
    { name: "Απαντήσεις", value: totals.replied, fill: C.mint },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Analytics</h1>
        <p className="text-sm mt-0.5" style={{ color: C.slate }}>Απόδοση όλων των sequences</p>
      </div>

      <div className="px-8 py-6 space-y-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση analytics…" />
        ) : (
          <>
            <div className="flex gap-4">
              <StatCard label="Open rate" value={pct(totals.opened, totals.sent)} sub={`${totals.sent} αποστολές`} color={C.mint} />
              <StatCard label="Click rate" value={pct(totals.clicked, totals.sent)} sub="σε σχέση με αποστολές" color={C.mint} />
              <StatCard label="Reply rate" value={pct(totals.replied, totals.sent)} sub="σε σχέση με αποστολές" color={C.coral} />
              <StatCard label="Sequences" value={overview?.perSequence?.length ?? 0} sub="ενεργά + ανενεργά" color={C.slate} />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <Card className="p-5">
                <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Τάση εμπλοκής</div>
                {timeline.length === 0 ? (
                  <p className="text-sm py-16 text-center" style={{ color: C.slate }}>Δεν υπάρχουν ακόμα events.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={timeline}>
                      <CartesianGrid stroke={C.line} vertical={false} />
                      <XAxis dataKey="day" tick={{ fontSize: 11, fill: C.slate }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: C.slate }} axisLine={false} tickLine={false} />
                      <Tooltip />
                      <Line type="monotone" dataKey="opens" stroke={C.sky} strokeWidth={2} dot={false} name="Ανοίγματα" />
                      <Line type="monotone" dataKey="clicks" stroke={C.amber} strokeWidth={2} dot={false} name="Κλικ" />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </Card>

              <Card className="p-5">
                <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Funnel αποστολών</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={funnelData} layout="vertical" margin={{ left: 20 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: C.ink }} axisLine={false} tickLine={false} width={100} />
                    <Tooltip />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                      {funnelData.map((d, i) => <React.Fragment key={i} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <Card className="p-5">
              <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Απόδοση ανά sequence</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-2">Sequence</th>
                    <th className="font-medium pb-2">Στάλθηκαν</th>
                    <th className="font-medium pb-2">Open rate</th>
                    <th className="font-medium pb-2">Reply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview?.perSequence || []).map((s) => (
                    <tr key={s.id} className="border-t" style={{ borderColor: C.line }}>
                      <td className="py-2.5 font-medium" style={{ color: C.ink }}>{s.name}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{s.sent}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{pct(s.opened, s.sent)}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{pct(s.replied, s.sent)}</td>
                    </tr>
                  ))}
                  {(!overview?.perSequence || overview.perSequence.length === 0) && (
                    <tr><td colSpan={4} className="py-6 text-center text-sm" style={{ color: C.slate }}>Καμία δραστηριότητα ακόμα.</td></tr>
                  )}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function InboxView({ activity, loading, error, onReload, setComposeOpen }) {
  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Απεσταλμένα</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>Emails που στάλθηκαν μέσω sequences</p>
        </div>
        <button
          onClick={() => setComposeOpen(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white"
          style={{ backgroundColor: C.sky }}
        >
          <Pencil size={15} /> Σύνταξη
        </button>
      </div>
      <div className="px-8 py-4">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση…" />
        ) : activity.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-sm" style={{ color: C.slate }}>
            <MailCheck size={28} strokeWidth={1.5} />
            Δεν έχει σταλεί κανένα email ακόμα.
          </div>
        ) : (
          activity.map((m) => (
            <div key={m.id} className="flex items-center justify-between py-3.5 border-b" style={{ borderColor: C.line }}>
              <div className="flex items-center gap-3 min-w-0">
                <Mail size={16} style={{ color: C.slate }} />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{m.subject}</div>
                  <div className="text-xs truncate" style={{ color: C.slate }}>προς {m.toName || m.to}</div>
                </div>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <Pill status={m.status} />
                <span className="text-xs" style={{ color: C.slate }}>{fmtDate(m.sentAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ComposeModal({ onClose }) {
  const [minimized, setMinimized] = useState(false);
  return (
    <div
      className="fixed bottom-0 right-8 w-[420px] rounded-t-xl shadow-2xl bg-white border border-b-0 flex flex-col"
      style={{ borderColor: C.line, height: minimized ? 48 : 460, zIndex: 50 }}
    >
      <div className="flex items-center justify-between px-4 py-3 rounded-t-xl" style={{ backgroundColor: C.navy }}>
        <span className="text-sm font-medium text-white">Νέο μήνυμα</span>
        <div className="flex items-center gap-3">
          <button onClick={() => setMinimized((m) => !m)} className="text-white/80 hover:text-white"><Minus size={15} /></button>
          <button onClick={onClose} className="text-white/80 hover:text-white"><X size={15} /></button>
        </div>
      </div>
      {!minimized && (
        <div className="flex-1 flex flex-col">
          <div className="px-4 py-2.5 border-b text-sm" style={{ borderColor: C.line, color: C.ink }}>
            <input placeholder="Προς" className="w-full outline-none" />
          </div>
          <div className="px-4 py-2.5 border-b text-sm" style={{ borderColor: C.line, color: C.ink }}>
            <input placeholder="Θέμα" className="w-full outline-none" />
          </div>
          <textarea
            placeholder="Γράψε το μήνυμά σου…"
            className="flex-1 px-4 py-3 text-sm outline-none resize-none"
            style={{ color: C.ink }}
          />
          <div className="px-4 py-3 border-t text-xs" style={{ borderColor: C.line, color: C.slate }}>
            Η χειροκίνητη αποστολή δεν είναι διαθέσιμη ακόμα — χρησιμοποίησε sequences για αποστολή μέσω Gmail.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [authState, setAuthState] = useState("loading"); // loading | anon | authed
  const [user, setUser] = useState(null);
  const [view, setView] = useState("inbox");
  const [composeOpen, setComposeOpen] = useState(false);
  const [gmailNotice, setGmailNotice] = useState("");

  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState("");

  const [sequences, setSequences] = useState([]);
  const [sequencesLoading, setSequencesLoading] = useState(false);
  const [sequencesError, setSequencesError] = useState("");

  const [overview, setOverview] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState("");

  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");

  const loadContacts = useCallback(async () => {
    setContactsLoading(true);
    setContactsError("");
    try {
      setContacts(await api.get("/contacts"));
    } catch (err) {
      setContactsError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν οι επαφές.");
    } finally {
      setContactsLoading(false);
    }
  }, []);

  const loadSequences = useCallback(async () => {
    setSequencesLoading(true);
    setSequencesError("");
    try {
      const [seqs, ov] = await Promise.all([api.get("/sequences"), api.get("/analytics/overview")]);
      const statsById = Object.fromEntries((ov.perSequence || []).map((s) => [s.id, s]));
      setSequences(seqs.map((s) => ({ ...s, stats: statsById[s.id] || { sent: 0, opened: 0, clicked: 0, replied: 0 } })));
    } catch (err) {
      setSequencesError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν τα sequences.");
    } finally {
      setSequencesLoading(false);
    }
  }, []);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setAnalyticsError("");
    try {
      const [ov, tl] = await Promise.all([api.get("/analytics/overview"), api.get("/analytics/timeline?days=14")]);
      setOverview(ov);
      setTimeline(tl);
    } catch (err) {
      setAnalyticsError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν τα analytics.");
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    setActivityError("");
    try {
      setActivity(await api.get("/analytics/activity"));
    } catch (err) {
      setActivityError(err instanceof ApiError ? err.message : "Δεν φορτώθηκε η δραστηριότητα.");
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    loadContacts();
    loadSequences();
    loadAnalytics();
    loadActivity();
  }, [loadContacts, loadSequences, loadAnalytics, loadActivity]);

  // Session check on mount, plus handling the redirect back from Google OAuth
  // (?gmail_connected=1|0) without leaving it sitting in the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailConnected = params.get("gmail_connected");
    if (gmailConnected !== null) {
      setGmailNotice(gmailConnected === "1" ? "Το Gmail συνδέθηκε." : "Η σύνδεση Gmail απέτυχε ή ακυρώθηκε.");
      params.delete("gmail_connected");
      params.delete("reason");
      const clean = window.location.pathname + (params.toString() ? `?${params}` : "");
      window.history.replaceState({}, "", clean);
    }

    api
      .get("/auth/me")
      .then((u) => {
        setUser(u);
        setAuthState("authed");
      })
      .catch(() => setAuthState("anon"));
  }, []);

  useEffect(() => {
    if (authState === "authed") refreshAll();
  }, [authState, refreshAll]);

  async function handleLogout() {
    try {
      await api.post("/auth/logout");
    } catch {
      // Even if the request fails, drop the client-side session state —
      // worst case the cookie is still valid server-side until it expires.
    }
    setUser(null);
    setAuthState("anon");
    setContacts([]);
    setSequences([]);
    setOverview(null);
    setTimeline([]);
    setActivity([]);
  }

  async function handleCreateContact(data) {
    await api.post("/contacts", data);
    await loadContacts();
  }

  async function handleUploadCsv(file) {
    const result = await api.uploadCsv("/contacts/upload", file);
    await loadContacts();
    return result;
  }

  async function handleEnroll(contactIds, sequenceId) {
    await api.post(`/sequences/${sequenceId}/enroll`, { contactIds });
    await Promise.all([loadContacts(), loadSequences()]);
  }

  async function handleCreateSequence(data) {
    await api.post("/sequences", data);
    await loadSequences();
  }

  if (authState === "loading") {
    return (
      <div className="flex h-screen w-full items-center justify-center" style={{ backgroundColor: "#F7F9FC" }}>
        <Spinner label="Φόρτωση…" />
      </div>
    );
  }

  if (authState === "anon") {
    return (
      <AuthScreen
        onAuthenticated={(u) => {
          setUser(u);
          setAuthState("authed");
        }}
      />
    );
  }

  const counts = {
    inbox: activity.length,
    contacts: contacts.length,
    sequences: sequences.filter((s) => s.active).length,
  };

  return (
    <div className="flex h-screen w-full" style={{ backgroundColor: "#F7F9FC", fontFamily: "Inter, sans-serif" }}>
      {/* Sidebar */}
      <div className="w-60 border-r flex flex-col shrink-0" style={{ borderColor: C.line, backgroundColor: "#FFFFFF" }}>
        <div className="px-5 py-5 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: C.navy }}>
            <Layers size={16} className="text-white" />
          </div>
          <span className="text-lg font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Loop</span>
        </div>

        <div className="px-3">
          <button
            onClick={() => setComposeOpen(true)}
            className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white mb-4 shadow-sm"
            style={{ backgroundColor: C.sky }}
          >
            <Pencil size={14} /> Σύνταξη
          </button>
        </div>

        <div className="px-3 space-y-0.5 flex-1">
          <NavItem icon={Mail} label="Απεσταλμένα" active={view === "inbox"} onClick={() => setView("inbox")} count={counts.inbox} />
          <NavItem icon={Users} label="Επαφές" active={view === "contacts"} onClick={() => setView("contacts")} count={counts.contacts} />
          <NavItem icon={Layers} label="Sequences" active={view === "sequences"} onClick={() => setView("sequences")} count={counts.sequences} />
          <NavItem icon={BarChart3} label="Analytics" active={view === "analytics"} onClick={() => setView("analytics")} />
        </div>

        <div className="px-5 py-4 border-t flex items-center gap-2.5" style={{ borderColor: C.line }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0" style={{ backgroundColor: C.navy }}>
            {(user?.name || user?.email || "?").slice(0, 2).toUpperCase()}
          </div>
          <div className="text-xs min-w-0 flex-1">
            <div className="font-medium truncate" style={{ color: C.ink }}>{user?.name || "Χρήστης"}</div>
            <div className="truncate" style={{ color: C.slate }}>{user?.email}</div>
          </div>
          <button onClick={handleLogout} className="text-slate-400 hover:text-slate-600 shrink-0" title="Αποσύνδεση">
            <LogOut size={15} />
          </button>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {gmailNotice && (
          <div className="px-6 py-2 text-sm flex items-center justify-between" style={{ backgroundColor: C.pale, color: C.navy }}>
            {gmailNotice}
            <button onClick={() => setGmailNotice("")} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
          </div>
        )}
        <GmailBanner user={user} />
        <div className="flex-1 min-w-0">
          {view === "inbox" && (
            <InboxView activity={activity} loading={activityLoading} error={activityError} onReload={loadActivity} setComposeOpen={setComposeOpen} />
          )}
          {view === "contacts" && (
            <ContactsView
              contacts={contacts}
              loading={contactsLoading}
              error={contactsError}
              onReload={loadContacts}
              sequences={sequences}
              onUpload={handleUploadCsv}
              onCreate={handleCreateContact}
              onEnroll={handleEnroll}
            />
          )}
          {view === "sequences" && (
            <SequencesView sequences={sequences} loading={sequencesLoading} error={sequencesError} onReload={loadSequences} onCreate={handleCreateSequence} />
          )}
          {view === "analytics" && (
            <AnalyticsView overview={overview} timeline={timeline} loading={analyticsLoading} error={analyticsError} onReload={loadAnalytics} />
          )}
        </div>
      </div>

      {composeOpen && <ComposeModal onClose={() => setComposeOpen(false)} />}
    </div>
  );
}
