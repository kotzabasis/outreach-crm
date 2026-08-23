import React, { useState, useMemo, useRef, useEffect, useCallback, lazy, Suspense } from "react";
import {
  Mail, Send, Users, BarChart3, Layers, Search, Upload, Plus, X,
  Clock, Tag, ChevronRight, Trash2, Pencil, MoreVertical, Paperclip,
  Minus, Maximize2, ChevronDown, Building2, CircleCheck, CircleDot,
  CircleX, Reply, LogOut, MailCheck, Loader2, AlertTriangle,
  Phone, FileText, Copy, ArrowUp, ArrowDown,
  ShieldCheck, UserCheck, UserX, Sparkles, Euro, StickyNote,
  CalendarClock, Download, Eye, Handshake, Bold, Italic, Underline,
  List, ListOrdered, Link as LinkIcon, UserPlus, Menu,
  AlignLeft, AlignCenter, AlignRight, Info, Megaphone, Play, Pause, Globe,
  Facebook, Instagram, MapPin, Star, Linkedin
} from "lucide-react";
import { api, API_URL, ApiError } from "./lib/api";
import { t, useLang, LanguageSwitcher } from "./lib/i18n.jsx";
import { C, Card, Spinner, ErrorNote, StatCard, EmptyState, Skeleton, SkeletonRows, PageHeader, Brand, ThemeToggle, useTheme, fmtMoney, fmtDate, OFFER_STATUSES, CampaignStatusBadge } from "./lib/ui.jsx";
import { toast, toastUndo, Toaster } from "./lib/toast.jsx";
import { AuthScreen } from "./AuthScreen.jsx";
import DOMPurify from "dompurify";

// recharts (and everything that depends on it) now lives entirely in
// AnalyticsView.jsx, loaded as its own chunk only when a user actually opens
// the Analytics tab - previously it shipped in every visitor's initial
// bundle regardless of whether they ever looked at that tab.
const AnalyticsView = lazy(() => import("./AnalyticsView.jsx"));

// Cold-outreach best-practice cadence: immediate, then 3/7/14/21/30 days -
// gives ~3-5 touches, which is the sweet spot most sales/outreach guides
// converge on before diminishing returns / spam fatigue set in.
const SUGGESTED_DELAYS = [0, 3, 7, 14, 21, 30];

const MERGE_SAMPLE = {
  name: "Μαρία Παπαδοπούλου",
  firstName: "Μαρία",
  lastName: "Παπαδοπούλου",
  company: "Acme A.E.",
  email: "maria@acme.gr",
  website: "acme.gr",
  gmb: "#",
  facebook: "#",
  instagram: "#",
  googleReviews: "#",
  reportLink: "#",
  bookingLink: "https://cal.com/you",
  comments: "μου άρεσε πολύ το τελευταίο σας project",
};
const SPAM_WORDS = [
  "δωρεάν", "εγγύηση", "click here", "κάνε κλικ εδώ", "act now", "τώρα αμέσως",
  "100%", "no obligation", "χωρίς καμία δέσμευση", "buy now", "αγόρασε τώρα",
  "urgent", "επείγον", "cash", "μετρητά", "winner", "νικητής", "risk-free",
  "χωρίς ρίσκο", "limited time", "περιορισμένος χρόνος",
];

// Seeded into every brand-new template/compose/step body (empty drafts only -
// never forced onto existing content) so the unsubscribe line is there by
// default but fully editable, movable, or deletable like any other text -
// per Stelios's request that it not be a hidden, backend-only addition
// anymore. {{unsubscribe_link}} is resolved to the real per-send URL
// server-side at send time (see injectTracking in gmailClient.js); here in
// the editor/preview it's just a token like {{name}}.
//
// Leads with an empty paragraph on purpose: with only the disclaimer <div>
// in the editor, contentEditable has nowhere else to put the caret, so
// clicking "above" it just drops you at the start of the disclaimer's own
// text - there's no way to write your own content first. The empty <p>
// gives the cursor a real line to land on above the disclaimer.
const DEFAULT_DISCLAIMER_HTML =
  '<p><br></p><div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:sans-serif;font-size:11px;color:#94a3b8;">Αν δεν θέλετε να λάβετε καμία άλλη επικοινωνία από εμάς, <a href="{{unsubscribe_link}}" style="color:#94a3b8;text-decoration:underline;">πατήστε εδώ</a>.</div>';

// The unsubscribe footer is now editable per workspace (Ομάδα → settings). The
// configured value is fetched once at app load and cached here; new draft
// bodies seed from unsubscribeSeed() instead of the hardcoded default. Falls
// back to DEFAULT_DISCLAIMER_HTML until settings load (and if the field is empty).
let _unsubscribeSeed = DEFAULT_DISCLAIMER_HTML;
function unsubscribeSeed() {
  return _unsubscribeSeed || DEFAULT_DISCLAIMER_HTML;
}
export function setUnsubscribeSeed(html) {
  _unsubscribeSeed = html || DEFAULT_DISCLAIMER_HTML;
}

// A body is "compliant" if it still contains a real unsubscribe link - check
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
    .split("{{first_name}}").join(MERGE_SAMPLE.firstName)
    .split("{{last_name}}").join(MERGE_SAMPLE.lastName)
    .split("{{company}}").join(MERGE_SAMPLE.company)
    .split("{{email}}").join(MERGE_SAMPLE.email)
    .split("{{website}}").join(MERGE_SAMPLE.website)
    .split("{{gmb}}").join(MERGE_SAMPLE.gmb)
    .split("{{facebook}}").join(MERGE_SAMPLE.facebook)
    .split("{{instagram}}").join(MERGE_SAMPLE.instagram)
    .split("{{google_reviews}}").join(MERGE_SAMPLE.googleReviews)
    .split("{{report_link}}").join(MERGE_SAMPLE.reportLink)
    .split("{{booking_link}}").join(MERGE_SAMPLE.bookingLink)
    .split("{{comments}}").join(MERGE_SAMPLE.comments)
    // "#" keeps the preview link clickable-looking without pointing anywhere
    // real - the actual URL only exists once a send creates a trackingId.
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

function isFollowUpDue(value) {
  if (!value) return false;
  return new Date(value).getTime() <= Date.now();
}

// Mirrors backend/src/lib/attachments.js - no external file storage, so
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

// Always shows date + time - used in the per-send event trace, where fmtDate's
// "just the time if it's today" shorthand would be ambiguous across a list of
// events that might span several days.
function fmtDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.toLocaleDateString("el-GR", { day: "2-digit", month: "short" })}, ${d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" })}`;
}

// Renders the chronological trace for one sent email: when it was sent, when
// (if ever) it was genuinely opened/clicked, and - transparently - any open
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
            ? t("Άνοιγμα αγνοήθηκε (αυτόματο/bot, όχι πραγματικό)")
            : t("Άνοιξε")
          : t("Κλικ σε σύνδεσμο") + (e.url ? `: ${e.url}` : ""),
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
          <span className="truncate">{t(it.label)}</span>
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
      {t(meta.label)}
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
  if (!children) return <span style={{ color: C.slate }}>-</span>;
  return (
    <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${C.sky}14`, color: C.sky }}>
      {children}
    </span>
  );
}

function NavItem({ icon: Icon, label, active, onClick, count, dark = false }) {
  // Dark rail: active row gets a translucent white fill + a sky accent bar and
  // crisp white text; idle rows sit in muted light-blue and brighten on hover.
  const color = dark
    ? (active ? "#FFFFFF" : C.onDark)
    : (active ? C.navy : "#475569");
  return (
    <button
      onClick={onClick}
      className={`group relative w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
        dark ? (active ? "" : "hover:bg-white/5") : (active ? "" : "hover:bg-slate-50")
      }`}
      style={{
        backgroundColor: active ? (dark ? "rgba(255,255,255,0.08)" : C.pale) : "transparent",
        color,
      }}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r" style={{ backgroundColor: dark ? "#7FB0FF" : C.sky }} />
      )}
      <Icon size={17} strokeWidth={active ? 2.4 : 2} style={{ color: active ? (dark ? "#7FB0FF" : C.sky) : "currentColor" }} />
      <span className="flex-1 text-left">{label}</span>
      {count != null && count > 0 && (
        <span
          className="text-[11px] font-semibold rounded-full px-1.5 min-w-[20px] text-center"
          style={
            dark
              ? { backgroundColor: active ? "rgba(127,176,255,0.18)" : "rgba(255,255,255,0.08)", color: active ? "#CFE0FF" : C.onDark }
              : { backgroundColor: active ? "#fff" : "transparent", color: active ? C.navy : C.slate }
          }
        >
          {count}
        </span>
      )}
    </button>
  );
}

// Lives in the sidebar, but works from any view - debounced query against
// GET /contacts?q=, jumps into the Contacts view and opens the picked
// contact's detail drawer via App's pendingOpenContactId relay.
function GlobalSearch({ onSelectContact, dark = false }) {
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
        // GET /contacts now returns a { contacts, total, ... } envelope
        // (paginated server-side) rather than a bare array - see
        // routes/contacts.js. pageSize=8 avoids fetching more rows than this
        // dropdown will ever show.
        const data = await api.get(`/contacts?q=${encodeURIComponent(query.trim())}&pageSize=8`);
        if (cancelled) return; // a newer query/clear already superseded this response
        setResults(data.contacts.slice(0, 8));
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
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: dark ? C.onDarkMuted : C.slate }} />
        <input
          id="global-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={t("Αναζήτηση επαφών…  (⌘K)")}
          className="w-full rounded-lg pl-8 pr-3 py-2 text-xs border outline-none placeholder:text-current"
          style={
            dark
              ? { borderColor: "rgba(255,255,255,0.12)", color: "#FFFFFF", backgroundColor: "rgba(255,255,255,0.06)" }
              : { borderColor: C.line, color: C.ink, backgroundColor: C.pale }
          }
        />
      </div>
      {open && (
        <div className="absolute left-3 right-3 mt-1 rounded-lg border bg-white shadow-lg z-50 overflow-hidden max-h-64 overflow-y-auto" style={{ borderColor: C.line }}>
          {loading ? (
            <div className="px-3 py-2 text-xs" style={{ color: C.slate }}>{t("Αναζήτηση…")}</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs" style={{ color: C.slate }}>{t("Καμία επαφή.")}</div>
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

// ⌘K command palette: fuzzy-ish filter over a list of static actions
// (navigate + create + quick actions, passed in from App so they can call
// setView/setComposeOpen/etc.) plus live contact-search results from the same
// /contacts?q= endpoint the sidebar search uses. Full keyboard nav: ↑/↓ to
// move, Enter to run, Esc to close.
function CommandPalette({ open, onClose, actions, onOpenContact }) {
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setContacts([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  // Debounced contact lookup (only when there's a query).
  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    if (!query.trim()) { setContacts([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.get(`/contacts?q=${encodeURIComponent(query.trim())}&pageSize=5`);
        setContacts(data.contacts.slice(0, 5));
      } catch { setContacts([]); }
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  const q = query.trim().toLowerCase();
  const filteredActions = q
    ? actions.filter((a) => (a.label + " " + (a.keywords || "")).toLowerCase().includes(q))
    : actions;

  // Flat list of selectable rows: actions first, then contacts.
  const rows = [
    ...filteredActions.map((a) => ({ kind: "action", ...a })),
    ...contacts.map((c) => ({ kind: "contact", id: c.id, label: c.name || c.email, sub: c.email, contact: c })),
  ];

  function run(row) {
    if (!row) return;
    onClose();
    if (row.kind === "action") row.run();
    else onOpenContact(row.contact.id);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(rows[active]); }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center p-4 pt-[12vh]" style={{ backgroundColor: "rgba(16,25,43,0.45)" }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white border overflow-hidden" style={{ borderColor: C.line, boxShadow: "0 24px 60px rgba(16,25,43,0.30)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: C.line }}>
          <Search size={16} style={{ color: C.slate }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder={t("Πήγαινε ή κάνε ενέργεια…")}
            className="flex-1 outline-none text-sm bg-transparent"
            style={{ color: C.ink }}
          />
          <span className="text-[10px] font-semibold rounded px-1.5 py-0.5" style={{ backgroundColor: C.pale, color: C.slate }}>ESC</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs" style={{ color: C.slate }}>{t("Κανένα αποτέλεσμα.")}</div>
          ) : (
            rows.map((row, i) => (
              <button
                key={row.kind + row.id}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => run(row)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
                style={{ backgroundColor: i === active ? C.pale : "transparent" }}
              >
                <span className="flex items-center justify-center rounded-md shrink-0" style={{ width: 26, height: 26, backgroundColor: i === active ? "#fff" : C.pale }}>
                  {row.kind === "action" ? (row.icon ? <row.icon size={14} style={{ color: C.navy }} /> : <ChevronRight size={14} style={{ color: C.navy }} />) : <Users size={14} style={{ color: C.navy }} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate" style={{ color: C.ink }}>{row.label}</span>
                  {row.sub && <span className="block text-xs truncate" style={{ color: C.slate }}>{row.sub}</span>}
                </span>
                {row.kind === "contact" && <span className="text-[10px]" style={{ color: C.slate }}>{t("επαφή")}</span>}
              </button>
            ))
          )}
        </div>
      </div>
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
// link - clicking it in the sent email would try to navigate relative to
// whatever page it's opened from, which breaks silently. Default to https.
function normalizeLinkUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^mailto:/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// Every RichTextEditor value gets routed through here before it's ever
// assigned to innerHTML. This isn't just content we typed ourselves - it can
// also be data loaded straight from the server (a contact's `comments`, a
// template/step/campaign body), which itself can originate from a CSV
// upload of a list we didn't author. Without this, a stray
// <img src=x onerror=...> in an imported column would execute the instant
// the record is opened. DOMPurify's default profile strips
// script/onerror/javascript: hrefs etc. while keeping the formatting tags
// (b/i/u/lists/links/inline style) the toolbar actually produces.
function sanitizeRichHtml(html) {
  return DOMPurify.sanitize(html || "");
}

// Minimal Gmail-style toolbar over a contentEditable div - no external
// dependency, since bold/lists/links/attachments are all the app needs.
function RichTextEditor({ value, onChange, attachments, onAttachmentsChange, minHeight = 140 }) {
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const [attachError, setAttachError] = useState("");

  useEffect(() => {
    const clean = sanitizeRichHtml(value);
    if (editorRef.current && editorRef.current.innerHTML !== clean) {
      editorRef.current.innerHTML = clean;
    }
  }, [value]);

  function exec(command, arg) {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    onChange(sanitizeRichHtml(editorRef.current?.innerHTML || ""));
  }

  function handleLink() {
    const raw = window.prompt(t("Σύνδεσμος (URL):"), "https://");
    if (!raw || !raw.trim()) return;
    const url = normalizeLinkUrl(raw);
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      toast.error(t("Ο σύνδεσμος δεν φαίνεται έγκυρος."));
      return;
    }
    const safeUrl = url.replace(/"/g, "&quot;");

    // execCommand("createLink") silently does nothing if there's no active
    // text selection - that looked like "the link just isn't there" to
    // anyone who clicked the button without first highlighting text. Fall
    // back to inserting the URL itself as the link text in that case.
    const selection = window.getSelection();
    const hasSelection =
      selection && selection.toString().length > 0 && editorRef.current?.contains(selection.anchorNode);

    editorRef.current?.focus();
    if (hasSelection) {
      document.execCommand("createLink", false, url);
      // execCommand doesn't let us style the anchor it just created directly -
      // find it by href and apply the same inline style as the manual-insert
      // branch below. Inline (not stylesheet) styling matters here because
      // Gmail/Outlook etc. strip <style> blocks - an unstyled <a> can render
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
    onChange(sanitizeRichHtml(editorRef.current?.innerHTML || ""));
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!onAttachmentsChange) return;
    setAttachError("");
    const next = [...attachments];
    for (const file of files) {
      if (next.length >= MAX_ATTACHMENTS) {
        setAttachError(t("Μέχρι {n} αρχεία ανά email.", { n: MAX_ATTACHMENTS }));
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(t("Το \"{name}\" ξεπερνάει τα 2MB.", { name: file.name }));
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
        <ToolBtn onClick={() => exec("bold")} title={t("Έντονα")}><Bold size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("italic")} title={t("Πλάγια")}><Italic size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("underline")} title={t("Υπογράμμιση")}><Underline size={14} /></ToolBtn>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: C.line }} />
        <ToolBtn onClick={() => exec("insertUnorderedList")} title={t("Λίστα με κουκκίδες")}><List size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("insertOrderedList")} title={t("Αριθμημένη λίστα")}><ListOrdered size={14} /></ToolBtn>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: C.line }} />
        <ToolBtn onClick={() => exec("justifyLeft")} title={t("Στοίχιση αριστερά")}><AlignLeft size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("justifyCenter")} title={t("Στοίχιση στο κέντρο")}><AlignCenter size={14} /></ToolBtn>
        <ToolBtn onClick={() => exec("justifyRight")} title={t("Στοίχιση δεξιά")}><AlignRight size={14} /></ToolBtn>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: C.line }} />
        <ToolBtn onClick={handleLink} title={t("Σύνδεσμος")}><LinkIcon size={14} /></ToolBtn>
        {onAttachmentsChange && (
          <>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFiles} />
            <ToolBtn onClick={() => fileRef.current?.click()} title={t("Επισύναψη αρχείου")}><Paperclip size={14} /></ToolBtn>
          </>
        )}
      </div>
      <div
        ref={editorRef}
        contentEditable
        onInput={() => onChange(sanitizeRichHtml(editorRef.current?.innerHTML || ""))}
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

// The unsubscribe line used to be a hidden, backend-only addition - it now
// lives directly in the editable body (see DEFAULT_DISCLAIMER_HTML, seeded
// into new drafts) so it shows up naturally in the live preview above this.
// The only thing still added invisibly at send time is the 1x1 open-tracking
// pixel, which has no visual form to preview - this is just a one-line note
// about that, for transparency.
function AutoTrackingPixelNote() {
  return (
    <div className="flex items-center gap-1.5 text-[11px] mt-2" style={{ color: C.slate }}>
      <Info size={11} className="shrink-0" /> {t("Προστίθεται επίσης ένα αόρατο pixel παρακολούθησης ανοίγματος σε κάθε αποστολή.")}
    </div>
  );
}

// ---------- Brand ----------
// AuthScreen and ResetPasswordPage moved to their own files (AuthScreen.jsx,
// ResetPasswordPage.jsx) so they can be shared/lazy-loaded independently -
// see main.jsx for how the three top-level screens are split.

function GmailBanner({ user }) {
  if (!user) return null;
  // The connected mailbox is shared company-wide now - only the workspace
  // owner can (re)connect it (see requireOwner on /auth/google in the
  // backend). A plain member would otherwise hit a raw 403 clicking this.
  const isOwner = user.role === "owner";

  if (!user.gmail) {
    return (
      <div className="flex items-center justify-between px-6 py-2.5 text-sm" style={{ backgroundColor: `${C.amber}14`, color: "#7A5206" }}>
        <span>
          {isOwner
            ? t("Δεν έχετε συνδέσει Gmail ακόμα - η αποστολή δεν θα δουλέψει χωρίς αυτό.")
            : t("Το workspace σας δεν έχει συνδέσει Gmail ακόμα - ζήτησε από τον ιδιοκτήτη να το συνδέσει.")}
        </span>
        {isOwner && (
          <a
            href={`${API_URL}/auth/google`}
            className="font-medium rounded-lg px-3 py-1.5 text-white shrink-0"
            style={{ backgroundColor: C.amber }}
          >
            {t("Σύνδεση Gmail")}
          </a>
        )}
      </div>
    );
  }

  // Set once a send has failed with a Gmail auth error (revoked/expired
  // access - see backend lib/gmailClient.js#isAuthError). The scheduler
  // stops attempting sends for this account until this is cleared by a
  // successful reconnect, so this takes priority over the daily-cap notice
  // below - a broken connection is a "nothing is sending" situation, not a
  // "almost sent the max" one.
  if (user.gmail.needsReconnect) {
    return (
      <div className="flex items-center justify-between px-6 py-2.5 text-sm" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>
        <span>
          {isOwner
            ? t("Η σύνδεση Gmail διακόπηκε (πιθανώς ανακλήθηκε η πρόσβαση) - οι αποστολές έχουν σταματήσει μέχρι να συνδεθεί ξανά.")
            : t("Η σύνδεση Gmail του workspace διακόπηκε - ζήτησε από τον ιδιοκτήτη να τη συνδέσει ξανά.")}
        </span>
        {isOwner && (
          <a
            href={`${API_URL}/auth/google`}
            className="font-medium rounded-lg px-3 py-1.5 text-white shrink-0"
            style={{ backgroundColor: C.coral }}
          >
            {t("Επανασύνδεση Gmail")}
          </a>
        )}
      </div>
    );
  }

  // Partial breakage: some (but not all) mailboxes are down. Sending continues
  // on the healthy ones, so this is a softer amber warning rather than the red
  // "stopped" one above - but still surfaced so a silently-lost mailbox (and
  // its capacity) doesn't go unnoticed.
  if (user.gmail.someNeedReconnect) {
    return (
      <div className="flex items-center justify-between px-6 py-2.5 text-sm" style={{ backgroundColor: `${C.amber}14`, color: "#7A5206" }}>
        <span>
          {isOwner
            ? t("{broken} από τα {total} mailbox χρειάζονται επανασύνδεση - η αποστολή συνεχίζει με μειωμένη χωρητικότητα.", { broken: user.gmail.brokenCount, total: user.gmail.mailboxCount })
            : t("Ένα mailbox του workspace χρειάζεται επανασύνδεση - ζήτησε από τον ιδιοκτήτη να το φτιάξει.")}
        </span>
        {isOwner && (
          <a href={`${API_URL}/auth/google`} className="font-medium rounded-lg px-3 py-1.5 text-white shrink-0" style={{ backgroundColor: C.amber }}>
            {t("Επανασύνδεση")}
          </a>
        )}
      </div>
    );
  }

  // Same daily cap the backend enforces on every send path (see
  // lib/emailCap.js) - only worth interrupting people with once it's
  // actually close, not on every normal day of sending.
  const { sentToday, dailyCap } = user.gmail;
  const usageRatio = dailyCap > 0 ? sentToday / dailyCap : 0;
  if (usageRatio < 0.8) return null;

  const capped = sentToday >= dailyCap;
  return (
    <div
      className="flex items-center justify-between px-6 py-2.5 text-sm"
      style={{ backgroundColor: capped ? `${C.coral}14` : `${C.amber}14`, color: capped ? C.coral : "#7A5206" }}
    >
      <span>
        {capped
          ? t("Το ημερήσιο όριο emails ({sent}/{cap}) έχει συμπληρωθεί - η αποστολή θα συνεχίσει αύριο.", { sent: sentToday, cap: dailyCap })
          : t("Πλησιάζετε το ημερήσιο όριο emails: {sent}/{cap} έχουν σταλεί σήμερα.", { sent: sentToday, cap: dailyCap })}
      </span>
    </div>
  );
}

// ---------- Contacts ----------
function NewContactModal({ onClose, onCreate }) {
  const [form, setForm] = useState({
    name: "", firstName: "", lastName: "", email: "", phone: "", company: "",
    category: "", tags: "", timezone: "", website: "", gmb: "", facebook: "", instagram: "",
    googleReviews: "", reportLink: "", linkedinProfileUrl: "", comments: "", internalNotes: "",
  });
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
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η δημιουργία επαφής."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5 max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Νέα επαφή")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required placeholder={t("Όνομα (εμφανίζεται ως {{name}} σε emails)")} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div className="grid grid-cols-2 gap-2">
            <input placeholder={t("Όνομα (first name)")} value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <input placeholder={t("Επώνυμο (last name)")} value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div className="grid grid-cols-2 gap-2">
            <input placeholder={t("Τηλέφωνο")} value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <input placeholder={t("Εταιρεία")} value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input placeholder={t("Κατηγορία (π.χ. Lead, Πελάτης)")} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <input placeholder={t("Ετικέτες (χωρισμένες με κόμμα)")} value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          <input placeholder={t("Ζώνη ώρας (προαιρετικό, π.χ. Europe/London - για send window στην ώρα του παραλήπτη)")} value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder={t("Website (προαιρετικό - {{website}} σε emails)")} value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="GMB" value={form.gmb} onChange={(e) => setForm((f) => ({ ...f, gmb: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <input placeholder="Facebook" value={form.facebook} onChange={(e) => setForm((f) => ({ ...f, facebook: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="Instagram" value={form.instagram} onChange={(e) => setForm((f) => ({ ...f, instagram: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <input placeholder="Google Reviews" value={form.googleReviews} onChange={(e) => setForm((f) => ({ ...f, googleReviews: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          <input placeholder={t("Report link (προαιρετικό - {{report_link}} σε emails)")} value={form.reportLink} onChange={(e) => setForm((f) => ({ ...f, reportLink: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder={t("LinkedIn profile URL (προαιρετικό - για LinkedIn outreach)")} value={form.linkedinProfileUrl} onChange={(e) => setForm((f) => ({ ...f, linkedinProfileUrl: e.target.value }))}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>
              {t("Σχόλια")} <span style={{ fontWeight: 400 }}>{t("- διαθέσιμο ως {{comments}} σε emails")}</span>
            </label>
            <RichTextEditor value={form.comments} onChange={(html) => setForm((f) => ({ ...f, comments: html }))} minHeight={70} />
          </div>
          <textarea placeholder={t("Internal σχόλια (προαιρετικό - ΔΕΝ χρησιμοποιείται σε emails, μόνο εσωτερική χρήση)")}
            value={form.internalNotes} onChange={(e) => setForm((f) => ({ ...f, internalNotes: e.target.value }))}
            rows={2} className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none" style={{ borderColor: C.line, color: C.ink }} />
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t("Προσθήκη")}
          </button>
        </form>
      </Card>
    </div>
  );
}

// LinkedIn outreach panel inside the contact drawer: shows the connection
// status and lets a user resolve the profile, send a connection request (with
// optional note), or withdraw a pending one. Only rendered when the contact has
// a linkedinProfileUrl. Talks to /linkedin/* directly and calls onChanged() to
// refresh the parent after any action.
const LINKEDIN_STATUS_LABELS = {
  "": "Δεν έχει σταλεί",
  not_sent: "Δεν έχει σταλεί",
  pending: "Εκκρεμεί (αίτημα στάλθηκε)",
  accepted: "Αποδεκτό ✓",
  connected: "Συνδεδεμένος ✓",
  declined: "Απορρίφθηκε",
  withdrawn: "Ανακλήθηκε",
};
function LinkedInContactPanel({ contact, onChanged }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [inmailOpen, setInmailOpen] = useState(false);
  const [inmailSubject, setInmailSubject] = useState("");
  const [inmailText, setInmailText] = useState("");
  const status = contact.linkedinConnectionStatus || "";
  const pending = status === "pending";
  const connected = status === "accepted" || status === "connected";

  async function sendInmail() {
    setBusy("inmail"); setMsg(""); setErr("");
    try {
      await api.post(`/linkedin/contacts/${contact.id}/inmail`, { subject: inmailSubject || undefined, text: inmailText });
      setMsg(t("Το InMail στάλθηκε ✓"));
      setInmailSubject(""); setInmailText(""); setInmailOpen(false);
      onChanged && onChanged();
    } catch (e) {
      const code = e instanceof ApiError && e.data && e.data.error;
      setErr(code === "daily_inmail_cap_reached" ? t("Συμπληρώθηκε το ημερήσιο όριο InMail.") : (e instanceof ApiError ? e.message : t("Η αποστολή απέτυχε.")));
    } finally {
      setBusy("");
    }
  }

  async function act(kind, fn) {
    setBusy(kind); setMsg(""); setErr("");
    try {
      const r = await fn();
      if (r && r.skipped) setMsg(r.reason === "already_connected" ? t("Είστε ήδη συνδεδεμένοι.") : t("Παραλείφθηκε."));
      else setMsg(t("Έγινε ✓"));
      onChanged && onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("Η ενέργεια απέτυχε."));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="rounded-lg border px-3 py-3" style={{ borderColor: C.line }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-semibold flex items-center gap-1.5" style={{ color: C.ink }}>
          <Linkedin size={14} /> LinkedIn outreach
        </span>
        <span className="text-xs" style={{ color: connected ? C.mint : pending ? C.amber : C.slate }}>
          {t(LINKEDIN_STATUS_LABELS[status] || status)}
        </span>
      </div>
      {!connected && !pending && (
        <>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
            placeholder={t("Προσωπικό σημείωμα (προαιρετικό, max 300 χαρ.)")}
            className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none mb-2" style={{ borderColor: C.line, color: C.ink }} />
          <div className="flex items-center gap-2">
            <button type="button" disabled={!!busy}
              onClick={() => act("connect", () => api.post(`/linkedin/contacts/${contact.id}/connect`, { note: note || undefined }))}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.6 : 1 }}>
              {busy === "connect" ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />} {t("Αίτημα σύνδεσης")}
            </button>
            <button type="button" disabled={!!busy}
              onClick={() => act("resolve", () => api.post(`/linkedin/contacts/${contact.id}/resolve`))}
              className="rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.slate }}>
              {t("Έλεγχος προφίλ")}
            </button>
          </div>
        </>
      )}
      {pending && (
        <button type="button" disabled={!!busy}
          onClick={() => act("withdraw", () => api.post(`/linkedin/contacts/${contact.id}/withdraw`))}
          className="rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.coral, opacity: busy ? 0.6 : 1 }}>
          {busy === "withdraw" ? t("Ανάκληση…") : t("Ανάκληση αιτήματος")}
        </button>
      )}

      {/* InMail - premium-only, works χωρίς σύνδεση */}
      <div className="mt-3 pt-3 border-t" style={{ borderColor: C.line }}>
        <button type="button" onClick={() => setInmailOpen((o) => !o)}
          className="flex items-center gap-1.5 text-xs font-medium" style={{ color: C.sky }}>
          <Send size={12} /> {inmailOpen ? t("Απόκρυψη InMail") : t("Αποστολή InMail (premium)")}
        </button>
        {inmailOpen && (
          <div className="mt-2 space-y-2">
            <input value={inmailSubject} onChange={(e) => setInmailSubject(e.target.value)} maxLength={200}
              placeholder={t("Θέμα InMail")}
              className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <textarea value={inmailText} onChange={(e) => setInmailText(e.target.value)} rows={3} maxLength={8000}
              placeholder={t("Μήνυμα InMail… (υποστηρίζει {{first_name}} κ.λπ.)")}
              className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none resize-none" style={{ borderColor: C.line, color: C.ink }} />
            <button type="button" disabled={!!busy || !inmailText.trim()} onClick={sendInmail}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: C.sky, opacity: (busy || !inmailText.trim()) ? 0.6 : 1 }}>
              {busy === "inmail" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} {t("Αποστολή InMail")}
            </button>
            <p className="text-[11px]" style={{ color: C.slate }}>{t("Χρειάζεται premium LinkedIn (Sales Navigator/Recruiter) και καταναλώνει InMail credit.")}</p>
          </div>
        )}
      </div>

      {msg && <div className="text-xs mt-2" style={{ color: C.mint }}>{msg}</div>}
      {err && <div className="text-xs mt-2" style={{ color: C.coral }}>{err}</div>}
    </div>
  );
}

function ContactDetailDrawer({ contactId, onClose, onLoad, onAddNote, onDeleteNote, onSetFollowUp, onCompose, onMarkReplied, onToggleUnsubscribed, onUpdateComments, onUpdateContact, onUpdateInternalNotes }) {
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
  // Private, internal-only notes - never sent in an email, separate from
  // `comments` (which IS used as {{comments}} merge content). Same
  // dedicated-save pattern as comments, just its own field/handler so saving
  // one never clobbers the other.
  const [internalNotes, setInternalNotes] = useState("");
  const [savingInternalNotes, setSavingInternalNotes] = useState(false);
  const [internalNotesSaved, setInternalNotesSaved] = useState(false);
  // Editing name/firstName/lastName/phone/company/category/tags/website/
  // reportLink updates only Contact's own columns (see PATCH /contacts/:id)
  // - it never touches emailLogs, notes, or offers, so the send
  // history/timeline below is never affected by this.
  const [editingContact, setEditingContact] = useState(false);
  const [contactForm, setContactForm] = useState({
    name: "", firstName: "", lastName: "", phone: "", company: "",
    category: "", tags: "", timezone: "", website: "", gmb: "", facebook: "", instagram: "",
    googleReviews: "", reportLink: "", linkedinProfileUrl: "",
  });
  const [savingContact, setSavingContact] = useState(false);

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
      setInternalNotes(data.internalNotes || "");
      setContactForm({
        name: data.name || "",
        firstName: data.firstName || "",
        lastName: data.lastName || "",
        phone: data.phone || "",
        company: data.company || "",
        category: data.category || "",
        tags: data.tags || "",
        timezone: data.timezone || "",
        website: data.website || "",
        gmb: data.gmb || "",
        facebook: data.facebook || "",
        instagram: data.instagram || "",
        googleReviews: data.googleReviews || "",
        reportLink: data.reportLink || "",
        linkedinProfileUrl: data.linkedinProfileUrl || "",
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα στοιχεία επαφής."));
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
      // best-effort - the note box just stays populated if it failed
    } finally {
      setSavingNote(false);
    }
  }

  async function handleFollowUpChange(value) {
    setFollowUp(value);
    try {
      await onSetFollowUp(contactId, value || null);
    } catch {
      // ignore - value stays as typed, next reload will reconcile
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

  async function handleSaveInternalNotes() {
    setSavingInternalNotes(true);
    setInternalNotesSaved(false);
    try {
      await onUpdateInternalNotes(contactId, internalNotes);
      setInternalNotesSaved(true);
      setTimeout(() => setInternalNotesSaved(false), 1800);
    } finally {
      setSavingInternalNotes(false);
    }
  }

  async function handleSaveContact() {
    setSavingContact(true);
    try {
      await onUpdateContact(contactId, contactForm);
      await load();
      setEditingContact(false);
    } finally {
      setSavingContact(false);
    }
  }

  function handleCancelEditContact() {
    setContactForm({
      name: detail.name || "",
      firstName: detail.firstName || "",
      lastName: detail.lastName || "",
      phone: detail.phone || "",
      company: detail.company || "",
      category: detail.category || "",
      tags: detail.tags || "",
      timezone: detail.timezone || "",
      website: detail.website || "",
      gmb: detail.gmb || "",
      facebook: detail.facebook || "",
      instagram: detail.instagram || "",
      googleReviews: detail.googleReviews || "",
      reportLink: detail.reportLink || "",
      linkedinProfileUrl: detail.linkedinProfileUrl || "",
    });
    setEditingContact(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <div className="w-full max-w-lg h-full bg-white overflow-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white" style={{ borderColor: C.line }}>
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Στοιχεία επαφής")}</h3>
          <div className="flex items-center gap-3">
            <button onClick={handleMarkReplied} disabled={markingReplied}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border"
              style={{ borderColor: C.line, color: C.mint, opacity: markingReplied ? 0.6 : 1 }}
              title={t("Δεν διαβάζουμε το inbox σου - σημείωσε το χειροκίνητα όταν κάποιος απαντήσει, για να σταματήσει το sequence και να μετρήσει σωστά το reply rate.")}>
              <Reply size={13} /> {t("Mark ως απάντησε")}
            </button>
            <button onClick={onCompose}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
              style={{ backgroundColor: C.sky }}>
              <Mail size={13} /> {t("Αποστολή email")}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
          </div>
        </div>

        {loading ? (
          <Spinner label={t("Φόρτωση…")} />
        ) : error ? (
          <div className="p-6"><ErrorNote message={error} onRetry={load} /></div>
        ) : detail ? (
          <div className="p-6 space-y-6">
            <div>
              {editingContact ? (
                <div className="space-y-2">
                  <input value={contactForm.name} onChange={(e) => setContactForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={t("Όνομα (εμφανίζεται ως {{name}} σε emails)")}
                    className="w-full rounded-lg px-3 py-1.5 text-sm font-semibold border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  <div className="text-sm" style={{ color: C.slate }}>{detail.email}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={contactForm.firstName} onChange={(e) => setContactForm((f) => ({ ...f, firstName: e.target.value }))}
                      placeholder={t("Όνομα (first name)")}
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                    <input value={contactForm.lastName} onChange={(e) => setContactForm((f) => ({ ...f, lastName: e.target.value }))}
                      placeholder={t("Επώνυμο (last name)")}
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={contactForm.phone} onChange={(e) => setContactForm((f) => ({ ...f, phone: e.target.value }))}
                      placeholder={t("Τηλέφωνο")}
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                    <input value={contactForm.company} onChange={(e) => setContactForm((f) => ({ ...f, company: e.target.value }))}
                      placeholder={t("Εταιρεία")}
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={contactForm.category} onChange={(e) => setContactForm((f) => ({ ...f, category: e.target.value }))}
                      placeholder={t("Κατηγορία")}
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                    <input value={contactForm.tags} onChange={(e) => setContactForm((f) => ({ ...f, tags: e.target.value }))}
                      placeholder={t("Ετικέτες (χωρισμένες με κόμμα)")}
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  </div>
                  <input value={contactForm.timezone} onChange={(e) => setContactForm((f) => ({ ...f, timezone: e.target.value }))}
                    placeholder={t("Ζώνη ώρας (π.χ. Europe/London - για send window στην ώρα του παραλήπτη)")}
                    className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={contactForm.website} onChange={(e) => setContactForm((f) => ({ ...f, website: e.target.value }))}
                      placeholder="Website"
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                    <input value={contactForm.gmb} onChange={(e) => setContactForm((f) => ({ ...f, gmb: e.target.value }))}
                      placeholder="GMB"
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={contactForm.facebook} onChange={(e) => setContactForm((f) => ({ ...f, facebook: e.target.value }))}
                      placeholder="Facebook"
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                    <input value={contactForm.instagram} onChange={(e) => setContactForm((f) => ({ ...f, instagram: e.target.value }))}
                      placeholder="Instagram"
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={contactForm.googleReviews} onChange={(e) => setContactForm((f) => ({ ...f, googleReviews: e.target.value }))}
                      placeholder="Google Reviews"
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                    <input value={contactForm.reportLink} onChange={(e) => setContactForm((f) => ({ ...f, reportLink: e.target.value }))}
                      placeholder="Report link"
                      className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  </div>
                  <input value={contactForm.linkedinProfileUrl} onChange={(e) => setContactForm((f) => ({ ...f, linkedinProfileUrl: e.target.value }))}
                    placeholder={t("LinkedIn profile URL (για LinkedIn outreach)")}
                    className="w-full rounded-lg px-3 py-1.5 text-xs border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  <div className="flex items-center gap-2 mt-1">
                    <button type="button" onClick={handleSaveContact} disabled={savingContact}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: C.sky, opacity: savingContact ? 0.6 : 1 }}>
                      {savingContact && <Loader2 size={12} className="animate-spin" />} {t("Αποθήκευση")}
                    </button>
                    <button type="button" onClick={handleCancelEditContact} disabled={savingContact}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.slate }}>
                      {t("Ακύρωση")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-lg font-semibold" style={{ color: C.ink }}>{detail.name}</div>
                    <div className="text-sm" style={{ color: C.slate }}>{detail.email}</div>
                    <div className="flex flex-wrap gap-3 mt-2 text-xs" style={{ color: C.slate }}>
                      {detail.phone && (
                        <a href={`tel:${detail.phone}`} className="flex items-center gap-1 hover:underline" style={{ color: C.slate }} title={t("Κλήση")}>
                          <Phone size={12} /> {detail.phone}
                        </a>
                      )}
                      {detail.company && <span className="flex items-center gap-1"><Building2 size={12} /> {detail.company}</span>}
                      {detail.website && (
                        <a href={normalizeLinkUrl(detail.website)} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 underline" style={{ color: C.sky }}>
                          <Globe size={12} /> {detail.website}
                        </a>
                      )}
                      {detail.gmb && (
                        <a href={normalizeLinkUrl(detail.gmb)} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 underline" style={{ color: C.sky }}>
                          <MapPin size={12} /> GMB
                        </a>
                      )}
                      {detail.facebook && (
                        <a href={normalizeLinkUrl(detail.facebook)} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 underline" style={{ color: C.sky }}>
                          <Facebook size={12} /> Facebook
                        </a>
                      )}
                      {detail.instagram && (
                        <a href={normalizeLinkUrl(detail.instagram)} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 underline" style={{ color: C.sky }}>
                          <Instagram size={12} /> Instagram
                        </a>
                      )}
                      {detail.googleReviews && (
                        <a href={normalizeLinkUrl(detail.googleReviews)} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 underline" style={{ color: C.sky }}>
                          <Star size={12} /> Reviews
                        </a>
                      )}
                      {detail.reportLink && (
                        // Routed through normalizeLinkUrl like website, not rendered raw -
                        // it only ever passes through http(s)/mailto or gets an https://
                        // prefix, so a javascript:/data: value (e.g. from an imported CSV)
                        // can't execute when clicked.
                        <a href={normalizeLinkUrl(detail.reportLink)} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 underline" style={{ color: C.sky }}>
                          <LinkIcon size={12} /> Report link
                        </a>
                      )}
                      {detail.linkedinProfileUrl && (
                        <a href={normalizeLinkUrl(detail.linkedinProfileUrl)} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 underline" style={{ color: C.sky }}>
                          <Linkedin size={12} /> LinkedIn
                        </a>
                      )}
                    </div>
                    <div className="flex gap-1.5 flex-wrap mt-2">
                      {(detail.tags || "").split(",").filter(Boolean).map((t) => <TagChip key={t}>{t.trim()}</TagChip>)}
                      {detail.category && <CategoryChip>{detail.category}</CategoryChip>}
                    </div>
                  </div>
                  <button type="button" onClick={() => setEditingContact(true)}
                    className="flex items-center gap-1 shrink-0 rounded-lg px-2 py-1 text-xs font-medium" style={{ color: C.sky }}
                    title={t("Επεξεργασία στοιχείων επαφής")}>
                    <Pencil size={12} /> {t("Επεξεργασία")}
                  </button>
                </div>
              )}
              <div className="mt-3">
                {detail.unsubscribed ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14` }}>
                    <span className="text-xs font-medium flex items-center gap-1.5" style={{ color: C.coral }}>
                      <CircleX size={13} /> Unsubscribed{detail.unsubscribedAt ? ` · ${fmtDate(detail.unsubscribedAt)}` : ""}
                    </span>
                    <button onClick={handleToggleUnsubscribed} disabled={togglingUnsub}
                      className="text-xs font-medium underline shrink-0" style={{ color: C.coral, opacity: togglingUnsub ? 0.6 : 1 }}>
                      {t("Ακύρωση")}
                    </button>
                  </div>
                ) : (
                  <button onClick={handleToggleUnsubscribed} disabled={togglingUnsub}
                    className="text-xs font-medium underline" style={{ color: C.slate, opacity: togglingUnsub ? 0.6 : 1 }}>
                    {t("Επισήμανση ως unsubscribed")}
                  </button>
                )}
              </div>
            </div>

            {detail.linkedinProfileUrl && (
              <LinkedInContactPanel contact={detail} onChanged={load} />
            )}

            <div>
              <label className="text-xs font-medium mb-1.5 flex items-center gap-1.5" style={{ color: C.slate }}>
                <StickyNote size={13} /> {t("Σχόλια")} <span style={{ color: C.slate, fontWeight: 400 }}>{t("- διαθέσιμο ως {{comments}} σε emails")}</span>
              </label>
              <RichTextEditor
                value={comments}
                onChange={(html) => { setComments(html); setCommentsSaved(false); }}
                minHeight={70}
              />
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  type="button"
                  onClick={handleSaveComments}
                  disabled={savingComments || comments === (detail.comments || "")}
                  className="text-xs font-medium rounded-lg px-2.5 py-1 text-white"
                  style={{ backgroundColor: C.sky, opacity: savingComments || comments === (detail.comments || "") ? 0.5 : 1 }}
                >
                  {savingComments ? t("Αποθήκευση…") : t("Αποθήκευση σχολίων")}
                </button>
                {commentsSaved && <span className="text-xs" style={{ color: C.mint }}>{t("Αποθηκεύτηκε ✓")}</span>}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium mb-1.5 flex items-center gap-1.5" style={{ color: C.slate }}>
                <StickyNote size={13} /> {t("Internal σχόλια")} <span style={{ color: C.slate, fontWeight: 400 }}>{t("- εσωτερική χρήση μόνο, ΔΕΝ στέλνεται ποτέ σε email")}</span>
              </label>
              <textarea
                value={internalNotes}
                onChange={(e) => { setInternalNotes(e.target.value); setInternalNotesSaved(false); }}
                placeholder={t("π.χ. εσωτερική σημείωση για το πώς προσεγγίσαμε αυτή την επαφή...")}
                rows={2}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none"
                style={{ borderColor: C.line, color: C.ink }}
              />
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  type="button"
                  onClick={handleSaveInternalNotes}
                  disabled={savingInternalNotes || internalNotes === (detail.internalNotes || "")}
                  className="text-xs font-medium rounded-lg px-2.5 py-1 text-white"
                  style={{ backgroundColor: C.sky, opacity: savingInternalNotes || internalNotes === (detail.internalNotes || "") ? 0.5 : 1 }}
                >
                  {savingInternalNotes ? t("Αποθήκευση…") : t("Αποθήκευση internal σχολίων")}
                </button>
                {internalNotesSaved && <span className="text-xs" style={{ color: C.mint }}>{t("Αποθηκεύτηκε ✓")}</span>}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium mb-1.5 flex items-center gap-1.5" style={{ color: C.slate }}>
                <CalendarClock size={13} /> {t("Επόμενη υπενθύμιση")}
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
                <Euro size={14} /> {t("Προσφορές")} ({detail.offers?.length || 0})
              </div>
              {(!detail.offers || detail.offers.length === 0) ? (
                <p className="text-xs" style={{ color: C.slate }}>{t("Καμία προσφορά ακόμα.")}</p>
              ) : (
                <div className="space-y-2">
                  {detail.offers.map((o) => (
                    <div key={o.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                      <span className="text-xs font-medium" style={{ color: C.ink }}>{o.title}</span>
                      <span className="text-xs" style={{ color: C.slate }}>{fmtMoney(o.value, o.currency)} · {t(OFFER_STATUSES.find((s) => s.key === o.status)?.label || "")}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              {(() => {
                // Unified conversation: email + LinkedIn touches in one thread.
                // Falls back to the email-only timeline for older cached detail.
                const convo = detail.conversation || (detail.timeline || []).map((e) => ({ kind: "email", ...e, at: e.sentAt }));
                return (
                  <>
                    <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: C.ink }}>
                      <Mail size={14} /> {t("Συνομιλία")} ({convo.length})
                    </div>
                    {convo.length === 0 ? (
                      <p className="text-xs" style={{ color: C.slate }}>{t("Καμία επικοινωνία ακόμα.")}</p>
                    ) : (
                      <div className="space-y-2">
                        {convo.map((ev) => {
                          if (ev.kind !== "email") {
                            const meta = {
                              linkedin_connection: { Icon: Linkedin, label: t("Αίτημα σύνδεσης LinkedIn"), color: C.sky },
                              linkedin_message: { Icon: Linkedin, label: t("Μήνυμα LinkedIn"), color: C.sky },
                              linkedin_inmail: { Icon: Send, label: "InMail", color: C.navy },
                            }[ev.kind] || { Icon: Linkedin, label: "LinkedIn", color: C.sky };
                            return (
                              <div key={ev.id} className="rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <meta.Icon size={13} style={{ color: meta.color }} className="shrink-0" />
                                    <span className="text-xs font-medium truncate" style={{ color: C.ink }}>{meta.label}</span>
                                  </div>
                                  <span className="text-[11px] shrink-0" style={{ color: C.slate }}>{fmtDate(ev.at)}</span>
                                </div>
                                {ev.text && <div className="text-[11px] mt-1 line-clamp-3" style={{ color: C.slate }}>{ev.text}</div>}
                                {ev.status && ev.status !== "sent" && <div className="text-[10px] mt-1" style={{ color: C.slate }}>{ev.status}</div>}
                              </div>
                            );
                          }
                          const open = expandedLogId === ev.id;
                          return (
                            <div key={ev.id} className="rounded-lg overflow-hidden" style={{ backgroundColor: C.pale }}>
                              <button
                                type="button"
                                onClick={() => setExpandedLogId(open ? null : ev.id)}
                                className="w-full flex items-center justify-between px-3 py-2 text-left"
                              >
                                <div className="min-w-0 flex items-center gap-1.5">
                                  <ChevronRight size={12} style={{ color: C.slate, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} className="shrink-0" />
                                  <Mail size={13} style={{ color: C.slate }} className="shrink-0" />
                                  <div className="min-w-0">
                                    <div className="text-xs font-medium truncate" style={{ color: C.ink }}>{ev.subject}</div>
                                    <div className="text-[11px]" style={{ color: C.slate }}>{ev.sequenceName || t("Χειροκίνητο")} · {fmtDate(ev.at || ev.sentAt)}</div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {ev.opened && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.sky}1A`, color: C.sky }}>{t("Άνοιξε")}</span>}
                                  {ev.clicked && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.amber}1A`, color: C.amber }}>{t("Κλικ")}</span>}
                                </div>
                              </button>
                              {open && (
                                <div className="px-3 pb-2.5 pl-7">
                                  <EventTrace sentAt={ev.at || ev.sentAt} events={ev.events} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: C.ink }}>
                <StickyNote size={14} /> {t("Σημειώσεις")} ({detail.notes?.length || 0})
              </div>
              <form onSubmit={handleAddNote} className="flex gap-2 mb-3">
                <input
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder={t("Νέα σημείωση…")}
                  className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none"
                  style={{ borderColor: C.line, color: C.ink }}
                />
                <button type="submit" disabled={savingNote || !noteText.trim()} className="rounded-lg px-3 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky, opacity: savingNote ? 0.7 : 1 }}>
                  {savingNote ? <Loader2 size={14} className="animate-spin" /> : t("Προσθήκη")}
                </button>
              </form>
              {(!detail.notes || detail.notes.length === 0) ? (
                <p className="text-xs" style={{ color: C.slate }}>{t("Καμία σημείωση ακόμα.")}</p>
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

function ContactsView({ sequences, onUpload, onCreate, onEnroll, onLoadDetail, onAddNote, onDeleteNote, onSetFollowUp, onBulkUpdate, onBulkDelete, onExport, onCompose, onMarkReplied, onToggleUnsubscribed, onUpdateComments, onUpdateContact, onUpdateInternalNotes, openContactId, onOpenContactHandled }) {
  const PAGE_SIZE = 50;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [onlyDue, setOnlyDue] = useState(false);
  const [hideUnsubscribed, setHideUnsubscribed] = useState(false);
  const [hasWebsiteOnly, setHasWebsiteOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkTag, setBulkTag] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Saved segments: named snapshots of the current filter set, persisted per
  // browser in localStorage (no backend needed — they're personal views).
  const SEG_KEY = "sdloop_segments";
  const [segments, setSegments] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SEG_KEY) || "[]"); } catch { return []; }
  });
  function persistSegments(next) {
    setSegments(next);
    try { localStorage.setItem(SEG_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
  function currentFilters() {
    return { query, statusFilter, categoryFilter, tagFilter, onlyDue, hideUnsubscribed, hasWebsiteOnly };
  }
  function applySegment(f) {
    setQuery(f.query || "");
    setStatusFilter(f.statusFilter || "all");
    setCategoryFilter(f.categoryFilter || "all");
    setTagFilter(f.tagFilter || "all");
    setOnlyDue(!!f.onlyDue);
    setHideUnsubscribed(!!f.hideUnsubscribed);
    setHasWebsiteOnly(!!f.hasWebsiteOnly);
    setPage(1);
  }
  function saveSegment() {
    const name = (window.prompt(t("Όνομα segment:")) || "").trim();
    if (!name) return;
    const next = [...segments.filter((s) => s.name !== name), { name, filters: currentFilters() }];
    persistSegments(next);
    toast.success(t("Το segment αποθηκεύτηκε."));
  }
  function deleteSegment(name) {
    persistSegments(segments.filter((s) => s.name !== name));
  }
  const [detailContactId, setDetailContactId] = useState(null);
  const fileRef = useRef(null);

  // The list is now fetched server-side - search/filters/pagination all
  // happen in the GET /contacts query (see routes/contacts.js) instead of
  // loading the company's entire contact list into the browser and
  // filtering it on every keystroke, which didn't scale as the list grew.
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [dueCount, setDueCount] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [rowsError, setRowsError] = useState("");
  const [categories, setCategories] = useState([]);
  const [allTags, setAllTags] = useState([]);

  // Lets the global search box (in the sidebar) jump straight into a
  // contact's detail drawer from any view, without lifting detailContactId
  // itself up to App - App just hands us the id once and we take it from there.
  useEffect(() => {
    if (openContactId) {
      setDetailContactId(openContactId);
      onOpenContactHandled();
    }
  }, [openContactId, onOpenContactHandled]);

  // Debounced the same way GlobalSearch is - typing doesn't hit the network
  // on every keystroke, only 350ms after the user stops.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  // Any filter change (besides paging itself) jumps back to page 1 -
  // otherwise staying on, say, page 4 of a now much smaller filtered result
  // would just show an empty page.
  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, statusFilter, categoryFilter, tagFilter, onlyDue, hideUnsubscribed, hasWebsiteOnly]);

  const fetchPage = useCallback(async () => {
    setRowsLoading(true);
    setRowsError("");
    try {
      const params = new URLSearchParams();
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (tagFilter !== "all") params.set("tag", tagFilter);
      if (onlyDue) params.set("dueOnly", "true");
      if (hideUnsubscribed) params.set("unsubscribed", "false");
      if (hasWebsiteOnly) params.set("hasWebsite", "true");
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      const data = await api.get(`/contacts?${params.toString()}`);
      setRows(data.contacts);
      setTotal(data.total);
      setDueCount(data.dueCount);
    } catch (err) {
      setRowsError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η φόρτωση επαφών."));
    } finally {
      setRowsLoading(false);
    }
  }, [debouncedQuery, statusFilter, categoryFilter, tagFilter, onlyDue, hideUnsubscribed, hasWebsiteOnly, page]);

  useEffect(() => { fetchPage(); }, [fetchPage]);

  // Distinct category/tag values for the filter dropdowns, sourced from
  // their own lightweight endpoint rather than derived from whatever page of
  // contacts happens to be loaded (which, now that the list is paginated,
  // would only ever surface categories/tags present on the CURRENT page).
  const fetchFacets = useCallback(async () => {
    try {
      const data = await api.get("/contacts/facets");
      setCategories(data.categories);
      setAllTags(data.tags);
    } catch {
      // Non-critical - the filter dropdowns just keep whatever they had.
    }
  }, []);

  useEffect(() => { fetchFacets(); }, [fetchFacets]);

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate(data) {
    await onCreate(data);
    await Promise.all([fetchPage(), fetchFacets()]);
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUploadNote("");
    try {
      const result = await onUpload(file);
      setUploadNote(t("Προστέθηκαν {created}, αγνοήθηκαν {skipped}.", { created: result.created, skipped: result.skipped }));
      await Promise.all([fetchPage(), fetchFacets()]);
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : t("Το ανέβασμα απέτυχε."));
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
      await fetchPage();
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : t("Η εγγραφή απέτυχε."));
    }
  }

  async function handleBulkCategory() {
    if (!bulkCategory || selected.size === 0) return;
    setBulkBusy(true);
    try {
      await onBulkUpdate(Array.from(selected), { category: bulkCategory });
      setBulkCategory("");
      await Promise.all([fetchPage(), fetchFacets()]);
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : t("Η μαζική ενέργεια απέτυχε."));
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
      await Promise.all([fetchPage(), fetchFacets()]);
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : t("Η μαζική ενέργεια απέτυχε."));
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
      await fetchPage();
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : t("Η διαγραφή απέτυχε."));
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      await onExport();
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : t("Η εξαγωγή απέτυχε."));
    } finally {
      setExporting(false);
    }
  }

  // Wrapped so the currently-loaded page of rows (name badge, follow-up
  // date, unsubscribed status, category/tags shown in the table) stays in
  // sync after an edit made from inside the detail drawer - the drawer only
  // ever reloads its own detail view, it has no way to know this list exists.
  async function handleDrawerSetFollowUp(contactId, date) {
    await onSetFollowUp(contactId, date);
    await fetchPage();
  }
  async function handleDrawerMarkReplied(contactId) {
    await onMarkReplied(contactId);
    await fetchPage();
  }
  async function handleDrawerToggleUnsubscribed(contactId, next) {
    await onToggleUnsubscribed(contactId, next);
    await fetchPage();
  }
  async function handleDrawerUpdateContact(contactId, data) {
    await onUpdateContact(contactId, data);
    await Promise.all([fetchPage(), fetchFacets()]);
  }

  const hasActiveFilters =
    statusFilter !== "all" || categoryFilter !== "all" || tagFilter !== "all" ||
    onlyDue || hideUnsubscribed || hasWebsiteOnly || query;

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col h-full">
      {showNew && <NewContactModal onClose={() => setShowNew(false)} onCreate={handleCreate} />}
      {detailContactId && (
        <ContactDetailDrawer
          contactId={detailContactId}
          onClose={() => setDetailContactId(null)}
          onLoad={onLoadDetail}
          onAddNote={onAddNote}
          onDeleteNote={onDeleteNote}
          onSetFollowUp={handleDrawerSetFollowUp}
          onCompose={() => { onCompose(detailContactId); setDetailContactId(null); }}
          onMarkReplied={handleDrawerMarkReplied}
          onToggleUnsubscribed={handleDrawerToggleUnsubscribed}
          onUpdateComments={onUpdateComments}
          onUpdateContact={handleDrawerUpdateContact}
          onUpdateInternalNotes={onUpdateInternalNotes}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-6 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{t("Επαφές")}</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>
            {hasActiveFilters ? t("{n} επαφές (φιλτραρισμένο)", { n: total }) : t("{n} επαφές συνολικά", { n: total })}
            {dueCount > 0 ? t(" · {n} με εκκρεμή υπενθύμιση", { n: dueCount }) : ""}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border"
            style={{ borderColor: C.line, color: C.ink, opacity: exporting ? 0.6 : 1 }}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {t("Εξαγωγή CSV")}
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            title={t("Στήλες CSV: name, firstName, lastName, email, phone, company, category, tags, website, reportLink, comments, internalNotes")}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border"
            style={{ borderColor: C.line, color: C.ink, opacity: uploading ? 0.6 : 1 }}
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} {t("Ανέβασμα CSV")}
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}
          >
            <Plus size={15} /> {t("Νέα επαφή")}
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
            placeholder={t("Αναζήτηση σε όνομα, email, τηλέφωνο, εταιρεία, website, tags, σχόλια…")}
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
          <option value="all">{t("Όλες οι καταστάσεις")}</option>
          {Object.entries(statusMeta).map(([k, v]) => (
            <option key={k} value={k}>{t(v.label)}</option>
          ))}
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm border outline-none"
          style={{ borderColor: C.line, color: C.ink }}
        >
          <option value="all">{t("Όλες οι κατηγορίες")}</option>
          {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
        </select>

        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm border outline-none"
          style={{ borderColor: C.line, color: C.ink }}
        >
          <option value="all">{t("Όλες οι ετικέτες")}</option>
          {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>

        <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: C.slate }}>
          <input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} />
          {t("Μόνο εκκρεμείς υπενθυμίσεις")}
        </label>

        <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: C.slate }}>
          <input type="checkbox" checked={hideUnsubscribed} onChange={(e) => setHideUnsubscribed(e.target.checked)} />
          {t("Απόκρυψη unsubscribed")}
        </label>

        <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: C.slate }}>
          <input type="checkbox" checked={hasWebsiteOnly} onChange={(e) => setHasWebsiteOnly(e.target.checked)} />
          {t("Μόνο με website")}
        </label>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => { setQuery(""); setStatusFilter("all"); setCategoryFilter("all"); setTagFilter("all"); setOnlyDue(false); setHideUnsubscribed(false); setHasWebsiteOnly(false); }}
            className="text-xs font-medium underline" style={{ color: C.slate }}
          >
            {t("Καθαρισμός φίλτρων")}
          </button>
        )}

        {/* Saved segments: apply a named filter set, or save the current one. */}
        <div className="flex items-center gap-1.5">
          {segments.length > 0 && (
            <select
              value=""
              onChange={(e) => { const s = segments.find((x) => x.name === e.target.value); if (s) applySegment(s.filters); }}
              className="rounded-lg px-2 py-1.5 text-xs border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}
            >
              <option value="">{t("Segments…")}</option>
              {segments.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          )}
          {segments.length > 0 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) deleteSegment(e.target.value); }}
              className="rounded-lg px-1.5 py-1.5 text-xs border outline-none bg-white" style={{ borderColor: C.line, color: C.slate }}
              title={t("Διαγραφή segment")}
            >
              <option value="">🗑</option>
              {segments.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          )}
          {hasActiveFilters && (
            <button type="button" onClick={saveSegment} className="text-xs font-medium" style={{ color: C.sky }}>
              {t("Αποθήκευση segment")}
            </button>
          )}
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap ml-auto">
            <span className="text-xs font-medium" style={{ color: C.slate }}>{t("{n} επιλεγμένες", { n: selected.size })}</span>
            <select
              value={enrollSeqId}
              onChange={(e) => setEnrollSeqId(e.target.value)}
              className="rounded-lg px-2 py-1.5 text-sm border outline-none"
              style={{ borderColor: C.line, color: C.ink }}
            >
              <option value="">{t("Εγγραφή σε sequence…")}</option>
              {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button
              onClick={handleEnroll}
              disabled={!enrollSeqId}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
              style={{ backgroundColor: C.sky, opacity: enrollSeqId ? 1 : 0.5 }}
            >
              {t("Εγγραφή")}
            </button>
            <input
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              placeholder={t("Νέα κατηγορία…")}
              className="w-32 rounded-lg px-2 py-1.5 text-xs border outline-none"
              style={{ borderColor: C.line, color: C.ink }}
            />
            <button onClick={handleBulkCategory} disabled={bulkBusy || !bulkCategory} className="rounded-lg px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
              {t("Ορισμός κατηγορίας")}
            </button>
            <input
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              placeholder={t("Νέα ετικέτα…")}
              className="w-28 rounded-lg px-2 py-1.5 text-xs border outline-none"
              style={{ borderColor: C.line, color: C.ink }}
            />
            <button onClick={handleBulkTag} disabled={bulkBusy || !bulkTag.trim()} className="rounded-lg px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
              {t("Προσθήκη ετικέτας")}
            </button>
            <button onClick={handleBulkDelete} disabled={bulkBusy} className="rounded-lg px-2.5 py-1.5 text-xs font-medium" style={{ color: C.coral }}>
              {t("Διαγραφή")}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <ErrorNote message={rowsError} onRetry={fetchPage} />
        {rowsLoading ? (
          <Card className="p-0 overflow-hidden"><SkeletonRows rows={8} cols={6} /></Card>
        ) : (
          <>
            {/* Desktop table view */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-3 w-8"></th>
                    <th className="font-medium pb-3">{t("Όνομα")}</th>
                    <th className="font-medium pb-3">{t("Τηλέφωνο")}</th>
                    <th className="font-medium pb-3">{t("Εταιρεία")}</th>
                    <th className="font-medium pb-3">{t("Κατηγορία")}</th>
                    <th className="font-medium pb-3">Website</th>
                    <th className="font-medium pb-3">Sequence</th>
                    <th className="font-medium pb-3">{t("Ετικέτες")}</th>
                    <th className="font-medium pb-3">{t("Υπενθύμιση")}</th>
                    <th className="font-medium pb-3">{t("Τελ. ενέργεια")}</th>
                    <th className="font-medium pb-3 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c, i) => (
                    <tr key={c.id} className="border-t transition-colors hover:bg-slate-50" style={{ borderColor: C.line, backgroundColor: i % 2 ? C.zebra : "transparent" }}>
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
                        {c.phone ? (
                          <a href={`tel:${c.phone}`} onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1.5 hover:underline" style={{ color: C.ink }} title={t("Κλήση")}>
                            <Phone size={13} style={{ color: C.slate }} />
                            {c.phone}
                          </a>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Phone size={13} style={{ color: C.slate }} />
                            -
                          </div>
                        )}
                      </td>
                      <td className="py-3" style={{ color: C.ink }}>
                        <div className="flex items-center gap-1.5">
                          <Building2 size={13} style={{ color: C.slate }} />
                          {c.company || "-"}
                        </div>
                      </td>
                      <td className="py-3"><CategoryChip>{c.category}</CategoryChip></td>
                      <td className="py-3">
                        {c.website ? (
                          <a href={normalizeLinkUrl(c.website)} target="_blank" rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1.5 hover:underline max-w-[160px] truncate" style={{ color: C.sky }} title={c.website}>
                            <Globe size={13} className="shrink-0" style={{ color: C.slate }} />
                            <span className="truncate">{c.website}</span>
                          </a>
                        ) : (
                          <span style={{ color: C.slate }}>-</span>
                        )}
                      </td>
                      <td className="py-3" style={{ color: C.ink }}>
                        {c.currentSequence ? t("{seq} · βήμα {n}", { seq: c.currentSequence, n: c.currentStep }) : "-"}
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
                        ) : "-"}
                      </td>
                      <td className="py-3 text-xs" style={{ color: C.slate }}>{fmtDate(c.lastActivityAt)}</td>
                      <td className="py-3">
                        <button onClick={() => setDetailContactId(c.id)} style={{ color: C.slate }} title={t("Στοιχεία επαφής")}>
                          <Eye size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={11} className="py-10 text-center text-sm" style={{ color: C.slate }}>{t("Καμία επαφή δεν ταιριάζει.")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile card view */}
            <div className="md:hidden space-y-3">
              {rows.length === 0 ? (
                <div className="text-center py-10 text-sm" style={{ color: C.slate }}>{t("Καμία επαφή δεν ταιριάζει.")}</div>
              ) : (
                rows.map((c) => (
                  <div key={c.id} className="rounded-lg border p-4" style={{ borderColor: C.line }}>
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelected(c.id)} />
                          <span className="font-medium truncate" style={{ color: C.ink }}>{c.name}</span>
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
                        <div className="text-xs truncate" style={{ color: C.slate }}>{c.email}</div>
                      </div>
                      <button onClick={() => setDetailContactId(c.id)} style={{ color: C.slate }} title={t("Στοιχεία επαφής")}>
                        <Eye size={15} className="shrink-0" />
                      </button>
                    </div>

                    <div className="space-y-2 text-xs">
                      {c.phone && (
                        <div className="flex items-center gap-2">
                          <Phone size={13} style={{ color: C.slate }} className="shrink-0" />
                          <a href={`tel:${c.phone}`} onClick={(e) => e.stopPropagation()} style={{ color: C.ink }} className="hover:underline">
                            {c.phone}
                          </a>
                        </div>
                      )}
                      {c.company && (
                        <div className="flex items-center gap-2">
                          <Building2 size={13} style={{ color: C.slate }} className="shrink-0" />
                          <span style={{ color: C.ink }}>{c.company}</span>
                        </div>
                      )}
                      {c.category && (
                        <div className="flex items-center gap-2">
                          <CategoryChip>{c.category}</CategoryChip>
                        </div>
                      )}
                      {(c.tags || "").split(",").filter(Boolean).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {(c.tags || "").split(",").filter(Boolean).map((t) => <TagChip key={t}>{t.trim()}</TagChip>)}
                        </div>
                      )}
                      {c.nextFollowUpAt && (
                        <div className="flex items-center gap-2">
                          <CalendarClock size={13} style={{ color: C.slate }} className="shrink-0" />
                          <span style={{ color: isFollowUpDue(c.nextFollowUpAt) ? C.coral : C.slate }}>
                            {t("Υπενθύμιση: {d}", { d: fmtDate(c.nextFollowUpAt) })}
                          </span>
                        </div>
                      )}
                      <div className="text-xs" style={{ color: C.slate }}>{t("Τελ. ενέργεια: {d}", { d: fmtDate(c.lastActivityAt) })}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {!rowsLoading && pageCount > 1 && (
          <div className="flex items-center justify-center gap-3 pt-5 pb-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg px-3 py-1.5 text-xs font-medium border"
              style={{ borderColor: C.line, color: C.ink, opacity: page <= 1 ? 0.5 : 1 }}
            >
              {t("Προηγούμενη")}
            </button>
            <span className="text-xs font-medium" style={{ color: C.slate }}>{t("Σελίδα {page} από {total}", { page, total: pageCount })}</span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
              className="rounded-lg px-3 py-1.5 text-xs font-medium border"
              style={{ borderColor: C.line, color: C.ink, opacity: page >= pageCount ? 0.5 : 1 }}
            >
              {t("Επόμενη")}
            </button>
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
  const [body, setBody] = useState(() => initial?.body || unsubscribeSeed());
  const [attachments, setAttachments] = useState(initial?.attachments || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function insertToken(token) {
    setBody((b) => (b || "") + token);
  }

  // Body is HTML now (rich text editor) - strip tags for word/char counts
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
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η αποθήκευση."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-3xl p-5 max-h-[88vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{initial ? t("Επεξεργασία template") : t("Νέο template")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <input required placeholder={t("Όνομα template")} value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

            <div>
              <input required placeholder={t("Θέμα")} value={subject} onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[11px]" style={{ color: subject.length > 60 ? C.amber : C.slate }}>
                  {t("{n} χαρακτήρες", { n: subject.length })} {subject.length > 60 ? t("(συνιστάται κάτω από 60 για καλύτερο open rate)") : ""}
                </span>
              </div>
              {subjectSpam.length > 0 && (
                <p className="text-[11px] mt-1" style={{ color: C.amber }}>{t("⚠ Πιθανές λέξεις spam-trigger: {words}", { words: subjectSpam.join(", ") })}</p>
              )}
            </div>

            <div className="flex gap-1.5 flex-wrap">
              <span className="text-[11px] self-center" style={{ color: C.slate }}>{t("Εισαγωγή token:")}</span>
              {["{{name}}", "{{first_name}}", "{{last_name}}", "{{company}}", "{{email}}", "{{website}}", "{{gmb}}", "{{facebook}}", "{{instagram}}", "{{google_reviews}}", "{{report_link}}", "{{booking_link}}", "{{comments}}"].map((tok) => (
                <button key={tok} type="button" onClick={() => insertToken(tok)}
                  className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ backgroundColor: C.pale, color: C.navy }}>
                  {tok}
                </button>
              ))}
            </div>
            <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={180} />
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: C.slate }}>{t("{chars} χαρακτήρες · {words} λέξεις", { chars: plainBody.trim().length, words: plainBody.split(/\s+/).filter(Boolean).length })}</span>
            </div>
            {bodySpam.length > 0 && (
              <p className="text-[11px]" style={{ color: C.amber }}>{t("⚠ Πιθανές λέξεις spam-trigger: {words}", { words: bodySpam.join(", ") })}</p>
            )}
            {!hasUnsubscribeLink(body) && body.length > 0 && (
              <TipBanner>{t("Best practice: το email δεν έχει σύνδεσμο απεγγραφής - βοηθά τη deliverability και είναι απαραίτητο για μαζικά cold emails. Πρόσθεσε ένα link με href {{unsubscribe_link}}.")}</TipBanner>
            )}

            {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
            <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
              {busy && <Loader2 size={14} className="animate-spin" />} {t("Αποθήκευση")}
            </button>
          </div>

          <div>
            <p className="text-xs font-medium mb-2" style={{ color: C.slate }}>{t("Προεπισκόπηση (με δείγμα δεδομένων)")}</p>
            <Card className="p-4" style={{ backgroundColor: C.pale }}>
              <div className="text-xs mb-2" style={{ color: C.slate }}>{t("Προς:")} {MERGE_SAMPLE.name} &lt;{MERGE_SAMPLE.email}&gt;</div>
              <div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>{renderPreview(subject) || "-"}</div>
              <div className="text-sm" style={{ color: C.ink }} dangerouslySetInnerHTML={{ __html: renderPreview(body) || "-" }} />
              <AutoTrackingPixelNote />
              {attachments.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mt-3 pt-3 border-t" style={{ borderColor: C.line }}>
                  {attachments.map((a, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]" style={{ backgroundColor: C.pale, color: C.navy }}>
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Templates</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>{t("{n} αποθηκευμένα templates", { n: templates.length })}</p>
        </div>
        <button onClick={() => setEditing("new")} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
          <Plus size={15} /> {t("Νέο template")}
        </button>
      </div>
      <div className="px-8 py-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label={t("Φόρτωση templates…")} />
        ) : templates.length === 0 ? (
          <EmptyState icon={FileText} title={t("Δεν υπάρχουν templates ακόμα.")}
            hint={t("Φτιάξε επαναχρησιμοποιήσιμα emails με merge fields και βάλ' τα σε sequences και campaigns.")}
            actionLabel={t("Νέο template")} onAction={() => setEditing("new")} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {templates.map((tpl) => (
              <Card key={tpl.id} className="p-4">
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: C.ink }}>{tpl.name}</div>
                    <div className="text-xs truncate mt-0.5" style={{ color: C.slate }}>{tpl.subject}</div>
                  </div>
                  <span className="text-[11px] font-medium rounded-full px-2 py-0.5 shrink-0" style={{ backgroundColor: C.pale, color: C.navy }}>
                    {t("{n}× σε χρήση", { n: tpl.usageCount || 0 })}
                  </span>
                </div>
                <p className="text-xs mb-3" style={{ color: C.slate }}>
                  {(() => {
                    const plain = tpl.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
                    return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain;
                  })()}
                </p>
                <div className="flex items-center gap-2">
                  <button onClick={() => setEditing(tpl)} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
                    <Pencil size={12} /> {t("Επεξεργασία")}
                  </button>
                  <button onClick={() => handleDuplicate(tpl)} disabled={busyId === tpl.id} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.ink }}>
                    <Copy size={12} /> {t("Αντιγραφή")}
                  </button>
                  <button onClick={() => handleDelete(tpl)} disabled={busyId === tpl.id} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium ml-auto" style={{ color: C.coral }}>
                    <Trash2 size={12} /> {t("Διαγραφή")}
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
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η δημιουργία προσφοράς."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Νέα προσφορά")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <select required value={contactId} onChange={(e) => setContactId(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }}>
            <option value="">{t("Επιλέξε επαφή…")}</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
          </select>
          <input required placeholder={t("Τίτλος προσφοράς")} value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div className="flex gap-2">
            <input type="number" min={0} step="0.01" placeholder={t("Αξία")} value={value} onChange={(e) => setValue(e.target.value)}
              className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}
              className="w-24 rounded-lg px-2 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <textarea placeholder={t("Σημειώσεις (προαιρετικό)")} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none" style={{ borderColor: C.line, color: C.ink }} />
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t("Δημιουργία")}
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
          {status === "accepted" ? t("Γιατί έγινε δεκτή;") : t("Γιατί απορρίφθηκε;")}
        </h3>
        <p className="text-xs mb-3" style={{ color: C.slate }}>
          {t("Προαιρετικό - τροφοδοτεί το CRM reporting (λόγοι έγκρισης/απόρριψης).")}
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("π.χ. τιμή, timing, ανταγωνισμός…")}
          rows={3}
          className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none mb-3"
          style={{ borderColor: C.line, color: C.ink }}
        />
        <div className="flex items-center justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => handleConfirm(true)}
            className="rounded-lg px-3 py-2 text-sm font-medium border" style={{ borderColor: C.line, color: C.slate }}>
            {t("Παράλειψη")}
          </button>
          <button type="button" disabled={busy} onClick={() => handleConfirm(false)}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t("Αποθήκευση")}
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
          <div className="text-xs truncate mt-0.5" style={{ color: C.slate }}>{offer.contact?.name || "-"}</div>
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
        {OFFER_STATUSES.map((s) => <option key={s.key} value={s.key}>{t(s.label)}</option>)}
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Offers</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>
            {t("{n} προσφορές · σύνολο ενεργών {total}", { n: offers.length, total: fmtMoney(totalValue) })}
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
          <Plus size={15} /> {t("Νέα προσφορά")}
        </button>
      </div>
      <div className="px-8 py-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label={t("Φόρτωση προσφορών…")} />
        ) : offers.length === 0 ? (
          <EmptyState icon={Handshake} title={t("Δεν υπάρχουν προσφορές ακόμα.")}
            hint={t("Κατέγραψε προσφορές ανά επαφή για να παρακολουθείς pipeline και win rate.")}
            actionLabel={t("Νέα προσφορά")} onAction={() => setShowNew(true)} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {OFFER_STATUSES.map((col) => (
              <div key={col.key}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: col.color }} />
                  <span className="text-xs font-semibold" style={{ color: C.ink }}>{t(col.label)}</span>
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
function TestSendModal({ defaultEmail, onClose, onSend, subjects = [] }) {
  const [email, setEmail] = useState(defaultEmail || "");
  const [subject, setSubject] = useState(subjects[0] || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(""); // "" | "sent" | error message

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setResult("");
    try {
      await onSend(email, subject);
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
          <h3 className="text-sm font-semibold" style={{ color: C.ink }}>{t("Δοκιμαστική αποστολή")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          {subjects.length > 1 && (
            <select value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
              {subjects.map((s, i) => (
                <option key={i} value={s}>{i === 0 ? t("A (κύριο)") : t("Παραλλαγή {v}", { v: String.fromCharCode(65 + i) })} - {s}</option>
              ))}
            </select>
          )}
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder={t("email για δοκιμή")}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          {result === "sent" ? (
            <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.mint}14`, color: C.mint }}>{t("Στάλθηκε! Έλεγξε το inbox σου.")}</p>
          ) : result ? (
            <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{result}</p>
          ) : null}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t("Αποστολή δοκιμής")}
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
        <TestSendModal
          defaultEmail={defaultTestEmail}
          subjects={[step.subject, ...(Array.isArray(step.subjectVariants) ? step.subjectVariants : [])].filter(Boolean)}
          onClose={() => setShowTestSend(false)}
          onSend={onTestSend}
        />
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
            {step.delayDays === 0 ? t("Άμεση αποστολή") : t("{n} ημέρες μετά", { n: step.delayDays })}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowTestSend(true)} disabled={busy} className="rounded p-1" style={{ color: C.sky }} title={t("Δοκιμαστική αποστολή")}>
              <Send size={13} />
            </button>
            <button onClick={onMoveUp} disabled={!canMoveUp || busy} className="rounded p-1" style={{ opacity: canMoveUp ? 1 : 0.3, color: C.slate }} title={t("Μετακίνηση πάνω")}>
              <ArrowUp size={13} />
            </button>
            <button onClick={onMoveDown} disabled={!canMoveDown || busy} className="rounded p-1" style={{ opacity: canMoveDown ? 1 : 0.3, color: C.slate }} title={t("Μετακίνηση κάτω")}>
              <ArrowDown size={13} />
            </button>
            <button onClick={onDelete} disabled={busy} className="rounded p-1" style={{ color: C.coral }} title={t("Διαγραφή βήματος")}>
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
                  {t(EVENT_CONDITIONS.find((c) => c.key === step.conditions.requireEvent)?.label || "")}
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
  channel = "email",
  mode, setMode, templateId, setTemplateId, subject, setSubject, body, setBody,
  attachments, setAttachments, conditions, setConditions, templates,
  subjectVariants, setSubjectVariants, bodyVariants, setBodyVariants,
}) {
  const variants = Array.isArray(subjectVariants) ? subjectVariants : [];
  const bodyVars = Array.isArray(bodyVariants) ? bodyVariants : [];
  const isEmail = channel === "email";
  const isInmail = channel === "linkedin_inmail";
  const isLinkedin = channel === "linkedin";
  // Same spam-word check the template editor uses - surfaced here so a spammy
  // subject/body in a sequence step gets flagged before it ever sends.
  const spamWords = [
    ...new Set([
      ...findSpamWords(subject || ""),
      ...findSpamWords((body || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")),
    ]),
  ];
  const tagsText = (conditions.requireTags || []).join(", ");
  function setTagsText(text) {
    setConditions({
      ...conditions,
      requireTags: text.split(",").map((t) => t.trim()).filter(Boolean),
    });
  }

  // LinkedIn message / InMail steps: plain-text message (LinkedIn doesn't render
  // HTML), optional subject for InMail. No templates/A/B/tracking/gating - those
  // are email-only concepts.
  if (isLinkedin || isInmail) {
    return (
      <div className="space-y-2">
        {isInmail && (
          <input required placeholder={t("Θέμα InMail")} value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }} />
        )}
        <textarea required rows={4} value={(body || "").replace(/<[^>]*>/g, "")} onChange={(e) => setBody(e.target.value)}
          placeholder={isInmail ? t("Μήνυμα InMail… (υποστηρίζει {{first_name}})") : t("Μήνυμα LinkedIn… (υποστηρίζει {{first_name}})")}
          className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none bg-white" style={{ borderColor: C.line, color: C.ink }} />
      </div>
    );
  }

  return (
    <>
      {templates.length > 0 && (
        <div className="flex rounded-lg p-0.5 mb-3 w-fit" style={{ backgroundColor: C.pale }}>
          {["inline", "template"].map((m) => (
            <button key={m} type="button"
              onClick={() => setMode(m)}
              className="rounded-md px-2.5 py-1 text-[11px] font-medium"
              style={{ backgroundColor: mode === m ? C.sky : "transparent", color: mode === m ? "#fff" : C.slate }}
            >
              {m === "inline" ? t("Νέο κείμενο") : t("Από template")}
            </button>
          ))}
        </div>
      )}
      {mode === "template" ? (
        <select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}
          className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
          <option value="">{t("Επιλέξε template…")}</option>
          {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
        </select>
      ) : (
        <div className="space-y-2">
          <input required placeholder={t("Θέμα (π.χ. Γρήγορη ιδέα για το {{company}})")} value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }} />

          {/* A/B subject test: optional extra subject lines. Each send picks one
              at random; results show under Analytics → A/B. */}
          {typeof setSubjectVariants === "function" && (
            <div className="rounded-lg border px-3 py-2 space-y-2" style={{ borderColor: C.line }}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium" style={{ color: C.slate }}>
                  {t("A/B θέματος")}{variants.length > 0 ? t(" · {n} παραλλαγές", { n: variants.length + 1 }) : ""}
                </span>
                {variants.length < 4 && (
                  <button type="button" onClick={() => setSubjectVariants([...variants, ""])}
                    className="text-[11px] font-medium flex items-center gap-1" style={{ color: C.sky }}>
                    <Plus size={11} /> {t("Παραλλαγή θέματος")}
                  </button>
                )}
              </div>
              {variants.map((v, vi) => (
                <div key={vi} className="flex items-center gap-2">
                  <input placeholder={t("Εναλλακτικό θέμα {n}", { n: vi + 2 })} value={v}
                    onChange={(e) => setSubjectVariants(variants.map((x, idx) => (idx === vi ? e.target.value : x)))}
                    className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }} />
                  <button type="button" onClick={() => setSubjectVariants(variants.filter((_, idx) => idx !== vi))} style={{ color: C.coral }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {variants.length > 0 && (
                <p className="text-[10px]" style={{ color: C.slate }}>{t("Κάθε αποστολή διαλέγει τυχαία ένα θέμα. Αποτελέσματα: Analytics → A/B.")}</p>
              )}
            </div>
          )}

          <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={90} />
          {!hasUnsubscribeLink(body) && body.length > 0 && (
            <TipBanner>{t("Best practice: το email δεν έχει σύνδεσμο απεγγραφής.")}</TipBanner>
          )}
          {spamWords.length > 0 && (
            <p className="text-[11px] rounded-lg px-2.5 py-1.5" style={{ backgroundColor: `${C.amber}14`, color: "#7A5206" }}>
              {t("⚠ Πιθανές spam λέξεις: {words}", { words: spamWords.join(", ") })}
            </p>
          )}
          <AutoTrackingPixelNote />

          {/* A/B body test: optional alternative full bodies. Each send picks
              one body at random; winner shows under Analytics → A/B. */}
          {typeof setBodyVariants === "function" && (
            <div className="rounded-lg border px-3 py-2 space-y-2 mt-1" style={{ borderColor: C.line }}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium" style={{ color: C.slate }}>
                  {t("A/B κειμένου")}{bodyVars.length > 0 ? t(" · {n} παραλλαγές", { n: bodyVars.length + 1 }) : ""}
                </span>
                {bodyVars.length < 3 && (
                  <button type="button" onClick={() => setBodyVariants([...bodyVars, ""])}
                    className="text-[11px] font-medium flex items-center gap-1" style={{ color: C.sky }}>
                    <Plus size={11} /> {t("Παραλλαγή κειμένου")}
                  </button>
                )}
              </div>
              {bodyVars.map((v, vi) => (
                <div key={vi} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold" style={{ color: C.slate }}>{t("Παραλλαγή {v}", { v: String.fromCharCode(66 + vi) })}</span>
                    <button type="button" onClick={() => setBodyVariants(bodyVars.filter((_, idx) => idx !== vi))} style={{ color: C.coral }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <RichTextEditor value={v} onChange={(html) => setBodyVariants(bodyVars.map((x, idx) => (idx === vi ? html : x)))} minHeight={70} />
                </div>
              ))}
              {bodyVars.length > 0 && (
                <p className="text-[10px]" style={{ color: C.slate }}>{t("Κάθε αποστολή διαλέγει τυχαία ένα κείμενο. Νικητής: Analytics → A/B.")}</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
        <select
          value={conditions.requireEvent || ""}
          onChange={(e) => setConditions({ ...conditions, requireEvent: e.target.value || null })}
          className="rounded-lg px-2.5 py-1.5 text-xs border outline-none bg-white"
          style={{ borderColor: C.line, color: C.ink }}
        >
          {EVENT_CONDITIONS.map((c) => <option key={c.key} value={c.key}>{t(c.label)}</option>)}
        </select>
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder={t("Μόνο για tags (χωρισμένα με κόμμα)…")}
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
    channel: "email", // per-step channel (only meaningful for multichannel sequences)
    templateId: "",
    subject: "",
    subjectVariants: [],
    bodyVariants: [],
    body: unsubscribeSeed(),
    delayDays: SUGGESTED_DELAYS[index] ?? 7,
    conditions: { requireEvent: null, requireTags: [] },
    attachments: [],
  };
}

function NewSequenceModal({ onClose, onCreate, templates }) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("email");
  const [linkedinConnectionNote, setLinkedinConnectionNote] = useState("");
  const [steps, setSteps] = useState([emptyStep(0)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isLinkedin = channel === "linkedin";
  const isInmail = channel === "linkedin_inmail";
  const isMulti = channel === "multichannel";
  // The connection-request note applies whenever a LinkedIn *message* step may
  // run against a not-yet-connected contact - that's pure-LinkedIn sequences
  // and any multichannel sequence that contains a LinkedIn step.
  const showConnectionNote = isLinkedin || (isMulti && steps.some((s) => s.channel === "linkedin"));
  // Effective channel of a given step for rendering StepFields.
  const stepCh = (s) => (isMulti ? s.channel || "email" : channel);

  function updateStep(i, patch) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function addStep() {
    setSteps((prev) => [...prev, emptyStep(prev.length)]);
  }
  // Keep a step's body sensible for its channel: the email unsubscribe footer
  // (seeded into new steps) must not carry into a LinkedIn/InMail plain-text
  // message, and switching back to email re-seeds an empty body.
  function bodyForChannel(ch, body) {
    const isMsg = ch === "linkedin" || ch === "linkedin_inmail";
    if (isMsg && body === unsubscribeSeed()) return "";
    if (ch === "email" && !body) return unsubscribeSeed();
    return body;
  }
  // Top-level channel switch (single-channel sequences): re-seed every step's
  // body for the new channel. Multichannel leaves bodies to the per-step picker.
  function changeChannel(val) {
    setChannel(val);
    if (val !== "multichannel") {
      setSteps((prev) => prev.map((s) => ({ ...s, body: bodyForChannel(val, s.body) })));
    }
  }
  function removeStep(i) {
    setSteps((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payloadSteps = steps.map((s) => {
        const ch = stepCh(s);
        // Templates are email-only; a template-mode step on a non-email channel
        // falls back to its inline subject/body.
        const base = isMulti ? { channel: ch } : {};
        return s.mode === "template" && s.templateId && ch === "email"
          ? { ...base, templateId: s.templateId, subjectVariants: s.subjectVariants || [], delayDays: Number(s.delayDays) || 0, conditions: s.conditions, attachments: s.attachments }
          : { ...base, subject: s.subject, subjectVariants: s.subjectVariants || [], body: s.body, bodyVariants: s.bodyVariants || [], delayDays: Number(s.delayDays) || 0, conditions: s.conditions, attachments: s.attachments };
      });
      await onCreate({ name, channel, linkedinConnectionNote: showConnectionNote ? linkedinConnectionNote : undefined, steps: payloadSteps });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η δημιουργία sequence."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-2xl p-5 max-h-[85vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Νέο sequence")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>

        {steps.length < 3 && (
          <TipBanner tone="warn">
            {t("Best practice: 3-5 follow-ups ανεβάζουν σημαντικά τα ποσοστά απάντησης. Σκέψου να προσθέσεις ακόμη βήματα πριν δημιουργήσεις το sequence.")}
          </TipBanner>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input required placeholder={t("Όνομα sequence")} value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: C.slate }}>{t("Κανάλι")}</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[["email", "Email", Mail], ["linkedin", "LinkedIn", Linkedin], ["linkedin_inmail", "InMail", Send], ["multichannel", t("Multichannel"), Layers]].map(([val, label, Icon]) => (
                <button key={val} type="button" onClick={() => changeChannel(val)}
                  className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium border"
                  style={channel === val ? { borderColor: C.sky, color: C.sky, backgroundColor: `${C.sky}0F` } : { borderColor: C.line, color: C.slate }}>
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </div>

          {isLinkedin && (
            <TipBanner tone="info">
              {t("LinkedIn sequence: αν η επαφή δεν είναι ήδη σύνδεση, το 1ο βήμα στέλνει αίτημα σύνδεσης με το σημείωμα παρακάτω. Τα follow-up μηνύματα ξεκινούν όταν γίνει αποδεκτό το αίτημα. Ισχύει ημερήσιο όριο αιτημάτων για προστασία του λογαριασμού. Μόνο επαφές με LinkedIn URL θα εγγραφούν.")}
            </TipBanner>
          )}
          {isInmail && (
            <TipBanner tone="info">
              {t("InMail sequence: κάθε βήμα στέλνει ένα InMail (με θέμα + μήνυμα) απευθείας, ακόμη και σε μη-συνδέσεις - δεν χρειάζεται αίτημα σύνδεσης. Απαιτεί premium LinkedIn και καταναλώνει InMail credits. Κάθε βήμα χρειάζεται θέμα και μήνυμα. Μόνο επαφές με LinkedIn URL θα εγγραφούν.")}
            </TipBanner>
          )}
          {isMulti && (
            <TipBanner tone="info">
              {t("Multichannel sequence: κάθε βήμα διαλέγει το δικό του κανάλι (Email / LinkedIn / InMail). Εγγράφονται όλες οι επαφές - τα βήματα LinkedIn/InMail παραλείπονται αυτόματα για επαφές χωρίς LinkedIn URL, ώστε να συνεχίζουν τα email.")}
            </TipBanner>
          )}
          {showConnectionNote && (
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: C.slate }}>{t("Σημείωμα αιτήματος σύνδεσης")} <span style={{ fontWeight: 400 }}>{t("(προαιρετικό, max 300 χαρ.)")}</span></label>
              <textarea value={linkedinConnectionNote} onChange={(e) => setLinkedinConnectionNote(e.target.value)} maxLength={300} rows={2}
                placeholder={t("π.χ. Γεια σου {{first_name}}, θα ήθελα να συνδεθούμε…")}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none resize-none" style={{ borderColor: C.line, color: C.ink }} />
            </div>
          )}

          {steps.map((step, i) => (
            <Card key={i} className="p-4" style={{ backgroundColor: C.pale }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold" style={{ color: C.navy }}>{t("Βήμα {n}", { n: i + 1 })}</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs" style={{ color: C.slate }}>
                    <Clock size={12} />
                    <input type="number" min={0} max={60} value={step.delayDays}
                      onChange={(e) => updateStep(i, { delayDays: e.target.value })}
                      className="w-14 rounded-md px-1.5 py-1 text-xs border outline-none" style={{ borderColor: C.line }} />
                    {t("ημέρες μετά")}
                  </label>
                  {steps.length > 1 && (
                    <button type="button" onClick={() => removeStep(i)} style={{ color: C.coral }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>

              {isMulti && (
                <div className="flex gap-1.5 mb-3">
                  {[["email", "Email", Mail], ["linkedin", "LinkedIn", Linkedin], ["linkedin_inmail", "InMail", Send]].map(([val, label, Icon]) => (
                    <button key={val} type="button" onClick={() => updateStep(i, { channel: val, body: bodyForChannel(val, step.body) })}
                      className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium border"
                      style={(step.channel || "email") === val ? { borderColor: C.sky, color: C.sky, backgroundColor: `${C.sky}0F` } : { borderColor: C.line, color: C.slate }}>
                      <Icon size={12} /> {label}
                    </button>
                  ))}
                </div>
              )}

              <StepFields
                channel={stepCh(step)}
                mode={step.mode} setMode={(m) => updateStep(i, { mode: m })}
                templateId={step.templateId} setTemplateId={(v) => updateStep(i, { templateId: v })}
                subject={step.subject} setSubject={(v) => updateStep(i, { subject: v })}
                subjectVariants={step.subjectVariants} setSubjectVariants={(v) => updateStep(i, { subjectVariants: v })}
                bodyVariants={step.bodyVariants} setBodyVariants={(v) => updateStep(i, { bodyVariants: v })}
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
            <Plus size={14} /> {t("Προσθήκη βήματος")} {steps.length < SUGGESTED_DELAYS.length ? t("(προτείνεται: {n} ημέρες)", { n: SUGGESTED_DELAYS[steps.length] }) : ""}
          </button>

          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t("Δημιουργία ({n} βήματα)", { n: steps.length })}
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
  const [subjectVariants, setSubjectVariants] = useState([]);
  const [body, setBody] = useState("");
  const [bodyVariants, setBodyVariants] = useState([]);
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
          ? { templateId, subjectVariants, delayDays: Number(delayDays) || 0, conditions, attachments }
          : { subject, subjectVariants, body, bodyVariants, delayDays: Number(delayDays) || 0, conditions, attachments };
      await onAdd(payload);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η προσθήκη βήματος."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Νέο βήμα")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <StepFields
            mode={mode} setMode={setMode}
            templateId={templateId} setTemplateId={setTemplateId}
            subject={subject} setSubject={setSubject}
            subjectVariants={subjectVariants} setSubjectVariants={setSubjectVariants}
            bodyVariants={bodyVariants} setBodyVariants={setBodyVariants}
            body={body} setBody={setBody}
            attachments={attachments} setAttachments={setAttachments}
            conditions={conditions} setConditions={setConditions}
            templates={templates}
          />
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Καθυστέρηση (ημέρες)")}</label>
            <input type="number" min={0} max={60} value={delayDays} onChange={(e) => setDelayDays(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t("Προσθήκη")}
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

  // Per-step drop-off funnel for the open sequence (sent/opened per step).
  const [dropoff, setDropoff] = useState(null);
  useEffect(() => {
    if (!activeId) { setDropoff(null); return; }
    let cancelled = false;
    api.get(`/analytics/sequence/${activeId}/steps`)
      .then((d) => { if (!cancelled) setDropoff(d); })
      .catch(() => { if (!cancelled) setDropoff(null); });
    return () => { cancelled = true; };
  }, [activeId, sequences]);

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
          {loading && <Spinner label={t("Φόρτωση…")} />}
          {!loading && sequences.length === 0 && (
            <p className="text-sm text-center py-8" style={{ color: C.slate }}>{t("Δεν υπάρχουν sequences ακόμα.")}</p>
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
                {t("{steps} βήματα · {sent} αποστολές", { steps: s.steps.length, sent: s.stats?.sent ?? 0 })}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <ErrorNote message={error} onRetry={onReload} />
        {active ? (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
              <div>
                <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{active.name}</h1>
                <p className="text-sm mt-0.5" style={{ color: C.slate }}>
                  {t("{sent} στάλθηκαν · {opened} ανοίχτηκαν · {replied} απαντήσεις", { sent: active.stats?.sent ?? 0, opened: active.stats?.opened ?? 0, replied: active.stats?.replied ?? 0 })}
                </p>
              </div>
              <button onClick={() => setShowAddStep(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white shrink-0" style={{ backgroundColor: C.sky }}>
                <Plus size={14} /> {t("Προσθήκη βήματος")}
              </button>
            </div>
            <div className="px-8 py-8 max-w-2xl">
              {dropoff && dropoff.steps.some((s) => s.sent > 0) && (
                <Card className="p-4 mb-5">
                  <div className="text-sm font-medium mb-3" style={{ color: C.ink }}>{t("Drop-off ανά βήμα")}</div>
                  <div className="space-y-2">
                    {dropoff.steps.map((s, i) => {
                      const first = dropoff.steps[0]?.sent || 0;
                      const widthPct = first ? Math.max(4, Math.round((s.sent / first) * 100)) : 0;
                      const openRate = s.sent ? Math.round((s.opened / s.sent) * 100) : 0;
                      return (
                        <div key={s.id} className="flex items-center gap-3">
                          <span className="text-[11px] w-12 shrink-0" style={{ color: C.slate }}>{t("Βήμα {n}", { n: i + 1 })}</span>
                          <div className="flex-1 h-6 rounded-md overflow-hidden" style={{ backgroundColor: C.pale }}>
                            <div className="h-full rounded-md flex items-center px-2" style={{ width: `${widthPct}%`, backgroundColor: C.sky, minWidth: 40 }}>
                              <span className="text-[11px] font-semibold text-white">{s.sent}</span>
                            </div>
                          </div>
                          <span className="text-[11px] w-24 shrink-0 text-right tabular-nums" style={{ color: C.slate }}>{t("{n}% open", { n: openRate })}</span>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}
              {active.steps.length < 3 && (
                <TipBanner tone="warn">
                  {t("Αυτό το sequence έχει {n} βήματα. Best practice: 3-5 follow-ups δίνουν σημαντικά καλύτερα reply rates.", { n: active.steps.length })}
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
                  onTestSend={(testEmail, subject) => onTestSend(active.id, step.id, testEmail, subject)}
                  defaultTestEmail={userEmail}
                />
              ))}
            </div>
          </>
        ) : (
          !loading && <div className="p-8 text-sm" style={{ color: C.slate }}>{t("Διάλεξε ή φτιάξε ένα sequence.")}</div>
        )}
      </div>
    </div>
  );
}

function InboxView({ activity, loading, error, onReload, setComposeOpen }) {
  const [expandedId, setExpandedId] = useState(null);

  return (
    <div className="h-full overflow-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{t("Απεσταλμένα")}</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>{t("Όλα τα emails που στάλθηκαν - sequences και χειροκίνητα. Πάτησε ένα για το trace.")}</p>
        </div>
        <button
          onClick={() => setComposeOpen(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white"
          style={{ backgroundColor: C.sky }}
        >
          <Pencil size={15} /> {t("Σύνταξη")}
        </button>
      </div>
      <div className="px-8 py-4">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label={t("Φόρτωση…")} />
        ) : activity.length === 0 ? (
          <EmptyState icon={MailCheck} title={t("Δεν έχει σταλεί κανένα email ακόμα.")}
            hint={t("Μόλις φύγει το πρώτο email, εδώ θα βλέπεις κάθε αποστολή με opens και clicks.")}
            actionLabel={t("Σύνταξη email")} onAction={() => setComposeOpen(true)} />
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
                        {t("προς {who}", { who: m.toName || m.to })}{m.sequenceName ? ` · ${m.sequenceName}` : t(" · χειροκίνητο")}
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

// "Due today" dashboard - the one view meant to be opened first each
// morning. Aggregates two independent kinds of "due" (manual follow-up
// reminders on a contact, and automatic sequence sends) into a single list,
// each row jumping into the contact's detail drawer via onSelectContact
// (same relay used by global search - see handleSelectFromSearch in App()).
function DashboardView({ dashboard, loading, error, onReload, onSelectContact }) {
  const { followUps = [], sends = [] } = dashboard;

  return (
    <div className="h-full overflow-auto">
      <div className="px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{t("Σήμερα")}</h1>
        <p className="text-sm mt-0.5" style={{ color: C.slate }}>{t("Ό,τι είναι εκκρεμές ή έληξε σήμερα - follow-ups και αυτόματα sequence sends.")}</p>
      </div>
      <div className="px-8 py-4 space-y-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label={t("Φόρτωση…")} />
        ) : followUps.length === 0 && sends.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-sm" style={{ color: C.slate }}>
            <CalendarClock size={28} strokeWidth={1.5} />
            {t("Τίποτα εκκρεμές για σήμερα.")}
          </div>
        ) : (
          <>
            <div>
              <h2 className="text-sm font-medium mb-2 flex items-center gap-2" style={{ color: C.ink }}>
                <StickyNote size={14} /> Follow-ups ({followUps.length})
              </h2>
              {followUps.length === 0 ? (
                <p className="text-sm" style={{ color: C.slate }}>{t("Κανένα follow-up εκκρεμές.")}</p>
              ) : (
                <div className="space-y-1.5">
                  {followUps.map((f) => (
                    <button
                      key={f.contactId}
                      onClick={() => onSelectContact(f.contactId)}
                      className="w-full flex items-center justify-between rounded-lg px-3 py-2.5 text-left"
                      style={{ backgroundColor: C.pale }}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{f.contactName || f.contactEmail}</div>
                        <div className="text-xs truncate" style={{ color: C.slate }}>{f.contactCompany || f.contactEmail}</div>
                      </div>
                      <span className="text-xs shrink-0 ml-3" style={{ color: f.overdue ? C.coral : C.slate }}>
                        {f.overdue ? t("εκπρόθεσμο") : t("σήμερα")} · {fmtDate(f.dueAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h2 className="text-sm font-medium mb-2 flex items-center gap-2" style={{ color: C.ink }}>
                <Layers size={14} /> {t("Αυτόματα sends")} ({sends.length})
              </h2>
              {sends.length === 0 ? (
                <p className="text-sm" style={{ color: C.slate }}>{t("Κανένα sequence send εκκρεμές.")}</p>
              ) : (
                <div className="space-y-1.5">
                  {sends.map((s) => (
                    <button
                      key={s.enrollmentId}
                      onClick={() => onSelectContact(s.contactId)}
                      className="w-full flex items-center justify-between rounded-lg px-3 py-2.5 text-left"
                      style={{ backgroundColor: C.pale }}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{s.contactName || s.contactEmail}</div>
                        <div className="text-xs truncate" style={{ color: C.slate }}>
                          {s.sequenceName}{s.stepSubject ? ` · ${s.stepSubject}` : ""}
                        </div>
                      </div>
                      <span className="text-xs shrink-0 ml-3" style={{ color: s.overdue ? C.coral : C.slate }}>
                        {s.overdue ? t("εκπρόθεσμο") : t("σήμερα")} · {fmtDate(s.dueAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ComposeModal({ onClose, contacts, gmailConnected, onSend, initialContactId }) {
  const [minimized, setMinimized] = useState(false);
  const [contactId, setContactId] = useState(initialContactId || "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(() => unsubscribeSeed());
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function handleSend(e) {
    e.preventDefault();
    if (!contactId) { setError(t("Επίλεξε παραλήπτη.")); return; }
    setError("");
    setBusy(true);
    try {
      await onSend({ contactId, subject, body, attachments });
      setSent(true);
      setTimeout(onClose, 900);
    } catch (err) {
      if (err instanceof ApiError && err.data?.error === "gmail_not_connected") {
        setError(t("Δεν έχεις συνδέσει Gmail - σύνδεσε το από το μπάνερ στην κορυφή για να στείλεις."));
      } else if (err instanceof ApiError && err.data?.error === "gmail_needs_reconnect") {
        setError(t("Η σύνδεση Gmail διακόπηκε - συνδέσου ξανά από το μπάνερ στην κορυφή για να στείλεις."));
      } else if (err instanceof ApiError && err.data?.error === "contact_unsubscribed") {
        setError(t("Η επαφή έχει κάνει unsubscribe - δεν επιτρέπεται αποστολή."));
      } else if (err instanceof ApiError && err.data?.error === "daily_send_cap_reached") {
        setError(t("Συμπληρώθηκε το ημερήσιο όριο emails ({limit}) για την εταιρεία σας - δοκίμασε ξανά αύριο.", { limit: err.data.limit }));
      } else {
        setError(err instanceof ApiError ? err.message : t("Η αποστολή απέτυχε."));
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
        <span className="text-sm font-medium text-white">{t("Νέο μήνυμα")}</span>
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
              <option value="">{t("Προς - επίλεξε επαφή…")}</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name ? `${c.name} <${c.email}>` : c.email}</option>
              ))}
            </select>
          </div>
          <div className="px-4 py-2.5 border-b text-sm" style={{ borderColor: C.line, color: C.ink }}>
            <input required placeholder={t("Θέμα")} value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full outline-none" />
          </div>
          <div className="flex-1 px-4 py-3 overflow-auto">
            <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={160} />
            {!hasUnsubscribeLink(body) && body.length > 0 && (
              <TipBanner>{t("Best practice: το email δεν έχει σύνδεσμο απεγγραφής.")}</TipBanner>
            )}
            <AutoTrackingPixelNote />
          </div>
          {!gmailConnected && (
            <div className="px-4 py-2 text-xs" style={{ backgroundColor: `${C.amber}14`, color: "#7A5206" }}>
              {t("Δεν έχεις συνδέσει Gmail ακόμα - η αποστολή δεν θα δουλέψει χωρίς αυτό.")}
            </div>
          )}
          {error && <p className="px-4 py-2 text-xs" style={{ color: C.coral }}>{error}</p>}
          <div className="px-4 py-3 border-t flex items-center justify-end gap-2" style={{ borderColor: C.line }}>
            {sent ? (
              <span className="text-sm font-medium" style={{ color: C.mint }}>{t("Εστάλη ✓")}</span>
            ) : (
              <button type="submit" disabled={busy}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
                style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
                {busy && <Loader2 size={14} className="animate-spin" />} {t("Αποστολή")}
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
// between sends (see scheduler.js's campaign tick) - distinct from a
// Sequence, which is a multi-step nurture with day-scale delays per contact.
function NewCampaignModal({ onClose, onCreate, contacts, templates }) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [subjectVariants, setSubjectVariants] = useState([]);
  const [body, setBody] = useState(() => unsubscribeSeed());
  const [attachments, setAttachments] = useState([]);
  const [intervalMinutes, setIntervalMinutes] = useState(2);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const categories = useMemo(() => {
    const set = new Set(contacts.map((c) => (c.category || "").trim()).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  // Segmentation by tag, same as the Contacts view - lets a campaign target
  // e.g. everyone tagged "warm-lead" without also filtering by category.
  const tags = useMemo(() => {
    const set = new Set();
    contacts.forEach((c) => (c.tags || "").split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (categoryFilter !== "all" && (c.category || "") !== categoryFilter) return false;
      if (tagFilter !== "all" && !(c.tags || "").split(",").map((t) => t.trim()).includes(tagFilter)) return false;
      if (c.unsubscribed) return false; // never let an unsubscribed contact even be selectable
      if (!q) return true;
      return (c.name || "").toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q) || (c.company || "").toLowerCase().includes(q);
    });
  }, [contacts, query, categoryFilter, tagFilter]);

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
    if (selectedIds.size === 0) { setError(t("Επίλεξε τουλάχιστον 1 επαφή.")); return; }
    setError("");
    setBusy(true);
    try {
      await onCreate({
        name,
        subject,
        subjectVariants,
        body,
        attachments,
        contactIds: [...selectedIds],
        intervalMinutes: Number(intervalMinutes) || 2,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η δημιουργία campaign."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-4xl p-5 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Νέο campaign")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <input required placeholder={t("Όνομα campaign")} value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

            {templates.length > 0 && (
              <select defaultValue="" onChange={(e) => { if (e.target.value) loadFromTemplate(e.target.value); e.target.value = ""; }}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.slate }}>
                <option value="">{t("Φόρτωση περιεχομένου από template…")}</option>
                {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
              </select>
            )}

            <input required placeholder={t("Θέμα (π.χ. Γρήγορη ιδέα για το {{company}})")} value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />

            {/* A/B subject test - each recipient gets one of these at random;
                results under Analytics → A/B. */}
            <div className="rounded-lg border px-3 py-2 space-y-2" style={{ borderColor: C.line }}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium" style={{ color: C.slate }}>
                  {t("A/B θέματος")}{subjectVariants.length > 0 ? t(" · {n} παραλλαγές", { n: subjectVariants.length + 1 }) : ""}
                </span>
                {subjectVariants.length < 4 && (
                  <button type="button" onClick={() => setSubjectVariants([...subjectVariants, ""])}
                    className="text-[11px] font-medium flex items-center gap-1" style={{ color: C.sky }}>
                    <Plus size={11} /> {t("Παραλλαγή θέματος")}
                  </button>
                )}
              </div>
              {subjectVariants.map((v, vi) => (
                <div key={vi} className="flex items-center gap-2">
                  <input placeholder={t("Εναλλακτικό θέμα {n}", { n: vi + 2 })} value={v}
                    onChange={(e) => setSubjectVariants(subjectVariants.map((x, idx) => (idx === vi ? e.target.value : x)))}
                    className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
                  <button type="button" onClick={() => setSubjectVariants(subjectVariants.filter((_, idx) => idx !== vi))} style={{ color: C.coral }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-1.5 flex-wrap">
              <span className="text-[11px] self-center" style={{ color: C.slate }}>{t("Εισαγωγή token:")}</span>
              {["{{name}}", "{{first_name}}", "{{last_name}}", "{{company}}", "{{email}}", "{{website}}", "{{gmb}}", "{{facebook}}", "{{instagram}}", "{{google_reviews}}", "{{report_link}}", "{{booking_link}}", "{{comments}}"].map((tok) => (
                <button key={tok} type="button" onClick={() => insertToken(tok)}
                  className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ backgroundColor: C.pale, color: C.navy }}>
                  {tok}
                </button>
              ))}
            </div>
            <RichTextEditor value={body} onChange={setBody} attachments={attachments} onAttachmentsChange={setAttachments} minHeight={160} />
            {!hasUnsubscribeLink(body) && body.length > 0 && (
              <TipBanner>{t("Best practice: το email δεν έχει σύνδεσμο απεγγραφής - ιδιαίτερα σημαντικό για μαζικές αποστολές σαν campaign.")}</TipBanner>
            )}
            <AutoTrackingPixelNote />

            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Απόσταση μεταξύ αποστολών (λεπτά)")}</label>
              <input type="number" min={1} max={1440} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <p className="text-[11px] mt-1" style={{ color: C.slate }}>
                {t("Τα emails φεύγουν ένα-ένα, όχι όλα μαζί - π.χ. με 2 λεπτά, {n} επαφές θα χρειαστούν περίπου {mins} λεπτά για να ολοκληρωθούν.", { n: selectedIds.size, mins: Math.round((selectedIds.size - 1) * (Number(intervalMinutes) || 2)) })}
              </p>
            </div>

            {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
            <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
              {busy && <Loader2 size={14} className="animate-spin" />} {t("Δημιουργία campaign (ως πρόχειρο)")}
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium" style={{ color: C.slate }}>{t("Παραλήπτες")}</label>
              <span className="text-xs font-medium" style={{ color: C.sky }}>{t("{n} επιλεγμένες", { n: selectedIds.size })}</span>
            </div>
            <div className="flex gap-2">
              <input placeholder={t("Αναζήτηση…")} value={query} onChange={(e) => setQuery(e.target.value)}
                className="flex-1 rounded-lg px-3 py-1.5 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
                className="rounded-lg px-2 py-1.5 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
                <option value="all">{t("Όλες οι κατηγορίες")}</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}
                className="rounded-lg px-2 py-1.5 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
                <option value="all">{t("Όλες οι ετικέτες")}</option>
                {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={selectAllFiltered} className="text-xs font-medium underline" style={{ color: C.sky }}>
                {t("Επιλογή όλων ({n})", { n: filtered.length })}
              </button>
              <button type="button" onClick={clearSelection} className="text-xs font-medium underline" style={{ color: C.slate }}>
                {t("Καθαρισμός")}
              </button>
            </div>
            <div className="rounded-lg border overflow-auto" style={{ borderColor: C.line, maxHeight: 420 }}>
              {filtered.length === 0 ? (
                <p className="text-xs text-center py-6" style={{ color: C.slate }}>{t("Καμία επαφή δεν ταιριάζει.")}</p>
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
      setError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα στοιχεία campaign."));
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
    if (!window.confirm(t("Διαγραφή αυτού του campaign; Δεν θα διαγραφούν τα emails που έχουν ήδη σταλεί."))) return;
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
                <Play size={13} /> {detail.status === "paused" ? t("Συνέχεια") : t("Εκκίνηση")}
              </button>
            )}
            {detail && detail.status === "running" && (
              <button onClick={() => run(onPause)} disabled={busy}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.amber, opacity: busy ? 0.6 : 1 }}>
                <Pause size={13} /> {t("Παύση")}
              </button>
            )}
            <button onClick={handleDelete} disabled={busy} className="text-slate-400 hover:text-coral-600" title={t("Διαγραφή")}>
              <Trash2 size={16} />
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
          </div>
        </div>

        {loading ? (
          <Spinner label={t("Φόρτωση…")} />
        ) : error ? (
          <div className="p-6"><ErrorNote message={error} onRetry={load} /></div>
        ) : detail ? (
          <div className="p-6 space-y-5">
            <div className="flex items-center gap-2">
              <CampaignStatusBadge status={detail.status} />
              <span className="text-xs" style={{ color: C.slate }}>
                {t("{n} λεπτά μεταξύ αποστολών · δημιουργήθηκε {d}", { n: detail.intervalMinutes, d: fmtDate(detail.createdAt) })}
              </span>
            </div>

            <div className="flex flex-wrap gap-3">
              <StatCard label={t("Σύνολο")} value={detail.counts.total} sub={t("παραλήπτες")} color={C.slate} />
              <StatCard label={t("Στάλθηκαν")} value={detail.counts.sent} sub={t("από {n}", { n: detail.counts.total })} color={C.navy} />
              <StatCard label={t("Εκκρεμούν")} value={detail.counts.pending} sub={t("στην ουρά")} color={C.amber} />
              <StatCard label={t("Παραλείφθηκαν")} value={detail.counts.skipped + detail.counts.failed} sub={t("unsubscribed / αποτυχία")} color={C.coral} />
            </div>

            <div>
              <div className="text-sm font-medium mb-2" style={{ color: C.ink }}>{t("Θέμα")}</div>
              <p className="text-sm" style={{ color: C.ink }}>{detail.subject}</p>
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: C.ink }}>
                <Users size={14} /> {t("Παραλήπτες")} ({detail.recipients.length})
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
                          {r.status === "pending" && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.slate}1A`, color: C.slate }}>{t("Εκκρεμεί")}</span>}
                          {r.status === "sent" && r.opened && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.sky}1A`, color: C.sky }}>{t("Άνοιξε")}</span>}
                          {r.status === "sent" && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.mint}1A`, color: C.mint }}>{t("Στάλθηκε")}</span>}
                          {(r.status === "skipped" || r.status === "failed") && (
                            <span className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: `${C.coral}1A`, color: C.coral }}>
                              {r.status === "skipped" ? t("Παραλείφθηκε") : t("Αποτυχία")}
                            </span>
                          )}
                        </div>
                      </button>
                      {open && (
                        <div className="px-3 pb-2.5 pl-7">
                          {r.note && <p className="text-[11px] mb-1.5" style={{ color: C.coral }}>{r.note}</p>}
                          {r.sentAt ? <EventTrace sentAt={r.sentAt} events={r.events} /> : (
                            <p className="text-[11px]" style={{ color: C.slate }}>{t("Δεν έχει σταλεί ακόμα.")}</p>
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Campaigns</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>{t("Ένα μήνυμα σε πολλές επαφές, ένα-ένα με απόσταση - όχι μαζική αποστολή.")}</p>
        </div>
        <button onClick={() => setShowNew(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white shrink-0" style={{ backgroundColor: C.sky }}>
          <Megaphone size={15} /> {t("Νέο campaign")}
        </button>
      </div>
      <div className="px-8 py-6">
        <ErrorNote message={error} onRetry={onReload} />
        {loading ? (
          <Spinner label={t("Φόρτωση…")} />
        ) : campaigns.length === 0 ? (
          <EmptyState icon={Megaphone} title={t("Δεν έχεις δημιουργήσει campaign ακόμα.")}
            hint={t("Στείλε ένα μήνυμα σε πολλές επαφές μαζί, με σταδιακή αποστολή για καλό deliverability.")}
            actionLabel={t("Νέο campaign")} onAction={() => setShowNew(true)} />
        ) : (
          <>
            {/* Desktop table view */}
            <div className="hidden md:block">
              <Card className="p-0 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left" style={{ color: C.slate, backgroundColor: C.pale }}>
                        <th className="font-medium px-4 py-2.5">{t("Όνομα")}</th>
                        <th className="font-medium px-4 py-2.5">{t("Κατάσταση")}</th>
                        <th className="font-medium px-4 py-2.5">{t("Πρόοδος")}</th>
                        <th className="font-medium px-4 py-2.5">{t("Δημιουργήθηκε")}</th>
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
                                <button onClick={() => run(c.id, onStart)} disabled={busyId === c.id} title={t("Εκκίνηση")} style={{ color: C.mint }}>
                                  <Play size={15} />
                                </button>
                              )}
                              {c.status === "running" && (
                                <button onClick={() => run(c.id, onPause)} disabled={busyId === c.id} title={t("Παύση")} style={{ color: C.amber }}>
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
            </div>

            {/* Mobile card view */}
            <div className="md:hidden space-y-3">
              {campaigns.map((c) => (
                <Card key={c.id} className="p-4 cursor-pointer hover:shadow-md transition-shadow" onClick={() => setDetailId(c.id)}>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium truncate mb-1" style={{ color: C.ink }}>{c.name}</h3>
                      <CampaignStatusBadge status={c.status} />
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {(c.status === "draft" || c.status === "paused") && (
                        <button onClick={() => run(c.id, onStart)} disabled={busyId === c.id} title={t("Εκκίνηση")} style={{ color: C.mint }}>
                          <Play size={15} />
                        </button>
                      )}
                      {c.status === "running" && (
                        <button onClick={() => run(c.id, onPause)} disabled={busyId === c.id} title={t("Παύση")} style={{ color: C.amber }}>
                          <Pause size={15} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span style={{ color: C.slate }}>{t("Πρόοδος:")}</span>
                      <span style={{ color: C.ink }}>{c.counts.sent} / {c.counts.total}</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: C.slate }}>{t("Δημιουργήθηκε:")}</span>
                      <span style={{ color: C.ink, fontSize: "0.875rem" }}>{fmtDate(c.createdAt)}</span>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Team ----------
function NewTeammateModal({ onClose, onInvite }) {
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
      await onInvite({ email, password, name: name || undefined });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η πρόσκληση."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Πρόσκληση συνεργάτη")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder={t("Όνομα (προαιρετικό)")} value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input required type="password" minLength={10} placeholder={t("Κωδικός (τουλάχιστον 10 χαρακτήρες)")} value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <p className="text-xs" style={{ color: C.slate }}>
            {t("Ο συνεργάτης θα βλέπει τις ίδιες επαφές, sequences, templates και campaigns με εσένα - μοιράζεστε το ίδιο workspace.")}
          </p>
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t("Πρόσκληση")}
          </button>
        </form>
      </Card>
    </div>
  );
}

// Owner inviting someone who ALREADY has an SDLoop account elsewhere - this
// can't just create a Membership directly the way NewTeammateModal does,
// since the target already owns their own account/password. It becomes a
// pending CompanyInvite instead; a Membership only appears once they accept
// it themselves (see the invite-response prompt near the top of App()).
function InviteExistingModal({ onClose, onInvite }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onInvite({ email, role });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η πρόσκληση."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Πρόσκληση υπάρχοντος χρήστη")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        {sent ? (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: C.ink }}>{t("Η πρόσκληση στάλθηκε. Θα εμφανιστεί στον λογαριασμό του/της την επόμενη φορά που θα συνδεθεί, και θα προστεθεί στην ομάδα μόνο αν την αποδεχτεί.")}</p>
            <button onClick={onClose} className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky }}>{t("Κλείσιμο")}</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input required type="email" placeholder={t("Email υπάρχοντος λογαριασμού")} value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Ρόλος")}</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
                <option value="member">{t("Μέλος")}</option>
                <option value="owner">{t("Ιδιοκτήτης")}</option>
              </select>
            </div>
            <p className="text-xs" style={{ color: C.slate }}>
              {t("Ο χρήστης πρέπει ήδη να έχει λογαριασμό SDLoop. Θα λάβει μια πρόσκληση που μπορεί να αποδεχτεί ή να απορρίψει - δεν προστίθεται αυτόματα.")}
            </p>
            {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
            <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
              {busy && <Loader2 size={14} className="animate-spin" />} {t("Αποστολή πρόσκλησης")}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

// Visible to every teammate; only an "owner" gets invite/remove actions.
// Deliberately no "promote to owner" here yet - one owner per company this
// round, matching the backend (routes/team.js refuses to remove an owner).
// Timezone-aware send-window settings (see backend lib/sendWindow.js). Fetches
// and saves its own /company/settings, so it drops into the Team view without
// threading state through App. Read-only for non-owners.
function SendWindowCard({ isOwner }) {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.get("/company/settings")
      .then((d) => { if (!cancelled) setS(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading || !s) return null;

  const DAYS = [[1, "Δε"], [2, "Τρ"], [3, "Τε"], [4, "Πε"], [5, "Πα"], [6, "Σα"], [0, "Κυ"]];
  const days = Array.isArray(s.sendDays) ? s.sendDays : [1, 2, 3, 4, 5];
  const update = (patch) => setS((prev) => ({ ...prev, ...patch }));
  const toggleDay = (d) => update({ sendDays: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] });
  const startOpts = Array.from({ length: 24 }, (_, h) => h); // 0-23
  const endOpts = Array.from({ length: 24 }, (_, h) => h + 1); // 1-24 (exclusive end)

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const saved = await api.patch("/company/settings", {
        sendWindowEnabled: !!s.sendWindowEnabled,
        sendWindowStart: Number(s.sendWindowStart),
        sendWindowEnd: Number(s.sendWindowEnd),
        sendDays: days,
        sendTimezone: s.sendTimezone,
        emailTrackingEnabled: s.emailTrackingEnabled !== false,
        unsubscribeEnabled: s.unsubscribeEnabled !== false,
        unsubscribeText: s.unsubscribeText || "",
        unsubscribeConfirmTitle: s.unsubscribeConfirmTitle || "",
        unsubscribeConfirmMessage: s.unsubscribeConfirmMessage || "",
        bookingLink: s.bookingLink || "",
        bookingLinks: Array.isArray(s.bookingLinks) ? s.bookingLinks : [],
      });
      setUnsubscribeSeed(saved.unsubscribeText);
      setS(saved);
      setMsg(t("Αποθηκεύτηκε."));
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : t("Δεν αποθηκεύτηκε."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm font-medium" style={{ color: C.ink }}>{t("Παράθυρο αποστολής")}</div>
        <label className="flex items-center gap-2 text-xs" style={{ color: C.slate }}>
          <input type="checkbox" disabled={!isOwner} checked={!!s.sendWindowEnabled}
            onChange={(e) => update({ sendWindowEnabled: e.target.checked })} />
          {t("Ενεργό")}
        </label>
      </div>
      <p className="text-xs mb-3" style={{ color: C.slate }}>
        {t("Τα αυτόματα emails (sequences & campaigns) φεύγουν μόνο μέσα σε αυτές τις ώρες/ημέρες. Ό,τι πέφτει εκτός, μετατίθεται για το επόμενο άνοιγμα.")}
      </p>

      <div className={`space-y-3 ${s.sendWindowEnabled ? "" : "opacity-50 pointer-events-none"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs w-20 shrink-0" style={{ color: C.slate }}>{t("Ημέρες")}</span>
          {DAYS.map(([d, label]) => (
            <button key={d} type="button" disabled={!isOwner} onClick={() => toggleDay(d)}
              className="rounded-md px-2 py-1 text-[11px] font-medium border"
              style={{ borderColor: C.line, backgroundColor: days.includes(d) ? C.sky : C.surface, color: days.includes(d) ? "#fff" : C.slate }}>
              {t(label)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs w-20 shrink-0" style={{ color: C.slate }}>{t("Ώρες")}</span>
          <select disabled={!isOwner} value={s.sendWindowStart} onChange={(e) => update({ sendWindowStart: Number(e.target.value) })}
            className="rounded-md px-2 py-1 text-xs border bg-white" style={{ borderColor: C.line, color: C.ink }}>
            {startOpts.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
          </select>
          <span className="text-xs" style={{ color: C.slate }}>{t("έως")}</span>
          <select disabled={!isOwner} value={s.sendWindowEnd} onChange={(e) => update({ sendWindowEnd: Number(e.target.value) })}
            className="rounded-md px-2 py-1 text-xs border bg-white" style={{ borderColor: C.line, color: C.ink }}>
            {endOpts.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs w-20 shrink-0" style={{ color: C.slate }}>{t("Ζώνη ώρας")}</span>
          <input disabled={!isOwner} value={s.sendTimezone || ""} onChange={(e) => update({ sendTimezone: e.target.value })}
            placeholder="Europe/Athens"
            className="rounded-md px-2 py-1 text-xs border bg-white flex-1 min-w-[160px]" style={{ borderColor: C.line, color: C.ink }} />
        </div>
      </div>

      {/* Booking link - powers the {{booking_link}} merge token */}
      <div className="mt-4 pt-4 border-t" style={{ borderColor: C.line }}>
        <div className="text-sm font-medium mb-1" style={{ color: C.ink }}>{t("Σύνδεσμος ραντεβού")}</div>
        <p className="text-xs mb-2" style={{ color: C.slate }}>
          {t("Το link για κράτηση κλήσης (Calendly, Cal.com…). Μπες το ως {{booking_link}} σε templates, sequences ή απαντήσεις.")}
        </p>
        <input disabled={!isOwner} value={s.bookingLink || ""} onChange={(e) => update({ bookingLink: e.target.value })}
          placeholder="https://cal.com/you/30min"
          className="w-full rounded-md px-2 py-1.5 text-xs border bg-white" style={{ borderColor: C.line, color: C.ink }} />

        {/* Round-robin: extra per-rep links. When present, {{booking_link}}
            rotates across the primary + these so meetings spread across the team. */}
        {(() => {
          const links = Array.isArray(s.bookingLinks) ? s.bookingLinks : [];
          return (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-medium" style={{ color: C.slate }}>
                  {t("Round-robin (extra links)")}{links.length > 0 ? t(" · {n} στη ρότα", { n: links.length + 1 }) : ""}
                </span>
                {isOwner && links.length < 20 && (
                  <button type="button" onClick={() => update({ bookingLinks: [...links, ""] })}
                    className="text-[11px] font-medium flex items-center gap-1" style={{ color: C.sky }}>
                    <Plus size={11} /> {t("Προσθήκη link")}
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {links.map((lnk, li) => (
                  <div key={li} className="flex items-center gap-1.5">
                    <input disabled={!isOwner} value={lnk} onChange={(e) => update({ bookingLinks: links.map((x, idx) => (idx === li ? e.target.value : x)) })}
                      placeholder="https://cal.com/teammate/30min"
                      className="flex-1 rounded-md px-2 py-1.5 text-xs border bg-white" style={{ borderColor: C.line, color: C.ink }} />
                    {isOwner && (
                      <button type="button" onClick={() => update({ bookingLinks: links.filter((_, idx) => idx !== li) })} style={{ color: C.coral }}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Email tracking on/off - deliverability */}
      <div className="mt-4 pt-4 border-t" style={{ borderColor: C.line }}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium" style={{ color: C.ink }}>Email tracking</div>
          <label className="flex items-center gap-2 text-xs" style={{ color: C.slate }}>
            <input type="checkbox" disabled={!isOwner} checked={s.emailTrackingEnabled !== false}
              onChange={(e) => update({ emailTrackingEnabled: e.target.checked })} />
            {t("Ενεργό")}
          </label>
        </div>
        <p className="text-xs" style={{ color: C.slate }}>
          {s.emailTrackingEnabled !== false
            ? t("Καταγράφονται opens & clicks (open pixel + rewriting των links).")
            : t("Clean αποστολή - χωρίς open pixel και χωρίς rewriting των links, για καλύτερο deliverability. Δεν θα υπάρχουν στατιστικά open/click.")}
        </p>
      </div>

      {/* One-click unsubscribe on/off */}
      <div className="mt-4 pt-4 border-t" style={{ borderColor: C.line }}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium" style={{ color: C.ink }}>One-click unsubscribe</div>
          <label className="flex items-center gap-2 text-xs" style={{ color: C.slate }}>
            <input type="checkbox" disabled={!isOwner} checked={s.unsubscribeEnabled !== false}
              onChange={(e) => update({ unsubscribeEnabled: e.target.checked })} />
            {t("Ενεργό")}
          </label>
        </div>
        <p className="text-xs" style={{ color: C.slate }}>
          {s.unsubscribeEnabled !== false
            ? t("Προστίθεται List-Unsubscribe header + ο σύνδεσμος {{unsubscribe_link}} λειτουργεί. Συνιστάται για deliverability.")
            : t("Χωρίς List-Unsubscribe header· το {{unsubscribe_link}} αφαιρείται από το κείμενο - 100% clean 1:1 αποστολή. Πρόσεξε τη συμμόρφωση (σε bulk απαιτείται unsubscribe).")}
        </p>

        {s.unsubscribeEnabled !== false && (
          <div className="mt-3 space-y-3">
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>
                {t("Κείμενο unsubscribe στο email")} <span style={{ fontWeight: 400 }}>{t("- seed σε νέα emails· πρέπει να περιέχει {{unsubscribe_link}}")}</span>
              </label>
              <textarea disabled={!isOwner} value={s.unsubscribeText || ""} onChange={(e) => update({ unsubscribeText: e.target.value })}
                rows={3}
                className="w-full rounded-md px-2 py-1.5 text-xs border bg-white font-mono" style={{ borderColor: C.line, color: C.ink }} />
              {(s.unsubscribeText || "").indexOf("{{unsubscribe_link}}") === -1 && (
                <p className="text-[11px] mt-1" style={{ color: C.amber }}>{t("⚠ Λείπει το {{unsubscribe_link}} - ο σύνδεσμος δεν θα λειτουργεί.")}</p>
              )}
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Σελίδα επιβεβαίωσης - τίτλος")}</label>
              <input disabled={!isOwner} value={s.unsubscribeConfirmTitle || ""} onChange={(e) => update({ unsubscribeConfirmTitle: e.target.value })}
                className="w-full rounded-md px-2 py-1.5 text-xs border bg-white" style={{ borderColor: C.line, color: C.ink }} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Σελίδα επιβεβαίωσης - μήνυμα")}</label>
              <input disabled={!isOwner} value={s.unsubscribeConfirmMessage || ""} onChange={(e) => update({ unsubscribeConfirmMessage: e.target.value })}
                className="w-full rounded-md px-2 py-1.5 text-xs border bg-white" style={{ borderColor: C.line, color: C.ink }} />
            </div>
          </div>
        )}
      </div>

      {isOwner && (
        <div className="flex items-center gap-3 mt-3">
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold text-white"
            style={{ backgroundColor: C.sky, opacity: saving ? 0.7 : 1 }}>
            {saving && <Loader2 size={13} className="animate-spin" />} {t("Αποθήκευση")}
          </button>
          {msg && <span className="text-xs" style={{ color: C.slate }}>{msg}</span>}
        </div>
      )}
    </Card>
  );
}

// Owner-facing Unipile credentials (DSN + access token). The token is
// write-only: the backend never returns it, only whether one is set. Leaving
// the token blank on save keeps the current one. Lives in the main app (Team
// view) so the owner configures everything in one place.
function UnipileSettingsCard({ onSaved }) {
  const [state, setState] = useState(null);
  const [dsn, setDsn] = useState("");
  const [token, setToken] = useState("");
  const [inmailApi, setInmailApi] = useState("classic");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const s = await api.get("/linkedin/config");
      setState(s);
      setDsn(s.unipileDsn || "");
      setInmailApi(s.inmailApi || "classic");
      setOpen(!s.unipileConfigured); // auto-expand if not set up yet
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("Δεν φορτώθηκε."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setSaved(false); setErr("");
    try {
      await api.patch("/linkedin/config", { unipileDsn: dsn.trim(), unipileAccessToken: token || undefined, inmailApi });
      setToken("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
      onSaved && onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("Η αποθήκευση απέτυχε."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-1.5" style={{ color: C.ink }}>
          <Linkedin size={15} /> {t("Ρυθμίσεις Unipile")}
          {state && (
            <span className="ml-1 text-xs font-medium px-2 py-0.5 rounded-md"
              style={state.unipileConfigured ? { backgroundColor: `${C.mint}18`, color: C.mint } : { backgroundColor: C.pale, color: C.slate }}>
              {state.unipileConfigured ? t("Ρυθμισμένο ✓") : t("Δεν έχει ρυθμιστεί")}
            </span>
          )}
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs font-medium" style={{ color: C.sky }}>
          {open ? t("Απόκρυψη") : t("Επεξεργασία")}
        </button>
      </div>
      {open && (
        loading ? (
          <div className="mt-3"><Spinner label={t("Φόρτωση…")} /></div>
        ) : (
          <form onSubmit={save} className="space-y-3 mt-3">
            <p className="text-xs" style={{ color: C.slate }}>
              {t("Access token και DSN για το Unipile API. Το token αποθηκεύεται κρυπτογραφημένο και δεν εμφανίζεται ποτέ ξανά.")}
            </p>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Unipile DSN (base URL)</label>
              <input value={dsn} onChange={(e) => setDsn(e.target.value)}
                placeholder="π.χ. https://api8.unipile.com:13851"
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>
                {t("Access token")} {state?.unipileAccessTokenSet && <span style={{ color: C.mint, fontWeight: 400 }}>{t("- έχει οριστεί (κενό = ίδιο)")}</span>}
              </label>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off"
                placeholder={state?.unipileAccessTokenSet ? t("••••••••  (άφησε κενό για να μη το αλλάξεις)") : "X-API-KEY access token"}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("InMail API tier")} <span style={{ fontWeight: 400 }}>{t("- ανάλογα με το premium seat σου")}</span></label>
              <select value={inmailApi} onChange={(e) => setInmailApi(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
                <option value="classic">Classic (Premium / Sales Navigator)</option>
                <option value="sales_navigator">Sales Navigator</option>
                <option value="recruiter">Recruiter</option>
              </select>
            </div>
            {err && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{err}</p>}
            <div className="flex items-center gap-3">
              <button type="submit" disabled={busy}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
                {busy && <Loader2 size={14} className="animate-spin" />} {t("Αποθήκευση")}
              </button>
              {saved && <span className="text-xs" style={{ color: C.mint }}>{t("Αποθηκεύτηκε ✓")}</span>}
            </div>
          </form>
        )
      )}
      {!open && err && <p className="text-xs mt-2" style={{ color: C.coral }}>{err}</p>}
    </Card>
  );
}

// Owner-facing card to connect / monitor the single LinkedIn outreach account
// (Unipile). Connect opens the Unipile hosted-auth flow in a new tab (handles
// login + 2FA/checkpoint); status + daily counters are polled from /linkedin/account.
function LinkedInAccountCard({ refreshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      setData(await api.get("/linkedin/account"));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("Δεν φορτώθηκε."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function connect() {
    setBusy("connect"); setErr("");
    try {
      const r = await api.post("/linkedin/connect");
      if (r.url) window.open(r.url, "_blank", "noopener");
      else setErr(t("Δεν επιστράφηκε σύνδεσμος σύνδεσης."));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("Η σύνδεση απέτυχε."));
    } finally {
      setBusy("");
    }
  }
  async function doAction(kind, path) {
    setBusy(kind); setErr("");
    try { await api.post(path); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : t("Η ενέργεια απέτυχε.")); }
    finally { setBusy(""); }
  }
  async function disconnect() {
    if (!window.confirm(t("Αποσύνδεση του LinkedIn λογαριασμού;"))) return;
    setBusy("disconnect"); setErr("");
    try { await api.del("/linkedin/account"); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : t("Η αποσύνδεση απέτυχε.")); }
    finally { setBusy(""); }
  }

  const acc = data?.account;
  const configured = data?.configured;
  const statusColor = acc?.status === "ok" ? C.mint : acc?.status === "error" ? C.coral : C.amber;
  const statusLabel = { ok: t("Ενεργός"), checkpoint_needed: t("Χρειάζεται επαλήθευση (checkpoint)"), error: t("Σφάλμα"), paused: t("Σε παύση") }[acc?.status] || acc?.status;

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium flex items-center gap-1.5" style={{ color: C.ink }}>
          <Linkedin size={15} /> LinkedIn outreach
        </div>
        {!acc && configured && (
          <button onClick={connect} disabled={!!busy}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.6 : 1 }}>
            {busy === "connect" ? <Loader2 size={13} className="animate-spin" /> : <Linkedin size={13} />} {t("Σύνδεση λογαριασμού")}
          </button>
        )}
      </div>

      {loading ? (
        <Spinner label={t("Φόρτωση…")} />
      ) : !configured ? (
        <p className="text-xs" style={{ color: C.slate }}>
          {t("Το LinkedIn outreach δεν έχει ρυθμιστεί ακόμα από τον διαχειριστή πλατφόρμας (Unipile access token). Επικοινώνησε μαζί του για να ενεργοποιηθεί.")}
        </p>
      ) : !acc ? (
        <p className="text-xs" style={{ color: C.slate }}>
          {t("Σύνδεσε τον προσωπικό σου LinkedIn λογαριασμό για να στέλνεις αιτήματα σύνδεσης και μηνύματα μέσω sequences. Η σύνδεση γίνεται σε νέα καρτέλα (login + τυχόν 2FA).")}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-lg px-3 py-2 mb-2" style={{ backgroundColor: C.pale }}>
            <div className="text-sm" style={{ color: C.ink }}>
              <span className="font-medium" style={{ color: statusColor }}>{statusLabel}</span>
              {acc.paused && <span className="ml-2 text-xs" style={{ color: C.amber }}>{t("· σε παύση")}</span>}
              <span className="ml-2 text-xs" style={{ color: C.slate }}>
                {t("{cs}/{cm} αιτήματα · {ms}/{mm} μηνύματα · {is}/{im} InMail σήμερα", { cs: acc.connectionsSentToday, cm: acc.maxConnectionsPerDay, ms: acc.messagesSentToday, mm: acc.maxMessagesPerDay, is: acc.inmailsSentToday ?? 0, im: acc.maxInmailsPerDay ?? 0 })}
              </span>
            </div>
          </div>
          {acc.statusMessage && <p className="text-xs mb-2" style={{ color: C.slate }}>{acc.statusMessage}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => doAction("refresh", "/linkedin/account/refresh")} disabled={!!busy}
              className="rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.slate }}>
              {busy === "refresh" ? t("Ανανέωση…") : t("Ανανέωση status")}
            </button>
            {acc.paused ? (
              <button onClick={() => doAction("resume", "/linkedin/account/resume")} disabled={!!busy}
                className="rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.mint }}>
                {busy === "resume" ? "…" : t("Επανεκκίνηση")}
              </button>
            ) : (
              <button onClick={() => doAction("pause", "/linkedin/account/pause")} disabled={!!busy}
                className="rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.amber }}>
                {busy === "pause" ? "…" : t("Παύση (kill-switch)")}
              </button>
            )}
            <button onClick={connect} disabled={!!busy}
              className="rounded-lg px-3 py-1.5 text-xs font-medium border" style={{ borderColor: C.line, color: C.slate }}>
              {t("Επανασύνδεση")}
            </button>
            <button onClick={disconnect} disabled={!!busy}
              className="rounded-lg px-3 py-1.5 text-xs font-medium border ml-auto" style={{ borderColor: C.line, color: C.coral }}>
              <Trash2 size={12} className="inline" /> {t("Αποσύνδεση")}
            </button>
          </div>
        </>
      )}
      {err && <p className="text-xs mt-2" style={{ color: C.coral }}>{err}</p>}
    </Card>
  );
}

function TeamView({ members, loading, error, onReload, onInvite, onRemove, currentUserId, isOwner, invites, onInviteExisting, onRevokeInvite, onExport, gmailAccounts, onDisconnectMailbox }) {
  const [busyId, setBusyId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showExisting, setShowExisting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [mailboxBusyId, setMailboxBusyId] = useState(null);
  const [mailboxError, setMailboxError] = useState("");
  const [linkedinRefresh, setLinkedinRefresh] = useState(0);

  async function handleRemove(m) {
    if (!window.confirm(t("Αφαίρεση του/της {who} από την ομάδα;", { who: m.name || m.email }))) return;
    setBusyId(m.id);
    try {
      await onRemove(m.id);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisconnectMailbox(acc) {
    if (!window.confirm(t("Αποσύνδεση του mailbox {email}; Οι αποστολές που το χρησιμοποιούσαν θα περάσουν στα υπόλοιπα συνδεδεμένα mailbox.", { email: acc.email }))) return;
    setMailboxError("");
    setMailboxBusyId(acc.id);
    try {
      await onDisconnectMailbox(acc.id);
    } catch (err) {
      setMailboxError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η αποσύνδεση."));
    } finally {
      setMailboxBusyId(null);
    }
  }

  async function handleExport() {
    setExportError("");
    setExporting(true);
    try {
      await onExport();
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : t("Η εξαγωγή απέτυχε."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="h-full overflow-auto">
      {showNew && <NewTeammateModal onClose={() => setShowNew(false)} onInvite={onInvite} />}
      {showExisting && <InviteExistingModal onClose={() => setShowExisting(false)} onInvite={onInviteExisting} />}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{t("Ομάδα")}</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>{t("Οι συνεργάτες στο workspace σου - μοιράζεστε τις ίδιες επαφές και το ίδιο Gmail.")}</p>
        </div>
        {isOwner && (
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={handleExport} disabled={exporting} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border" style={{ borderColor: C.line, color: C.ink, opacity: exporting ? 0.7 : 1 }}>
              {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {t("Εξαγωγή δεδομένων")}
            </button>
            <button onClick={() => setShowExisting(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border" style={{ borderColor: C.line, color: C.ink }}>
              <UserPlus size={15} /> {t("Υπάρχων χρήστης")}
            </button>
            <button onClick={() => setShowNew(true)} className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
              <UserPlus size={15} /> {t("Πρόσκληση")}
            </button>
          </div>
        )}
      </div>
      <div className="px-8 py-6">
        <ErrorNote message={exportError} />
        <ErrorNote message={error} onRetry={onReload} />
        <SendWindowCard isOwner={isOwner} />
        {isOwner && invites?.length > 0 && (
          <Card className="p-4 mb-4">
            <div className="text-sm font-medium mb-3" style={{ color: C.ink }}>{t("Εκκρεμείς προσκλήσεις")}</div>
            <div className="space-y-2">
              {invites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                  <div className="text-sm" style={{ color: C.ink }}>
                    {inv.email} <span style={{ color: C.slate }}>- {inv.role === "owner" ? t("Ιδιοκτήτης") : t("Μέλος")} · {fmtDate(inv.createdAt)}</span>
                  </div>
                  <button onClick={() => onRevokeInvite(inv.id)} title={t("Ανάκληση")} style={{ color: C.coral }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        )}
        {isOwner && (
          <Card className="p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium" style={{ color: C.ink }}>{t("Συνδεδεμένα mailbox")}</div>
              <a
                href={`${API_URL}/auth/google`}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                style={{ backgroundColor: C.sky }}
              >
                <Mail size={13} /> {t("Σύνδεση mailbox")}
              </a>
            </div>
            <p className="text-xs mb-3" style={{ color: C.slate }}>
              {t("Οι αποστολές μοιράζονται αυτόματα ανάμεσα σε όλα τα συνδεδεμένα mailbox - περισσότερα mailbox σημαίνουν μεγαλύτερη ημερήσια χωρητικότητα αποστολών.")}
            </p>
            <ErrorNote message={mailboxError} />
            {(!gmailAccounts || gmailAccounts.length === 0) ? (
              <p className="text-sm" style={{ color: C.slate }}>{t("Δεν έχει συνδεθεί κανένα mailbox ακόμα.")}</p>
            ) : (
              <div className="space-y-1.5">
                {gmailAccounts.map((acc) => (
                  <div key={acc.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                    <div className="text-sm" style={{ color: C.ink }}>
                      {acc.email}
                      <span className="ml-2 text-xs" style={{ color: acc.needsReconnect ? C.coral : C.slate }}>
                        {acc.needsReconnect ? t("χρειάζεται επανασύνδεση") : t("{sent}/{cap} σήμερα", { sent: acc.sentToday, cap: acc.dailyCap })}
                      </span>
                    </div>
                    <button
                      disabled={mailboxBusyId === acc.id}
                      onClick={() => handleDisconnectMailbox(acc)}
                      title={t("Αποσύνδεση")}
                      style={{ color: C.coral, opacity: mailboxBusyId === acc.id ? 0.6 : 1 }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
        {isOwner && (
          <>
            <UnipileSettingsCard onSaved={() => setLinkedinRefresh((n) => n + 1)} />
            <LinkedInAccountCard refreshKey={linkedinRefresh} />
          </>
        )}
        {loading ? (
          <Spinner label={t("Φόρτωση ομάδας…")} />
        ) : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate, backgroundColor: C.pale }}>
                    <th className="font-medium px-4 py-2.5">{t("Συνεργάτης")}</th>
                    <th className="font-medium px-4 py-2.5">{t("Ρόλος")}</th>
                    <th className="font-medium px-4 py-2.5">{t("Εγγραφή")}</th>
                    {isOwner && <th className="font-medium px-4 py-2.5 text-right">{t("Ενέργειες")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} className="border-t" style={{ borderColor: C.line }}>
                      <td className="px-4 py-3">
                        <div className="font-medium" style={{ color: C.ink }}>{m.name || "-"}</div>
                        <div className="text-xs" style={{ color: C.slate }}>{m.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        {m.role === "owner" ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: C.navy }}><ShieldCheck size={13} /> {t("Ιδιοκτήτης")}</span>
                        ) : (
                          <span className="text-xs" style={{ color: C.slate }}>{t("Μέλος")}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: C.slate }}>{fmtDate(m.createdAt)}</td>
                      {isOwner && (
                        <td className="px-4 py-3 text-right">
                          {m.role !== "owner" && m.id !== currentUserId && (
                            <button disabled={busyId === m.id} onClick={() => handleRemove(m)} title={t("Αφαίρεση")}
                              className="rounded-md p-1.5" style={{ color: C.coral }}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </td>
                      )}
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

// Owner-only management of inbound lead sources: generic webhook tokens
// (WordPress form plugins, Zapier/Make, any leadgen tool with an outgoing
// webhook) and connected Meta Lead Ads pages (direct Graph API integration -
// see routes/integrations.js). Non-owners see a locked message, same
// treatment as the mailbox section inside TeamView.
function IntegrationsView({ data, loading, error, onReload, isOwner, onCreateWebhook, onRotateWebhook, onDeleteWebhook, onConnectMeta, onDisconnectMeta, linkedinPendingConnect, onFinalizeLinkedIn, onDisconnectLinkedIn, recentLeads, onLoadRecentLeads }) {
  const [newWebhookName, setNewWebhookName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [metaForm, setMetaForm] = useState({ pageId: "", pageName: "", pageAccessToken: "" });
  const [linkedinForm, setLinkedinForm] = useState({ organizationUrn: "", organizationName: "" });
  const [showRecent, setShowRecent] = useState(false);

  const webhooks = data?.webhooks || [];
  const metaConnections = data?.metaConnections || [];
  const linkedinConnections = data?.linkedinConnections || [];

  function webhookUrl(token) {
    return `${API_URL}/integrations/inbound/${token}`;
  }

  async function copyUrl(id, token) {
    try {
      await navigator.clipboard.writeText(webhookUrl(token));
      setCopiedId(id);
      setTimeout(() => setCopiedId(""), 1500);
    } catch {
      // Clipboard API can fail silently on some browsers/permissions -
      // the URL is still visible in the row, just not auto-copied.
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    setActionError("");
    setBusy(true);
    try {
      await onCreateWebhook(newWebhookName.trim());
      setNewWebhookName("");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η δημιουργία."));
    } finally {
      setBusy(false);
    }
  }

  async function handleRotate(id) {
    if (!window.confirm(t("Η παλιά διεύθυνση θα σταματήσει να δουλεύει - θα χρειαστεί να ενημερώσεις τη φόρμα/plugin με τη νέα. Συνέχεια;"))) return;
    setActionError("");
    try {
      await onRotateWebhook(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η ανανέωση."));
    }
  }

  async function handleDelete(id) {
    if (!window.confirm(t("Διαγραφή αυτού του webhook; Η φόρμα/plugin που το χρησιμοποιεί θα σταματήσει να στέλνει leads."))) return;
    setActionError("");
    try {
      await onDeleteWebhook(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η διαγραφή."));
    }
  }

  async function handleConnectMeta(e) {
    e.preventDefault();
    if (!metaForm.pageId.trim() || !metaForm.pageAccessToken.trim()) return;
    setActionError("");
    setBusy(true);
    try {
      await onConnectMeta(metaForm);
      setMetaForm({ pageId: "", pageName: "", pageAccessToken: "" });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η σύνδεση."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnectMeta(id) {
    if (!window.confirm(t("Αποσύνδεση αυτής της σελίδας Meta; Νέα leads από αυτήν δεν θα καταγράφονται πια."))) return;
    setActionError("");
    try {
      await onDisconnectMeta(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η αποσύνδεση."));
    }
  }

  async function handleFinalizeLinkedIn(e) {
    e.preventDefault();
    if (!linkedinForm.organizationUrn.trim()) return;
    setActionError("");
    setBusy(true);
    try {
      await onFinalizeLinkedIn(linkedinForm);
      setLinkedinForm({ organizationUrn: "", organizationName: "" });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η ολοκλήρωση της σύνδεσης."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnectLinkedIn(id) {
    if (!window.confirm(t("Αποσύνδεση αυτού του LinkedIn organization; Νέα leads από αυτό δεν θα καταγράφονται πια."))) return;
    setActionError("");
    try {
      await onDisconnectLinkedIn(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η αποσύνδεση."));
    }
  }

  async function toggleRecent() {
    if (!showRecent) await onLoadRecentLeads();
    setShowRecent(!showRecent);
  }

  if (!isOwner) {
    return (
      <div className="h-full overflow-auto">
        <div className="px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Integrations</h1>
        </div>
        <div className="px-8 py-16 flex flex-col items-center gap-2 text-sm" style={{ color: C.slate }}>
          <ShieldCheck size={28} strokeWidth={1.5} />
          {t("Μόνο ο ιδιοκτήτης της εταιρείας μπορεί να διαχειριστεί τα integrations.")}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="px-8 py-5 border-b sticky top-0 z-20" style={{ borderColor: C.line, backgroundColor: C.canvas }}>
        <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Integrations</h1>
        <p className="text-sm mt-0.5" style={{ color: C.slate }}>{t("Αυτόματη εισαγωγή επαφών από WordPress, φόρμες leadgen και Meta Lead Ads.")}</p>
      </div>
      <div className="px-8 py-4 space-y-6 max-w-3xl">
        <ErrorNote message={error || actionError} onRetry={error ? onReload : undefined} />

        <Card className="p-5">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-semibold" style={{ color: C.ink }}>{t("Γενικό webhook (WordPress / φόρμες / Zapier)")}</div>
          </div>
          <p className="text-xs mb-3" style={{ color: C.slate }}>
            {t("Δημιούργησε μία διεύθυνση ανά φόρμα/site και βάλε την ως \"webhook URL\" στο plugin σου (π.χ. WP Webhooks, Gravity Forms, Fluent Forms, Zapier/Make). Κάθε POST με email δημιουργεί ή ενημερώνει μια επαφή.")}
          </p>
          {loading ? (
            <Spinner label={t("Φόρτωση…")} />
          ) : (
            <>
              {webhooks.length > 0 && (
                <div className="space-y-2 mb-4">
                  {webhooks.map((w) => (
                    <div key={w.id} className="rounded-lg px-3 py-2.5" style={{ backgroundColor: C.pale }}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{w.name || t("Χωρίς όνομα")}</div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => copyUrl(w.id, w.token)} title={t("Αντιγραφή URL")} className="rounded-md p-1.5" style={{ color: C.sky }}>
                            <Copy size={14} />
                          </button>
                          <button onClick={() => handleRotate(w.id)} title={t("Ανανέωση token")} className="rounded-md p-1.5" style={{ color: C.slate }}>
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => handleDelete(w.id)} title={t("Διαγραφή")} className="rounded-md p-1.5" style={{ color: C.coral }}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="text-xs mt-1 font-mono truncate" style={{ color: C.slate }}>{webhookUrl(w.token)}</div>
                      {copiedId === w.id && <div className="text-xs mt-1" style={{ color: C.sky }}>{t("Αντιγράφηκε!")}</div>}
                      <div className="text-xs mt-1" style={{ color: C.slate }}>
                        {w.receivedCount} leads {w.lastReceivedAt ? t("· τελευταίο {d}", { d: fmtDate(w.lastReceivedAt) }) : t("· κανένα ακόμα")}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={handleCreate} className="flex items-center gap-2">
                <input
                  value={newWebhookName}
                  onChange={(e) => setNewWebhookName(e.target.value)}
                  placeholder={t("Ετικέτα (π.χ. WordPress site)")}
                  className="flex-1 rounded-lg border px-3 py-2 text-sm"
                  style={{ borderColor: C.line }}
                />
                <button
                  disabled={busy}
                  type="submit"
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white shrink-0"
                  style={{ backgroundColor: C.sky, opacity: busy ? 0.6 : 1 }}
                >
                  <Plus size={14} /> {t("Νέο webhook")}
                </button>
              </form>
            </>
          )}
        </Card>

        <Card className="p-5">
          <div className="text-sm font-semibold mb-1" style={{ color: C.ink }}>Meta Lead Ads</div>
          <p className="text-xs mb-3" style={{ color: C.slate }}>
            {t("Απευθείας σύνδεση σελίδας Facebook/Instagram μέσω Graph API. Χρειάζεται το Page ID και ένα Page Access Token με δικαίωμα leads_retrieval - δες το SETUP.md για τα βήματα δημιουργίας Meta App.")}
          </p>
          {metaConnections.length > 0 && (
            <div className="space-y-2 mb-4">
              {metaConnections.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2.5" style={{ backgroundColor: C.pale }}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{c.pageName || c.pageId}</div>
                    <div className="text-xs" style={{ color: C.slate }}>
                      {c.receivedCount} leads {c.lastReceivedAt ? t("· τελευταίο {d}", { d: fmtDate(c.lastReceivedAt) }) : t("· κανένα ακόμα")}
                    </div>
                  </div>
                  <button onClick={() => handleDisconnectMeta(c.id)} title={t("Αποσύνδεση")} className="rounded-md p-1.5 shrink-0" style={{ color: C.coral }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <form onSubmit={handleConnectMeta} className="space-y-2">
            <input
              value={metaForm.pageId}
              onChange={(e) => setMetaForm({ ...metaForm, pageId: e.target.value })}
              placeholder="Page ID"
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: C.line }}
            />
            <input
              value={metaForm.pageName}
              onChange={(e) => setMetaForm({ ...metaForm, pageName: e.target.value })}
              placeholder={t("Όνομα σελίδας (προαιρετικό)")}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: C.line }}
            />
            <input
              value={metaForm.pageAccessToken}
              onChange={(e) => setMetaForm({ ...metaForm, pageAccessToken: e.target.value })}
              placeholder="Page Access Token"
              type="password"
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: C.line }}
            />
            <button
              disabled={busy}
              type="submit"
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white"
              style={{ backgroundColor: C.sky, opacity: busy ? 0.6 : 1 }}
            >
              <Plus size={14} /> {t("Σύνδεση σελίδας")}
            </button>
          </form>
        </Card>

        <Card className="p-5">
          <div className="text-sm font-semibold mb-1" style={{ color: C.ink }}>LinkedIn Lead Gen Forms</div>
          <p className="text-xs mb-3" style={{ color: C.slate }}>
            {t("Απευθείας σύνδεση μέσω LinkedIn's Lead Sync API. Χρειάζεται έγκριση από το LinkedIn (Lead Sync API access) πριν λειτουργήσει για πραγματικά organizations - δες το SETUP.md. Μέχρι τότε η σύνδεση αποθηκεύεται αλλά δεν θα λαμβάνει leads.")}
          </p>
          {linkedinConnections.length > 0 && (
            <div className="space-y-2 mb-4">
              {linkedinConnections.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2.5" style={{ backgroundColor: C.pale }}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{c.organizationName || c.organizationUrn}</div>
                    <div className="text-xs" style={{ color: c.needsReconnect ? C.coral : C.slate }}>
                      {c.needsReconnect
                        ? t("χρειάζεται επανασύνδεση")
                        : `${c.receivedCount} leads ${c.lastReceivedAt ? t("· τελευταίο {d}", { d: fmtDate(c.lastReceivedAt) }) : t("· κανένα ακόμα")}`}
                    </div>
                  </div>
                  <button onClick={() => handleDisconnectLinkedIn(c.id)} title={t("Αποσύνδεση")} className="rounded-md p-1.5 shrink-0" style={{ color: C.coral }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {linkedinPendingConnect ? (
            <form onSubmit={handleFinalizeLinkedIn} className="space-y-2">
              <p className="text-xs" style={{ color: C.sky }}>{t("Η σύνδεση με το LinkedIn έγινε - πρόσθεσε το Organization URN για να ολοκληρωθεί.")}</p>
              <input
                value={linkedinForm.organizationUrn}
                onChange={(e) => setLinkedinForm({ ...linkedinForm, organizationUrn: e.target.value })}
                placeholder={t("Organization URN (π.χ. urn:li:organization:12345)")}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ borderColor: C.line }}
              />
              <input
                value={linkedinForm.organizationName}
                onChange={(e) => setLinkedinForm({ ...linkedinForm, organizationName: e.target.value })}
                placeholder={t("Όνομα (προαιρετικό)")}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ borderColor: C.line }}
              />
              <button
                disabled={busy}
                type="submit"
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white"
                style={{ backgroundColor: C.sky, opacity: busy ? 0.6 : 1 }}
              >
                <Plus size={14} /> {t("Ολοκλήρωση σύνδεσης")}
              </button>
            </form>
          ) : (
            <a
              href={`${API_URL}/integrations/linkedin/connect`}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white w-fit"
              style={{ backgroundColor: C.sky }}
            >
              <Globe size={14} /> {t("Σύνδεση LinkedIn")}
            </a>
          )}
        </Card>

        <div>
          <button onClick={toggleRecent} className="text-sm font-medium flex items-center gap-1.5" style={{ color: C.sky }}>
            <ChevronRight size={14} style={{ transform: showRecent ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
            {t("Πρόσφατα leads (debug)")}
          </button>
          {showRecent && (
            <div className="mt-2 space-y-1">
              {(!recentLeads || recentLeads.length === 0) ? (
                <p className="text-sm" style={{ color: C.slate }}>{t("Δεν έχει καταγραφεί κανένα lead ακόμα.")}</p>
              ) : (
                recentLeads.map((l) => (
                  <div key={l.id} className="text-xs px-3 py-2 rounded-lg" style={{ backgroundColor: C.pale, color: C.ink }}>
                    {l.summary} <span style={{ color: C.slate }}>· {fmtDate(l.createdAt)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Shown right after login/reload whenever the current account has one or
// more pending CompanyInvites (see routes/team.js#invite-existing) - i.e.
// someone already added them by email and is waiting on a yes/no. "Αργότερα"
// just hides it for this session (the invite is still pending and will show
// again next login); Accept/Decline actually resolve it server-side.
function InviteResponseModal({ invites, onAccept, onDecline, onDismiss }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  async function respond(id, fn) {
    setError("");
    setBusyId(id);
    try {
      await fn(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Η ενέργεια απέτυχε."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>{t("Προσκλήσεις σε εταιρείες")}</h3>
          <button onClick={onDismiss} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <p className="text-xs mb-4" style={{ color: C.slate }}>{t("Κάποιος σε προσκάλεσε να μπεις στην ομάδα τους.")}</p>
        {error && <p className="text-xs rounded-lg px-3 py-2 mb-3" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
        <div className="space-y-2">
          {invites.map((inv) => (
            <div key={inv.id} className="rounded-lg px-3 py-3" style={{ backgroundColor: C.pale }}>
              <div className="text-sm font-medium" style={{ color: C.ink }}>{inv.companyName}</div>
              <div className="text-xs mt-0.5" style={{ color: C.slate }}>
                {t("Ρόλος:")} {inv.role === "owner" ? t("Ιδιοκτήτης") : t("Μέλος")}{inv.invitedByName ? t(" · από {who}", { who: inv.invitedByName }) : ""}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  disabled={busyId === inv.id}
                  onClick={() => respond(inv.id, onAccept)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                  style={{ backgroundColor: C.mint, opacity: busyId === inv.id ? 0.7 : 1 }}
                >
                  <CircleCheck size={13} /> {t("Αποδοχή")}
                </button>
                <button
                  disabled={busyId === inv.id}
                  onClick={() => respond(inv.id, onDecline)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border"
                  style={{ borderColor: C.line, color: C.slate }}
                >
                  <CircleX size={13} /> {t("Απόρριψη")}
                </button>
              </div>
            </div>
          ))}
        </div>
        <button onClick={onDismiss} className="w-full text-center text-xs mt-4" style={{ color: C.slate }}>{t("Αργότερα")}</button>
      </Card>
    </div>
  );
}

// ---------- App ----------
export default function App() {
  // Subscribe to the language store so a switch re-renders the whole tree and
  // every t() call re-evaluates (see lib/i18n.jsx).
  useLang();
  // Subscribe to the theme store so a light/dark toggle re-renders the tree and
  // every C.* (theme-aware Proxy) re-reads (see lib/ui.jsx).
  useTheme();
  const [authState, setAuthState] = useState("loading"); // loading | anon | authed
  const [user, setUser] = useState(null);
  const [view, setView] = useState("dashboard");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeContactId, setComposeContactId] = useState("");
  const [pendingOpenContactId, setPendingOpenContactId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  const [dashboard, setDashboard] = useState({ followUps: [], sends: [], counts: { followUps: 0, sends: 0 } });
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");

  // Exact sidebar-badge counts from cheap COUNT queries (GET /dashboard/summary),
  // so the badges are accurate (not capped by list page size) and show up
  // immediately instead of waiting on every full list to load. `counts` below
  // reads this first and falls back to list lengths until it arrives.
  const [summary, setSummary] = useState(null);

  const [integrations, setIntegrations] = useState({ webhooks: [], metaConnections: [], linkedinConnections: [] });
  const [integrationsLoading, setIntegrationsLoading] = useState(false);
  const [integrationsError, setIntegrationsError] = useState("");
  const [recentLeads, setRecentLeads] = useState([]);
  const [linkedinPendingConnect, setLinkedinPendingConnect] = useState(false);

  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");

  // My own company's teammates - visible to everyone on the team; only an
  // "owner" gets invite/remove actions (see TeamView).
  const [teamMembers, setTeamMembers] = useState([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState("");
  // Invites THIS company has sent to existing accounts, still awaiting a
  // response - separate from teamMembers above (those are actual
  // Memberships; these are still pending). Owner-only, so left empty (and
  // never fetched) for a regular member.
  const [teamInvites, setTeamInvites] = useState([]);
  const [inviteBannerDismissed, setInviteBannerDismissed] = useState(false);

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
      // /contacts returns a paginated object ({ contacts, total, dueCount, ... }),
      // not a bare array - extract the rows. Request the max page so the
      // recipient pickers / category+tag facets built from this list aren't
      // truncated to the default page size. (Defensive: also accept a bare
      // array in case the endpoint shape changes back.)
      const res = await api.get("/contacts?pageSize=200");
      setContacts(Array.isArray(res) ? res : res.contacts || []);
    } catch (err) {
      setContactsError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν οι επαφές."));
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
      setSequencesError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα sequences."));
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
      setAnalyticsError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα analytics."));
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
      setActivityError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκε η δραστηριότητα."));
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    setDashboardError("");
    try {
      setDashboard(await api.get("/dashboard/due-today"));
    } catch (err) {
      setDashboardError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα σημερινά."));
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  // Cheap counts for the sidebar badges - fetched on its own so the badges can
  // render before the heavy lists do. Silent on failure (badges just fall back
  // to list lengths).
  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.get("/dashboard/summary"));
    } catch {
      /* non-critical - counts fall back to list lengths */
    }
  }, []);

  const loadIntegrations = useCallback(async () => {
    setIntegrationsLoading(true);
    setIntegrationsError("");
    try {
      setIntegrations(await api.get("/integrations"));
    } catch (err) {
      setIntegrationsError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα integrations."));
    } finally {
      setIntegrationsLoading(false);
    }
  }, []);

  const loadRecentLeads = useCallback(async () => {
    try {
      setRecentLeads(await api.get("/integrations/recent-leads"));
    } catch {
      setRecentLeads([]);
    }
  }, []);

  async function handleCreateWebhook(name) {
    await api.post("/integrations", { name });
    await loadIntegrations();
  }

  async function handleRotateWebhook(id) {
    await api.post(`/integrations/${id}/rotate`, {});
    await loadIntegrations();
  }

  async function handleDeleteWebhook(id) {
    await api.del(`/integrations/${id}`);
    await loadIntegrations();
  }

  async function handleConnectMeta({ pageId, pageName, pageAccessToken }) {
    await api.post("/integrations/meta/connections", { pageId, pageName, pageAccessToken });
    await loadIntegrations();
  }

  async function handleDisconnectMeta(id) {
    await api.del(`/integrations/meta/connections/${id}`);
    await loadIntegrations();
  }

  async function handleFinalizeLinkedIn({ organizationUrn, organizationName }) {
    await api.post("/integrations/linkedin/finalize", { organizationUrn, organizationName });
    setLinkedinPendingConnect(false);
    await loadIntegrations();
  }

  async function handleDisconnectLinkedIn(id) {
    await api.del(`/integrations/linkedin/connections/${id}`);
    await loadIntegrations();
  }

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError("");
    try {
      setTemplates(await api.get("/templates"));
    } catch (err) {
      setTemplatesError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα templates."));
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadTeam = useCallback(async () => {
    setTeamLoading(true);
    setTeamError("");
    try {
      setTeamMembers(await api.get("/team"));
      // Only an owner can see/manage pending invites (GET /team/invites is
      // owner-only) - a plain 403 here for a regular member is expected, not
      // an error worth surfacing.
      try {
        setTeamInvites(await api.get("/team/invites"));
      } catch {
        setTeamInvites([]);
      }
    } catch (err) {
      setTeamError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκε η ομάδα."));
    } finally {
      setTeamLoading(false);
    }
  }, []);

  const loadOffers = useCallback(async () => {
    setOffersLoading(true);
    setOffersError("");
    try {
      // /offers returns a paginated object ({ offers, total, ... }), not a bare
      // array - extract the rows (the offers board calls .filter/.map on this).
      const res = await api.get("/offers?pageSize=200");
      setOffers(Array.isArray(res) ? res : res.offers || []);
    } catch (err) {
      setOffersError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν οι προσφορές."));
    } finally {
      setOffersLoading(false);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    setCampaignsError("");
    try {
      // /campaigns returns a paginated object ({ campaigns, total, ... }), not
      // a bare array - extract the rows (dashboard stats + list render call
      // .filter/.map on this). Max page size so counts aren't truncated.
      const res = await api.get("/campaigns?pageSize=200");
      setCampaigns(Array.isArray(res) ? res : res.campaigns || []);
    } catch (err) {
      setCampaignsError(err instanceof ApiError ? err.message : t("Δεν φορτώθηκαν τα campaigns."));
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  // Loaded once on login: the dashboard's own data, plus the broadly-shared
  // lists that many tabs read (contact pickers, sequence/enroll dropdowns,
  // template insert). Everything else - analytics, inbox, offers, campaigns,
  // integrations, team - is fetched only when its tab is opened (see the
  // view-gated effect below), so login fires ~5 requests instead of ~10. That
  // matters most right after a cold start, when the backend is still waking up.
  const loadCore = useCallback(() => {
    loadSummary();
    loadDashboard();
    loadContacts();
    loadSequences();
    loadTemplates();
  }, [loadSummary, loadDashboard, loadContacts, loadSequences, loadTemplates]);

  // Session check on mount, plus handling the redirect back from Google OAuth
  // (?gmail_connected=1|0) without leaving it sitting in the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailConnected = params.get("gmail_connected");
    if (gmailConnected !== null) {
      if (gmailConnected === "1") toast.success(t("Το Gmail συνδέθηκε."));
      else toast.error(t("Η σύνδεση Gmail απέτυχε ή ακυρώθηκε."));
      params.delete("gmail_connected");
      params.delete("reason");
      const clean = window.location.pathname + (params.toString() ? `?${params}` : "");
      window.history.replaceState({}, "", clean);
    }

    // Same idea for the LinkedIn OAuth redirect (?linkedin_connected=pending|0)
    // - "pending" means the token exchange succeeded but the connection still
    // needs an organization URN to attach to (see routes/integrations.js's
    // /linkedin/finalize), so send the owner straight to the Integrations tab
    // to finish that step rather than leaving them on whatever tab they left.
    const linkedinConnected = params.get("linkedin_connected");
    if (linkedinConnected !== null) {
      if (linkedinConnected === "pending") {
        setLinkedinPendingConnect(true);
        setView("integrations");
      } else if (linkedinConnected === "0") {
        toast.error(t("Η σύνδεση LinkedIn απέτυχε ή ακυρώθηκε."));
      }
      params.delete("linkedin_connected");
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
    if (authState === "authed") loadCore();
  }, [authState, loadCore]);

  // Global keyboard shortcuts (only while authed): ⌘/Ctrl+K focuses the sidebar
  // search; plain "C" opens compose. Both are ignored while the user is typing
  // in a field or a modal-style overlay so they never hijack normal input.
  useEffect(() => {
    if (authState !== "authed") return;
    function isTyping() {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "c" || e.key === "C") && !isTyping()) {
        e.preventDefault();
        setComposeOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authState]);

  // Load the workspace's editable unsubscribe footer once, so new draft bodies
  // (compose, sequence steps, campaigns, templates) seed from the configured
  // text instead of the hardcoded default. Best-effort - falls back silently.
  useEffect(() => {
    if (authState !== "authed") return;
    api.get("/company/settings")
      .then((s) => { if (s?.unsubscribeText) setUnsubscribeSeed(s.unsubscribeText); })
      .catch(() => {});
  }, [authState]);

  // Analytics/Inbox numbers otherwise only change on the actions we happen to
  // remember to refresh after (see handleManualSend etc. above) - that misses
  // tracking events (opens/clicks/unsubscribes) which land asynchronously
  // whenever the recipient acts, with no corresponding frontend call at all.
  // Re-pull the relevant data the moment the user actually looks at that tab,
  // plus a background poll everywhere else so the sidebar counts and the
  // Analytics stat board stay current without needing a manual reload.
  useEffect(() => {
    if (authState !== "authed") return;
    // First open of a tab loads its data (it's no longer fetched upfront on
    // login); re-opening it refreshes so background changes (tracking events,
    // scheduler progress) look live.
    if (view === "analytics") loadAnalytics();
    if (view === "inbox") loadActivity();
    if (view === "dashboard") loadDashboard();
    if (view === "integrations") loadIntegrations();
    if (view === "offers") loadOffers();
    if (view === "team") loadTeam();
    // Running campaigns send in the background via the scheduler, one
    // recipient at a time - reload whenever this tab is actually open so
    // progress (sent/pending counts) looks live rather than stuck at
    // whatever it was on last page load.
    if (view === "campaigns") loadCampaigns();
  }, [view, authState, loadAnalytics, loadActivity, loadDashboard, loadIntegrations, loadOffers, loadTeam, loadCampaigns]);

  // Gated on whichever tab is actually open - this used to unconditionally
  // refresh analytics/activity/dashboard/campaigns every tick regardless of
  // which view the user was looking at, so e.g. someone sitting on Contacts
  // all day still triggered a full Analytics reload every 90s for nobody.
  // Same per-view conditions as the "view changed" effect above, just also
  // applied on a timer and on tab refocus.
  useEffect(() => {
    if (authState !== "authed") return;
    const id = setInterval(() => {
      // Skip the round-trip entirely while the tab isn't visible (switched
      // away, minimized, different tab focused) - there's no one looking at
      // the result, so it was just burning requests/battery every tick for
      // nothing. Whatever's stale gets refreshed as soon as the tab is
      // focused again via the visibilitychange listener below.
      if (document.hidden) return;
      if (view === "analytics") loadAnalytics();
      if (view === "inbox") loadActivity();
      if (view === "dashboard") loadDashboard();
      if (view === "campaigns") loadCampaigns();
    }, 90000); // was 30s - 90s cuts request volume/egress 3x with no real loss of freshness
    return () => clearInterval(id);
  }, [authState, view, loadAnalytics, loadActivity, loadDashboard, loadCampaigns]);

  useEffect(() => {
    if (authState !== "authed") return;
    function handleVisibilityChange() {
      if (document.hidden) return;
      if (view === "analytics") loadAnalytics();
      if (view === "inbox") loadActivity();
      if (view === "dashboard") loadDashboard();
      if (view === "campaigns") loadCampaigns();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [authState, view, loadAnalytics, loadActivity, loadDashboard, loadCampaigns]);

  async function handleLogout() {
    try {
      await api.post("/auth/logout");
    } catch {
      // Even if the request fails, drop the client-side session state -
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
    setOffers([]);
    setCampaigns([]);
  }

  // Switching companies changes literally every piece of company-scoped
  // state on this page (contacts, sequences, templates, offers, campaigns,
  // gmail connection...) - rather than carefully resetting each one here and
  // risking something stale slipping through, a full reload re-runs the
  // normal auth-gated load path from scratch against the new session
  // (session.activeCompanyId is set server-side first, so the reload's
  // /auth/me + subsequent loads all reflect the newly active company).
  async function handleSwitchCompany(companyId) {
    if (!companyId || companyId === user?.company?.id) return;
    try {
      await api.post("/auth/switch-company", { companyId });
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Δεν ήταν δυνατή η αλλαγή εταιρείας."));
    }
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

  // Stable reference on purpose (useCallback with no deps): this is passed
  // down as ContactDetailDrawer's onLoad prop, which its own `load`
  // useCallback depends on. Before this was memoized, a brand-new function
  // was created here on every App render (e.g. the 30s background poll
  // updating analytics/activity/campaigns elsewhere) - that changed `load`'s
  // identity too, re-firing its effect and silently overwriting whatever the
  // user was mid-typing in the contact edit form. Now it only reloads when
  // contactId actually changes (a different contact opened).
  const handleLoadContactDetail = useCallback((id) => api.get(`/contacts/${id}`), []);

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
    // Deferred: the actual delete only fires after the Undo window closes.
    toastUndo(
      t("Διαγράφηκαν {n} επαφές.", { n: ids.length }),
      async () => { await api.post("/contacts/bulk-delete", { ids }); await loadContacts(); },
      { undoLabel: t("Αναίρεση") }
    );
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
    toastUndo(
      t("Η προσφορά διαγράφηκε."),
      async () => { await api.del(`/offers/${id}`); await loadOffers(); },
      { undoLabel: t("Αναίρεση") }
    );
  }

  async function handleEnroll(contactIds, sequenceId) {
    const r = await api.post(`/sequences/${sequenceId}/enroll`, { contactIds });
    await Promise.all([loadContacts(), loadSequences()]);
    if (r && typeof r.enrolled === "number") {
      toast.success(
        r.skipped
          ? t("Εγγράφηκαν {n}, παραλείφθηκαν {s}.", { n: r.enrolled, s: r.skipped })
          : t("Εγγράφηκαν {n} επαφές.", { n: r.enrolled })
      );
    }
    return r;
  }

  async function handleCreateSequence(data) {
    await api.post("/sequences", data);
    await loadSequences();
    toast.success(t("Το sequence δημιουργήθηκε."));
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

  async function handleTestSendStep(sequenceId, stepId, testEmail, subject) {
    await api.post(`/sequences/${sequenceId}/steps/${stepId}/test-send`, { testEmail, subject });
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
    toastUndo(
      t("Το template διαγράφηκε."),
      async () => { await api.del(`/templates/${id}`); await loadTemplates(); },
      { undoLabel: t("Αναίρεση") }
    );
  }

  async function handleManualSend(data) {
    await api.post("/send", data);
    // Sends move the sent/opened/reply counts on the Analytics board and the
    // Inbox list - refresh both immediately instead of waiting for a tab
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
    toastUndo(
      t("Το campaign διαγράφηκε."),
      async () => { await api.del(`/campaigns/${campaignId}`); await loadCampaigns(); },
      { undoLabel: t("Αναίρεση") }
    );
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
    // Marking replied pauses the contact's active sequences server-side. Nudge
    // the rep toward the highest-value next step: reply with the booking link.
    toast.success(t("Σημειώθηκε ως απάντηση - το sequence σταμάτησε. Στείλε τον σύνδεσμο ραντεβού για κλείσιμο."));
  }

  async function handleToggleUnsubscribed(contactId, next) {
    await api.patch(`/contacts/${contactId}`, { unsubscribed: next });
    await Promise.all([loadContacts(), loadAnalytics()]);
  }

  // Freeform personalization notes, editable straight from the contact
  // drawer - no contacts list refresh needed since comments aren't shown in
  // the table, only used as {{comments}} merge content when composing.
  async function handleUpdateComments(contactId, comments) {
    await api.patch(`/contacts/${contactId}`, { comments });
  }

  // Private, internal-only notes - same no-list-refresh rationale as
  // comments (not shown in the contacts table), kept as its own handler so
  // it's clear this field is never used as a merge tag / sent in an email.
  async function handleUpdateInternalNotes(contactId, internalNotes) {
    await api.patch(`/contacts/${contactId}`, { internalNotes });
  }

  // Editing name/phone/company/category/tags from the contact drawer. Unlike
  // comments, these fields ARE shown in the contacts table, so refresh the
  // list too - PATCH only ever touches the Contact row itself, so send
  // history/notes/offers are untouched by this.
  async function handleUpdateContact(contactId, data) {
    await api.patch(`/contacts/${contactId}`, data);
    await loadContacts();
  }

  function handleSelectFromSearch(contactId) {
    setView("contacts");
    setPendingOpenContactId(contactId);
    setSidebarOpen(false);
  }

  async function handleInviteTeammate(data) {
    await api.post("/team", data);
    await loadTeam();
  }
  async function handleRemoveTeammate(id) {
    await api.del(`/team/${id}`);
    await loadTeam();
  }
  async function handleInviteExistingTeammate(data) {
    await api.post("/team/invite-existing", data);
    await loadTeam();
  }
  async function handleRevokeInvite(id) {
    await api.del(`/team/invites/${id}`);
    await loadTeam();
  }
  async function handleExportTeamData() {
    const blob = await api.downloadBlob("/team/export");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sdloop-export.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  async function handleAcceptInvite(id) {
    await api.post(`/team/invites/${id}/accept`);
    // A new Membership can change the active company/gmail/permissions -
    // simplest to just reload, same as handleSwitchCompany, rather than
    // patching a dozen pieces of state by hand.
    window.location.reload();
  }
  async function handleDeclineInvite(id) {
    await api.post(`/team/invites/${id}/decline`);
    setUser((u) => (u ? { ...u, pendingInvites: (u.pendingInvites || []).filter((i) => i.id !== id) } : u));
  }
  async function handleDisconnectMailbox(gmailAccountId) {
    await api.post("/auth/google/disconnect", { gmailAccountId });
    // The Gmail summary/list lives on `user`, not a separately-loaded
    // resource - simplest to just re-fetch it rather than hand-patch the
    // aggregate sentToday/dailyCap/needsReconnect fields on the frontend.
    setUser(await api.get("/auth/me"));
  }

  if (authState === "loading") {
    return (
      <div className="flex h-screen w-full items-center justify-center" style={{ backgroundColor: C.canvas }}>
        <Spinner label={t("Φόρτωση…")} />
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

  // Prefer the exact counts from /dashboard/summary; fall back to the loaded
  // lists' lengths until it arrives (or if it failed). Using `?? ` so a real 0
  // from the summary isn't overridden by a stale/empty list length.
  const counts = {
    inbox: summary?.inbox ?? activity.length,
    dueToday: summary?.dueToday ?? ((dashboard.counts?.followUps || 0) + (dashboard.counts?.sends || 0)),
    contacts: summary?.contacts ?? contacts.length,
    sequences: summary?.activeSequences ?? sequences.filter((s) => s.active).length,
    templates: summary?.templates ?? templates.length,
    offers: summary?.offers ?? offers.length,
    campaigns: summary?.runningCampaigns ?? campaigns.filter((c) => c.status === "running").length,
  };

  return (
    <div className="flex h-screen w-full overflow-hidden" style={{ backgroundColor: C.canvas, fontFamily: "Inter, sans-serif" }}>
      <Toaster />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenContact={handleSelectFromSearch}
        actions={[
          { id: "compose", label: t("Σύνταξη email"), icon: Pencil, keywords: "compose new email", run: () => setComposeOpen(true) },
          { id: "go-dashboard", label: t("Σήμερα"), icon: CalendarClock, keywords: "today dashboard", run: () => setView("dashboard") },
          { id: "go-inbox", label: t("Απεσταλμένα"), icon: Mail, keywords: "sent inbox", run: () => setView("inbox") },
          { id: "go-contacts", label: t("Επαφές"), icon: Users, keywords: "contacts people", run: () => setView("contacts") },
          { id: "go-sequences", label: t("Sequences"), icon: Layers, keywords: "sequences cadence", run: () => setView("sequences") },
          { id: "go-templates", label: t("Templates"), icon: FileText, keywords: "templates", run: () => setView("templates") },
          { id: "go-offers", label: t("Offers"), icon: Handshake, keywords: "offers deals pipeline", run: () => setView("offers") },
          { id: "go-campaigns", label: t("Campaigns"), icon: Megaphone, keywords: "campaigns blast", run: () => setView("campaigns") },
          { id: "go-analytics", label: "Analytics", icon: BarChart3, keywords: "analytics reports metrics", run: () => setView("analytics") },
          { id: "go-team", label: t("Ομάδα"), icon: UserPlus, keywords: "team settings members", run: () => setView("team") },
          { id: "go-integrations", label: "Integrations", icon: Globe, keywords: "integrations webhook meta linkedin", run: () => setView("integrations") },
        ]}
      />
      {!inviteBannerDismissed && user?.pendingInvites?.length > 0 && (
        <InviteResponseModal
          invites={user.pendingInvites}
          onAccept={handleAcceptInvite}
          onDecline={handleDeclineInvite}
          onDismiss={() => setInviteBannerDismissed(true)}
        />
      )}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:relative inset-y-0 left-0 z-40 w-60 flex flex-col shrink-0 transform transition-transform duration-200 md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
        style={{ background: `linear-gradient(180deg, ${C.sidebarTop} 0%, ${C.sidebar} 100%)` }}
      >
        <div className="px-5 py-5 flex items-center justify-between">
          <Brand size={32} textSize="text-base" light />
          <button onClick={() => setSidebarOpen(false)} className="md:hidden" style={{ color: C.onDarkMuted }}>
            <X size={18} />
          </button>
        </div>

        <div className="px-3">
          <button
            onClick={() => { setComposeOpen(true); setSidebarOpen(false); }}
            className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white mb-3"
            style={{ backgroundColor: C.sky, boxShadow: "0 6px 16px rgba(46,110,232,0.35)" }}
          >
            <Pencil size={14} /> {t("Σύνταξη")}
          </button>
        </div>

        <GlobalSearch onSelectContact={handleSelectFromSearch} dark />

        <div className="px-3 space-y-0.5 flex-1 min-h-0 overflow-y-auto">
          <NavItem dark icon={CalendarClock} label={t("Σήμερα")} active={view === "dashboard"} onClick={() => { setView("dashboard"); setSidebarOpen(false); }} count={counts.dueToday} />
          <NavItem dark icon={Mail} label={t("Απεσταλμένα")} active={view === "inbox"} onClick={() => { setView("inbox"); setSidebarOpen(false); }} count={counts.inbox} />
          <NavItem dark icon={Users} label={t("Επαφές")} active={view === "contacts"} onClick={() => { setView("contacts"); setSidebarOpen(false); }} count={counts.contacts} />
          <NavItem dark icon={Layers} label={t("Sequences")} active={view === "sequences"} onClick={() => { setView("sequences"); setSidebarOpen(false); }} count={counts.sequences} />
          <NavItem dark icon={FileText} label={t("Templates")} active={view === "templates"} onClick={() => { setView("templates"); setSidebarOpen(false); }} count={counts.templates} />
          <NavItem dark icon={Handshake} label={t("Offers")} active={view === "offers"} onClick={() => { setView("offers"); setSidebarOpen(false); }} count={counts.offers} />
          <NavItem dark icon={Megaphone} label={t("Campaigns")} active={view === "campaigns"} onClick={() => { setView("campaigns"); setSidebarOpen(false); }} count={counts.campaigns} />
          <NavItem dark icon={BarChart3} label={t("Analytics")} active={view === "analytics"} onClick={() => { setView("analytics"); setSidebarOpen(false); }} />
          <NavItem dark icon={UserPlus} label={t("Ομάδα")} active={view === "team"} onClick={() => { setView("team"); setSidebarOpen(false); }} />
          <NavItem dark icon={Globe} label={t("Integrations")} active={view === "integrations"} onClick={() => { setView("integrations"); setSidebarOpen(false); }} />
        </div>

        {user?.memberships?.length > 1 && (
          <div className="px-5 pb-2">
            <label className="text-[11px] font-medium block mb-1" style={{ color: C.onDarkMuted }}>{t("Εταιρεία")}</label>
            <select
              value={user.company?.id || ""}
              onChange={(e) => handleSwitchCompany(e.target.value)}
              className="w-full rounded-lg px-2.5 py-1.5 text-xs border outline-none"
              style={{ borderColor: "rgba(255,255,255,0.12)", color: "#FFFFFF", backgroundColor: "rgba(255,255,255,0.06)" }}
            >
              {user.memberships.map((m) => (
                <option key={m.companyId} value={m.companyId} style={{ color: C.ink }}>
                  {m.companyName} ({m.role === "owner" ? t("Ιδιοκτήτης") : t("Μέλος")})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="px-5 pt-3 pb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium" style={{ color: C.onDarkMuted }}>{t("Γλώσσα")}</span>
          <LanguageSwitcher compact dark />
        </div>
        <div className="px-5 pt-2 pb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium" style={{ color: C.onDarkMuted }}>{t("Εμφάνιση")}</span>
          <ThemeToggle dark />
        </div>
        <div className="px-5 py-4 flex items-center gap-2.5" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0" style={{ background: `linear-gradient(135deg, ${C.sky}, ${C.navy})` }}>
            {(user?.name || user?.email || "?").slice(0, 2).toUpperCase()}
          </div>
          <div className="text-xs min-w-0 flex-1">
            <div className="font-medium truncate" style={{ color: "#FFFFFF" }}>{user?.name || t("Χρήστης")}</div>
            <div className="truncate" style={{ color: C.onDarkMuted }}>{user?.email}</div>
          </div>
          <button onClick={handleLogout} className="shrink-0" style={{ color: C.onDarkMuted }} title={t("Αποσύνδεση")}>
            <LogOut size={15} />
          </button>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: C.line, backgroundColor: C.surface }}>
          <button onClick={() => setSidebarOpen(true)} className="text-slate-500 hover:text-slate-700">
            <Menu size={20} />
          </button>
          <Brand size={26} textSize="text-sm" />
        </div>
        <GmailBanner user={user} />
        <div className="flex-1 min-w-0 min-h-0">
          {view === "dashboard" && (
            <DashboardView dashboard={dashboard} loading={dashboardLoading} error={dashboardError} onReload={loadDashboard} onSelectContact={handleSelectFromSearch} />
          )}
          {view === "inbox" && (
            <InboxView activity={activity} loading={activityLoading} error={activityError} onReload={loadActivity} setComposeOpen={setComposeOpen} />
          )}
          {view === "contacts" && (
            <ContactsView
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
              onUpdateContact={handleUpdateContact}
              onUpdateInternalNotes={handleUpdateInternalNotes}
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
            <Suspense fallback={<Spinner label={t("Φόρτωση analytics…")} />}>
              <AnalyticsView overview={overview} timeline={timeline} crmOverview={crmOverview} loading={analyticsLoading} error={analyticsError} onReload={loadAnalytics} />
            </Suspense>
          )}
          {view === "team" && (
            <TeamView
              members={teamMembers}
              loading={teamLoading}
              error={teamError}
              onReload={loadTeam}
              onInvite={handleInviteTeammate}
              onRemove={handleRemoveTeammate}
              currentUserId={user.id}
              isOwner={user?.role === "owner"}
              invites={teamInvites}
              onInviteExisting={handleInviteExistingTeammate}
              onRevokeInvite={handleRevokeInvite}
              onExport={handleExportTeamData}
              gmailAccounts={user?.gmailAccounts}
              onDisconnectMailbox={handleDisconnectMailbox}
            />
          )}
          {view === "integrations" && (
            <IntegrationsView
              data={integrations}
              loading={integrationsLoading}
              error={integrationsError}
              onReload={loadIntegrations}
              isOwner={user?.role === "owner"}
              onCreateWebhook={handleCreateWebhook}
              onRotateWebhook={handleRotateWebhook}
              onDeleteWebhook={handleDeleteWebhook}
              onConnectMeta={handleConnectMeta}
              onDisconnectMeta={handleDisconnectMeta}
              linkedinPendingConnect={linkedinPendingConnect}
              onFinalizeLinkedIn={handleFinalizeLinkedIn}
              onDisconnectLinkedIn={handleDisconnectLinkedIn}
              recentLeads={recentLeads}
              onLoadRecentLeads={loadRecentLeads}
            />
          )}
        </div>

        {/* Mobile bottom navigation — thumb-reachable quick access to the core
            views, plus "More" which opens the full sidebar drawer. Part of the
            flex column (not fixed) so it never overlaps content. */}
        <nav className="md:hidden flex items-stretch border-t shrink-0" style={{ borderColor: C.line, backgroundColor: C.surface }}>
          {[
            ["dashboard", t("Σήμερα"), CalendarClock],
            ["contacts", t("Επαφές"), Users],
            ["sequences", t("Sequences"), Layers],
            ["analytics", "Analytics", BarChart3],
          ].map(([v, label, Icon]) => (
            <button key={v} onClick={() => { setView(v); setSidebarOpen(false); }}
              className="flex-1 flex flex-col items-center gap-0.5 py-2"
              style={{ color: view === v ? C.sky : C.slate }}>
              <Icon size={19} strokeWidth={view === v ? 2.4 : 2} />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
          <button onClick={() => setSidebarOpen(true)} className="flex-1 flex flex-col items-center gap-0.5 py-2" style={{ color: C.slate }}>
            <Menu size={19} />
            <span className="text-[10px] font-medium">{t("Περισσότερα")}</span>
          </button>
        </nav>
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
