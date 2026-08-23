// Split out of App.jsx specifically so recharts (a sizeable dependency only
// this view needs) ships as its own chunk, fetched only when a user opens
// the Analytics tab, instead of bloating every visitor's initial bundle -
// see App.jsx's `const AnalyticsView = lazy(() => import("./AnalyticsView.jsx"))`.
// Default export is required for React.lazy's dynamic import().
import React, { useState, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, LabelList,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { C, Card, Spinner, ErrorNote, StatCard, EmptyState, PageHeader, fmtMoney, OFFER_STATUSES, CampaignStatusBadge } from "./lib/ui.jsx";
import { api } from "./lib/api";
import { t } from "./lib/i18n.jsx";

function pct(numerator, denominator) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

// A/B subject-test results. Each card is one step/campaign that has variants;
// the winning line (highest open rate among those actually sent) is highlighted.
function AbTestCard({ title, subtitle, variants }) {
  const contended = variants.filter((v) => v.sent > 0);
  const bestRate = contended.length ? Math.max(...contended.map((v) => v.openRate)) : null;
  return (
    <Card className="p-5">
      <div className="text-sm font-medium" style={{ color: C.ink }}>{title}</div>
      {subtitle && <div className="text-xs mb-3" style={{ color: C.slate }}>{subtitle}</div>}
      <div className="space-y-1.5 mt-2">
        {variants.map((v, i) => {
          const isWinner = bestRate != null && v.sent > 0 && v.openRate === bestRate;
          return (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
              style={{ backgroundColor: isWinner ? `${C.mint}1f` : C.pale }}>
              <div className="min-w-0 flex items-center gap-2">
                <span className="text-[10px] font-semibold shrink-0 rounded px-1.5 py-0.5"
                  style={{ backgroundColor: v.isPrimary ? `${C.navy}14` : `${C.slate}14`, color: v.isPrimary ? C.navy : C.slate }}>
                  {v.isPrimary ? "A" : String.fromCharCode(65 + i)}
                </span>
                <span className="text-xs truncate" style={{ color: C.ink }} title={v.subject}>{v.subject || "-"}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-[11px]" style={{ color: C.slate }}>{v.opened}/{v.sent}</span>
                <span className="text-xs font-semibold tabular-nums" style={{ color: isWinner ? C.mint : C.slate }}>
                  {v.sent > 0 ? `${v.openRate}%` : "-"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CrmReportingSection({ crm }) {
  if (!crm) return null;
  const OFFER_STATUS_LABELS = { draft: t("Πρόχειρες"), sent: t("Στάλθηκαν"), accepted: t("Έγιναν δεκτές"), declined: t("Απορρίφθηκαν") };
  const pipelineData = ["draft", "sent", "accepted", "declined"].map((key) => ({
    name: OFFER_STATUS_LABELS[key],
    value: crm.offersByStatus?.[key] ?? 0,
    fill: OFFER_STATUSES.find((s) => s.key === key)?.color || C.slate,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <StatCard label={t("Επικοινωνήθηκαν")} value={crm.contactsContacted} sub={t("από {n} επαφές", { n: crm.contactsTotal })} color={C.sky} />
        <StatCard label={t("Προσφορές")} value={crm.offersTotal} sub={t("σύνολο")} color={C.navy} />
        <StatCard label={t("Win rate")} value={crm.winRate == null ? "-" : `${Math.round(crm.winRate * 100)}%`} sub={t("αποδεκτές / αποφασισμένες")} color={C.mint} />
        <StatCard label={t("Αξία σε εξέλιξη")} value={fmtMoney((crm.valueByStatus?.sent || 0) + (crm.valueByStatus?.draft || 0))} sub="draft + sent" color={C.amber} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5">
          <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Pipeline προσφορών")}</div>
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
          <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Αξία ανά κατάσταση")}</div>
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
        <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Συχνότερες αιτίες αποδοχής/απόρριψης")}</div>
        {(!crm.declineReasons || crm.declineReasons.length === 0) ? (
          <p className="text-sm py-6 text-center" style={{ color: C.slate }}>{t("Δεν έχουν καταχωρηθεί αιτίες ακόμα.")}</p>
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

// Body A/B card: like AbTestCard but each row is a body variant (A/B/C), and
// the winner (highest open rate among sent) is highlighted.
function BodyAbCard({ title, subtitle, variants, winner }) {
  return (
    <Card className="p-5">
      <div className="text-sm font-medium" style={{ color: C.ink }}>{title}</div>
      <div className="text-xs mb-3" style={{ color: C.slate }}>{subtitle}</div>
      <div className="space-y-2">
        {variants.map((v) => {
          const isWinner = winner === v.index && v.sent > 0;
          return (
            <div key={v.index} className="rounded-lg px-3 py-2" style={{ backgroundColor: isWinner ? `${C.mint}12` : C.pale }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: isWinner ? C.mint : C.ink }}>
                  {t("Κείμενο {v}", { v: v.label })}{v.isPrimary ? t(" (κύριο)") : ""}{isWinner ? t(" · νικητής ✓") : ""}
                </span>
                <span className="text-sm font-bold tabular-nums" style={{ color: isWinner ? C.mint : C.ink }}>{v.openRate}%</span>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: C.slate }}>{t("{sent} στάλθηκαν · {opened} ανοίγματα", { sent: v.sent, opened: v.opened })}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function AbTestsResults({ data, loading }) {
  const seqs = data?.sequences || [];
  const camps = data?.campaigns || [];
  const bodyTests = data?.bodyTests || [];
  if (loading && !data) return <Spinner label={t("Φόρτωση A/B…")} />;
  if (seqs.length === 0 && camps.length === 0 && bodyTests.length === 0) {
    return (
      <p className="text-sm py-16 text-center" style={{ color: C.slate }}>
        {t("Δεν υπάρχουν ακόμα A/B tests. Πρόσθεσε εναλλακτικά θέματα ή κείμενα σε ένα βήμα sequence ή σε ένα campaign για να ξεκινήσεις.")}
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {(seqs.length > 0 || camps.length > 0) && (
        <div>
          <div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>{t("A/B θέματος")}</div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {seqs.map((item) => (
              <AbTestCard key={item.stepId} title={item.sequenceName} subtitle={t("Sequence · Βήμα {n}", { n: item.stepOrder + 1 })} variants={item.variants} />
            ))}
            {camps.map((item) => (
              <AbTestCard key={item.campaignId} title={item.name} subtitle="Campaign" variants={item.variants} />
            ))}
          </div>
        </div>
      )}
      {bodyTests.length > 0 && (
        <div>
          <div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>{t("A/B κειμένου")}</div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {bodyTests.map((item) => (
              <BodyAbCard key={item.stepId} title={item.sequenceName} subtitle={t("Sequence · Βήμα {n}", { n: item.stepOrder + 1 })} variants={item.variants} winner={item.winner} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const RANGES = [
  ["7", "7"],
  ["30", "30"],
  ["90", "90"],
  ["all", "all"],
  ["custom", "custom"],
];

function AnalyticsView({ overview, timeline, crmOverview, loading, error, onReload }) {
  const [tab, setTab] = useState("email"); // email | crm | abtests
  const [abTests, setAbTests] = useState(null);
  const [abLoading, setAbLoading] = useState(false);
  // Date-range filter for the Email tab. Presets (7/30/90/all) or a custom
  // from-to window. Overview is refetched with the range so KPIs, funnel and
  // the per-sequence/campaign tables all reflect it. Seeded from the prop so
  // the first paint isn't empty.
  const [range, setRange] = useState("30");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [rangedOverview, setRangedOverview] = useState(overview);
  const [ovLoading, setOvLoading] = useState(false);

  useEffect(() => {
    let qs = "";
    if (range === "custom") {
      if (!custom.from || !custom.to) return; // wait for both dates
      qs = `?from=${custom.from}&to=${custom.to}`;
    } else if (range !== "all") {
      qs = `?days=${range}`;
    }
    let cancelled = false;
    setOvLoading(true);
    api.get(`/analytics/overview${qs}`)
      .then((d) => { if (!cancelled) setRangedOverview(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setOvLoading(false); });
    return () => { cancelled = true; };
  }, [range, custom.from, custom.to]);

  const ov = rangedOverview || overview;

  // A/B results are their own endpoint, fetched only when that tab is opened.
  useEffect(() => {
    if (tab !== "abtests") return;
    let cancelled = false;
    setAbLoading(true);
    api
      .get("/analytics/ab-tests")
      .then((d) => { if (!cancelled) setAbTests(d); })
      .catch(() => { if (!cancelled) setAbTests({ sequences: [], campaigns: [] }); })
      .finally(() => { if (!cancelled) setAbLoading(false); });
    return () => { cancelled = true; };
  }, [tab]);
  const totals = ov?.totals || { sent: 0, opened: 0, clicked: 0, replied: 0 };
  const rate = (n) => (totals.sent ? Math.round((n / totals.sent) * 100) : 0);
  const funnelData = [
    { name: t("Στάλθηκαν"), value: totals.sent, rate: 100, fill: C.navy },
    { name: t("Ανοίχτηκαν"), value: totals.opened, rate: rate(totals.opened), fill: C.sky },
    { name: t("Κλικ"), value: totals.clicked, rate: rate(totals.clicked), fill: C.amber },
    { name: t("Απαντήσεις"), value: totals.replied, rate: rate(totals.replied), fill: C.mint },
  ];
  const funnelLabel = (e) => {
    const d = funnelData[e.index] || {};
    return `${d.value} · ${d.rate}%`;
  };

  return (
    <div className="h-full overflow-auto">
      <PageHeader className="px-8 py-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: C.ink, fontFamily: "Sora, sans-serif" }}>Analytics</h1>
            <p className="text-sm mt-0.5" style={{ color: C.slate }}>
              {tab === "email"
                ? t("Απόδοση όλων των αποστολών - sequences και χειροκίνητα emails")
                : tab === "crm"
                ? t("CRM reporting - pipeline & αποτελέσματα")
                : t("A/B θεμάτων - ποια γραμμή θέματος ανοίγεται περισσότερο")}
            </p>
          </div>
          <div className="flex rounded-lg p-0.5" style={{ backgroundColor: C.pale }}>
            {[["email", "Email"], ["crm", "Business (CRM)"], ["abtests", "A/B"]].map(([key, label]) => (
              <button key={key} type="button" onClick={() => setTab(key)}
                className="rounded-md px-3 py-1.5 text-xs font-medium"
                style={{ backgroundColor: tab === key ? C.sky : "transparent", color: tab === key ? "#fff" : C.slate }}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === "email" && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <div className="flex rounded-lg p-0.5 border" style={{ borderColor: C.line, backgroundColor: "#fff" }}>
              {RANGES.map(([key]) => (
                <button key={key} type="button" onClick={() => setRange(key)}
                  className="rounded-md px-2.5 py-1 text-[11px] font-medium"
                  style={{ backgroundColor: range === key ? C.sky : "transparent", color: range === key ? "#fff" : C.slate }}>
                  {key === "all" ? t("Όλα") : key === "custom" ? t("Προσαρμογή") : t("{n} ημέρες", { n: key })}
                </button>
              ))}
            </div>
            {range === "custom" && (
              <div className="flex items-center gap-1.5">
                <input type="date" value={custom.from} max={custom.to || undefined}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  className="rounded-md border px-2 py-1 text-[11px]" style={{ borderColor: C.line, color: C.ink }} />
                <span className="text-[11px]" style={{ color: C.slate }}>{t("έως")}</span>
                <input type="date" value={custom.to} min={custom.from || undefined}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  className="rounded-md border px-2 py-1 text-[11px]" style={{ borderColor: C.line, color: C.ink }} />
              </div>
            )}
            {ovLoading && <span className="text-[11px]" style={{ color: C.slate }}>{t("Ενημέρωση…")}</span>}
          </div>
        )}
      </PageHeader>

      <div className="px-8 py-6 space-y-6">
        <ErrorNote message={error} onRetry={onReload} />
        {tab === "abtests" ? (
          <AbTestsResults data={abTests} loading={abLoading} />
        ) : loading ? (
          <Spinner label={t("Φόρτωση analytics…")} />
        ) : tab === "crm" ? (
          <CrmReportingSection crm={crmOverview} />
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label={t("Στάλθηκαν")} value={totals.sent} sub={t("emails στο διάστημα")} color={C.navy} />
              <StatCard label="Open rate" value={pct(totals.opened, totals.sent)} sub={t("{n} ανοίγματα", { n: totals.opened })} color={C.sky} />
              <StatCard label="Reply rate" value={pct(totals.replied, totals.sent)} sub={t("{n} απαντήσεις", { n: totals.replied })} color={C.mint} />
              <StatCard label="Click rate" value={pct(totals.clicked, totals.sent)} sub={t("{n} κλικ", { n: totals.clicked })} color={C.amber} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="p-5">
                <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Τάση εμπλοκής")}</div>
                {timeline.length === 0 ? (
                  <EmptyState icon={BarChart3} title={t("Δεν υπάρχουν ακόμα events.")} hint={t("Μόλις αρχίσουν να ανοίγονται τα emails σου, η τάση θα εμφανιστεί εδώ.")} />
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={timeline}>
                      <CartesianGrid stroke={C.line} vertical={false} />
                      <XAxis dataKey="day" tick={{ fontSize: 11, fill: C.slate }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: C.slate }} axisLine={false} tickLine={false} />
                      <Tooltip />
                      <Line type="monotone" dataKey="opens" stroke={C.sky} strokeWidth={2} dot={false} name={t("Ανοίγματα")} />
                      <Line type="monotone" dataKey="clicks" stroke={C.amber} strokeWidth={2} dot={false} name={t("Κλικ")} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </Card>

              <Card className="p-5">
                <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Funnel αποστολών")}</div>
                {totals.sent === 0 ? (
                  <EmptyState icon={BarChart3} title={t("Καμία αποστολή ακόμα.")} hint={t("Το funnel γεμίζει μόλις σταλεί το πρώτο email.")} />
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={funnelData} layout="vertical" margin={{ left: 20, right: 56 }}>
                      <XAxis type="number" hide domain={[0, Math.max(totals.sent, 1)]} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: C.ink }} axisLine={false} tickLine={false} width={100} />
                      <Bar dataKey="value" radius={[0, 6, 6, 0]} minPointSize={2} background={{ fill: C.pale, radius: 6 }}>
                        {funnelData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                        <LabelList dataKey="value" position="right" content={(p) => (
                          <text x={p.x + p.width + 8} y={p.y + p.height / 2} dy={4} fontSize={12} fontWeight={600} fill={C.slate}>
                            {funnelLabel(p)}
                          </text>
                        )} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Card>
            </div>

            <Card className="p-5">
              <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Απόδοση ανά sequence")}</div>
              <div className="overflow-x-auto"><table className="w-full text-sm min-w-[420px]">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-2">Sequence</th>
                    <th className="font-medium pb-2 text-right">{t("Στάλθηκαν")}</th>
                    <th className="font-medium pb-2 text-right">Open rate</th>
                    <th className="font-medium pb-2 text-right">Reply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(ov?.perSequence || []).map((s, i) => (
                    <tr key={s.id} className="border-t transition-colors hover:bg-slate-50" style={{ borderColor: C.line, backgroundColor: i % 2 ? "#FAFCFE" : "transparent" }}>
                      <td className="py-2.5 font-medium" style={{ color: C.ink }}>{s.name}</td>
                      <td className="py-2.5 text-right tabular-nums" style={{ color: C.ink }}>{s.sent}</td>
                      <td className="py-2.5 text-right tabular-nums" style={{ color: C.ink }}>{pct(s.opened, s.sent)}</td>
                      <td className="py-2.5 text-right tabular-nums font-semibold" style={{ color: s.replied ? C.mint : C.ink }}>{pct(s.replied, s.sent)}</td>
                    </tr>
                  ))}
                  {(!ov?.perSequence || ov.perSequence.length === 0) && (
                    <tr><td colSpan={4} className="py-6 text-center text-sm" style={{ color: C.slate }}>{t("Καμία δραστηριότητα ακόμα.")}</td></tr>
                  )}
                </tbody>
              </table></div>
            </Card>

            <Card className="p-5">
              <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Απόδοση ανά campaign")}</div>
              <div className="overflow-x-auto"><table className="w-full text-sm min-w-[420px]">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-2">Campaign</th>
                    <th className="font-medium pb-2">{t("Κατάσταση")}</th>
                    <th className="font-medium pb-2 text-right">{t("Στάλθηκαν")}</th>
                    <th className="font-medium pb-2 text-right">Open rate</th>
                    <th className="font-medium pb-2 text-right">Reply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(ov?.perCampaign || []).map((c, i) => (
                    <tr key={c.id} className="border-t transition-colors hover:bg-slate-50" style={{ borderColor: C.line, backgroundColor: i % 2 ? "#FAFCFE" : "transparent" }}>
                      <td className="py-2.5 font-medium" style={{ color: C.ink }}>{c.name}</td>
                      <td className="py-2.5"><CampaignStatusBadge status={c.status} /></td>
                      <td className="py-2.5 text-right tabular-nums" style={{ color: C.ink }}>{c.sent}</td>
                      <td className="py-2.5 text-right tabular-nums" style={{ color: C.ink }}>{pct(c.opened, c.sent)}</td>
                      <td className="py-2.5 text-right tabular-nums font-semibold" style={{ color: c.replied ? C.mint : C.ink }}>{pct(c.replied, c.sent)}</td>
                    </tr>
                  ))}
                  {(!ov?.perCampaign || ov.perCampaign.length === 0) && (
                    <tr><td colSpan={5} className="py-6 text-center text-sm" style={{ color: C.slate }}>{t("Κανένα campaign ακόμα.")}</td></tr>
                  )}
                </tbody>
              </table></div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default AnalyticsView;
