import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  Mail, Send, Users, BarChart3, Layers, Search, Upload, Plus, X,
  Clock, Tag, ChevronRight, Trash2, Pencil, MoreVertical, Paperclip,
  Minus, Maximize2, ChevronDown, Building2, CircleCheck, CircleDot,
  CircleX, Reply, LogOut, MailCheck, Loader2, AlertTriangle,
  PhoneCall, RefreshCw, Phone, FileText, Copy, ArrowUp, ArrowDown,
  ShieldCheck, UserCheck, UserX, Sparkles, Euro, StickyNote,
  CalendarClock, Download, Eye, Handshake, Bold, Italic, Underline,
  List, ListOrdered, Link as LinkIcon, UserPlus, Menu,
  AlignLeft, AlignCenter, AlignRight, Info, Megaphone, Play, Pause
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

// Cold-outreach best-practice cadence: immediate, then 3/7/14/21/30 days —
// gives ~3-5 touches, which is the sweet spot most sales/outreach guides
// converge on before diminishing returns / spam fatigue set in.
const SUGGESTED_DELAYS = [0, 3, 7, 14, 21, 30];

const MERGE_SAMPLE = {
  name: "Μαρία Παπαδοπούλου",
  company: "Acme A.E.",
  email: "maria@acme.gr",
  comments: "μου άρεσε πολύ το τελευταίο σας project",
};
const SPAM_WORDS = [
  "δωρεάν", "εγγύηση", "click here", "κάνε κλικ εδώ", "act now", "τώρα αμέσως",
  "100%", "no obligation", "χωρίς καμία δέσμευση", "buy now", "αγόρασε τώρα",
  "urgent", "επείγον", "cash", "μετρητά", "winner", "νικητής", "risk-free",
  "χωρίς ρίσκο", "limited time", "περιορισμένος χρόνος",
];

// Seeded into every brand-new template/compose/step body (empty drafts only —
// never forced onto existing content) so the unsubscribe line is there by
// default but fully editable, movable, or deletable like any other text —
// per Stelios's request that it not be a hidden, backend-only addition
// anymore. {{unsubscribe_link}} is resolved to the real per-send URL
// server-side at send time (see injectTracking in gmailClient.js); here in
// the editor/preview it's just a token like {{name}}.
const DEFAULT_DISCLAIMER_HTML =
  '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:sans-serif;font-size:11px;color:#94a3b8;">Αν δεν θέλετε να λάβετε καμία άλλη επικοινωνία από εμάς, <a href="{{unsubscribe_link}}" style="color:#94a3b8;text-decoration:underline;">πατήστε εδώ</a>.</div>';

// A body is "compliant" if it still contains a real unsubscribe link — check
// the raw HTML (not the tag-stripped plain text used for spam/word counts),
// since the token lives inside an href attribute that tag-stripping would
// throw away along with the rest of the <a> tag.
function hasUnsubscribeLink(html) {
  return (html || "").includes("{{unsubscribe_link}}");
}

function renderPreview(text) {
  if (!text) return "";
  return text
    .split("{{name}}").join(MERGE_SAMPLE.name)
    .split("{{company}}").join(MERGE_SAMPLE.company)
    .split("{{email}}").join(MERGE_SAMPLE.email)
    .split("{{comments}}").join(MERGE_SAMPLE.comments)
    // "#" keeps the preview link clickable-looking without pointing anywhere
    // real — the actual URL only exists once a send creates a trackingId.
    .split("{{unsubscribe_link}}").join("#");
}

function findSpamWords(text) {
  const lower = (text || "").toLowerCase();
  return SPAM_WORDS.filter((w) => lower.includes(w.toLowerCase()));
}

const statusMeta = {
  new:         { label: "Νέο",        color: C.slate, Icon: CircleDot },
  contacted:   { label: "Στάλθηκε",   color: C.sky,   Icon: Send },
  opened:      { label: "Άνοιξε",     color: C.amber, Icon: CircleDot },
  replied:     { label: "Απάντησε",   color: C.mint,  Icon: Reply },
  bounced:     { label: "Bounce",     color: C.coral, Icon: CircleX },
  unsubscribed:{ label: "Unsubscribed", color: C.slate, Icon: CircleX },
};

const OFFER_STATUSES = [
  { key: "draft", label: "Πρόχειρο", color: C.slate },
  { key: "sent", label: "Στάλθηκε", color: C.sky },
  { key: "accepted", label: "Έγινε δεκτό", color: C.mint },
  { key: "declined", label: "Απορρίφθηκε", color: C.coral },
];

function fmtMoney(value, currency = "EUR") {
  if (value == null || value === "") return "—";
  const symbol = currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${Number(value).toLocaleString("el-GR", { maximumFractionDigits: 2 })}`;
}

function isFollowUpDue(value) {
  if (!value) return false;
  return new Date(value).getTime() <= Date.now();
}

// Mirrors backend/src/lib/attachments.js — no external file storage, so
// attachments are capped hard and stored as base64 on the row.
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const EVENT_CONDITIONS = [
  { key: "", label: "Χωρίς συνθήκη" },
  { key: "opened", label: "Μόνο αν άνοιξε το προηγούμενο" },
  { key: "clicked", label: "Μόνο αν έκανε κλικ στο προηγούμενο" },
  { key: "not_opened", label: "Μόνο αν ΔΕΝ άνοιξε το προηγούμενο" },
  { key: "not_clicked", label: "Μόνο αν ΔΕΝ έκανε κλικ στο προηγούμενο" },
];

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("el-GR", { day: "2-digit", month: "short" });
}

// Always shows date + time — used in the per-send event trace, where fmtDate's
// "just the time if it's today" shorthand would be ambiguous across a list of
// events that might span several days.
function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("el-GR", { day: "2-digit", month: "short" })}, ${d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" })}`;
}

// Renders the chronological trace for one sent email: when it was sent, when
// (if ever) it was genuinely opened/clicked, and — transparently — any open
// that got filtered out as a bot/self-view (see isLikelyBotOpen in
// tracking.js) instead of just silently not counting it. Shared between the
// Inbox row expansion and the contact detail drawer's timeline.
function EventTrace({ sentAt, events = [] }) {
  const items = [
    { key: "sent", label: "Στάλθηκε", at: sentAt, kind: "sent" },
    ...events.map((e, i) => ({
      key: `${e.type}-${i}`,
      label:
        e.type === "open"
          ? e.isBot
            ? "Άνοιγμα αγνοήθηκε (αυτόματο/bot, όχι πραγματικό)"
            : "Άνοιξε"
          : `Κλικ σε σύνδεσμο${e.url ? `: ${e.url}` : ""}`,
      at: e.occurredAt,
      kind: e.type === "open" ? (e.isBot ? "bot" : "open") : "click",
    })),
  ];
  return (
    <div className="space-y-1.5">
      {items.map((it) => (
        <div key={it.key} className="flex items-center gap-2 text-[11px]" style={{ color: it.kind === "bot" ? C.slate : C.ink, opacity: it.kind === "bot" ? 0.75 : 1 }}>
          {it.kind === "sent" && <Send size={11} style={{ color: C.slate }} className="shrink-0" />}
          {it.kind === "open" && <Eye size={11} style={{ color: C.sky }} className="shrink-0" />}
          {it.kind === "bot" && <Info size={11} style={{ color: C.slate }} className="shrink-0" />}
          {it.kind === "click" && <LinkIcon size={11} style={{ color: C.amber }} className="shrink-0" />}
          <span className="truncate">{it.label}</span>
          <span className="ml-auto shrink-0 pl-2" style={{ color: C.slate }}>{fmtDateTime(it.at)}</span>
        </div>
      ))}
    </div>
  );
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

function CategoryChip({ children }) {
  if (!children) return <span style={{ color: C.slate }}>—</span>;
  return (
    <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${C.sky}14`, color: C.sky }}>
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

// Lives in the sidebar, but works from any view — debounced query against
// GET /contacts?q=, jumps into the Contacts view and opens the picked
// contact's detail drawer via App's pendingOpenContactId relay.
function GlobalSearch({ onSelectContact }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.get(`/contacts?q=${encodeURIComponent(query.trim())}`);
        if (cancelled) return; // a newer query/clear already superseded this response
        setResults(data.slice(0, 8));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setOpen(true);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(debounceRef.current);
    };
  }, [query]);

  function handleSelect(contact) {
    onSelectContact(contact.id);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="relative px-3 mb-3">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: C.slate }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Αναζήτηση επαφών…"
          className="w-full rounded-lg pl-8 pr-3 py-2 text-xs border outline-none"
          style={{ borderColor: C.line, color: C.ink, backgroundColor: C.pale }}
        />
      </div>
      {open && (
        <div className="absolute left-3 right-3 mt-1 rounded-lg border bg-white shadow-lg z-50 overflow-hidden max-h-64 overflow-y-auto" style={{ borderColor: C.line }}>
          {loading ? (
            <div className="px-3 py-2 text-xs" style={{ color: C.slate }}>Αναζήτηση…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs" style={{ color: C.slate }}>Καμία επαφή.</div>
          ) : (
            results.map((c) => (
              <button key={c.id} type="button" onClick={() => handleSelect(c)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex flex-col">
                <span className="font-medium truncate" style={{ color: C.ink }}>{c.name || c.email}</span>
                <span className="truncate" style={{ color: C.slate }}>{c.email}{c.company ? ` · ${c.company}` : ""}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Card({ children, className = "", style }) {
  return (
    <div className={`rounded-2xl bg-white border ${className}`} style={{ borderColor: C.line, ...style }}>
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

function TipBanner({ children, tone = "info" }) {
  const toneColor = tone === "warn" ? C.amber : C.sky;
  return (
    <div className="flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-xs mb-4" style={{ backgroundColor: `${toneColor}14`, color: C.ink }}>
      <Sparkles size={14} style={{ color: toneColor, marginTop: 1 }} className="shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// ---------- Rich text editor ----------
// Best-practice link handling for cold outreach: a bare domain typed without
// a scheme (e.g. "example.com") would otherwise be inserted as a relative
// link — clicking it in the sent email would try to navigate relative to
// whatever page it's opened from, which breaks silently. Default to https.
function normalizeLinkUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^mailto:/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// Minimal Gmail-style toolbar over a contentEditable div — no external
// dependency, since bold/lists/links/attachments are all the app needs.
function RichTextEditor({ value, onChange, attachments, onAttachmentsChange, minHeight = 140 }) {
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const [attachError, setAttachError] = useState("");

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== (value || "")) {
      editorRef.current.innerHTML = value || "";
    }
  }, [value]);

  function exec(command, arg) {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    onChange(editorRef.current?.innerHTML || "");
  }

  function handleLink() {
    const raw = window.prompt("Σύνδεσμος (URL):", "https://");
    if (!raw || !raw.trim()) return;
    const url = normalizeLinkUrl(raw);
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      window.alert("Ο σύνδεσμος δεν φαίνεται έγκυρος.");
      return;
    }
    const safeUrl = url.replace(/"/g, "&quot;");

    // execCommand("createLink") silently does nothing if there's no active
    // text selection — that looked like "the link just isn't there" to
    // anyone who clicked the button without first highlighting text. Fall
    // back to inserting the URL itself as the link text in that case.
    const selection = window.getSelection();
    const hasSelection =
      selection && selection.toString().length > 0 && editorRef.current?.contains(selection.anchorNode);

    editorRef.current?.focus();
    if (hasSelection) {
      document.execCommand("createLink", false, url);
      // execCommand doesn't let us style the anchor it just created directly —
      // find it by href and apply the same inline style as the manual-insert
      // branch below. Inline (not stylesheet) styling matters here because
      // Gmail/Outlook etc. strip <style> blocks — an unstyled <a> can render
      // with no visible color/underline in some clients.
      const anchors = editorRef.current?.querySelectorAll(`a[href="${safeUrl}"]`) || [];
      const created = anchors[anchors.length - 1];
      if (created) {
        created.style.color = C.sky;
        created.style.textDecoration = "underline";
        created.setAttribute("target", "_blank");
        created.setAttribute("rel", "noopener noreferrer");
      }
    } else {
      const safeText = url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${safeUrl}" style="color:${C.sky};text-decoration:underline;" target="_blank" rel="noopener noreferrer">${safeText}</a>`
      );
    }
    onChange(editorRef.current?.innerHTML || "");
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!onAttachmentsChange) return;
    setAttachError("");
    const next = [...attachments];
    for (const file of files) {
      if (next.length >= MAX_ATTACHMENTS) {
        setAttachError(`Μέχρι ${MAX_ATTACHMENTS} αρχεία ανά email.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(`Το "${file.name}" ξεπερνάει τα 2MB.`);
        continue;
      }
      const contentBase64 = await fileToBase64(file);
      next.push({ filename: file.name, mimeType: file.type || "application/octet-stream", contentBase64 });
    }
    onAttachmentsChange(next);
  }

  function removeAttachment(i) {
    onAttachmentsChange(attachments.filter((_, idx) => idx !== i));
  }

  const ToolBtn = ({ onClick, title, children }) => (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title}
      className="p-1.5 rounded hover:bg-white" style={{ color: C.ink }}>
      {children}
    </button>
  );

  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: C.line }}>
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b flex-wrap" style={{ borderColor: C.line, backgroundColor: C.pale }}>
        <ToolBtn onClick={() => exec("bold")} title="Έντονα"><Bold size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("italic")} title="Πλάγια"><Italic size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("underline")} title="Υπογράμμιση"><Underline size={14} /></ToolBtn>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: C.line }} />
        <ToolBtn onClick={() => exec("insertUnorderedList")} title="Λίστα με κουκκίδες"><List size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("insertOrderedList")} title="Αριθμημένη λίστα"><ListOrdered size={14} /></ToolBtn>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: C.line }} />
        <ToolBtn onClick={() => exec("justifyLeft")} title="Στοίχιση αριστερά"><AlignLeft size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("justifyCenter")} title="Στοίχιση στο κέντρο"><AlignCenter size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("justifyRight")} title="Στοίχιση δεξιά"><AlignRight size={14} /></ToolBtn>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: C.line }} />
        <ToolBtn onClick={handleLink} title="Σύνδεσμος"><LinkIcon size={14} /></ToolBtn>
        {onAttachmentsChange && (
          <>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFiles} />
            <ToolBtn onClick={() => fileRef.current?.click()} title="Επισύναψη αρχείου"><Paperclip size={14} /></ToolBtn>
          </>
        )}
      </div>
      <div
        ref={editorRef}
        contentEditable
        onInput={() => onChange(editorRef.current?.innerHTML || "")}
        className="px-3 py-2 text-sm outline-none overflow-auto"
        style={{ color: C.ink, minHeight, maxHeight: minHeight * 2.4 }}
        suppressContentEditableWarning
      />
      {attachError && <p className="text-[11px] px-3 pb-1.5" style={{ color: C.coral }}>{attachError}</p>}
      {onAttachmentsChange && attachments.length > 0 && (
        <div className="flex gap-1.5 flex-wrap px-3 pb-2 pt-1">
          {attachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]" style={{ backgroundColor: C.pale, color: C.navy }}>
              <Paperclip size={10} /> {a.filename}
              <button type="button" onClick={() => removeAttachment(i)}><X size={10} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// The unsubscribe line used to be a hidden, backend-only addition — it now
// lives directly in the editable body (see DEFAULT_DISCLAIMER_HTML, seeded
// into new drafts) so it shows up naturally in the live preview above this.
// The only thing still added invisibly at send time is the 1x1 open-tracking
// pixel, which has no visual form to preview — this is just a one-line note
// about that, for transparency.
function AutoTrackingPixelNote() {
  return (
    <div className="flex items-center gap-1.5 text-[11px] mt-2" style={{ color: C.slate }}>
      <Info size={11} className="shrink-0" /> Προστίθεται επίσης ένα αόρατο pixel παρακολούθησης ανοίγματος σε κάθε αποστολή.
    </div>
  );
}

// ---------- Brand ----------
function Logo({ size = 34 }) {
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

function Brand({ size = 34, textSize = "text-lg" }) {
  return (
    <div className="flex items-center gap-2.5">
      <Logo size={size} />
      <span className={`${textSize} font-semibold`} style={{ color: C.ink, fontFamily: "Sora, sans-serif", letterSpacing: "-0.01em" }}>
        SD<span style={{ color: C.sky }}>Loop</span>
      </span>
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
  const [info, setInfo] = useState("");

  function switchMode(m) {
    setMode(m);
    setError("");
    setInfo("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "login") {
        const user = await api.post("/auth/login", { email, password });
        onAuthenticated(user);
      } else {
        const result = await api.post("/auth/register", { email, password, name: name || undefined });
        if (result && result.pending) {
          // Access is invite/approval-gated — new accounts wait for an admin.
          setInfo(result.message || "Ο λογαριασμός δημιουργήθηκε. Περιμένει έγκριση από διαχειριστή.");
          setMode("login");
        } else {
          onAuthenticated(result);
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.data?.error === "account_pending_approval") {
        setError("Ο λογαριασμός σου εκκρεμεί έγκρισης από διαχειριστή. Δοκίμασε ξανά αργότερα.");
      } else {
        setError(err instanceof ApiError ? err.message : "Κάτι πήγε στραβά. Δοκίμασε ξανά.");
      }
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
        <div className="flex items-center justify-center mb-8">
          <Brand size={38} textSize="text-2xl" />
        </div>

        <Card className="p-6">
          <div className="flex rounded-lg p-1 mb-5" style={{ backgroundColor: C.pale }}>
            {["login", "register"].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
                style={{ backgroundColor: mode === m ? "#fff" : "transparent", color: mode === m ? C.navy : C.slate }}
              >
                {m === "login" ? "Σύνδεση" : "Εγγραφή"}
              </button>
            ))}
          </div>

          {info && (
            <p className="text-xs rounded-lg px-3 py-2 mb-3" style={{ backgroundColor: `${C.mint}14`, color: C.mint }}>{info}</p>
          )}

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

            {mode === "register" && (
              <p className="text-[11px] rounded-lg px-3 py-2" style={{ backgroundColor: C.pale, color: C.navy }}>
                Η πρόσβαση εγκρίνεται από διαχειριστή — μετά την εγγραφή θα περιμένεις έγκριση πριν μπορέσεις να συνδεθείς.
              </p>
            )}

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

// ---------- Contacts ----------
function NewContactModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", category: "", tags: "", comments: "" });
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
          <input placeholder="Τηλέφωνο" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Εταιρεία" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Κατηγορία (π.χ. Lead, Πελάτης, Συνεργάτης)" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Ετικέτες (χωρισμένες με κόμμα)" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <textarea placeholder="Σχόλια (προαιρετικό — διαθέσιμο ως {{comments}} σε emails)" value={form.comments} onChange={(e) => setForm((f) => ({ ...f, comments: e.target.value }))}
            rows={2} className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none" style={{ borderColor: C.line, color: C.ink }} />
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Προσθήκη
          </button>
        </form>
      </Card>
    </div>
  );
}

function ContactDetailDrawer({ contactId, onClose, onLoad, onAddNote, onDeleteNote, onSetFollowUp, onCompose, onMarkReplied, onToggleUnsubscribed, onUpdateComments }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [markingReplied, setMarkingReplied] = useState(false);
  const [togglingUnsub, setTogglingUnsub] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState(null);
  const [comments, setComments] = useState("");
  const [savingComments, setSavingComments] = useState(false);
  const [commentsSaved, setCommentsSaved] = useState(false);

  async function handleMarkReplied() {
    setMarkingReplied(true);
    try {
      await onMarkReplied(contactId);
      await load();
    } finally {
      setMarkingReplied(false);
    }
  }

  async function handleToggleUnsubscribed() {
    setTogglingUnsub(true);
    try {
      await onToggleUnsubscribed(contactId, !detail.unsubscribed);
      await load();
    } finally {
      setTogglingUnsub(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await onLoad(contactId);
      setDetail(data);
      setFollowUp(data.nextFollowUpAt ? data.nextFollowUpAt.slice(0, 10) : "");
      setComments(data.comments || "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν τα στοιχεία επαφής.");
    } finally {
      setLoading(false);
    }
  }, [contactId, onLoad]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddNote(e) {
    e.preventDefault();
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await onAddNote(contactId, noteText.trim());
      setNoteText("");
      await load();
    } catch {
      // best-effort — the note box just stays populated if it failed
    } finally {
      setSavingNote(false);
    }
  }

  async function handleFollowUpChange(value) {
    setFollowUp(value);
    try {
      await onSetFollowUp(contactId, value || null);
    } catch {
      // ignore — value stays as typed, next reload will reconcile
    }
  }

  async function handleSaveComments() {
    setSavingComments(true);
    setCommentsSaved(false);
    try {
      await onUpdateComments(contactId, comments);
      setCommentsSaved(true);
      setTimeout(() => setCommentsSaved(false), 1800);
    } finally {
      setSavingComments(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <div className="w-full max-w-lg h-full bg-white overflow-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white" style={{ borderColor: C.line }}>
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Στοιχεία επαφής</h3>
          <div className="flex items-center gap-3">
            <button onClick={handleMarkReplied} disabled={markingReplied}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border"
              style={{ borderColor: C.line, color: C.mint, opacity: markingReplied ? 0.6 : 1 }}
              title="Δεν διαβάζουμε το inbox σου — σημείωσε το χειροκίνητα όταν κάποιος απαντήσει, για να σταματήσει το sequence και να μετρήσει σωστά το reply rate.">
              <Reply size={13} /> Mark ως απάντησε
            </button>
            <button onClick={onCompose}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
              style={{ backgroundColor: C.sky }}>
              <Mail size={13} /> Αποστολή email
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
          </div>
        </div>

        {loading ? (
          <Spinner label="Φόρτωση…" />
        ) : error ? (
          <div className="p-6"><ErrorNote message={error} onRetry={load} /></div>
        ) : detail ? (
          <div className="p-6 space-y-6">
            <div>
              <div className="text-lg font-semibold" style={{ color: C.ink }}>{detail.name}</div>
              <div className="text-sm" style={{ color: C.slate }}>{detail.email}</div>
              <div className="flex flex-wrap gap-3 mt-2 text-xs" style={{ color: C.slate }}>
                {detail.phone && <span className="flex items-center gap-1"><Phone size={12} /> {detail.phone}</span>}
                {detail.company && <span className="flex items-center gap-1"><Building2 size={12} /> {detail.company}</span>}
              </div>
              <div className="flex gap-1.5 flex-wrap mt-2">
                {(detail.tags || "").split(",").filter(Boolean).map((t) => <TagChip key={t}>{t.trim()}</TagChip>)}
                {detail.category && <CategoryChip>{detail.category}</CategoryChip>}
              </div>
              <div className="mt-3">
                {detail.unsubscribed ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14` }}>
                    <span className="text-xs font-medium flex items-center gap-1.5" style={{ color: C.coral }}>
                      <CircleX size={13} /> Unsubscribed{detail.unsubscribedAt ? ` · ${fmtDate(detail.unsubscribedAt)}` : ""}
                    </span>
                    <button onClick={handleToggleUnsubscribed} disabled={togglingUnsub}
                      className="text-xs font-medium underline shrink-0" style={{ color: C.coral, opacity: togglingUnsub ? 0.6 : 1 }}>
                      Ακύρωση
                    </button>
                  </div>
                ) : (
                  <button onClick={handleToggleUnsubscribed} disabled={togglingUnsub}
                    className="text-xs font-medium underline" style={{ color: C.slate, opacity: togglingUnsub ? 0.6 : 1 }}>
                    Επισήμανση ως unsubscribed
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium mb-1.5 flex items-center gap-1.5" style={{ color: C.slate }}>
                <StickyNote size={13} /> Σχόλια <span style={{ color: C.slate, fontWeight: 400 }}>— διαθέσιμο ως {"{{comments}}"} σε emails</span>
              </label>
              <textarea
                value={comments}
                onChange={(e) => { setComments(e.target.value); setCommentsSaved(false); }}
                placeholder="π.χ. ενδιαφέρθηκε για το πακέτο X, ανέφερε ότι..."
                rows={2}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none"
                style={{ borderColor: C.line, color: C.ink }}
              />
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  type="button"
                  onClick={handleSaveComments}
                  disabled={savingComments || comments === (detail.comments || "")}
                  className="text-xs font-medium rounded-lg px-2.5 py-1 text-white"
                  style={{ backgroundColor: C.sky, opacity: savingComments || comments === (detail.comments || "") ? 0.5 : 1 }}
                >
                  {savingComments ? "Αποθήκευση…" : "Αποθήκευση σχολίων"}
                </button>
                {commentsSaved && <span className="text-xs" style={{ color: C.mint }}>Αποθηκεύτηκε ✓</span>}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium mb-1.5 flex items-center gap-1.5" style={{ color: C.slate }}>
                <CalendarClock size={13} /> Επόμενη υπενθύμιση
              </label>
              <input
                type="date"
                value={followUp}
                onChange={(e) => handleFollowUpChange(e.target.value)}
                className="rounded-lg px-3 py-2 text-sm border outline-none"
                style={{ borderColor: C.line, color: C.ink }}
              />
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: C.ink }}>
                <Euro size={14} /> Προσφορές ({detail.offers?.length || 0})
              </div>
              {(!detail.offers || detail.offers.length === 0) ? (
                <p className="text-xs" style={{ color: C.slate }}>Καμία προσφορά ακόμα.</p>
              ) : (
                <div className="space-y-2">
                  {detail.offers.map((o) => (
                    <div key={o.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                      <span className="text-xs font-medium" style={{ color: C.ink }}>{o.title}</span>
                      <span className="text-xs" style={{ color: C.slate }}>{fmtMoney(o.value, o.currency)} · {OFFER_STATUSES.find((s) => s.key === o.status)?.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: C.ink }}>
                <Mail size={14} /> Ιστορικό αποστολών ({detail.timeline?.length || 0})
              </div>
              {(!detail.timeline || detail.timeline.length === 0) ? (
                <p className="text-xs" style={{ color: C.slate }}>Δεν έχει σταλεί κανένα email ακόμα.</p>
              ) : (
                <div className="space-y-2">
                  {detail.timeline.map((t) => {
                    const open = expandedLogId === t.id;
                    return (
                      <div key={t.id} className="rounded-lg overflow-hidden" style={{ backgroundColor: C.pale }}>
                        <button
                          type="button"
                          onClick={() => setExpandedLogId(open ? null : t.id)}
                          className="w-full flex items-center justify-between px-3 py-2 text-left"
                        >
                          <div className="min-w-0 flex items-center gap-1.5">
                            <ChevronRight size={12} style={{ color: C.slate, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} className="shrink-0" />
                            <div className="min-w-0">
                              <div className="text-xs font-medium truncate" style={{ color: C.ink }}>{t.subject}</div>
                              <div className="text-[11px]" style={{ color: C.slate }}>{t.sequenceName || "Χειροκίνητο"} · {fmtDate(t.sentAt)}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {t.opened && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.sky}1A`, color: C.sky }}>Άνοιξε</span>}
                            {t.clicked && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.amber}1A`, color: C.amber }}>Κλικ</span>}
                          </div>
                        </button>
                        {open && (
                          <div className="px-3 pb-2.5 pl-7">
                            <EventTrace sentAt={t.sentAt} events={t.events} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: C.ink }}>
                <StickyNote size={14} /> Σημειώσεις ({detail.notes?.length || 0})
              </div>
              <form onSubmit={handleAddNote} className="flex gap-2 mb-3">
                <input
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Νέα σημείωση…"
                  className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none"
                  style={{ borderColor: C.line, color: C.ink }}
                />
                <button type="submit" disabled={savingNote || !noteText.trim()} className="rounded-lg px-3 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky, opacity: savingNote ? 0.7 : 1 }}>
                  {savingNote ? <Loader2 size={14} className="animate-spin" /> : "Προσθήκη"}
                </button>
              </form>
              {(!detail.notes || detail.notes.length === 0) ? (
                <p className="text-xs" style={{ color: C.slate }}>Καμία σημείωση ακόμα.</p>
              ) : (
                <div className="space-y-2">
                  {detail.notes.map((n) => (
                    <div key={n.id} className="flex items-start justify-between gap-2 rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                      <div className="min-w-0">
                        <p className="text-xs whitespace-pre-wrap" style={{ color: C.ink }}>{n.body}</p>
                        <p className="text-[11px] mt-1" style={{ color: C.slate }}>{fmtDate(n.createdAt)}</p>
                      </div>
                      <button
                        onClick={async () => { await onDeleteNote(contactId, n.id); load(); }}
                        className="shrink-0"
                        style={{ color: C.coral }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ContactsView({ contacts, loading, error, onReload, sequences, onUpload, onCreate, onEnroll, onLoadDetail, onAddNote, onDeleteNote, onSetFollowUp, onBulkUpdate, onBulkDelete, onExport, onCompose, onMarkReplied, onToggleUnsubscribed, onUpdateComments, openContactId, onOpenContactHandled }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [onlyDue, setOnlyDue] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkTag, setBulkTag] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [detailContactId, setDetailContactId] = useState(null);
  const fileRef = useRef(null);

  // Lets the global search box (in the sidebar) jump straight into a
  // contact's detail drawer from any view, without lifting detailContactId
  // itself up to App — App just hands us the id once and we take it from there.
  useEffect(() => {
    if (openContactId) {
      setDetailContactId(openContactId);
      onOpenContactHandled();
    }
  }, [openContactId, onOpenContactHandled]);

  const categories = useMemo(() => {
    const set = new Set(contacts.map((c) => (c.category || "").trim()).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  const allTags = useMemo(() => {
    const set = new Set();
    contacts.forEach((c) =>
      (c.tags || "").split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => set.add(t))
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      const matchesQuery = (c.name + c.email + (c.company || "") + (c.phone || "")).toLowerCase().includes(query.toLowerCase());
      const matchesStatus = statusFilter === "all" || c.status === statusFilter;
      const matchesCategory = categoryFilter === "all" || (c.category || "").trim() === categoryFilter;
      const matchesTag =
        tagFilter === "all" ||
        (c.tags || "").split(",").map((t) => t.trim()).includes(tagFilter);
      const matchesDue = !onlyDue || isFollowUpDue(c.nextFollowUpAt);
      return matchesQuery && matchesStatus && matchesCategory && matchesTag && matchesDue;
    });
  }, [contacts, query, statusFilter, categoryFilter, tagFilter, onlyDue]);

  const dueCount = useMemo(() => contacts.filter((c) => isFollowUpDue(c.nextFollowUpAt)).length, [contacts]);

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

  async function handleBulkCategory() {
    if (!bulkCategory || selected.size === 0) return;
    setBulkBusy(true);
    try {
      await onBulkUpdate(Array.from(selected), { category: bulkCategory });
      setBulkCategory("");
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Η μαζική ενέργεια απέτυχε.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkTag() {
    if (!bulkTag.trim() || selected.size === 0) return;
    setBulkBusy(true);
    try {
      await onBulkUpdate(Array.from(selected), {}, bulkTag.trim());
      setBulkTag("");
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Η μαζική ενέργεια απέτυχε.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      await onBulkDelete(Array.from(selected));
      setSelected(new Set());
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Η διαγραφή απέτυχε.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      await onExport();
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Η εξαγωγή απέτυχε.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {showNew && <NewContactModal onClose={() => setShowNew(false)} onCreate={onCreate} />}
      {detailContactId && (
        <ContactDetailDrawer
          contactId={detailContactId}
          onClose={() => setDetailContactId(null)}
          onLoad={onLoadDetail}
          onAddNote={onAddNote}
          onDeleteNote={onDeleteNote}
          onSetFollowUp={onSetFollowUp}
          onCompose={() => { onCompose(detailContactId); setDetailContactId(null); }}
          onMarkReplied={onMarkReplied}
          onToggleUnsubscribed={onToggleUnsubscribed}
          onUpdateComments={onUpdateComments}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-6 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Επαφές</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>
            {contacts.length} επαφές συνολικά{dueCount > 0 ? ` · ${dueCount} με εκκρεμή υπενθύμιση` : ""}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border"
            style={{ borderColor: C.line, color: C.ink, opacity: exporting ? 0.6 : 1 }}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Εξαγωγή CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            title="Στήλες CSV: name, email, phone, company, category, tags, comments"
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

      <div className="flex items-center gap-3 px-6 py-3 border-b flex-wrap" style={{ borderColor: C.line }}>
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 flex-1 max-w-sm" style={{ backgroundColor: C.pale }}>
          <Search size={15} style={{ color: C.slate }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Αναζήτηση ονόματος, email, τηλεφώνου, εταιρείας…"
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

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm border outline-none"
          style={{ borderColor: C.line, color: C.ink }}
        >
          <option value="all">Όλες οι κατηγορίες</option>
          {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
        </select>

        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm border outline-none"
          style={{ borderColor: C.line, color: C.ink }}
        >
          <option value="all">Όλες οι ετικέτες</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: C.slate }}>
          <input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} />
          Μόνο εκκρεμείς υπενθυμίσεις
        </label>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap ml-auto">
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
            <input
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              placeholder="Νέα κατηγορία…"
              className="w-32 rounded-lg px-2 py-1.5 text-xs border outline-none"
              style={{ borderColor: C.line, color: C.ink }}
            />
            <button onClick={handleBulkCategory} disabled={bulkBusy || !bulkCategory} className="rounded-lg px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
              Ορισμός κατηγορίας
            </button>
            <input
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              placeholder="Νέα ετικέτα…"
              className="w-28 rounded-lg px-2 py-1.5 text-xs border outline-none"
              style={{ borderColor: C.line, color: C.ink }}
            />
            <button onClick={handleBulkTag} disabled={bulkBusy || !bulkTag.trim()} className="rounded-lg px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
              Προσθήκη ετικέτας
            </button>
            <button onClick={handleBulkDelete} disabled={bulkBusy} className="rounded-lg px-2.5 py-1.5 text-xs font-medium" style={{ color: C.coral }}>
              Διαγραφή
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση επαφών…" />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: C.slate }}>
                <th className="font-medium pb-3 w-8"></th>
                <th className="font-medium pb-3">Όνομα</th>
                <th className="font-medium pb-3">Τηλέφωνο</th>
                <th className="font-medium pb-3">Εταιρεία</th>
                <th className="font-medium pb-3">Κατηγορία</th>
                <th className="font-medium pb-3">Κατάσταση</th>
                <th className="font-medium pb-3">Sequence</th>
                <th className="font-medium pb-3">Ετικέτες</th>
                <th className="font-medium pb-3">Υπενθύμιση</th>
                <th className="font-medium pb-3">Τελ. ενέργεια</th>
                <th className="font-medium pb-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: C.line }}>
                  <td className="py-3">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelected(c.id)} />
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium" style={{ color: C.ink }}>{c.name}</span>
                      {c.unsubscribed && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] font-medium rounded-md px-1 py-0.5 shrink-0"
                          style={{ color: C.coral, backgroundColor: `${C.coral}14` }}
                          title={c.unsubscribedAt ? `Unsubscribed · ${fmtDate(c.unsubscribedAt)}` : "Unsubscribed"}
                        >
                          <CircleX size={10} /> Unsub
                        </span>
                      )}
                    </div>
                    <div className="text-xs" style={{ color: C.slate }}>{c.email}</div>
                  </td>
                  <td className="py-3" style={{ color: C.ink }}>
                    <div className="flex items-center gap-1.5">
                      <Phone size={13} style={{ color: C.slate }} />
                      {c.phone || "—"}
                    </div>
                  </td>
                  <td className="py-3" style={{ color: C.ink }}>
                    <div className="flex items-center gap-1.5">
                      <Building2 size={13} style={{ color: C.slate }} />
                      {c.company || "—"}
                    </div>
                  </td>
                  <td className="py-3"><CategoryChip>{c.category}</CategoryChip></td>
                  <td className="py-3"><Pill status={c.status} /></td>
                  <td className="py-3" style={{ color: C.ink }}>
                    {c.currentSequence ? `${c.currentSequence} · βήμα ${c.currentStep}` : "—"}
                  </td>
                  <td className="py-3">
                    <div className="flex gap-1 flex-wrap">
                      {(c.tags || "").split(",").filter(Boolean).map((t) => <TagChip key={t}>{t.trim()}</TagChip>)}
                    </div>
                  </td>
                  <td className="py-3">
                    {c.nextFollowUpAt ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs font-medium rounded-md px-1.5 py-0.5"
                        style={{ color: isFollowUpDue(c.nextFollowUpAt) ? C.coral : C.slate, backgroundColor: isFollowUpDue(c.nextFollowUpAt) ? `${C.coral}14` : "transparent" }}
                      >
                        <CalendarClock size={12} /> {fmtDate(c.nextFollowUpAt)}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="py-3 text-xs" style={{ color: C.slate }}>{fmtDate(c.lastActivityAt)}</td>
                  <td className="py-3">
                    <button onClick={() => setDetailContactId(c.id)} style={{ color: C.slate }} title="Στοιχεία επαφής">
                      <Eye size={15} />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={11} className="py-10 text-center text-sm" style={{ color: C.slate }}>Καμία επαφή δεν ταιριάζει.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Templates ----------
function TemplateModal({ initial, onClose, onSave }) {
  const [name, setName] = useState(initial?.name || "");
  const [subject, setSubject] = useState(initial?.subject || "");
  const [body, setBody] = useState(initial?.body || DEFAULT_DISCLAIMER_HTML);
  const [attachments, setAttachments] = useState(initial?.attachments || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function insertToken(token) {
    setBody((b) => (b || "") + token);
  }

  // Body is HTML now (rich text editor) — strip tags for word/char counts
  // and spam-word checks so markup doesn't skew them.
  const plainBody = body.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  const subjectSpam = findSpamWords(subject);
  const bodySpam = findSpamWords(plainBody);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onSave({ name, subject, body, attachments });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η αποθήκευση.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-3xl p-5 max-h-[88vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{initial ? "Επεξεργασία template" : "Νέο template"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <input required placeholder="Όνομα template" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

            <div>
              <input required placeholder="Θέμα" value={subject} onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[11px]" style={{ color: subject.length > 60 ? C.amber : C.slate }}>
                  {subject.length} χαρακτήρες {subject.length > 60 ? "(συνιστάται κάτω από 60 για καλύτερο open rate)" : ""}
                </span>
              </div>
              {subjectSpam.length > 0 && (
                <p className="text-[11px] mt-1" style={{ color: C.amber }}>⚠ Πιθανές λέξεις spam-trigger: {subjectSpam.join(", ")}</p>
              )}
            </div>

            <div className="flex gap-1.5 flex-wrap">
              <span className="text-[11px] self-center" style={{ color: C.slate }}>Εισαγωγή token:</span>
              {["{{name}}", "{{company}}", "{{email}}", "{{comments}}"].map((tok) => (
                <button key={tok} type="button" onClick={() => insertToken(tok)}
                  className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ backgroundColor: C.pale, color: C.navy }}>
                  {tok}
                </button>
              ))}
            </div>
            <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={180} />
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: C.slate }}>{plainBody.trim().length} χαρακτήρες · {plainBody.split(/\s+/).filter(Boolean).length} λέξεις</span>
            </div>
            {bodySpam.length > 0 && (
              <p className="text-[11px]" style={{ color: C.amber }}>⚠ Πιθανές λέξεις spam-trigger: {bodySpam.join(", ")}</p>
            )}
            {!hasUnsubscribeLink(body) && body.length > 0 && (
              <TipBanner>Best practice: το email δεν έχει σύνδεσμο απεγγραφής — βοηθά τη deliverability και είναι απαραίτητο για μαζικά cold emails. Πρόσθεσε ένα link με href {"{{unsubscribe_link}}"}.</TipBanner>
            )}

            {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
            <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
              {busy && <Loader2 size={14} className="animate-spin" />} Αποθήκευση
            </button>
          </div>

          <div>
            <p className="text-xs font-medium mb-2" style={{ color: C.slate }}>Προεπισκόπηση (με δείγμα δεδομένων)</p>
            <Card className="p-4" style={{ backgroundColor: C.pale }}>
              <div className="text-xs mb-2" style={{ color: C.slate }}>Προς: {MERGE_SAMPLE.name} &lt;{MERGE_SAMPLE.email}&gt;</div>
              <div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>{renderPreview(subject) || "—"}</div>
              <div className="text-sm" style={{ color: C.ink }} dangerouslySetInnerHTML={{ __html: renderPreview(body) || "—" }} />
              <AutoTrackingPixelNote />
              {attachments.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mt-3 pt-3 border-t" style={{ borderColor: C.line }}>
                  {attachments.map((a, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]" style={{ backgroundColor: "#fff", color: C.navy }}>
                      <Paperclip size={10} /> {a.filename}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </form>
      </Card>
    </div>
  );
}

function TemplatesView({ templates, loading, error, onReload, onCreate, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(null); // null | "new" | template object
  const [busyId, setBusyId] = useState(null);

  async function handleSave(data) {
    if (editing === "new") await onCreate(data);
    else await onUpdate(editing.id, data);
  }

  async function handleDuplicate(t) {
    setBusyId(t.id);
    try {
      await onCreate({ name: `${t.name} (copy)`, subject: t.subject, body: t.body, attachments: t.attachments || [] });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(t) {
    setBusyId(t.id);
    try {
      await onDelete(t.id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="h-full overflow-auto">
      {editing && (
        <TemplateModal
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Templates</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>{templates.length} αποθηκευμένα templates</p>
        </div>
        <button onClick={() => setEditing("new")} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
          <Plus size={15} /> Νέο template
        </button>
      </div>
      <div className="px-8 py-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση templates…" />
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-sm" style={{ color: C.slate }}>
            <FileText size={28} strokeWidth={1.5} />
            Δεν υπάρχουν templates ακόμα.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {templates.map((t) => (
              <Card key={t.id} className="p-4">
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: C.ink }}>{t.name}</div>
                    <div className="text-xs truncate mt-0.5" style={{ color: C.slate }}>{t.subject}</div>
                  </div>
                  <span className="text-[11px] font-medium rounded-full px-2 py-0.5 shrink-0" style={{ backgroundColor: C.pale, color: C.navy }}>
                    {t.usageCount || 0}× σε χρήση
                  </span>
                </div>
                <p className="text-xs mb-3" style={{ color: C.slate }}>
                  {(() => {
                    const plain = t.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
                    return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain;
                  })()}
                </p>
                <div className="flex items-center gap-2">
                  <button onClick={() => setEditing(t)} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
                    <Pencil size={12} /> Επεξεργασία
                  </button>
                  <button onClick={() => handleDuplicate(t)} disabled={busyId === t.id} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
                    <Copy size={12} /> Αντιγραφή
                  </button>
                  <button onClick={() => handleDelete(t)} disabled={busyId === t.id} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium ml-auto" style={{ color: C.coral }}>
                    <Trash2 size={12} /> Διαγραφή
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Offers (mini deals/pipeline) ----------
function NewOfferModal({ contacts, onClose, onCreate }) {
  const [contactId, setContactId] = useState("");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onCreate({
        contactId,
        title,
        value: value === "" ? null : Number(value),
        currency,
        notes: notes || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η δημιουργία προσφοράς.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέα προσφορά</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <select required value={contactId} onChange={(e) => setContactId(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }}>
            <option value="">Επιλέξε επαφή…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
          </select>
          <input required placeholder="Τίτλος προσφοράς" value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div className="flex gap-2">
            <input type="number" min={0} step="0.01" placeholder="Αξία" value={value} onChange={(e) => setValue(e.target.value)}
              className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}
              className="w-24 rounded-lg px-2 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <textarea placeholder="Σημειώσεις (προαιρετικό)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none" style={{ borderColor: C.line, color: C.ink }} />
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Δημιουργία
          </button>
        </form>
      </Card>
    </div>
  );
}

function OfferOutcomeReasonModal({ status, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleConfirm(skip) {
    setBusy(true);
    try {
      await onConfirm(skip ? "" : reason.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <h3 className="text-sm font-semibold mb-1" style={{ color: C.ink }}>
          {status === "accepted" ? "Γιατί έγινε δεκτή;" : "Γιατί απορρίφθηκε;"}
        </h3>
        <p className="text-xs mb-3" style={{ color: C.slate }}>
          Προαιρετικό — τροφοδοτεί το CRM reporting (λόγοι έγκρισης/απόρριψης).
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="π.χ. τιμή, timing, ανταγωνισμός…"
          rows={3}
          className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none mb-3"
          style={{ borderColor: C.line, color: C.ink }}
        />
        <div className="flex items-center justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => handleConfirm(true)}
            className="rounded-lg px-3 py-2 text-sm font-medium border" style={{ borderColor: C.line, color: C.slate }}>
            Παράλειψη
          </button>
          <button type="button" disabled={busy} onClick={() => handleConfirm(false)}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Αποθήκευση
          </button>
        </div>
      </Card>
    </div>
  );
}

function OfferCard({ offer, onChangeStatus, onDelete, busy }) {
  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: C.ink }}>{offer.title}</div>
          <div className="text-xs truncate mt-0.5" style={{ color: C.slate }}>{offer.contact?.name || "—"}</div>
        </div>
        <button onClick={() => onDelete(offer.id)} disabled={busy} className="shrink-0" style={{ color: C.coral }}>
          <Trash2 size={13} />
        </button>
      </div>
      <div className="flex items-center gap-1 text-sm font-medium mb-2" style={{ color: C.navy }}>
        <Euro size={13} /> {fmtMoney(offer.value, offer.currency)}
      </div>
      {offer.notes && <p className="text-xs mb-2 line-clamp-2" style={{ color: C.slate }}>{offer.notes}</p>}
      {offer.outcomeReason && (
        <p className="text-xs mb-2 italic line-clamp-2" style={{ color: C.slate }}>“{offer.outcomeReason}”</p>
      )}
      <select
        value={offer.status}
        disabled={busy}
        onChange={(e) => onChangeStatus(offer.id, e.target.value)}
        className="w-full rounded-md px-2 py-1.5 text-xs border outline-none"
        style={{ borderColor: C.line, color: C.ink }}
      >
        {OFFER_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    </Card>
  );
}

function OffersView({ offers, contacts, loading, error, onReload, onCreate, onChangeStatus, onDelete }) {
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [reasonPrompt, setReasonPrompt] = useState(null); // { id, status } | null

  async function handleChangeStatus(id, status) {
    if (status === "accepted" || status === "declined") {
      setReasonPrompt({ id, status });
      return;
    }
    setBusyId(id);
    try {
      await onChangeStatus(id, status);
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmReason(reason) {
    if (!reasonPrompt) return;
    setBusyId(reasonPrompt.id);
    try {
      await onChangeStatus(reasonPrompt.id, reasonPrompt.status, reason);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id) {
    setBusyId(id);
    try {
      await onDelete(id);
    } finally {
      setBusyId(null);
    }
  }

  const totalValue = offers
    .filter((o) => o.status !== "declined")
    .reduce((sum, o) => sum + (Number(o.value) || 0), 0);

  return (
    <div className="h-full overflow-auto">
      {showNew && <NewOfferModal contacts={contacts} onClose={() => setShowNew(false)} onCreate={onCreate} />}
      {reasonPrompt && (
        <OfferOutcomeReasonModal
          status={reasonPrompt.status}
          onClose={() => setReasonPrompt(null)}
          onConfirm={handleConfirmReason}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Offers</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>
            {offers.length} προσφορές · σύνολο ενεργών {fmtMoney(totalValue)}
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
          <Plus size={15} /> Νέα προσφορά
        </button>
      </div>
      <div className="px-8 py-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση προσφορών…" />
        ) : offers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-sm" style={{ color: C.slate }}>
            <Handshake size={28} strokeWidth={1.5} />
            Δεν υπάρχουν προσφορές ακόμα.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {OFFER_STATUSES.map((col) => (
              <div key={col.key}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: col.color }} />
                  <span className="text-xs font-semibold" style={{ color: C.ink }}>{col.label}</span>
                  <span className="text-xs" style={{ color: C.slate }}>
                    {offers.filter((o) => o.status === col.key).length}
                  </span>
                </div>
                <div className="space-y-2.5">
                  {offers.filter((o) => o.status === col.key).map((offer) => (
                    <OfferCard
                      key={offer.id}
                      offer={offer}
                      busy={busyId === offer.id}
                      onChangeStatus={handleChangeStatus}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Sequences ----------
function TestSendModal({ defaultEmail, onClose, onSend }) {
  const [email, setEmail] = useState(defaultEmail || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(""); // "" | "sent" | error message

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setResult("");
    try {
      await onSend(email);
      setResult("sent");
    } catch (err) {
      setResult(err instanceof ApiError ? err.message : "Η δοκιμαστική αποστολή απέτυχε.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: C.ink }}>Δοκιμαστική αποστολή</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="email για δοκιμή"
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          {result === "sent" ? (
            <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.mint}14`, color: C.mint }}>Στάλθηκε! Έλεγξε το inbox σου.</p>
          ) : result ? (
            <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{result}</p>
          ) : null}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Αποστολή δοκιμής
          </button>
        </form>
      </Card>
    </div>
  );
}

function SequenceStepCard({ step, index, isLast, onDelete, onMoveUp, onMoveDown, canMoveUp, canMoveDown, busy, onTestSend, defaultTestEmail }) {
  const [showTestSend, setShowTestSend] = useState(false);
  return (
    <div className="flex gap-4">
      {showTestSend && (
        <TestSendModal defaultEmail={defaultTestEmail} onClose={() => setShowTestSend(false)} onSend={onTestSend} />
      )}
      <div className="flex flex-col items-center">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white" style={{ backgroundColor: C.navy }}>
          {index + 1}
        </div>
        {!isLast && <div className="w-px flex-1 mt-1" style={{ backgroundColor: C.line, minHeight: 32 }} />}
      </div>
      <div className="flex-1 pb-6">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2 text-xs" style={{ color: C.slate }}>
            <Clock size={12} />
            {step.delayDays === 0 ? "Άμεση αποστολή" : `${step.delayDays} ημέρες μετά`}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowTestSend(true)} disabled={busy} className="rounded p-1" style={{ color: C.sky }} title="Δοκιμαστική αποστολή">
              <Send size={13} />
            </button>
            <button onClick={onMoveUp} disabled={!canMoveUp || busy} className="rounded p-1" style={{ opacity: canMoveUp ? 1 : 0.3, color: C.slate }} title="Μετακίνηση πάνω">
              <ArrowUp size={13} />
            </button>
            <button onClick={onMoveDown} disabled={!canMoveDown || busy} className="rounded p-1" style={{ opacity: canMoveDown ? 1 : 0.3, color: C.slate }} title="Μετακίνηση κάτω">
              <ArrowDown size={13} />
            </button>
            <button onClick={onDelete} disabled={busy} className="rounded p-1" style={{ color: C.coral }} title="Διαγραφή βήματος">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        <Card className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium" style={{ color: C.ink }}>{step.subject}</span>
          </div>
          <div className="text-xs leading-relaxed [&_a]:underline" style={{ color: C.slate }} dangerouslySetInnerHTML={{ __html: step.body || "" }} />
          {(step.conditions?.requireEvent || step.conditions?.requireTags?.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2.5 border-t" style={{ borderColor: C.line }}>
              {step.conditions?.requireEvent && (
                <span className="text-[10px] rounded px-1.5 py-0.5 font-medium" style={{ backgroundColor: `${C.amber}1A`, color: "#7A5206" }}>
                  {EVENT_CONDITIONS.find((c) => c.key === step.conditions.requireEvent)?.label}
                </span>
              )}
              {(step.conditions?.requireTags || []).map((t) => (
                <span key={t} className="text-[10px] rounded px-1.5 py-0.5 font-medium" style={{ backgroundColor: `${C.sky}1A`, color: C.sky }}>
                  tag: {t}
                </span>
              ))}
            </div>
          )}
          {Array.isArray(step.attachments) && step.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {step.attachments.map((a, i) => (
                <span key={i} className="text-[10px] rounded px-1.5 py-0.5 flex items-center gap-1" style={{ backgroundColor: C.pale, color: C.slate }}>
                  <Paperclip size={10} /> {a.filename}
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StepFields({
  mode, setMode, templateId, setTemplateId, subject, setSubject, body, setBody,
  attachments, setAttachments, conditions, setConditions, templates,
}) {
  const tagsText = (conditions.requireTags || []).join(", ");
  function setTagsText(text) {
    setConditions({
      ...conditions,
      requireTags: text.split(",").map((t) => t.trim()).filter(Boolean),
    });
  }

  return (
    <>
      {templates.length > 0 && (
        <div className="flex rounded-lg p-0.5 mb-3 w-fit" style={{ backgroundColor: "#fff" }}>
          {["inline", "template"].map((m) => (
            <button key={m} type="button"
              onClick={() => setMode(m)}
              className="rounded-md px-2.5 py-1 text-[11px] font-medium"
              style={{ backgroundColor: mode === m ? C.sky : "transparent", color: mode === m ? "#fff" : C.slate }}
            >
              {m === "inline" ? "Νέο κείμενο" : "Από template"}
            </button>
          ))}
        </div>
      )}
      {mode === "template" ? (
        <select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}
          className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
          <option value="">Επιλέξε template…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      ) : (
        <div className="space-y-2">
          <input required placeholder="Θέμα (π.χ. Γρήγορη ιδέα για το {{company}})" value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }} />
          <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={90} />
          {!hasUnsubscribeLink(body) && body.length > 0 && (
            <TipBanner>Best practice: το email δεν έχει σύνδεσμο απεγγραφής.</TipBanner>
          )}
          <AutoTrackingPixelNote />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
        <select
          value={conditions.requireEvent || ""}
          onChange={(e) => setConditions({ ...conditions, requireEvent: e.target.value || null })}
          className="rounded-lg px-2.5 py-1.5 text-xs border outline-none bg-white"
          style={{ borderColor: C.line, color: C.ink }}
        >
          {EVENT_CONDITIONS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="Μόνο για tags (χωρισμένα με κόμμα)…"
          className="rounded-lg px-2.5 py-1.5 text-xs border outline-none bg-white"
          style={{ borderColor: C.line, color: C.ink }}
        />
      </div>
    </>
  );
}

function emptyStep(index) {
  return {
    mode: "inline",
    templateId: "",
    subject: "",
    body: DEFAULT_DISCLAIMER_HTML,
    delayDays: SUGGESTED_DELAYS[index] ?? 7,
    conditions: { requireEvent: null, requireTags: [] },
    attachments: [],
  };
}

function NewSequenceModal({ onClose, onCreate, templates }) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState([emptyStep(0)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function updateStep(i, patch) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function addStep() {
    setSteps((prev) => [...prev, emptyStep(prev.length)]);
  }
  function removeStep(i) {
    setSteps((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payloadSteps = steps.map((s) =>
        s.mode === "template" && s.templateId
          ? { templateId: s.templateId, delayDays: Number(s.delayDays) || 0, conditions: s.conditions, attachments: s.attachments }
          : { subject: s.subject, body: s.body, delayDays: Number(s.delayDays) || 0, conditions: s.conditions, attachments: s.attachments }
      );
      await onCreate({ name, steps: payloadSteps });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η δημιουργία sequence.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-2xl p-5 max-h-[85vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέο sequence</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>

        {steps.length < 3 && (
          <TipBanner tone="warn">
            Best practice: 3–5 follow-ups ανεβάζουν σημαντικά τα ποσοστά απάντησης. Σκέψου να προσθέσεις ακόμη βήματα πριν δημιουργήσεις το sequence.
          </TipBanner>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input required placeholder="Όνομα sequence" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

          {steps.map((step, i) => (
            <Card key={i} className="p-4" style={{ backgroundColor: C.pale }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold" style={{ color: C.navy }}>Βήμα {i + 1}</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs" style={{ color: C.slate }}>
                    <Clock size={12} />
                    <input type="number" min={0} max={60} value={step.delayDays}
                      onChange={(e) => updateStep(i, { delayDays: e.target.value })}
                      className="w-14 rounded-md px-1.5 py-1 text-xs border outline-none" style={{ borderColor: C.line }} />
                    ημέρες μετά
                  </label>
                  {steps.length > 1 && (
                    <button type="button" onClick={() => removeStep(i)} style={{ color: C.coral }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>

              <StepFields
                mode={step.mode} setMode={(m) => updateStep(i, { mode: m })}
                templateId={step.templateId} setTemplateId={(v) => updateStep(i, { templateId: v })}
                subject={step.subject} setSubject={(v) => updateStep(i, { subject: v })}
                body={step.body} setBody={(v) => updateStep(i, { body: v })}
                attachments={step.attachments} setAttachments={(v) => updateStep(i, { attachments: v })}
                conditions={step.conditions} setConditions={(v) => updateStep(i, { conditions: v })}
                templates={templates}
              />
            </Card>
          ))}

          <button type="button" onClick={addStep}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border"
            style={{ borderColor: C.line, color: C.navy }}>
            <Plus size={14} /> Προσθήκη βήματος {steps.length < SUGGESTED_DELAYS.length ? `(προτείνεται: ${SUGGESTED_DELAYS[steps.length]} ημέρες)` : ""}
          </button>

          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Δημιουργία ({steps.length} βήματα)
          </button>
        </form>
      </Card>
    </div>
  );
}

function AddStepModal({ onClose, onAdd, templates, suggestedDelay }) {
  const [mode, setMode] = useState("inline");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [conditions, setConditions] = useState({ requireEvent: null, requireTags: [] });
  const [delayDays, setDelayDays] = useState(suggestedDelay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload =
        mode === "template"
          ? { templateId, delayDays: Number(delayDays) || 0, conditions, attachments }
          : { subject, body, delayDays: Number(delayDays) || 0, conditions, attachments };
      await onAdd(payload);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η προσθήκη βήματος.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέο βήμα</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <StepFields
            mode={mode} setMode={setMode}
            templateId={templateId} setTemplateId={setTemplateId}
            subject={subject} setSubject={setSubject}
            body={body} setBody={setBody}
            attachments={attachments} setAttachments={setAttachments}
            conditions={conditions} setConditions={setConditions}
            templates={templates}
          />
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Καθυστέρηση (ημέρες)</label>
            <input type="number" min={0} max={60} value={delayDays} onChange={(e) => setDelayDays(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Προσθήκη
          </button>
        </form>
      </Card>
    </div>
  );
}

function SequencesView({ sequences, loading, error, onReload, onCreate, templates, onAddStep, onDeleteStep, onReorderStep, onTestSend, userEmail }) {
  const [activeId, setActiveId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showAddStep, setShowAddStep] = useState(false);
  const [busyStepId, setBusyStepId] = useState(null);

  useEffect(() => {
    if (sequences.length > 0 && !sequences.some((s) => s.id === activeId)) {
      setActiveId(sequences[0].id);
    }
  }, [sequences, activeId]);

  const active = sequences.find((s) => s.id === activeId);

  async function handleDeleteStep(stepId) {
    if (!active) return;
    setBusyStepId(stepId);
    try {
      await onDeleteStep(active.id, stepId);
    } finally {
      setBusyStepId(null);
    }
  }

  async function handleMove(stepId, direction) {
    if (!active) return;
    const ids = active.steps.map((s) => s.id);
    const i = ids.indexOf(stepId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setBusyStepId(stepId);
    try {
      await onReorderStep(active.id, ids);
    } finally {
      setBusyStepId(null);
    }
  }

  const nextSuggestedDelay = active ? SUGGESTED_DELAYS[active.steps.length] ?? 7 : 0;

  return (
    <div className="flex h-full">
      {showNew && <NewSequenceModal onClose={() => setShowNew(false)} onCreate={onCreate} templates={templates} />}
      {showAddStep && active && (
        <AddStepModal
          onClose={() => setShowAddStep(false)}
          templates={templates}
          suggestedDelay={nextSuggestedDelay}
          onAdd={(payload) => onAddStep(active.id, payload)}
        />
      )}
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
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
              <div>
                <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{active.name}</h1>
                <p className="text-sm mt-0.5" style={{ color: C.slate }}>
                  {active.stats?.sent ?? 0} στάλθηκαν · {active.stats?.opened ?? 0} ανοίχτηκαν · {active.stats?.replied ?? 0} απαντήσεις
                </p>
              </div>
              <button onClick={() => setShowAddStep(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white shrink-0" style={{ backgroundColor: C.sky }}>
                <Plus size={14} /> Προσθήκη βήματος
              </button>
            </div>
            <div className="px-8 py-8 max-w-2xl">
              {active.steps.length < 3 && (
                <TipBanner tone="warn">
                  Αυτό το sequence έχει {active.steps.length} {active.steps.length === 1 ? "βήμα" : "βήματα"}. Best practice: 3–5 follow-ups δίνουν σημαντικά καλύτερα reply rates.
                </TipBanner>
              )}
              {active.steps.map((step, i) => (
                <SequenceStepCard
                  key={step.id}
                  step={step}
                  index={i}
                  isLast={i === active.steps.length - 1}
                  canMoveUp={i > 0}
                  canMoveDown={i < active.steps.length - 1}
                  busy={busyStepId === step.id}
                  onMoveUp={() => handleMove(step.id, "up")}
                  onMoveDown={() => handleMove(step.id, "down")}
                  onDelete={() => handleDeleteStep(step.id)}
                  onTestSend={(testEmail) => onTestSend(active.id, step.id, testEmail)}
                  defaultTestEmail={userEmail}
                />
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

function CrmReportingSection({ crm }) {
  if (!crm) return null;
  const OFFER_STATUS_LABELS = { draft: "Πρόχειρες", sent: "Στάλθηκαν", accepted: "Έγιναν δεκτές", declined: "Απορρίφθηκαν" };
  const pipelineData = ["draft", "sent", "accepted", "declined"].map((key) => ({
    name: OFFER_STATUS_LABELS[key],
    value: crm.offersByStatus?.[key] ?? 0,
    fill: OFFER_STATUSES.find((s) => s.key === key)?.color || C.slate,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <StatCard label="Επικοινωνήθηκαν" value={crm.contactsContacted} sub={`από ${crm.contactsTotal} επαφές`} color={C.sky} />
        <StatCard label="Προσφορές" value={crm.offersTotal} sub="σύνολο" color={C.navy} />
        <StatCard label="Win rate" value={crm.winRate == null ? "—" : `${Math.round(crm.winRate * 100)}%`} sub="αποδεκτές / αποφασισμένες" color={C.mint} />
        <StatCard label="Αξία σε εξέλιξη" value={fmtMoney((crm.valueByStatus?.sent || 0) + (crm.valueByStatus?.draft || 0))} sub="draft + sent" color={C.amber} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5">
          <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Pipeline προσφορών</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={pipelineData} layout="vertical" margin={{ left: 20 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: C.ink }} axisLine={false} tickLine={false} width={100} />
              <Tooltip />
              <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                {pipelineData.map((d, i) => <React.Fragment key={i} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-5">
          <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Αξία ανά κατάσταση</div>
          <div className="space-y-2.5">
            {["draft", "sent", "accepted", "declined"].map((key) => (
              <div key={key} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                <span className="text-xs font-medium" style={{ color: C.ink }}>{OFFER_STATUS_LABELS[key]}</span>
                <span className="text-xs" style={{ color: C.slate }}>{fmtMoney(crm.valueByStatus?.[key] || 0)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Συχνότερες αιτίες αποδοχής/απόρριψης</div>
        {(!crm.declineReasons || crm.declineReasons.length === 0) ? (
          <p className="text-sm py-6 text-center" style={{ color: C.slate }}>Δεν έχουν καταχωρηθεί αιτίες ακόμα.</p>
        ) : (
          <div className="space-y-2">
            {crm.declineReasons.map((r, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                <span className="text-xs" style={{ color: C.ink }}>“{r.reason}”</span>
                <span className="text-xs font-medium shrink-0 ml-3" style={{ color: C.slate }}>×{r.count}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function AnalyticsView({ overview, timeline, crmOverview, loading, error, onReload }) {
  const [tab, setTab] = useState("email"); // email | crm
  const totals = overview?.totals || { sent: 0, opened: 0, clicked: 0, replied: 0 };
  const funnelData = [
    { name: "Στάλθηκαν", value: totals.sent, fill: C.navy },
    { name: "Ανοίχτηκαν", value: totals.opened, fill: C.sky },
    { name: "Κλικ", value: totals.clicked, fill: C.amber },
    { name: "Απαντήσεις", value: totals.replied, fill: C.mint },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Analytics</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>
            {tab === "email" ? "Απόδοση όλων των αποστολών — sequences και χειροκίνητα emails" : "CRM reporting — pipeline & αποτελέσματα"}
          </p>
        </div>
        <div className="flex rounded-lg p-0.5" style={{ backgroundColor: C.pale }}>
          {[["email", "Email"], ["crm", "Business (CRM)"]].map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              className="rounded-md px-3 py-1.5 text-xs font-medium"
              style={{ backgroundColor: tab === key ? C.sky : "transparent", color: tab === key ? "#fff" : C.slate }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-8 py-6 space-y-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση analytics…" />
        ) : tab === "crm" ? (
          <CrmReportingSection crm={crmOverview} />
        ) : (
          <>
            <div className="flex flex-wrap gap-4">
              <StatCard label="Open rate" value={pct(totals.opened, totals.sent)} sub={`${totals.sent} αποστολές`} color={C.mint} />
              <StatCard label="Click rate" value={pct(totals.clicked, totals.sent)} sub="σε σχέση με αποστολές" color={C.mint} />
              <StatCard label="Reply rate" value={pct(totals.replied, totals.sent)} sub="σε σχέση με αποστολές" color={C.coral} />
              <StatCard label="Sequences" value={overview?.perSequence?.length ?? 0} sub="ενεργά + ανενεργά" color={C.slate} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

            <Card className="p-5">
              <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Απόδοση ανά campaign</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-2">Campaign</th>
                    <th className="font-medium pb-2">Κατάσταση</th>
                    <th className="font-medium pb-2">Στάλθηκαν</th>
                    <th className="font-medium pb-2">Open rate</th>
                    <th className="font-medium pb-2">Reply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview?.perCampaign || []).map((c) => (
                    <tr key={c.id} className="border-t" style={{ borderColor: C.line }}>
                      <td className="py-2.5 font-medium" style={{ color: C.ink }}>{c.name}</td>
                      <td className="py-2.5"><CampaignStatusBadge status={c.status} /></td>
                      <td className="py-2.5" style={{ color: C.ink }}>{c.sent}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{pct(c.opened, c.sent)}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{pct(c.replied, c.sent)}</td>
                    </tr>
                  ))}
                  {(!overview?.perCampaign || overview.perCampaign.length === 0) && (
                    <tr><td colSpan={5} className="py-6 text-center text-sm" style={{ color: C.slate }}>Κανένα campaign ακόμα.</td></tr>
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
  const [expandedId, setExpandedId] = useState(null);

  return (
    <div className="h-full overflow-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Απεσταλμένα</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>Όλα τα emails που στάλθηκαν — sequences και χειροκίνητα. Πάτησε ένα για το trace.</p>
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
          activity.map((m) => {
            const isOpen = expandedId === m.id;
            return (
              <div key={m.id} className="border-b" style={{ borderColor: C.line }}>
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : m.id)}
                  className="w-full flex items-center justify-between py-3.5 text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <ChevronRight size={14} style={{ color: C.slate, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} className="shrink-0" />
                    <Mail size={16} style={{ color: C.slate }} className="shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{m.subject}</div>
                      <div className="text-xs truncate" style={{ color: C.slate }}>
                        προς {m.toName || m.to}{m.sequenceName ? ` · ${m.sequenceName}` : " · χειροκίνητο"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <Pill status={m.status} />
                    <span className="text-xs" style={{ color: C.slate }}>{fmtDate(m.sentAt)}</span>
                  </div>
                </button>
                {isOpen && (
                  <div className="pl-9 pb-3.5 pr-3">
                    <EventTrace sentAt={m.sentAt} events={m.events} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ComposeModal({ onClose, contacts, gmailConnected, onSend, initialContactId }) {
  const [minimized, setMinimized] = useState(false);
  const [contactId, setContactId] = useState(initialContactId || "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(DEFAULT_DISCLAIMER_HTML);
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function handleSend(e) {
    e.preventDefault();
    if (!contactId) { setError("Επίλεξε παραλήπτη."); return; }
    setError("");
    setBusy(true);
    try {
      await onSend({ contactId, subject, body, attachments });
      setSent(true);
      setTimeout(onClose, 900);
    } catch (err) {
      if (err instanceof ApiError && err.data?.error === "gmail_not_connected") {
        setError("Δεν έχεις συνδέσει Gmail — σύνδεσε το από το μπάνερ στην κορυφή για να στείλεις.");
      } else if (err instanceof ApiError && err.data?.error === "contact_unsubscribed") {
        setError("Η επαφή έχει κάνει unsubscribe — δεν επιτρέπεται αποστολή.");
      } else {
        setError(err instanceof ApiError ? err.message : "Η αποστολή απέτυχε.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed bottom-0 right-0 sm:right-8 w-full sm:w-[460px] rounded-t-xl shadow-2xl bg-white border border-b-0 flex flex-col"
      style={{ borderColor: C.line, height: minimized ? 48 : 580, maxHeight: "90vh", zIndex: 50 }}
    >
      <div className="flex items-center justify-between px-4 py-3 rounded-t-xl" style={{ backgroundColor: C.navy }}>
        <span className="text-sm font-medium text-white">Νέο μήνυμα</span>
        <div className="flex items-center gap-3">
          <button onClick={() => setMinimized((m) => !m)} className="text-white/80 hover:text-white"><Minus size={15} /></button>
          <button onClick={onClose} className="text-white/80 hover:text-white"><X size={15} /></button>
        </div>
      </div>
      {!minimized && (
        <form onSubmit={handleSend} className="flex-1 flex flex-col overflow-auto">
          <div className="px-4 py-2.5 border-b text-sm" style={{ borderColor: C.line, color: C.ink }}>
            <select required value={contactId} onChange={(e) => setContactId(e.target.value)}
              className="w-full outline-none bg-white" style={{ color: contactId ? C.ink : C.slate }}>
              <option value="">Προς — επίλεξε επαφή…</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name ? `${c.name} <${c.email}>` : c.email}</option>
              ))}
            </select>
          </div>
          <div className="px-4 py-2.5 border-b text-sm" style={{ borderColor: C.line, color: C.ink }}>
            <input required placeholder="Θέμα" value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full outline-none" />
          </div>
          <div className="flex-1 px-4 py-3 overflow-auto">
            <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={160} />
            {!hasUnsubscribeLink(body) && body.length > 0 && (
              <TipBanner>Best practice: το email δεν έχει σύνδεσμο απεγγραφής.</TipBanner>
            )}
            <AutoTrackingPixelNote />
          </div>
          {!gmailConnected && (
            <div className="px-4 py-2 text-xs" style={{ backgroundColor: `${C.amber}14`, color: "#7A5206" }}>
              Δεν έχεις συνδέσει Gmail ακόμα — η αποστολή δεν θα δουλέψει χωρίς αυτό.
            </div>
          )}
          {error && <p className="px-4 py-2 text-xs" style={{ color: C.coral }}>{error}</p>}
          <div className="px-4 py-3 border-t flex items-center justify-end gap-2" style={{ borderColor: C.line }}>
            {sent ? (
              <span className="text-sm font-medium" style={{ color: C.mint }}>Εστάλη ✓</span>
            ) : (
              <button type="submit" disabled={busy}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
                style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
                {busy && <Loader2 size={14} className="animate-spin" />} Αποστολή
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

// ---------- Campaigns ----------
// A campaign is one message sent to many contacts, one-by-one with spacing
// between sends (see scheduler.js's campaign tick) — distinct from a
// Sequence, which is a multi-step nurture with day-scale delays per contact.
const CAMPAIGN_STATUS_META = {
  draft:     { label: "Πρόχειρο", color: C.slate },
  running:   { label: "Σε εξέλιξη", color: C.mint },
  paused:    { label: "Σε παύση", color: C.amber },
  completed: { label: "Ολοκληρώθηκε", color: C.sky },
};

function CampaignStatusBadge({ status }) {
  const meta = CAMPAIGN_STATUS_META[status] || CAMPAIGN_STATUS_META.draft;
  return (
    <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium" style={{ backgroundColor: `${meta.color}1A`, color: meta.color }}>
      {meta.label}
    </span>
  );
}

function NewCampaignModal({ onClose, onCreate, contacts, templates }) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(DEFAULT_DISCLAIMER_HTML);
  const [attachments, setAttachments] = useState([]);
  const [intervalMinutes, setIntervalMinutes] = useState(2);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const categories = useMemo(() => {
    const set = new Set(contacts.map((c) => (c.category || "").trim()).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (categoryFilter !== "all" && (c.category || "") !== categoryFilter) return false;
      if (c.unsubscribed) return false; // never let an unsubscribed contact even be selectable
      if (!q) return true;
      return (c.name || "").toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q) || (c.company || "").toLowerCase().includes(q);
    });
  }, [contacts, query, categoryFilter]);

  function toggleContact(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds((prev) => new Set([...prev, ...filtered.map((c) => c.id)]));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function loadFromTemplate(templateId) {
    const t = templates.find((tpl) => tpl.id === templateId);
    if (!t) return;
    setSubject(t.subject);
    setBody(t.body);
    setAttachments(Array.isArray(t.attachments) ? t.attachments : []);
  }

  function insertToken(token) {
    setBody((b) => (b || "") + token);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (selectedIds.size === 0) { setError("Επίλεξε τουλάχιστον 1 επαφή."); return; }
    setError("");
    setBusy(true);
    try {
      await onCreate({
        name,
        subject,
        body,
        attachments,
        contactIds: [...selectedIds],
        intervalMinutes: Number(intervalMinutes) || 2,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η δημιουργία campaign.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-4xl p-5 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέο campaign</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <input required placeholder="Όνομα campaign" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

            {templates.length > 0 && (
              <select defaultValue="" onChange={(e) => { if (e.target.value) loadFromTemplate(e.target.value); e.target.value = ""; }}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.slate }}>
                <option value="">Φόρτωση περιεχομένου από template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}

            <input required placeholder="Θέμα (π.χ. Γρήγορη ιδέα για το {{company}})" value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

            <div className="flex gap-1.5 flex-wrap">
              <span className="text-[11px] self-center" style={{ color: C.slate }}>Εισαγωγή token:</span>
              {["{{name}}", "{{company}}", "{{email}}", "{{comments}}"].map((tok) => (
                <button key={tok} type="button" onClick={() => insertToken(tok)}
                  className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ backgroundColor: C.pale, color: C.navy }}>
                  {tok}
                </button>
              ))}
            </div>
            <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={160} />
            {!hasUnsubscribeLink(body) && body.length > 0 && (
              <TipBanner>Best practice: το email δεν έχει σύνδεσμο απεγγραφής — ιδιαίτερα σημαντικό για μαζικές αποστολές σαν campaign.</TipBanner>
            )}
            <AutoTrackingPixelNote />

            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Απόσταση μεταξύ αποστολών (λεπτά)</label>
              <input type="number" min={1} max={1440} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <p className="text-[11px] mt-1" style={{ color: C.slate }}>
                Τα emails φεύγουν ένα-ένα, όχι όλα μαζί — π.χ. με 2 λεπτά, {selectedIds.size} επαφές θα χρειαστούν περίπου {Math.round((selectedIds.size - 1) * (Number(intervalMinutes) || 2))} λεπτά για να ολοκληρωθούν.
              </p>
            </div>

            {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
            <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
              {busy && <Loader2 size={14} className="animate-spin" />} Δημιουργία campaign (ως πρόχειρο)
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium" style={{ color: C.slate }}>Παραλήπτες</label>
              <span className="text-xs font-medium" style={{ color: C.sky }}>{selectedIds.size} επιλεγμένες</span>
            </div>
            <div className="flex gap-2">
              <input placeholder="Αναζήτηση…" value={query} onChange={(e) => setQuery(e.target.value)}
                className="flex-1 rounded-lg px-3 py-1.5 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
                className="rounded-lg px-2 py-1.5 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
                <option value="all">Όλες οι κατηγορίες</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={selectAllFiltered} className="text-xs font-medium underline" style={{ color: C.sky }}>
                Επιλογή όλων ({filtered.length})
              </button>
              <button type="button" onClick={clearSelection} className="text-xs font-medium underline" style={{ color: C.slate }}>
                Καθαρισμός
              </button>
            </div>
            <div className="rounded-lg border overflow-auto" style={{ borderColor: C.line, maxHeight: 420 }}>
              {filtered.length === 0 ? (
                <p className="text-xs text-center py-6" style={{ color: C.slate }}>Καμία επαφή δεν ταιριάζει.</p>
              ) : (
                filtered.map((c) => (
                  <label key={c.id} className="flex items-center gap-2.5 px-3 py-2 border-b cursor-pointer hover:bg-slate-50" style={{ borderColor: C.line }}>
                    <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleContact(c.id)} />
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate" style={{ color: C.ink }}>{c.name}</div>
                      <div className="text-[11px] truncate" style={{ color: C.slate }}>{c.email}{c.company ? ` · ${c.company}` : ""}</div>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}

function CampaignDetailDrawer({ campaignId, onClose, onLoad, onStart, onPause, onDelete }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDetail(await onLoad(campaignId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν τα στοιχεία campaign.");
    } finally {
      setLoading(false);
    }
  }, [campaignId, onLoad]);

  useEffect(() => { load(); }, [load]);

  async function run(fn) {
    setBusy(true);
    try {
      await fn(campaignId);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Διαγραφή αυτού του campaign; Δεν θα διαγραφούν τα emails που έχουν ήδη σταλεί.")) return;
    setBusy(true);
    try {
      await onDelete(campaignId);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <div className="w-full max-w-2xl h-full bg-white overflow-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white" style={{ borderColor: C.line }}>
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{detail?.name || "Campaign"}</h3>
          <div className="flex items-center gap-3">
            {detail && (detail.status === "draft" || detail.status === "paused") && (
              <button onClick={() => run(onStart)} disabled={busy}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: C.mint, opacity: busy ? 0.6 : 1 }}>
                <Play size={13} /> {detail.status === "paused" ? "Συνέχεια" : "Εκκίνηση"}
              </button>
            )}
            {detail && detail.status === "running" && (
              <button onClick={() => run(onPause)} disabled={busy}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.amber, opacity: busy ? 0.6 : 1 }}>
                <Pause size={13} /> Παύση
              </button>
            )}
            <button onClick={handleDelete} disabled={busy} className="text-slate-400 hover:text-coral-600" title="Διαγραφή">
              <Trash2 size={16} />
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
          </div>
        </div>

        {loading ? (
          <Spinner label="Φόρτωση…" />
        ) : error ? (
          <div className="p-6"><ErrorNote message={error} onRetry={load} /></div>
        ) : detail ? (
          <div className="p-6 space-y-5">
            <div className="flex items-center gap-2">
              <CampaignStatusBadge status={detail.status} />
              <span className="text-xs" style={{ color: C.slate }}>
                {detail.intervalMinutes} λεπτά μεταξύ αποστολών · δημιουργήθηκε {fmtDate(detail.createdAt)}
              </span>
            </div>

            <div className="flex flex-wrap gap-3">
              <StatCard label="Σύνολο" value={detail.counts.total} sub="παραλήπτες" color={C.slate} />
              <StatCard label="Στάλθηκαν" value={detail.counts.sent} sub={`από ${detail.counts.total}`} color={C.navy} />
              <StatCard label="Εκκρεμούν" value={detail.counts.pending} sub="στην ουρά" color={C.amber} />
              <StatCard label="Παραλείφθηκαν" value={detail.counts.skipped + detail.counts.failed} sub="unsubscribed / αποτυχία" color={C.coral} />
            </div>

            <div>
              <div className="text-sm font-medium mb-2" style={{ color: C.ink }}>Θέμα</div>
              <p className="text-sm" style={{ color: C.ink }}>{detail.subject}</p>
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: C.ink }}>
                <Users size={14} /> Παραλήπτες ({detail.recipients.length})
              </div>
              <div className="space-y-2">
                {detail.recipients.map((r) => {
                  const open = expandedId === r.id;
                  return (
                    <div key={r.id} className="rounded-lg overflow-hidden" style={{ backgroundColor: C.pale }}>
                      <button type="button" onClick={() => setExpandedId(open ? null : r.id)}
                        className="w-full flex items-center justify-between px-3 py-2 text-left">
                        <div className="min-w-0 flex items-center gap-1.5">
                          <ChevronRight size={12} style={{ color: C.slate, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} className="shrink-0" />
                          <div className="min-w-0">
                            <div className="text-xs font-medium truncate" style={{ color: C.ink }}>{r.name || r.email}</div>
                            <div className="text-[11px] truncate" style={{ color: C.slate }}>{r.email}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {r.status === "pending" && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.slate}1A`, color: C.slate }}>Εκκρεμεί</span>}
                          {r.status === "sent" && r.opened && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.sky}1A`, color: C.sky }}>Άνοιξε</span>}
                          {r.status === "sent" && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.mint}1A`, color: C.mint }}>Στάλθηκε</span>}
                          {(r.status === "skipped" || r.status === "failed") && (
                            <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.coral}1A`, color: C.coral }}>
                              {r.status === "skipped" ? "Παραλείφθηκε" : "Αποτυχία"}
                            </span>
                          )}
                        </div>
                      </button>
                      {open && (
                        <div className="px-3 pb-2.5 pl-7">
                          {r.note && <p className="text-[11px] mb-1.5" style={{ color: C.coral }}>{r.note}</p>}
                          {r.sentAt ? <EventTrace sentAt={r.sentAt} events={r.events} /> : (
                            <p className="text-[11px]" style={{ color: C.slate }}>Δεν έχει σταλεί ακόμα.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CampaignsView({ campaigns, loading, error, onReload, contacts, templates, onCreate, onStart, onPause, onDelete, onLoadDetail }) {
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function run(id, fn) {
    setBusyId(id);
    try {
      await fn(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="h-full overflow-auto">
      {showNew && <NewCampaignModal onClose={() => setShowNew(false)} onCreate={onCreate} contacts={contacts} templates={templates} />}
      {detailId && (
        <CampaignDetailDrawer campaignId={detailId} onClose={() => setDetailId(null)} onLoad={onLoadDetail} onStart={onStart} onPause={onPause} onDelete={onDelete} />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Campaigns</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>Ένα μήνυμα σε πολλές επαφές, ένα-ένα με απόσταση — όχι μαζική αποστολή.</p>
        </div>
        <button onClick={() => setShowNew(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white shrink-0" style={{ backgroundColor: C.sky }}>
          <Megaphone size={15} /> Νέο campaign
        </button>
      </div>
      <div className="px-8 py-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label="Φόρτωση…" />
        ) : campaigns.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-sm" style={{ color: C.slate }}>
            <Megaphone size={28} strokeWidth={1.5} />
            Δεν έχεις δημιουργήσει campaign ακόμα.
          </div>
        ) : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate, backgroundColor: C.pale }}>
                    <th className="font-medium px-4 py-2.5">Όνομα</th>
                    <th className="font-medium px-4 py-2.5">Κατάσταση</th>
                    <th className="font-medium px-4 py-2.5">Πρόοδος</th>
                    <th className="font-medium px-4 py-2.5">Δημιουργήθηκε</th>
                    <th className="font-medium px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-t cursor-pointer hover:bg-slate-50" style={{ borderColor: C.line }} onClick={() => setDetailId(c.id)}>
                      <td className="px-4 py-3 font-medium" style={{ color: C.ink }}>{c.name}</td>
                      <td className="px-4 py-3"><CampaignStatusBadge status={c.status} /></td>
                      <td className="px-4 py-3" style={{ color: C.ink }}>{c.counts.sent} / {c.counts.total}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: C.slate }}>{fmtDate(c.createdAt)}</td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2">
                          {(c.status === "draft" || c.status === "paused") && (
                            <button onClick={() => run(c.id, onStart)} disabled={busyId === c.id} title="Εκκίνηση" style={{ color: C.mint }}>
                              <Play size={15} />
                            </button>
                          )}
                          {c.status === "running" && (
                            <button onClick={() => run(c.id, onPause)} disabled={busyId === c.id} title="Παύση" style={{ color: C.amber }}>
                              <Pause size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------- Admin ----------
function NewAdminUserModal({ onClose, onCreate }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onCreate({ email, password, name: name || undefined, isAdmin });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η δημιουργία χρήστη.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέος χρήστης</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Όνομα (προαιρετικό)" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input required type="password" minLength={10} placeholder="Κωδικός (τουλάχιστον 10 χαρακτήρες)" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <label className="flex items-center gap-2 text-sm" style={{ color: C.ink }}>
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            Δικαιώματα admin
          </label>
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Δημιουργία χρήστη
          </button>
        </form>
      </Card>
    </div>
  );
}

function AdminView({ users, loading, error, onReload, onApprove, onRevoke, onPromote, onDemote, onCreateUser, onDeleteUser, currentUserId, teamOverview }) {
  const [busyId, setBusyId] = useState(null);
  const [showNew, setShowNew] = useState(false);

  async function run(id, fn) {
    setBusyId(id);
    try {
      await fn(id);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(u) {
    if (!window.confirm(`Διαγραφή του χρήστη ${u.email}; Θα διαγραφούν και όλα τα δεδομένα του (επαφές, sequences, κτλ).`)) return;
    setBusyId(u.id);
    try {
      await onDeleteUser(u.id);
    } finally {
      setBusyId(null);
    }
  }

  const adminCount = users.filter((u) => u.isAdmin).length;

  return (
    <div className="h-full overflow-auto">
      {showNew && <NewAdminUserModal onClose={() => setShowNew(false)} onCreate={onCreateUser} />}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Διαχείριση πρόσβασης</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>Έγκριση νέων λογαριασμών και διαχείριση δικαιωμάτων admin</p>
        </div>
        <button onClick={() => setShowNew(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white shrink-0" style={{ backgroundColor: C.sky }}>
          <UserPlus size={15} /> Νέος χρήστης
        </button>
      </div>
      <div className="px-8 py-6 space-y-6">
        <ErrorNote message={error} onRetry={onReload} />

        {teamOverview && (
          <Card className="p-5">
            <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Απόδοση ομάδας</div>
            <div className="flex flex-wrap gap-4 mb-4">
              <StatCard label="Επαφές" value={teamOverview.totals.contacts} sub="σύνολο team" color={C.sky} />
              <StatCard label="Στάλθηκαν" value={teamOverview.totals.sent} sub="emails, όλοι" color={C.navy} />
              <StatCard label="Προσφορές" value={teamOverview.totals.offers} sub={fmtMoney(teamOverview.totals.offersValue)} color={C.mint} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-2">Χρήστης</th>
                    <th className="font-medium pb-2">Επαφές</th>
                    <th className="font-medium pb-2">Στάλθηκαν</th>
                    <th className="font-medium pb-2">Προσφορές</th>
                    <th className="font-medium pb-2">Win rate</th>
                  </tr>
                </thead>
                <tbody>
                  {teamOverview.perUser.map((u) => (
                    <tr key={u.userId} className="border-t" style={{ borderColor: C.line }}>
                      <td className="py-2.5 font-medium" style={{ color: C.ink }}>{u.name || u.email}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.contacts}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.sent}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.offers} <span style={{ color: C.slate }}>({fmtMoney(u.offersValue)})</span></td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.winRate == null ? "—" : `${Math.round(u.winRate * 100)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {loading ? (
          <Spinner label="Φόρτωση χρηστών…" />
        ) : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ color: C.slate, backgroundColor: C.pale }}>
                  <th className="font-medium px-4 py-2.5">Χρήστης</th>
                  <th className="font-medium px-4 py-2.5">Κατάσταση</th>
                  <th className="font-medium px-4 py-2.5">Ρόλος</th>
                  <th className="font-medium px-4 py-2.5">Εγγραφή</th>
                  <th className="font-medium px-4 py-2.5 text-right">Ενέργειες</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t" style={{ borderColor: C.line }}>
                    <td className="px-4 py-3">
                      <div className="font-medium" style={{ color: C.ink }}>{u.name || "—"}</div>
                      <div className="text-xs" style={{ color: C.slate }}>{u.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      {u.approved ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: C.mint }}><UserCheck size={13} /> Εγκεκριμένος</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: C.amber }}><UserX size={13} /> Εκκρεμεί</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.isAdmin ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: C.navy }}><ShieldCheck size={13} /> Admin</span>
                      ) : (
                        <span className="text-xs" style={{ color: C.slate }}>Χρήστης</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: C.slate }}>{fmtDate(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        {!u.approved && (
                          <button disabled={busyId === u.id} onClick={() => run(u.id, onApprove)}
                            className="rounded-md px-2.5 py-1 text-xs font-medium text-white" style={{ backgroundColor: C.mint }}>
                            Έγκριση
                          </button>
                        )}
                        {u.approved && u.id !== currentUserId && (
                          <button disabled={busyId === u.id} onClick={() => run(u.id, onRevoke)}
                            className="rounded-md px-2.5 py-1 text-xs font-medium border" style={{ borderColor: C.line, color: C.coral }}>
                            Ανάκληση
                          </button>
                        )}
                        {!u.isAdmin && (
                          <button disabled={busyId === u.id} onClick={() => run(u.id, onPromote)}
                            className="rounded-md px-2.5 py-1 text-xs font-medium border" style={{ borderColor: C.line, color: C.navy }}>
                            Ανάδειξη σε admin
                          </button>
                        )}
                        {u.isAdmin && u.id !== currentUserId && (
                          <button disabled={busyId === u.id} onClick={() => run(u.id, onDemote)}
                            className="rounded-md px-2.5 py-1 text-xs font-medium border" style={{ borderColor: C.line, color: C.slate }}>
                            Αφαίρεση admin
                          </button>
                        )}
                        {u.id !== currentUserId && !(u.isAdmin && adminCount <= 1) && (
                          <button disabled={busyId === u.id} onClick={() => handleDelete(u)} title="Διαγραφή χρήστη"
                            className="rounded-md p-1.5" style={{ color: C.coral }}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [authState, setAuthState] = useState("loading"); // loading | anon | authed
  const [user, setUser] = useState(null);
  const [view, setView] = useState("inbox");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeContactId, setComposeContactId] = useState("");
  const [pendingOpenContactId, setPendingOpenContactId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [gmailNotice, setGmailNotice] = useState("");

  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState("");

  const [sequences, setSequences] = useState([]);
  const [sequencesLoading, setSequencesLoading] = useState(false);
  const [sequencesError, setSequencesError] = useState("");

  const [overview, setOverview] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [crmOverview, setCrmOverview] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState("");

  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");

  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");

  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [teamOverview, setTeamOverview] = useState(null);

  const [offers, setOffers] = useState([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersError, setOffersError] = useState("");

  const [campaigns, setCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState("");

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
      const [ov, tl, crm] = await Promise.all([
        api.get("/analytics/overview"),
        api.get("/analytics/timeline?days=14"),
        api.get("/analytics/crm-overview"),
      ]);
      setOverview(ov);
      setTimeline(tl);
      setCrmOverview(crm);
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

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError("");
    try {
      setTemplates(await api.get("/templates"));
    } catch (err) {
      setTemplatesError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν τα templates.");
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadAdminUsers = useCallback(async () => {
    setAdminLoading(true);
    setAdminError("");
    try {
      const [users, overview] = await Promise.all([
        api.get("/admin/users"),
        api.get("/admin/team-overview").catch(() => null),
      ]);
      setAdminUsers(users);
      setTeamOverview(overview);
    } catch (err) {
      setAdminError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν οι χρήστες.");
    } finally {
      setAdminLoading(false);
    }
  }, []);

  const loadOffers = useCallback(async () => {
    setOffersLoading(true);
    setOffersError("");
    try {
      setOffers(await api.get("/offers"));
    } catch (err) {
      setOffersError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν οι προσφορές.");
    } finally {
      setOffersLoading(false);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    setCampaignsError("");
    try {
      setCampaigns(await api.get("/campaigns"));
    } catch (err) {
      setCampaignsError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν τα campaigns.");
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    loadContacts();
    loadSequences();
    loadAnalytics();
    loadActivity();
    loadTemplates();
    loadOffers();
    loadCampaigns();
  }, [loadContacts, loadSequences, loadAnalytics, loadActivity, loadTemplates, loadOffers, loadCampaigns]);

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

  useEffect(() => {
    if (authState === "authed" && user?.isAdmin) loadAdminUsers();
  }, [authState, user, loadAdminUsers]);

  // Analytics/Inbox numbers otherwise only change on the actions we happen to
  // remember to refresh after (see handleManualSend etc. above) — that misses
  // tracking events (opens/clicks/unsubscribes) which land asynchronously
  // whenever the recipient acts, with no corresponding frontend call at all.
  // Re-pull the relevant data the moment the user actually looks at that tab,
  // plus a background poll everywhere else so the sidebar counts and the
  // Analytics stat board stay current without needing a manual reload.
  useEffect(() => {
    if (authState !== "authed") return;
    if (view === "analytics") loadAnalytics();
    if (view === "inbox") loadActivity();
    // Running campaigns send in the background via the scheduler, one
    // recipient at a time — reload whenever this tab is actually open so
    // progress (sent/pending counts) looks live rather than stuck at
    // whatever it was on last page load.
    if (view === "campaigns") loadCampaigns();
  }, [view, authState, loadAnalytics, loadActivity, loadCampaigns]);

  useEffect(() => {
    if (authState !== "authed") return;
    const id = setInterval(() => {
      loadAnalytics();
      loadActivity();
      loadCampaigns();
    }, 30000);
    return () => clearInterval(id);
  }, [authState, loadAnalytics, loadActivity, loadCampaigns]);

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
    setTemplates([]);
    setAdminUsers([]);
    setOffers([]);
    setCampaigns([]);
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

  async function handleLoadContactDetail(id) {
    return api.get(`/contacts/${id}`);
  }

  async function handleAddContactNote(contactId, body) {
    await api.post(`/contacts/${contactId}/notes`, { body });
  }

  async function handleDeleteContactNote(contactId, noteId) {
    await api.del(`/contacts/${contactId}/notes/${noteId}`);
  }

  async function handleSetFollowUp(contactId, date) {
    await api.patch(`/contacts/${contactId}`, { nextFollowUpAt: date });
    await loadContacts();
  }

  async function handleBulkUpdateContacts(ids, data, addTag) {
    await api.post("/contacts/bulk-update", { ids, data, addTag });
    await loadContacts();
    if ("unsubscribed" in (data || {}) || "status" in (data || {})) await loadAnalytics();
  }

  async function handleBulkDeleteContacts(ids) {
    await api.post("/contacts/bulk-delete", { ids });
    await loadContacts();
  }

  async function handleExportContacts() {
    const blob = await api.downloadBlob("/contacts/export");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleCreateOffer(data) {
    await api.post("/offers", data);
    await loadOffers();
  }

  async function handleChangeOfferStatus(id, status, outcomeReason) {
    await api.patch(`/offers/${id}`, outcomeReason !== undefined ? { status, outcomeReason } : { status });
    await loadOffers();
  }

  async function handleDeleteOffer(id) {
    await api.del(`/offers/${id}`);
    await loadOffers();
  }

  async function handleEnroll(contactIds, sequenceId) {
    await api.post(`/sequences/${sequenceId}/enroll`, { contactIds });
    await Promise.all([loadContacts(), loadSequences()]);
  }

  async function handleCreateSequence(data) {
    await api.post("/sequences", data);
    await loadSequences();
  }

  async function handleAddStep(sequenceId, payload) {
    await api.post(`/sequences/${sequenceId}/steps`, payload);
    await loadSequences();
  }

  async function handleDeleteStep(sequenceId, stepId) {
    await api.del(`/sequences/${sequenceId}/steps/${stepId}`);
    await loadSequences();
  }

  async function handleReorderStep(sequenceId, stepIds) {
    await api.post(`/sequences/${sequenceId}/steps/reorder`, { stepIds });
    await loadSequences();
  }

  async function handleTestSendStep(sequenceId, stepId, testEmail) {
    await api.post(`/sequences/${sequenceId}/steps/${stepId}/test-send`, { testEmail });
  }

  async function handleCreateTemplate(data) {
    await api.post("/templates", data);
    await loadTemplates();
  }

  async function handleUpdateTemplate(id, data) {
    await api.patch(`/templates/${id}`, data);
    await loadTemplates();
  }

  async function handleDeleteTemplate(id) {
    await api.del(`/templates/${id}`);
    await loadTemplates();
  }

  async function handleManualSend(data) {
    await api.post("/send", data);
    // Sends move the sent/opened/reply counts on the Analytics board and the
    // Inbox list — refresh both immediately instead of waiting for a tab
    // switch or the next poll (see the polling effect below).
    await Promise.all([loadActivity(), loadContacts(), loadAnalytics()]);
  }

  async function handleCreateCampaign(data) {
    await api.post("/campaigns", data);
    await loadCampaigns();
  }

  async function handleStartCampaign(campaignId) {
    await api.post(`/campaigns/${campaignId}/start`);
    await loadCampaigns();
  }

  async function handlePauseCampaign(campaignId) {
    await api.post(`/campaigns/${campaignId}/pause`);
    await loadCampaigns();
  }

  async function handleDeleteCampaign(campaignId) {
    await api.del(`/campaigns/${campaignId}`);
    await loadCampaigns();
  }

  async function handleLoadCampaignDetail(campaignId) {
    return api.get(`/campaigns/${campaignId}`);
  }

  function openComposeFor(contactId) {
    setComposeContactId(contactId);
    setComposeOpen(true);
  }

  async function handleMarkReplied(contactId) {
    await api.post(`/contacts/${contactId}/mark-replied`);
    await Promise.all([loadContacts(), loadSequences(), loadAnalytics()]);
  }

  async function handleToggleUnsubscribed(contactId, next) {
    await api.patch(`/contacts/${contactId}`, { unsubscribed: next });
    await Promise.all([loadContacts(), loadAnalytics()]);
  }

  // Freeform personalization notes, editable straight from the contact
  // drawer — no contacts list refresh needed since comments aren't shown in
  // the table, only used as {{comments}} merge content when composing.
  async function handleUpdateComments(contactId, comments) {
    await api.patch(`/contacts/${contactId}`, { comments });
  }

  function handleSelectFromSearch(contactId) {
    setView("contacts");
    setPendingOpenContactId(contactId);
    setSidebarOpen(false);
  }

  async function handleApproveUser(id) {
    await api.post(`/admin/users/${id}/approve`);
    await loadAdminUsers();
  }
  async function handleRevokeUser(id) {
    await api.post(`/admin/users/${id}/revoke`);
    await loadAdminUsers();
  }
  async function handlePromoteUser(id) {
    await api.post(`/admin/users/${id}/promote`);
    await loadAdminUsers();
  }
  async function handleDemoteUser(id) {
    await api.post(`/admin/users/${id}/demote`);
    await loadAdminUsers();
  }
  async function handleCreateAdminUser(data) {
    await api.post("/admin/users", data);
    await loadAdminUsers();
  }
  async function handleDeleteAdminUser(id) {
    await api.del(`/admin/users/${id}`);
    await loadAdminUsers();
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
    templates: templates.length,
    offers: offers.length,
    campaigns: campaigns.filter((c) => c.status === "running").length,
  };

  return (
    <div className="flex h-screen w-full" style={{ backgroundColor: "#F7F9FC", fontFamily: "Inter, sans-serif" }}>
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:relative inset-y-0 left-0 z-40 w-60 border-r flex flex-col shrink-0 transform transition-transform duration-200 md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
        style={{ borderColor: C.line, backgroundColor: "#FFFFFF" }}
      >
        <div className="px-5 py-5 flex items-center justify-between">
          <Brand size={32} textSize="text-base" />
          <button onClick={() => setSidebarOpen(false)} className="md:hidden text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="px-3">
          <button
            onClick={() => { setComposeOpen(true); setSidebarOpen(false); }}
            className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white mb-3 shadow-sm"
            style={{ backgroundColor: C.sky }}
          >
            <Pencil size={14} /> Σύνταξη
          </button>
        </div>

        <GlobalSearch onSelectContact={handleSelectFromSearch} />

        <div className="px-3 space-y-0.5 flex-1">
          <NavItem icon={Mail} label="Απεσταλμένα" active={view === "inbox"} onClick={() => { setView("inbox"); setSidebarOpen(false); }} count={counts.inbox} />
          <NavItem icon={Users} label="Επαφές" active={view === "contacts"} onClick={() => { setView("contacts"); setSidebarOpen(false); }} count={counts.contacts} />
          <NavItem icon={Layers} label="Sequences" active={view === "sequences"} onClick={() => { setView("sequences"); setSidebarOpen(false); }} count={counts.sequences} />
          <NavItem icon={FileText} label="Templates" active={view === "templates"} onClick={() => { setView("templates"); setSidebarOpen(false); }} count={counts.templates} />
          <NavItem icon={Handshake} label="Offers" active={view === "offers"} onClick={() => { setView("offers"); setSidebarOpen(false); }} count={counts.offers} />
          <NavItem icon={Megaphone} label="Campaigns" active={view === "campaigns"} onClick={() => { setView("campaigns"); setSidebarOpen(false); }} count={counts.campaigns} />
          <NavItem icon={BarChart3} label="Analytics" active={view === "analytics"} onClick={() => { setView("analytics"); setSidebarOpen(false); }} />
          {user?.isAdmin && (
            <NavItem icon={ShieldCheck} label="Admin" active={view === "admin"} onClick={() => { setView("admin"); setSidebarOpen(false); }} />
          )}
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
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: C.line, backgroundColor: "#FFFFFF" }}>
          <button onClick={() => setSidebarOpen(true)} className="text-slate-500 hover:text-slate-700">
            <Menu size={20} />
          </button>
          <Brand size={26} textSize="text-sm" />
        </div>
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
              onLoadDetail={handleLoadContactDetail}
              onAddNote={handleAddContactNote}
              onDeleteNote={handleDeleteContactNote}
              onSetFollowUp={handleSetFollowUp}
              onBulkUpdate={handleBulkUpdateContacts}
              onBulkDelete={handleBulkDeleteContacts}
              onExport={handleExportContacts}
              onCompose={openComposeFor}
              onMarkReplied={handleMarkReplied}
              onToggleUnsubscribed={handleToggleUnsubscribed}
              onUpdateComments={handleUpdateComments}
              openContactId={pendingOpenContactId}
              onOpenContactHandled={() => setPendingOpenContactId("")}
            />
          )}
          {view === "sequences" && (
            <SequencesView
              sequences={sequences}
              loading={sequencesLoading}
              error={sequencesError}
              onReload={loadSequences}
              onCreate={handleCreateSequence}
              templates={templates}
              onAddStep={handleAddStep}
              onDeleteStep={handleDeleteStep}
              onReorderStep={handleReorderStep}
              onTestSend={handleTestSendStep}
              userEmail={user?.email}
            />
          )}
          {view === "templates" && (
            <TemplatesView
              templates={templates}
              loading={templatesLoading}
              error={templatesError}
              onReload={loadTemplates}
              onCreate={handleCreateTemplate}
              onUpdate={handleUpdateTemplate}
              onDelete={handleDeleteTemplate}
            />
          )}
          {view === "offers" && (
            <OffersView
              offers={offers}
              contacts={contacts}
              loading={offersLoading}
              error={offersError}
              onReload={loadOffers}
              onCreate={handleCreateOffer}
              onChangeStatus={handleChangeOfferStatus}
              onDelete={handleDeleteOffer}
            />
          )}
          {view === "campaigns" && (
            <CampaignsView
              campaigns={campaigns}
              loading={campaignsLoading}
              error={campaignsError}
              onReload={loadCampaigns}
              contacts={contacts}
              templates={templates}
              onCreate={handleCreateCampaign}
              onStart={handleStartCampaign}
              onPause={handlePauseCampaign}
              onDelete={handleDeleteCampaign}
              onLoadDetail={handleLoadCampaignDetail}
            />
          )}
          {view === "analytics" && (
            <AnalyticsView overview={overview} timeline={timeline} crmOverview={crmOverview} loading={analyticsLoading} error={analyticsError} onReload={loadAnalytics} />
          )}
          {view === "admin" && user?.isAdmin && (
            <AdminView
              users={adminUsers}
              loading={adminLoading}
              error={adminError}
              onReload={loadAdminUsers}
              onApprove={handleApproveUser}
              onRevoke={handleRevokeUser}
              onPromote={handlePromoteUser}
              onDemote={handleDemoteUser}
              onCreateUser={handleCreateAdminUser}
              onDeleteUser={handleDeleteAdminUser}
              currentUserId={user.id}
              teamOverview={teamOverview}
            />
          )}
        </div>
      </div>

      {composeOpen && (
        <ComposeModal
          onClose={() => { setComposeOpen(false); setComposeContactId(""); }}
          contacts={contacts}
          gmailConnected={!!user?.gmail}
          initialContactId={composeContactId}
          onSend={handleManualSend}
        />
      )}
    </div>
  );
}
