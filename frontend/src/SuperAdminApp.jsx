import { useState, useEffect, useCallback } from "react";
import { X, Loader2, Building2, Pencil, ShieldCheck, UserPlus, UserCheck, UserX, Trash2, LogOut } from "lucide-react";
import { api, ApiError } from "./lib/api";
import { C, Card, Spinner, ErrorNote, StatCard, Brand, fmtMoney, fmtDate } from "./lib/ui.jsx";
import { AuthScreen } from "./AuthScreen.jsx";

// ---------- Admin ----------
// Everything below (through SuperAdminApp at the bottom) used to live inline
// in App.jsx. Split into its own file so the main app — the thing every
// regular company user actually loads — doesn't ship this platform-admin-only
// code (companies panel, cross-company user list, stats modal, etc.) in its
// bundle. Only reachable via the /superadmin route (see main.jsx), which
// lazy-loads this file on its own.
function NewAdminUserModal({ onClose, onCreate, companies }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [companyId, setCompanyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onCreate({ email, password, name: name || undefined, isAdmin, companyId: companyId || undefined });
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
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Εταιρεία</label>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
              <option value="">— χωρίς εταιρεία (θα οριστεί αργότερα) —</option>
              {(companies || []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
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

function NewCompanyModal({ onClose, onCreate }) {
  const [companyName, setCompanyName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onCreate({ companyName, ownerEmail, ownerPassword, ownerName: ownerName || undefined });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η δημιουργία εταιρείας.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Νέα εταιρεία</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required placeholder="Όνομα εταιρείας" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <p className="text-xs font-medium pt-1" style={{ color: C.slate }}>Πρώτος χρήστης (ιδιοκτήτης)</p>
          <input required type="email" placeholder="Email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Όνομα (προαιρετικό)" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input required type="password" minLength={10} placeholder="Κωδικός (τουλάχιστον 10 χαρακτήρες)" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Δημιουργία εταιρείας
          </button>
        </form>
      </Card>
    </div>
  );
}

function RenameCompanyModal({ company, onClose, onRename }) {
  const [name, setName] = useState(company.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onRename(company.id, name);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η μετονομασία.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Μετονομασία εταιρείας</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required autoFocus placeholder="Όνομα εταιρείας" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Αποθήκευση
          </button>
        </form>
      </Card>
    </div>
  );
}

// Platform-admin-only: create/suspend/reactivate pilot companies. Each row's
// users/contacts counts come straight from the backend's _count include.
function CompaniesPanel({ companies, loading, error, onReload, onCreate, onRename, onSuspend, onActivate }) {
  const [busyId, setBusyId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [statsCompany, setStatsCompany] = useState(null);
  const [renameCompany, setRenameCompany] = useState(null);

  async function run(id, fn) {
    setBusyId(id);
    try {
      await fn(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="p-5">
      {showNew && <NewCompanyModal onClose={() => setShowNew(false)} onCreate={onCreate} />}
      {statsCompany && <CompanyStatsModal company={statsCompany} onClose={() => setStatsCompany(null)} />}
      {renameCompany && (
        <RenameCompanyModal company={renameCompany} onClose={() => setRenameCompany(null)} onRename={onRename} />
      )}
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium" style={{ color: C.ink }}>Εταιρείες</div>
        <button onClick={() => setShowNew(true)} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: C.sky }}>
          <Building2 size={13} /> Νέα εταιρεία
        </button>
      </div>
      <ErrorNote message={error} onRetry={onReload} />
      {loading ? (
        <Spinner label="Φόρτωση εταιρειών…" />
      ) : companies.length === 0 ? (
        <p className="text-sm" style={{ color: C.slate }}>Δεν υπάρχουν ακόμα εταιρείες.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: C.slate }}>
                <th className="font-medium pb-2">Εταιρεία</th>
                <th className="font-medium pb-2">Κατάσταση</th>
                <th className="font-medium pb-2">Χρήστες</th>
                <th className="font-medium pb-2">Επαφές</th>
                <th className="font-medium pb-2 text-right">Ενέργειες</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr
                  key={c.id}
                  className="border-t cursor-pointer hover:bg-slate-50"
                  style={{ borderColor: C.line }}
                  onClick={() => setStatsCompany(c)}
                  title="Στατιστικά εταιρείας"
                >
                  <td className="py-2.5 font-medium" style={{ color: C.ink }}>
                    <span className="inline-flex items-center gap-1.5">
                      {c.name}
                      <button
                        onClick={(e) => { e.stopPropagation(); setRenameCompany(c); }}
                        className="text-slate-300 hover:text-slate-500"
                        title="Μετονομασία"
                      >
                        <Pencil size={12} />
                      </button>
                    </span>
                  </td>
                  <td className="py-2.5">
                    {c.status === "suspended" ? (
                      <span className="text-xs font-medium" style={{ color: C.coral }}>Ανεσταλμένη</span>
                    ) : (
                      <span className="text-xs font-medium" style={{ color: C.mint }}>Ενεργή</span>
                    )}
                  </td>
                  <td className="py-2.5" style={{ color: C.ink }}>{c.userCount ?? "—"}</td>
                  <td className="py-2.5" style={{ color: C.ink }}>{c.contactCount ?? "—"}</td>
                  <td className="py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    {c.status === "suspended" ? (
                      <button disabled={busyId === c.id} onClick={() => run(c.id, onActivate)}
                        className="rounded-md px-2.5 py-1 text-xs font-medium border" style={{ borderColor: C.line, color: C.mint }}>
                        Επανενεργοποίηση
                      </button>
                    ) : (
                      <button disabled={busyId === c.id} onClick={() => run(c.id, onSuspend)}
                        className="rounded-md px-2.5 py-1 text-xs font-medium border" style={{ borderColor: C.line, color: C.coral }}>
                        Αναστολή
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// Read-only per-company usage snapshot, opened by clicking a row in
// CompaniesPanel — self-contained (fetches its own data via companyId) since
// nothing else on the page needs this data, unlike the list above which is
// already loaded/managed by the parent.
function CompanyStatsModal({ company, onClose }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api
      .get(`/admin/companies/${company.id}/stats`)
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν τα στατιστικά.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [company.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] overflow-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold" style={{ color: C.ink }}>{company.name}</div>
            <div className="text-xs mt-0.5" style={{ color: company.status === "suspended" ? C.coral : C.mint }}>
              {company.status === "suspended" ? "Ανεσταλμένη" : "Ενεργή"}
            </div>
          </div>
          <button onClick={onClose} style={{ color: C.slate }}>
            <X size={16} />
          </button>
        </div>

        {loading && <Spinner label="Φόρτωση στατιστικών…" />}
        <ErrorNote message={error} />

        {stats && (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-3">
              <StatCard label="Χρήστες" value={stats.users.length} color={C.navy} />
              <StatCard label="Επαφές" value={stats.contacts.total} color={C.sky} />
              <StatCard label="Sequences" value={`${stats.sequences.active}/${stats.sequences.total}`} sub="ενεργά / σύνολο" color={C.mint} />
              <StatCard label="Templates" value={stats.templates.total} color={C.slate} />
              <StatCard label="Campaigns" value={stats.campaigns.total} color={C.amber} />
              <StatCard label="Emails" value={stats.emails.sent} sub={`${stats.emails.opened} opens · ${stats.emails.clicked} clicks`} color={C.navy} />
              <StatCard label="Προσφορές" value={stats.offers.total} sub={fmtMoney(stats.offers.value)} color={C.mint} />
            </div>

            <div>
              <div className="text-xs font-medium mb-2" style={{ color: C.slate }}>Gmail</div>
              <p className="text-sm" style={{ color: stats.gmail?.needsReconnect ? C.coral : C.ink }}>
                {stats.gmail
                  ? stats.gmail.needsReconnect
                    ? `${stats.gmail.email} — η σύνδεση χρειάζεται επανασύνδεση (η αποστολή έχει σταματήσει)`
                    : stats.gmail.email
                  : "Δεν έχει συνδεθεί ακόμα."}
              </p>
            </div>

            {Object.keys(stats.contacts.byStatus).length > 0 && (
              <div>
                <div className="text-xs font-medium mb-2" style={{ color: C.slate }}>Επαφές ανά κατάσταση</div>
                <div className="flex flex-wrap gap-2 text-xs" style={{ color: C.ink }}>
                  {Object.entries(stats.contacts.byStatus).map(([k, v]) => (
                    <span key={k} className="px-2 py-1 rounded-md" style={{ backgroundColor: C.pale }}>{k}: {v}</span>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-xs font-medium mb-2" style={{ color: C.slate }}>Μέλη ομάδας</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: C.slate }}>
                    <th className="font-medium pb-1.5">Email</th>
                    <th className="font-medium pb-1.5">Ρόλος</th>
                    <th className="font-medium pb-1.5">Κατάσταση</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.users.map((u) => (
                    <tr key={u.id} className="border-t" style={{ borderColor: C.line }}>
                      <td className="py-1.5" style={{ color: C.ink }}>{u.email}</td>
                      <td className="py-1.5" style={{ color: C.slate }}>{u.role === "owner" ? "Ιδιοκτήτης" : "Μέλος"}</td>
                      <td className="py-1.5" style={{ color: u.approved ? C.mint : C.amber }}>
                        {u.approved ? "Εγκεκριμένος" : "Εκκρεμεί"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AdminView({ users, loading, error, onReload, onApprove, onRevoke, onPromote, onDemote, onCreateUser, onDeleteUser, onAssignCompany, currentUserId, teamOverview, companies, companiesLoading, companiesError, onReloadCompanies, onCreateCompany, onRenameCompany, onSuspendCompany, onActivateCompany }) {
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

  async function handleAssignCompany(u, companyId) {
    setBusyId(u.id);
    try {
      await onAssignCompany(u.id, companyId || null);
    } catch (err) {
      if (err instanceof ApiError && err.data?.error === "would_leave_company_ownerless") {
        window.alert(
          "Δεν μπορείς να μετακινήσεις/αφαιρέσεις τον μοναδικό ιδιοκτήτη αυτής της εταιρείας. " +
          "Ανάθεσε πρώτα σε κάποιον άλλον τον ρόλο ιδιοκτήτη."
        );
      } else {
        window.alert(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η αλλαγή εταιρείας.");
      }
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
      {showNew && <NewAdminUserModal onClose={() => setShowNew(false)} onCreate={onCreateUser} companies={companies} />}
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

        <CompaniesPanel
          companies={companies}
          loading={companiesLoading}
          error={companiesError}
          onReload={onReloadCompanies}
          onCreate={onCreateCompany}
          onRename={onRenameCompany}
          onSuspend={onSuspendCompany}
          onActivate={onActivateCompany}
        />

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
                  <th className="font-medium px-4 py-2.5">Εταιρεία</th>
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
                    <td className="px-4 py-3">
                      <select
                        disabled={busyId === u.id}
                        value={u.companyId || ""}
                        onChange={(e) => handleAssignCompany(u, e.target.value)}
                        className="rounded-md px-2 py-1 text-xs border bg-white"
                        style={{ borderColor: C.line, color: C.ink }}
                        title="Ανάθεση σε εταιρεία"
                      >
                        <option value="">— χωρίς εταιρεία —</option>
                        {(companies || []).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
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

// ---------- Super Admin (separate route: /superadmin) ----------
// Platform-wide company/user management, deliberately isolated from the main
// SDLoop app shell — no CRM sidebar, no per-company data, and not linked from
// any in-app nav. Reachable only by typing the URL (see main.jsx) and gated
// to isAdmin accounts; a logged-in company owner/member who lands here sees
// an access-denied screen, never the panel itself.
export function SuperAdminApp() {
  const [authState, setAuthState] = useState("loading"); // loading | anon | authed | forbidden
  const [user, setUser] = useState(null);

  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [teamOverview, setTeamOverview] = useState(null);

  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesError, setCompaniesError] = useState("");

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

  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    setCompaniesError("");
    try {
      setCompanies(await api.get("/admin/companies"));
    } catch (err) {
      setCompaniesError(err instanceof ApiError ? err.message : "Δεν φορτώθηκαν οι εταιρείες.");
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .get("/auth/me")
      .then((u) => {
        setUser(u);
        setAuthState(u.isAdmin ? "authed" : "forbidden");
      })
      .catch(() => setAuthState("anon"));
  }, []);

  useEffect(() => {
    if (authState === "authed") {
      loadAdminUsers();
      loadCompanies();
    }
  }, [authState, loadAdminUsers, loadCompanies]);

  async function handleLogout() {
    try {
      await api.post("/auth/logout");
    } catch {
      // Same as the main app: drop client-side session state even if the
      // request itself fails.
    }
    setUser(null);
    setAuthState("anon");
    setAdminUsers([]);
    setCompanies([]);
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
  async function handleAssignUserCompany(id, companyId) {
    await api.post(`/admin/users/${id}/assign-company`, { companyId });
    await loadAdminUsers();
    await loadCompanies(); // user counts per company shift when someone moves
  }
  async function handleCreateCompany(data) {
    await api.post("/admin/companies", data);
    await loadCompanies();
  }
  async function handleRenameCompany(id, name) {
    await api.patch(`/admin/companies/${id}`, { name });
    await loadCompanies();
  }
  async function handleSuspendCompany(id) {
    await api.post(`/admin/companies/${id}/suspend`);
    await loadCompanies();
  }
  async function handleActivateCompany(id) {
    await api.post(`/admin/companies/${id}/activate`);
    await loadCompanies();
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
          setAuthState(u.isAdmin ? "authed" : "forbidden");
        }}
      />
    );
  }

  if (authState === "forbidden") {
    return (
      <div className="flex h-screen w-full items-center justify-center px-6" style={{ backgroundColor: "#F7F9FC" }}>
        <div className="max-w-sm text-center space-y-3">
          <ShieldCheck size={28} style={{ color: C.slate, margin: "0 auto" }} />
          <div className="text-sm font-medium" style={{ color: C.ink }}>Δεν έχεις πρόσβαση σε αυτή τη σελίδα.</div>
          <p className="text-xs" style={{ color: C.slate }}>
            Ο λογαριασμός {user?.email} δεν έχει δικαιώματα διαχειριστή πλατφόρμας.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <a href="/" className="text-xs font-medium" style={{ color: C.sky }}>Πίσω στην εφαρμογή</a>
            <button onClick={handleLogout} className="text-xs font-medium" style={{ color: C.slate }}>Αποσύνδεση</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col" style={{ backgroundColor: "#F7F9FC", fontFamily: "Inter, sans-serif" }}>
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0" style={{ borderColor: C.line }}>
        <div className="flex items-center gap-3">
          <Brand size={28} textSize="text-sm" />
          <span className="text-xs font-medium px-2 py-1 rounded-md" style={{ backgroundColor: C.pale, color: C.navy }}>
            Διαχείριση πλατφόρμας
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a href="/" className="text-xs font-medium" style={{ color: C.sky }}>Πίσω στην εφαρμογή</a>
          <div className="text-xs text-right" style={{ color: C.slate }}>{user?.email}</div>
          <button onClick={handleLogout} className="text-slate-400 hover:text-slate-600" title="Αποσύνδεση">
            <LogOut size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
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
          onAssignCompany={handleAssignUserCompany}
          currentUserId={user.id}
          teamOverview={teamOverview}
          companies={companies}
          companiesLoading={companiesLoading}
          companiesError={companiesError}
          onReloadCompanies={loadCompanies}
          onCreateCompany={handleCreateCompany}
          onRenameCompany={handleRenameCompany}
          onSuspendCompany={handleSuspendCompany}
          onActivateCompany={handleActivateCompany}
        />
      </div>
    </div>
  );
}

export default SuperAdminApp;
