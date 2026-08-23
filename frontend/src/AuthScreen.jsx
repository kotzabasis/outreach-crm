import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "./lib/api";
import { C, Card, Brand } from "./lib/ui.jsx";
import { t, useLang, LanguageSwitcher } from "./lib/i18n.jsx";

// Shared between the main App (default screen) and SuperAdminApp (/superadmin)
// - both are gated behind the same login, just with a different destination
// afterwards. Kept in its own file so both entry points can import it without
// either one pulling in the other's code (see main.jsx for the lazy-loaded
// split).
export function AuthScreen({ onAuthenticated }) {
  useLang(); // re-render on language switch
  const [mode, setMode] = useState("login"); // "login" | "register" | "forgot"
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
      } else if (mode === "forgot") {
        // Backend always responds the same way whether or not the email
        // exists (see auth.js) - nothing to branch on here, just show its
        // message and drop back to the login tab.
        const result = await api.post("/auth/forgot-password", { email });
        setInfo(result?.message || t("Αν υπάρχει λογαριασμός με αυτό το email, στάλθηκε σύνδεσμος επαναφοράς."));
        setMode("login");
      } else {
        const result = await api.post("/auth/register", { email, password, name: name || undefined });
        if (result && result.pending) {
          // Access is invite/approval-gated - new accounts wait for an admin.
          setInfo(result.message || t("Ο λογαριασμός δημιουργήθηκε. Περιμένει έγκριση από διαχειριστή."));
          setMode("login");
        } else {
          onAuthenticated(result);
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.data?.error === "account_pending_approval") {
        setError(t("Ο λογαριασμός σου εκκρεμεί έγκρισης από διαχειριστή. Δοκίμασε ξανά αργότερα."));
      } else if (err instanceof ApiError && err.status === 403 && err.data?.error === "company_suspended") {
        setError(t("Το workspace της εταιρείας σου έχει ανασταλεί. Επικοινώνησε με τον διαχειριστή."));
      } else {
        setError(err instanceof ApiError ? err.message : t("Κάτι πήγε στραβά. Δοκίμασε ξανά."));
      }
    } finally {
      // Never leave the password sitting in memory longer than necessary,
      // success or failure.
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full items-center justify-center" style={{ backgroundColor: C.canvas, fontFamily: "Inter, sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center justify-center mb-8 gap-3">
          <Brand size={38} textSize="text-2xl" />
          <LanguageSwitcher compact />
        </div>

        <Card className="p-6">
          {mode === "forgot" ? (
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold" style={{ color: C.ink }}>{t("Επαναφορά κωδικού")}</h3>
              <button type="button" onClick={() => switchMode("login")} className="text-xs font-medium" style={{ color: C.sky }}>
                {t("Πίσω στη σύνδεση")}
              </button>
            </div>
          ) : (
            <div className="flex rounded-lg p-1 mb-5" style={{ backgroundColor: C.pale }}>
              {["login", "register"].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  className="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
                  style={{ backgroundColor: mode === m ? C.surface : "transparent", color: mode === m ? C.navy : C.slate }}
                >
                  {m === "login" ? t("Σύνδεση") : t("Εγγραφή")}
                </button>
              ))}
            </div>
          )}

          {info && (
            <p className="text-xs rounded-lg px-3 py-2 mb-3" style={{ backgroundColor: `${C.mint}14`, color: C.mint }}>{info}</p>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === "register" && (
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Όνομα")}</label>
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
            {mode !== "forgot" && (
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Κωδικός")}</label>
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
                  <p className="text-[11px] mt-1" style={{ color: C.slate }}>{t("Τουλάχιστον 10 χαρακτήρες.")}</p>
                )}
                {mode === "login" && (
                  <button type="button" onClick={() => switchMode("forgot")} className="text-[11px] font-medium mt-1.5" style={{ color: C.sky }}>
                    {t("Ξέχασες τον κωδικό;")}
                  </button>
                )}
              </div>
            )}

            {mode === "register" && (
              <p className="text-[11px] rounded-lg px-3 py-2" style={{ backgroundColor: C.pale, color: C.navy }}>
                {t("Η πρόσβαση εγκρίνεται από διαχειριστή - μετά την εγγραφή θα περιμένεις έγκριση πριν μπορέσεις να συνδεθείς.")}
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
              {mode === "login" ? t("Σύνδεση") : mode === "forgot" ? t("Αποστολή συνδέσμου") : t("Δημιουργία λογαριασμού")}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}

export default AuthScreen;
