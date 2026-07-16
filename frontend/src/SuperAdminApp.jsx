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

// `users` (all existing accounts, passed down from AdminView) lets a platform
// admin make an EXISTING person the owner of this new company — e.g. someone
// who already owns/works at one pilot company is now also launching another
// — without hitting "email_already_registered" trying to create a duplicate
// account for them. That error is correct for a brand-new account; it just
// isn't the right tool for "add this person to another company," which is a
// Membership, not a new user (see POST /admin/companies + assign-company).
function NewCompanyModal({ onClose, onCreate, users }) {
  const [companyName, setCompanyName] = useState("");
  const [ownerMode, setOwnerMode] = useState("new"); // "new" | "existing"
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [existingOwnerUserId, setExistingOwnerUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (ownerMode === "existing") {
        if (!existingOwnerUserId) throw new Error("no_owner_selected");
        await onCreate({ companyName, existingOwnerUserId });
      } else {
        await onCreate({ companyName, ownerEmail, ownerPassword, ownerName: ownerName || undefined });
      }
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

          <div className="flex items-center gap-1 rounded-lg p-1" style={{ backgroundColor: C.pale }}>
            <button type="button" onClick={() => setOwnerMode("new")}
              className="flex-1 rounded-md py-1.5 text-xs font-medium"
              style={{ backgroundColor: ownerMode === "new" ? "white" : "transparent", color: ownerMode === "new" ? C.ink : C.slate }}>
              Νέος ιδιοκτήτης
            </button>
            <button type="button" onClick={() => setOwnerMode("existing")}
              className="flex-1 rounded-md py-1.5 text-xs font-medium"
              style={{ backgroundColor: ownerMode === "existing" ? "white" : "transparent", color: ownerMode === "existing" ? C.ink : C.slate }}>
              Υπάρχων χρήστης
            </button>
          </div>

          {ownerMode === "existing" ? (
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Ιδιοκτήτης</label>
              <select required value={existingOwnerUserId} onChange={(e) => setExistingOwnerUserId(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
                <option value="">— επίλεξε χρήστη —</option>
                {(users || []).map((u) => (
                  <option key={u.id} value={u.id}>{u.name ? `${u.name} (${u.email})` : u.email}</option>
                ))}
              </select>
              <p className="text-xs mt-1" style={{ color: C.slate }}>
                Ο χρήστης θα γίνει ιδιοκτήτης της νέας εταιρείας, χωρίς να αγγίξει τις υπόλοιπες εταιρείες του.
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs font-medium pt-1" style={{ color: C.slate }}>Πρώτος χρήστης (ιδιοκτήτης)</p>
              <input required type="email" placeholder="Email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <input placeholder="Όνομα (προαιρετικό)" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
              <input required type="password" minLength={10} placeholder="Κωδικός (τουλάχιστον 10 χαρακτήρες)" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            </>
          )}

          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Δημιουργία εταιρείας
          </button>
        </form>
      </Card>
    </div>
  );
}

// Only `name` is required — legalName/taxId/taxOffice/gemhNumber/address/
// phone/email are the optional Greek-business profile fields (see
// schema.prisma's Company model); a pilot company can go indefinitely
// without ever filling them in.
function EditCompanyModal({ company, onClose, onSave }) {
  const [form, setForm] = useState({
    name: company.name || "",
    legalName: company.legalName || "",
    taxId: company.taxId || "",
    taxOffice: company.taxOffice || "",
    gemhNumber: company.gemhNumber || "",
    address: company.address || "",
    phone: company.phone || "",
    email: company.email || "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onSave(company.id, form);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η αποθήκευση.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5 max-h-[85vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Στοιχεία εταιρείας</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input required autoFocus placeholder="Όνομα εταιρείας" value={form.name} onChange={set("name")}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Επωνυμία (νομική, προαιρετικό)" value={form.legalName} onChange={set("legalName")}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="ΑΦΜ" value={form.taxId} onChange={set("taxId")}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <input placeholder="ΔΟΥ" value={form.taxOffice} onChange={set("taxOffice")}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          <input placeholder="ΓΕΜΗ" value={form.gemhNumber} onChange={set("gemhNumber")}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <input placeholder="Διεύθυνση" value={form.address} onChange={set("address")}
            className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Τηλέφωνο" value={form.phone} onChange={set("phone")}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
            <input placeholder="Email επικοινωνίας" value={form.email} onChange={set("email")}
              className="w-full rounded-lg px-3 py-2 text-sm border outline-none" style={{ borderColor: C.line, color: C.ink }} />
          </div>
          {error && <p className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky, opacity: busy ? 0.7 : 1 }}>
            {busy && <Loader2 size={14} className="animate-spin" />} Αποθήκευση
          </button>
        </form>
      </Card>
    </div>
  );
}

// Lets a platform admin add this user to another company (or change their
// role in one they're already in), and remove them from one — the additive
// counterpart to the single "assign a company" dropdown this replaced, now
// that a user can belong to more than one company at once (owner of one,
// member of another). See POST/DELETE /admin/users/:id/(assign-company|
// companies/:companyId) in admin.js.
function ManageMembershipsModal({ user, companies, onClose, onAdd, onRemove }) {
  const [companyId, setCompanyId] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const memberships = user.memberships || [];
  const availableCompanies = (companies || []).filter((c) => !memberships.some((m) => m.companyId === c.id));

  async function handleAdd(e) {
    e.preventDefault();
    if (!companyId) return;
    setError("");
    setBusy(true);
    try {
      await onAdd(user.id, companyId, role);
      setCompanyId("");
      setRole("member");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η προσθήκη.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(m) {
    setError("");
    setBusy(true);
    try {
      await onRemove(user.id, m.companyId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Δεν ήταν δυνατή η αφαίρεση.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: "rgba(16,25,43,0.45)" }}>
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold" style={{ color: C.ink }}>Εταιρείες χρήστη</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <p className="text-xs mb-4" style={{ color: C.slate }}>{user.email}</p>

        {memberships.length === 0 ? (
          <p className="text-sm mb-4" style={{ color: C.slate }}>Δεν ανήκει σε καμία εταιρεία ακόμα.</p>
        ) : (
          <div className="space-y-1.5 mb-4">
            {memberships.map((m) => (
              <div key={m.companyId} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: C.pale }}>
                <div className="text-sm" style={{ color: C.ink }}>
                  {m.companyName} <span style={{ color: C.slate }}>— {m.role === "owner" ? "Ιδιοκτήτης" : "Μέλος"}</span>
                </div>
                <button disabled={busy} onClick={() => handleRemove(m)} title="Αφαίρεση" style={{ color: C.coral }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs rounded-lg px-3 py-2 mb-3" style={{ backgroundColor: `${C.coral}14`, color: C.coral }}>{error}</p>}

        {availableCompanies.length > 0 && (
          <form onSubmit={handleAdd} className="flex items-end gap-2 pt-3 border-t" style={{ borderColor: C.line }}>
            <div className="flex-1">
              <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>Προσθήκη σε εταιρεία</label>
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
                className="w-full rounded-lg px-2.5 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
                <option value="">— επίλεξε —</option>
                {availableCompanies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <select value={role} onChange={(e) => setRole(e.target.value)}
              className="rounded-lg px-2.5 py-2 text-sm border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
              <option value="member">Μέλος</option>
              <option value="owner">Ιδιοκτήτης</option>
            </select>
            <button type="submit" disabled={busy || !companyId} className="rounded-lg px-3 py-2 text-sm font-medium text-white shrink-0" style={{ backgroundColor: C.sky, opacity: busy || !companyId ? 0.6 : 1 }}>
              Προσθήκη
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

// Platform-admin-only: create/suspend/reactivate pilot companies. Each row's
// users/contacts counts come straight from the backend's _count include.
function CompaniesPanel({ companies, loading, error, onReload, onCreate, onEditCompany, onSuspend, onActivate, users }) {
  const [busyId, setBusyId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [statsCompany, setStatsCompany] = useState(null);
  const [editCompany, setEditCompany] = useState(null);

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
      {showNew && <NewCompanyModal onClose={() => setShowNew(false)} onCreate={onCreate} users={users} />}
      {statsCompany && <CompanyStatsModal company={statsCompany} onClose={() => setStatsCompany(null)} />}
      {editCompany && (
        <EditCompanyModal company={editCompany} onClose={() => setEditCompany(null)} onSave={onEditCompany} />
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
                        onClick={(e) => { e.stopPropagation(); setEditCompany(c); }}
                        className="text-slate-300 hover:text-slate-500"
                        title="Επεξεργασία στοιχείων"
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
              <div className="text-xs font-medium mb-2" style={{ color: C.slate }}>
                Gmail {stats.gmailAccounts?.length > 1 ? `(${stats.gmailAccounts.length} mailbox)` : ""}
              </div>
              {!stats.gmailAccounts || stats.gmailAccounts.length === 0 ? (
                <p className="text-sm" style={{ color: C.ink }}>Δεν έχει συνδεθεί ακόμα.</p>
              ) : (
                <div className="space-y-1">
                  {stats.gmailAccounts.map((g, i) => (
                    <p key={i} className="text-sm" style={{ color: g.needsReconnect ? C.coral : C.ink }}>
                      {g.needsReconnect ? `${g.email} — χρειάζεται επανασύνδεση` : g.email}
                    </p>
                  ))}
                </div>
              )}
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

// Self-contained (fetches its own data, same pattern as CompanyStatsModal)
// so the company filter dropdown can just live here rather than threading a
// selected-company-id up through AdminView/SuperAdminApp. Defaults to "every
// company" (companyId omitted) — the original cross-platform rollup — and
// refetches /admin/team-overview?companyId=... whenever the dropdown changes,
// since a rep's numbers only make sense scoped to one company (someone who's
// a member of two companies would otherwise have contacts/sends from both
// mixed into one row).
function TeamPerformanceCard({ companies }) {
  const [companyId, setCompanyId] = useState("");
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    api
      .get(`/admin/team-overview${qs}`)
      .then((o) => {
        if (alive) setOverview(o);
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? err.message : "Δεν φορτώθηκε η απόδοση ομάδας.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [companyId]);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium" style={{ color: C.ink }}>Απόδοση ομάδας</div>
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
          className="rounded-lg px-2.5 py-1.5 text-xs border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
          <option value="">Όλες οι εταιρείες</option>
          {(companies || []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {loading && <Spinner label="Φόρτωση…" />}
      <ErrorNote message={error} />

      {overview && (
        <>
          <div className="flex flex-wrap gap-4 mb-4">
            <StatCard label="Επαφές" value={overview.totals.contacts} sub="σύνολο team" color={C.sky} />
            <StatCard label="Στάλθηκαν" value={overview.totals.sent} sub="emails, όλοι" color={C.navy} />
            <StatCard label="Προσφορές" value={overview.totals.offers} sub={fmtMoney(overview.totals.offersValue)} color={C.mint} />
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
                {overview.perUser.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-3 text-sm" style={{ color: C.slate }}>Δεν υπάρχουν χρήστες σε αυτή την εταιρεία.</td>
                  </tr>
                ) : (
                  overview.perUser.map((u) => (
                    <tr key={u.userId} className="border-t" style={{ borderColor: C.line }}>
                      <td className="py-2.5 font-medium" style={{ color: C.ink }}>{u.name || u.email}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.contacts}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.sent}</td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.offers} <span style={{ color: C.slate }}>({fmtMoney(u.offersValue)})</span></td>
                      <td className="py-2.5" style={{ color: C.ink }}>{u.winRate == null ? "—" : `${Math.round(u.winRate * 100)}%`}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// Read-only trail of admin/owner actions (see backend lib/auditLog.js for
// exactly what gets logged and why) — self-contained/self-fetching, same
// pattern as TeamPerformanceCard, with its own company filter since "what
// happened in this one company" is the far more common question than "every
// action across the whole platform."
function AuditLogCard({ companies }) {
  const [companyId, setCompanyId] = useState("");
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    api
      .get(`/admin/audit-log${qs}`)
      .then((l) => {
        if (alive) setLogs(l);
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? err.message : "Δεν φορτώθηκε το ιστορικό ενεργειών.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [companyId]);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium" style={{ color: C.ink }}>Ιστορικό ενεργειών</div>
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
          className="rounded-lg px-2.5 py-1.5 text-xs border outline-none bg-white" style={{ borderColor: C.line, color: C.ink }}>
          <option value="">Όλες οι εταιρείες</option>
          {(companies || []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {loading && <Spinner label="Φόρτωση…" />}
      <ErrorNote message={error} />

      {logs && (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: C.slate }}>
                <th className="font-medium pb-2">Πότε</th>
                <th className="font-medium pb-2">Ενέργεια</th>
                <th className="font-medium pb-2">Εταιρεία</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-3 text-sm" style={{ color: C.slate }}>Δεν υπάρχουν καταγεγραμμένες ενέργειες.</td>
                </tr>
              ) : (
                logs.map((l) => (
                  <tr key={l.id} className="border-t align-top" style={{ borderColor: C.line }}>
                    <td className="py-2.5 text-xs whitespace-nowrap" style={{ color: C.slate }}>{fmtDate(l.createdAt)}</td>
                    <td className="py-2.5" style={{ color: C.ink }}>{l.summary}</td>
                    <td className="py-2.5 text-xs" style={{ color: C.slate }}>{l.companyName || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AdminView({ users, loading, error, onReload, onApprove, onRevoke, onPromote, onDemote, onCreateUser, onDeleteUser, onAddMembership, onRemoveMembership, currentUserId, companies, companiesLoading, companiesError, onReloadCompanies, onCreateCompany, onEditCompany, onSuspendCompany, onActivateCompany }) {
  const [busyId, setBusyId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [membershipsUser, setMembershipsUser] = useState(null);

  async function run(id, fn) {
    setBusyId(id);
    try {
      await fn(id);
    } finally {
      setBusyId(null);
    }
  }

  function ownerlessAlert(err) {
    if (err instanceof ApiError && err.data?.error === "would_leave_company_ownerless") {
      window.alert(
        "Δεν μπορείς να αφαιρέσεις/υποβαθμίσεις τον μοναδικό ιδιοκτήτη αυτής της εταιρείας. " +
        "Ανάθεσε πρώτα σε κάποιον άλλον τον ρόλο ιδιοκτήτη."
      );
      return true;
    }
    return false;
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
          onEditCompany={onEditCompany}
          onSuspend={onSuspendCompany}
          onActivate={onActivateCompany}
          users={users}
        />

        {membershipsUser && (
          <ManageMembershipsModal
            user={membershipsUser}
            companies={companies}
            onClose={() => setMembershipsUser(null)}
            onAdd={async (userId, companyId, role) => {
              try {
                const updated = await onAddMembership(userId, companyId, role);
                setMembershipsUser(updated);
              } catch (err) {
                if (!ownerlessAlert(err)) throw err;
              }
            }}
            onRemove={async (userId, companyId) => {
              try {
                const updated = await onRemoveMembership(userId, companyId);
                setMembershipsUser(updated);
              } catch (err) {
                if (!ownerlessAlert(err)) throw err;
              }
            }}
          />
        )}

        <TeamPerformanceCard companies={companies} />

        <AuditLogCard companies={companies} />

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
                  <th className="font-medium px-4 py-2.5">Εταιρείες</th>
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
                      <button
                        onClick={() => setMembershipsUser(u)}
                        className="rounded-md px-2 py-1 text-xs border"
                        style={{ borderColor: C.line, color: C.ink }}
                      >
                        {(u.memberships || []).length === 0
                          ? "— καμία —"
                          : u.memberships.length === 1
                          ? u.memberships[0].companyName
                          : `${u.memberships.length} εταιρείες`}
                      </button>
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

  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesError, setCompaniesError] = useState("");

  // Team performance (Απόδοση ομάδας) fetches itself now — see
  // TeamPerformanceCard — since it needs to refetch on its own company filter
  // independently of the users list.
  const loadAdminUsers = useCallback(async () => {
    setAdminLoading(true);
    setAdminError("");
    try {
      setAdminUsers(await api.get("/admin/users"));
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
  // Additive — adds/updates a Membership without touching any other company
  // the user already belongs to (see admin.js). Returns the updated user
  // (with its fresh memberships list) so ManageMembershipsModal can refresh
  // itself without a full users reload round-trip.
  async function handleAddMembership(id, companyId, role) {
    const updated = await api.post(`/admin/users/${id}/assign-company`, { companyId, role });
    await loadAdminUsers();
    await loadCompanies(); // user counts per company shift when someone joins
    return updated;
  }
  async function handleRemoveMembership(id, companyId) {
    const updated = await api.del(`/admin/users/${id}/companies/${companyId}`);
    await loadAdminUsers();
    await loadCompanies();
    return updated;
  }
  async function handleCreateCompany(data) {
    await api.post("/admin/companies", data);
    await loadCompanies();
    // An existingOwnerUserId create can change that user's memberships/home
    // company — refresh the users list too so it's reflected immediately.
    await loadAdminUsers();
  }
  async function handleEditCompany(id, data) {
    await api.patch(`/admin/companies/${id}`, data);
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
          onAddMembership={handleAddMembership}
          onRemoveMembership={handleRemoveMembership}
          currentUserId={user.id}
          companies={companies}
          companiesLoading={companiesLoading}
          companiesError={companiesError}
          onReloadCompanies={loadCompanies}
          onCreateCompany={handleCreateCompany}
          onEditCompany={handleEditCompany}
          onSuspendCompany={handleSuspendCompany}
          onActivateCompany={handleActivateCompany}
        />
      </div>
    </div>
  );
}

export default SuperAdminApp;
