// The keypad in front of Budget, the database backup, and the assistant's
// financial tools once a PIN is configured (see auth.ts's requireUnlocked and
// routes/lock.ts). Deliberately large touch targets and inputMode="numeric" --
// this is the one dialog most likely to be operated with a whole finger on a
// fridge door screen, not a mouse.
import { useState } from "react";
import { Delete, Lock } from "lucide-react";
import { api, ApiError } from "./api.ts";

const MAX_PIN_LENGTH = 6;

export default function PinPrompt({
  defaultTrusted,
  onClose,
  onUnlocked,
}: {
  /** Pre-checks "keep this device unlocked longer" outside kiosk mode, where
   *  the household's own devices are the common case and the fridge (the one
   *  place that shouldn't stay unlocked) is the exception, not the rule. */
  defaultTrusted: boolean;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const [pin, setPin] = useState("");
  const [trusted, setTrusted] = useState(defaultTrusted);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function press(digit: string) {
    setError(null);
    setPin((p) => (p.length < MAX_PIN_LENGTH ? p + digit : p));
  }

  async function submit() {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/lock/unlock", { code: pin, trusted });
      onUnlocked();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Wait a minute and try again.");
      } else {
        setError("Incorrect PIN.");
      }
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] bg-slate-950/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-full max-w-xs rounded-2xl shadow-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-slate-100">
          <Lock size={16} /> Enter PIN
        </div>

        {/* Dots, not the digits themselves -- this is meant to be entered in a
            kitchen with other people around. */}
        <div className="flex items-center justify-center gap-2 py-1" aria-live="polite">
          {Array.from({ length: MAX_PIN_LENGTH }).map((_, i) => (
            <div
              key={i}
              className={`w-3.5 h-3.5 rounded-full border-2 ${
                i < pin.length
                  ? "bg-blue-600 border-blue-600"
                  : "border-slate-300 dark:border-slate-700"
              }`}
            />
          ))}
        </div>

        {error && <p className="text-xs font-medium text-rose-600 text-center">{error}</p>}

        <div className="grid grid-cols-3 gap-2">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => press(d)}
              className="py-3.5 rounded-xl text-lg font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100"
            >
              {d}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPin("")}
            className="py-3.5 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => press("0")}
            className="py-3.5 rounded-xl text-lg font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => setPin((p) => p.slice(0, -1))}
            aria-label="Backspace"
            className="py-3.5 rounded-xl flex items-center justify-center bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"
          >
            <Delete size={16} />
          </button>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={trusted}
            onChange={(e) => setTrusted(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-700"
          />
          Keep this device unlocked longer
        </label>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pin.length < 4 || busy}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold"
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}
