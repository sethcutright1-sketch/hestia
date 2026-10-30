// A checkbox whose ON direction sends data somewhere it wasn't going before, so it asks for the account password
// first; OFF only makes things safer and saves straight away. Used by AdminSettings' Security tab for the cloud-finance
// switches and the grocery-budget switch, and by AdminFood.tsx for the cloud-health switches, which all follow the same
// rule server-side (routes/assistant.ts). Lives in its own file so AdminFood.tsx can use it without importing AdminSettings.
import { useState } from "react";
import { ApiError } from "./api.ts";

/**
 * One cloud provider's "may see financial data" switch. Rendered once per
 * provider so each has its own password form, busy flag and error line --
 * a failed Gemini enable must not show up under Claude's toggle. Enabling goes
 * through the password form (PUT /api/assistant/settings/cloud-finance checks
 * it); disabling is one click, since it only moves data back behind the
 * local-only boundary.
 */
// A checkbox whose ON direction sends data somewhere it wasn't going before,
// so it asks for the account password first; OFF only makes things safer and
// saves straight away. Shared by the cloud-finance switches and the grocery
// budget switch, which follow the same rule server-side.
export function PasswordGatedToggle({
  label,
  description,
  enabled,
  onSave,
  confirmLabel,
  enabledNote,
  extraWarning,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onSave: (allow: boolean, password?: string) => Promise<void>;
  confirmLabel: string;
  enabledNote: string;
  extraWarning?: string;
}) {
  const [showForm, setShowForm] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(allow: boolean, pw?: string) {
    setBusy(true);
    setError("");
    try {
      await onSave(allow, pw);
      setShowForm(false);
      setPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  function handleToggle() {
    if (enabled) {
      save(false);
    } else {
      setError("");
      setShowForm((v) => !v);
    }
  }

  return (
    <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={handleToggle} className="mt-0.5 shrink-0" />
        <span>
          <span className="block text-xs font-bold text-slate-700 dark:text-slate-300">{label}</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400 leading-normal mt-0.5">{description}</span>
        </span>
      </label>
      {extraWarning && (
        <p className="text-xs leading-normal text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-2.5 py-2">
          <span className="font-bold">Warning: </span>
          {extraWarning}
        </p>
      )}
      {enabled && <p className="text-xs font-medium text-amber-600 dark:text-amber-400">{enabledNote}</p>}
      {showForm && !enabled && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(true, password);
          }}
          className="space-y-2"
        >
          <input
            type="password"
            required
            autoComplete="current-password"
            className="w-full px-2.5 py-1.5 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-xs"
            placeholder="Account password to confirm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg text-xs font-bold text-white"
          >
            {confirmLabel}
          </button>
        </form>
      )}
      {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
