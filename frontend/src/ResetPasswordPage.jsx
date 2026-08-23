import { useState, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "./lib/api";
import { C, Card, Brand } from "./lib/ui.jsx";
import { t, useLang, LanguageSwitcher } from "./lib/i18n.jsx";

// Standalone page at /reset-password?token=... - the destination of the
// email link sent by AuthScreen's "forgot password" flow. Deliberately
// separate from AuthScreen (no login/register tabs, no existing session
// needed) since resetting a password is, by definition, something you do
// without being logged in. Split into its own file (see main.jsx) so this
// tiny page doesn't pull in the entire main-app bundle just to render a
// two-field form.
export function ResetPasswordPage() {
  useLang();
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") || "", []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError(t("Οι κωδικοί δεν ταιριάζουν."));
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/reset-password", { token, password });
      setDone(true);
    } catch (err) {
      // Every failure mode here (bad/expired/reused token, or even a
      // malformed one) boils down to the same actionable advice for a real
      // user - never show them a raw backend error code like
      // "invalid_request" or "invalid_or_expired_token".
      setError(t("Ο σύνδεσμος επαναφοράς δεν είναι έγκυρος ή έχει λήξει. Ζήτησε νέο σύνδεσμο από την οθόνη σύνδεσης."));
    } finally {
      setPassword("");
      setConfirmPassword("");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full items-center justify-center" style={{ backgroundColor: "#F7F9FC", fontFamily: "Inter, sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-3">
          <Brand size={38} textSize="text-2xl" />
        </div>
        <div className="flex items-center justify-center mb-8">
          <LanguageSwitcher compact />
        </div>

        <Card className="p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: C.ink }}>{t("Νέος κωδικός πρόσβασης")}</h3>

          {!token ? (
            <p className="text-sm" style={{ color: C.coral }}>
              {t("Μη έγκυρος σύνδεσμος επαναφοράς. Ζήτησε νέο σύνδεσμο από την οθόνη σύνδεσης.")}
            </p>
          ) : done ? (
            <div className="space-y-3">
              <p className="text-sm rounded-lg px-3 py-2" style={{ backgroundColor: `${C.mint}14`, color: C.mint }}>
                {t("Ο κωδικός άλλαξε επιτυχώς.")}
              </p>
              <a href="/" className="block w-full text-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: C.sky }}>
                {t("Σύνδεση")}
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Νέος κωδικός")}</label>
                <input
                  type="password"
                  required
                  minLength={10}
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm border outline-none"
                  style={{ borderColor: C.line, color: C.ink }}
                  autoComplete="new-password"
                />
                <p className="text-[11px] mt-1" style={{ color: C.slate }}>{t("Τουλάχιστον 10 χαρακτήρες.")}</p>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: C.slate }}>{t("Επιβεβαίωση κωδικού")}</label>
                <input
                  type="password"
                  required
                  minLength={10}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm border outline-none"
                  style={{ borderColor: C.line, color: C.ink }}
                  autoComplete="new-password"
                />
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
                {t("Αλλαγή κωδικού")}
              </button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}

export default ResetPasswordPage;
