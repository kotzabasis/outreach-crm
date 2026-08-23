// Split out of App.jsx specifically so recharts (a sizeable dependency only
// this view needs) ships as its own chunk, fetched only when a user opens
// the Analytics tab, instead of bloating every visitor's initial bundle -
// see App.jsx's `const AnalyticsView = lazy(() => import("./AnalyticsView.jsx"))`.
// Default export is required for React.lazy's dynamic import().
import React, { useState, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";
import { C, Card, Spinner, ErrorNote, StatCard, fmtMoney, OFFER_STATUSES, CampaignStatusBadge } from "./lib/ui.jsx";
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

function AbTestsResults({ data, loading }) {
  const seqs = data?.sequences || [];
  const camps = data?.campaigns || [];
  if (loading && !data) return <Spinner label={t("Φόρτωση A/B…")} />;
  if (seqs.length === 0 && camps.length === 0) {
    return (
      <p className="text-sm py-16 text-center" style={{ color: C.slate }}>
        {t("Δεν υπάρχουν ακόμα A/B tests. Πρόσθεσε εναλλακτικά θέματα σε ένα βήμα sequence ή σε ένα campaign για να ξεκινήσεις.")}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {seqs.map((item) => (
        <AbTestCard key={item.stepId} title={item.sequenceName} subtitle={t("Sequence · Βήμα {n}", { n: item.stepOrder + 1 })} variants={item.variants} />
      ))}
      {camps.map((item) => (
        <AbTestCard key={item.campaignId} title={item.name} subtitle="Campaign" variants={item.variants} />
      ))}
    </div>
  );
}

function AnalyticsView({ overview, timeline, crmOverview, loading, error, onReload }) {
  const [tab, setTab] = useState("email"); // email | crm | abtests
  const [abTests, setAbTests] = useState(null);
  const [abLoading, setAbLoading] = useState(false);

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
  const totals = overview?.totals || { sent: 0, opened: 0, clicked: 0, replied: 0 };
  const funnelData = [
    { name: t("Στάλθηκαν"), value: totals.sent, fill: C.navy },
    { name: t("Ανοίχτηκαν"), value: totals.opened, fill: C.sky },
    { name: t("Κλικ"), value: totals.clicked, fill: C.amber },
    { name: t("Απαντήσεις"), value: totals.replied, fill: C.mint },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-5 border-b" style={{ borderColor: C.line }}>
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
            <div className="flex flex-wrap gap-4">
              <StatCard label="Open rate" value={pct(totals.opened, totals.sent)} sub={t("{n} αποστολές", { n: totals.sent })} color={C.mint} />
              <StatCard label="Click rate" value={pct(totals.clicked, totals.sent)} sub={t("σε σχέση με αποστολές")} color={C.mint} />
              <StatCard label="Reply rate" value={pct(totals.replied, totals.sent)} sub={t("σε σχέση με αποστολές")} color={C.coral} />
              <StatCard label="Sequences" value={overview?.perSequence?.length ?? 0} sub={t("ενεργά + ανενεργά")} color={C.slate} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="p-5">
                <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Τάση εμπλοκής")}</div>
                {timeline.length === 0 ? (
                  <p className="text-sm py-16 text-center" style={{ color: C.slate }}>{t("Δεν υπάρχουν ακόμα events.")}</p>
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
              <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Απόδοση ανά sequence")}</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-2">Sequence</th>
                    <th className="font-medium pb-2">{t("Στάλθηκαν")}</th>
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
                    <tr><td colSpan={4} className="py-6 text-center text-sm" style={{ color: C.slate }}>{t("Καμία δραστηριότητα ακόμα.")}</td></tr>
                  )}
                </tbody>
              </table>
            </Card>

            <Card className="p-5">
              <div className="text-sm font-medium mb-4" style={{ color: C.ink }}>{t("Απόδοση ανά campaign")}</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-2">Campaign</th>
                    <th className="font-medium pb-2">{t("Κατάσταση")}</th>
                    <th className="font-medium pb-2">{t("Στάλθηκαν")}</th>
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
                    <tr><td colSpan={5} className="py-6 text-center text-sm" style={{ color: C.slate }}>{t("Κανένα campaign ακόμα.")}</td></tr>
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

export default AnalyticsView;
