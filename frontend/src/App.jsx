import React, { useState, useMemo, useRef } from "react";
import Papa from "papaparse";
import {
  Mail, Send, Users, BarChart3, Layers, Search, Upload, Plus, X,
  Clock, Tag, ChevronRight, Trash2, Pencil, MoreVertical, Paperclip,
  Minus, Maximize2, ChevronDown, Building2, CircleCheck, CircleDot,
  CircleX, Reply
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Funnel, FunnelChart, LabelList
} from "recharts";

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

const seedContacts = [
  { id: 1, name: "Δημήτρης Καρράς", email: "d.karras@vertex.gr", company: "Vertex Retail", status: "replied", tags: ["Retail"], sequence: "Cold Intro Q3", step: 2, lastActivity: "2026-07-09" },
  { id: 2, name: "Ελένη Ροδίτου", email: "e.roditou@harborlogix.com", company: "Harbor Logix", status: "opened", tags: ["Logistics", "Priority"], sequence: "Cold Intro Q3", step: 1, lastActivity: "2026-07-10" },
  { id: 3, name: "Νίκος Παπαδάκης", email: "n.papadakis@finaris.gr", company: "Finaris Capital", status: "bounced", tags: ["Finance"], sequence: "Cold Intro Q3", step: 1, lastActivity: "2026-07-08" },
  { id: 4, name: "Sofia Marinou", email: "sofia@brightloom.io", company: "Brightloom", status: "new", tags: ["SaaS"], sequence: "—", step: 0, lastActivity: "—" },
  { id: 5, name: "Γιώργος Αντωνίου", email: "g.antoniou@atlaslogistics.com", company: "Atlas Logistics", status: "contacted", tags: ["Logistics"], sequence: "Cold Intro Q3", step: 1, lastActivity: "2026-07-07" },
  { id: 6, name: "Katerina Foti", email: "k.foti@novumretail.gr", company: "Novum Retail", status: "replied", tags: ["Retail", "Priority"], sequence: "Follow-up Loop", step: 3, lastActivity: "2026-07-10" },
];

const seedSequences = [
  {
    id: 1, name: "Cold Intro Q3", active: true,
    stats: { sent: 480, opened: 312, clicked: 96, replied: 41 },
    steps: [
      { id: 1, subject: "Γρήγορη ιδέα για το {{company}}", delayDays: 0, body: "Γεια σου {{first_name}}, είδα ότι το {{company}} επεκτείνεται φέτος και ήθελα να μοιραστώ μια σύντομη σκέψη…" },
      { id: 2, subject: "Re: Γρήγορη ιδέα για το {{company}}", delayDays: 3, body: "Ήθελα απλά να ανεβάσω το προηγούμενο μήνυμά μου, μήπως πρόλαβες να το δεις." },
      { id: 3, subject: "Τελευταίο follow-up", delayDays: 7, body: "Δεν θέλω να σε ενοχλώ άλλο — αν δεν είναι η κατάλληλη στιγμή, no worries." },
    ],
  },
  {
    id: 2, name: "Follow-up Loop", active: true,
    stats: { sent: 210, opened: 158, clicked: 61, replied: 28 },
    steps: [
      { id: 1, subject: "Ακολουθία μετά το call", delayDays: 1, body: "Χάρηκα για τη συζήτηση σήμερα — σου στέλνω τα σημεία που συζητήσαμε." },
      { id: 2, subject: "Κάποιες σκέψεις ακόμα", delayDays: 4, body: "Σκέφτηκα ξανά τη συζήτησή μας και ήθελα να προσθέσω…" },
    ],
  },
  { id: 3, name: "Re-engagement", active: false, stats: { sent: 96, opened: 40, clicked: 9, replied: 3 }, steps: [
    { id: 1, subject: "Περάσαμε καιρό", delayDays: 0, body: "Ήθελα να δω πώς πάνε τα πράγματα στο {{company}} τους τελευταίους μήνες." },
  ] },
];

const statusMeta = {
  new:       { label: "Νέο",        color: C.slate, Icon: CircleDot },
  contacted: { label: "Στάλθηκε",   color: C.sky,   Icon: Send },
  opened:    { label: "Άνοιξε",     color: C.amber, Icon: CircleDot },
  replied:   { label: "Απάντησε",   color: C.mint,  Icon: Reply },
  bounced:   { label: "Bounce",     color: C.coral, Icon: CircleX },
};

const trend = [
  { day: "1 Ιουλ", opens: 38, clicks: 11, replies: 3 },
  { day: "3 Ιουλ", opens: 52, clicks: 15, replies: 5 },
  { day: "5 Ιουλ", opens: 44, clicks: 12, replies: 4 },
  { day: "7 Ιουλ", opens: 61, clicks: 21, replies: 7 },
  { day: "9 Ιουλ", opens: 58, clicks: 19, replies: 9 },
  { day: "11 Ιουλ", opens: 70, clicks: 24, replies: 11 },
];

const funnelData = [
  { name: "Στάλθηκαν", value: 786, fill: C.navy },
  { name: "Ανοίχτηκαν", value: 510, fill: C.sky },
  { name: "Κλικ", value: 166, fill: C.amber },
  { name: "Απαντήσεις", value: 72, fill: C.mint },
];

// ---------- Small building blocks ----------
function Pill({ status }) {
  const meta = statusMeta[status];
  if (!meta) return null;
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

// ---------- Views ----------
function ContactsView({ contacts, setContacts }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const fileRef = useRef(null);

  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      const matchesQuery = (c.name + c.email + c.company).toLowerCase().includes(query.toLowerCase());
      const matchesStatus = statusFilter === "all" || c.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [contacts, query, statusFilter]);

  function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const imported = results.data
          .filter((row) => row.email || row.Email)
          .map((row, i) => ({
            id: Date.now() + i,
            name: row.name || row.Name || row.email || "Χωρίς όνομα",
            email: row.email || row.Email,
            company: row.company || row.Company || "—",
            status: "new",
            tags: [],
            sequence: "—",
            step: 0,
            lastActivity: "—",
          }));
        setContacts((prev) => [...imported, ...prev]);
      },
    });
    e.target.value = "";
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Επαφές</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>{contacts.length} επαφές συνολικά</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border"
            style={{ borderColor: C.line, color: C.ink }}
          >
            <Upload size={15} /> Ανέβασμα CSV
          </button>
          <button className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
            <Plus size={15} /> Νέα επαφή
          </button>
        </div>
      </div>

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
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: C.slate }}>
              <th className="font-medium pb-3">Όνομα</th>
              <th className="font-medium pb-3">Εταιρεία</th>
              <th className="font-medium pb-3">Κατάσταση</th>
              <th className="font-medium pb-3">Sequence</th>
              <th className="font-medium pb-3">Ετικέτες</th>
              <th className="font-medium pb-3">Τελ. ενέργεια</th>
              <th className="pb-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className="border-t" style={{ borderColor: C.line }}>
                <td className="py-3">
                  <div className="font-medium" style={{ color: C.ink }}>{c.name}</div>
                  <div className="text-xs" style={{ color: C.slate }}>{c.email}</div>
                </td>
                <td className="py-3" style={{ color: C.ink }}>
                  <div className="flex items-center gap-1.5">
                    <Building2 size={13} style={{ color: C.slate }} />
                    {c.company}
                  </div>
                </td>
                <td className="py-3"><Pill status={c.status} /></td>
                <td className="py-3" style={{ color: C.ink }}>
                  {c.sequence !== "—" ? `${c.sequence} · βήμα ${c.step}` : "—"}
                </td>
                <td className="py-3">
                  <div className="flex gap-1 flex-wrap">
                    {c.tags.map((t) => <TagChip key={t}>{t}</TagChip>)}
                  </div>
                </td>
                <td className="py-3 text-xs" style={{ color: C.slate }}>{c.lastActivity}</td>
                <td className="py-3 text-right">
                  <button className="text-slate-400 hover:text-slate-600"><MoreVertical size={16} /></button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: C.slate }}>Καμία επαφή δεν ταιριάζει.</td></tr>
            )}
          </tbody>
        </table>
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
            <button className="text-slate-400 hover:text-slate-600"><Pencil size={14} /></button>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: C.slate }}>{step.body}</p>
        </Card>
      </div>
    </div>
  );
}

function SequencesView({ sequences }) {
  const [activeId, setActiveId] = useState(sequences[0].id);
  const active = sequences.find((s) => s.id === activeId);

  return (
    <div className="flex h-full">
      <div className="w-72 border-r flex flex-col" style={{ borderColor: C.line }}>
        <div className="flex items-center justify-between px-5 py-5 border-b" style={{ borderColor: C.line }}>
          <h2 className="text-base font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Sequences</h2>
          <button className="rounded-lg p-1.5" style={{ backgroundColor: C.pale }}><Plus size={15} style={{ color: C.navy }} /></button>
        </div>
        <div className="flex-1 overflow-auto px-3 py-2">
          {sequences.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className="w-full text-left rounded-xl px-3 py-3 mb-1"
              style={{ backgroundColor: activeId === s.id ? C.pale : "transparent" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: C.ink }}>{s.name}</span>
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: s.active ? C.mint : C.slate }}
                />
              </div>
              <div className="text-xs mt-1" style={{ color: C.slate }}>{s.steps.length} βήματα · {s.stats.sent} αποστολές</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="flex items-center justify-between px-8 py-5 border-b" style={{ borderColor: C.line }}>
          <div>
            <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>{active.name}</h1>
            <p className="text-sm mt-0.5" style={{ color: C.slate }}>
              {active.stats.sent} στάλθηκαν · {active.stats.opened} ανοίχτηκαν · {active.stats.replied} απαντήσεις
            </p>
          </div>
          <button className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
            <Plus size={15} /> Νέο βήμα
          </button>
        </div>
        <div className="px-8 py-8 max-w-2xl">
          {active.steps.map((step, i) => (
            <SequenceStep key={step.id} step={step} index={i} isLast={i === active.steps.length - 1} />
          ))}
        </div>
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

function AnalyticsView() {
  return (
    <div className="h-full overflow-auto">
      <div className="px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Analytics</h1>
        <p className="text-sm mt-0.5" style={{ color: C.slate }}>Απόδοση όλων των sequences τις τελευταίες 2 εβδομάδες</p>
      </div>

      <div className="px-8 py-6 space-y-6">
        <div className="flex gap-4">
          <StatCard label="Open rate" value="64.9%" sub="+4.2% από προηγ. εβδομάδα" color={C.mint} />
          <StatCard label="Click rate" value="21.1%" sub="+1.8% από προηγ. εβδομάδα" color={C.mint} />
          <StatCard label="Reply rate" value="9.2%" sub="−0.6% από προηγ. εβδομάδα" color={C.coral} />
          <StatCard label="Bounce rate" value="2.1%" sub="σταθερό" color={C.slate} />
        </div>

        <div className="grid grid-cols-2 gap-6">
          <Card className="p-5">
            <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>Τάση εμπλοκής</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trend}>
                <CartesianGrid stroke={C.line} vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: C.slate }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: C.slate }} axisLine={false} tickLine={false} />
                <Tooltip />
                <Line type="monotone" dataKey="opens" stroke={C.sky} strokeWidth={2} dot={false} name="Ανοίγματα" />
                <Line type="monotone" dataKey="clicks" stroke={C.amber} strokeWidth={2} dot={false} name="Κλικ" />
                <Line type="monotone" dataKey="replies" stroke={C.mint} strokeWidth={2} dot={false} name="Απαντήσεις" />
              </LineChart>
            </ResponsiveContainer>
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
              {seedSequences.map((s) => (
                <tr key={s.id} className="border-t" style={{ borderColor: C.line }}>
                  <td className="py-2.5 font-medium" style={{ color: C.ink }}>{s.name}</td>
                  <td className="py-2.5" style={{ color: C.ink }}>{s.stats.sent}</td>
                  <td className="py-2.5" style={{ color: C.ink }}>{Math.round((s.stats.opened / s.stats.sent) * 100)}%</td>
                  <td className="py-2.5" style={{ color: C.ink }}>{Math.round((s.stats.replied / s.stats.sent) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

function InboxView({ setComposeOpen }) {
  const sent = [
    { id: 1, to: "d.karras@vertex.gr", subject: "Γρήγορη ιδέα για το Vertex Retail", time: "09:41", status: "opened" },
    { id: 2, to: "e.roditou@harborlogix.com", subject: "Γρήγορη ιδέα για το Harbor Logix", time: "09:38", status: "contacted" },
    { id: 3, to: "k.foti@novumretail.gr", subject: "Re: Ακολουθία μετά το call", time: "Χθες", status: "replied" },
    { id: 4, to: "n.papadakis@finaris.gr", subject: "Γρήγορη ιδέα για το Finaris Capital", time: "Χθες", status: "bounced" },
  ];
  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between px-8 py-5 border-b" style={{ borderColor: C.line }}>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Απεσταλμένα</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>Emails που στάλθηκαν μέσω sequences ή χειροκίνητα</p>
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
        {sent.map((m) => (
          <div key={m.id} className="flex items-center justify-between py-3.5 border-b" style={{ borderColor: C.line }}>
            <div className="flex items-center gap-3 min-w-0">
              <Mail size={16} style={{ color: C.slate }} />
              <div className="min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: C.ink }}>{m.subject}</div>
                <div className="text-xs truncate" style={{ color: C.slate }}>προς {m.to}</div>
              </div>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <Pill status={m.status} />
              <span className="text-xs" style={{ color: C.slate }}>{m.time}</span>
            </div>
          </div>
        ))}
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
          <button className="text-white/80 hover:text-white"><Maximize2 size={13} /></button>
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
          <div className="flex items-center justify-between px-4 py-3 border-t" style={{ borderColor: C.line }}>
            <button className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: C.sky }}>
              Αποστολή <Send size={13} />
            </button>
            <div className="flex items-center gap-3" style={{ color: C.slate }}>
              <Paperclip size={16} />
              <Trash2 size={16} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [view, setView] = useState("inbox");
  const [contacts, setContacts] = useState(seedContacts);
  const [composeOpen, setComposeOpen] = useState(false);

  const counts = {
    inbox: 4,
    contacts: contacts.length,
    sequences: seedSequences.filter((s) => s.active).length,
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
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white" style={{ backgroundColor: C.navy }}>ΧΤ</div>
          <div className="text-xs">
            <div className="font-medium" style={{ color: C.ink }}>Χρήστος Τ.</div>
            <div style={{ color: C.slate }}>info@sender.gr</div>
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0">
        {view === "inbox" && <InboxView setComposeOpen={setComposeOpen} />}
        {view === "contacts" && <ContactsView contacts={contacts} setContacts={setContacts} />}
        {view === "sequences" && <SequencesView sequences={seedSequences} />}
        {view === "analytics" && <AnalyticsView />}
      </div>

      {composeOpen && <ComposeModal onClose={() => setComposeOpen(false)} />}
    </div>
  );
}
