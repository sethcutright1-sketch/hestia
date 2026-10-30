import { useState } from "react";
import { Home, Loader2 } from "lucide-react";
import { api, type AuthStatus, type SessionUser } from "./api.ts";

interface Props {
  status: AuthStatus;
  onSignedIn: (user: SessionUser) => void;
}

// One sign-in for the whole app. The household is capped at two accounts, so once
// both exist this only ever offers login.
export default function AuthGate({ status, onSignedIn }: Props) {
  const [mode, setMode] = useState<"login" | "register">(status.canRegister && status.userCount === 0 ? "register" : "login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [householdPin, setHouseholdPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body = mode === "register" ? { username, password, displayName, pin: householdPin } : { username, password };
      const res = await api.post<{ user: SessionUser }>(`/api/auth/${mode}`, body);
      onSignedIn(res.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="p-2 rounded-xl bg-blue-600 text-white">
            <Home size={20} />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Household</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {mode === "register" ? "Create your account" : "Sign in to continue"}
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />

          {mode === "register" && (
            <input
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              placeholder="Display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}

          <input
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            type="password"
            placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {mode === "register" && (
            <>
              <input
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                type="text"
                inputMode="numeric"
                placeholder="Household PIN"
                value={householdPin}
                onChange={(e) => setHouseholdPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Ask whoever set up this household's app for the household PIN.
              </p>
            </>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={busy || !username || !password || (mode === "register" && !householdPin)}
            className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium flex items-center justify-center gap-2"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {mode === "register" ? "Create account" : "Sign in"}
          </button>
        </form>

        {status.canRegister && (
          <button
            onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}
            className="mt-4 w-full text-sm text-slate-500 dark:text-slate-400 hover:underline"
          >
            {mode === "login" ? "Set up the second household account" : "Already have an account? Sign in"}
          </button>
        )}
      </div>
    </div>
  );
}
