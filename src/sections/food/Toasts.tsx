// The Food section's toasts: a short message that fades after a few seconds, with an optional action
// (Undo). Its own small queue rather than the money Budget's, so the two sections share nothing.

import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";

export interface FoodToast {
  id: number;
  message: string;
  tone: "info" | "error";
  action?: { label: string; onClick: () => void };
}

const MAX_VISIBLE = 3;
/** Long enough to read, and to reach Undo with a thumb. */
const AUTO_DISMISS_MS = 8000;

export function useFoodToasts() {
  const [toasts, setToasts] = useState<FoodToast[]>([]);
  const next = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback((message: string, opts: { tone?: "info" | "error"; action?: FoodToast["action"] } = {}) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, message, tone: opts.tone ?? "info", action: opts.action }].slice(-MAX_VISIBLE));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), AUTO_DISMISS_MS);
  }, []);

  return { toasts, show, dismiss };
}

export function FoodToasts({ toasts, onDismiss }: { toasts: FoodToast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed z-[70] left-4 right-4 bottom-4 flex flex-col items-center gap-2 pointer-events-none" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto w-full max-w-md flex items-start gap-2 rounded-2xl border shadow-lg px-3.5 py-3 text-sm ${
            t.tone === "error"
              ? "bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-900 text-red-900 dark:text-red-200"
              : "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100"
          }`}
        >
          <p className="flex-1 min-w-0 break-words">{t.message}</p>
          {t.action && (
            <button
              onClick={() => {
                t.action?.onClick();
                onDismiss(t.id);
              }}
              className="shrink-0 px-2.5 py-1 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-xs font-bold uppercase tracking-wide"
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => onDismiss(t.id)} aria-label="Dismiss" className="shrink-0 p-1 -m-1 rounded-lg opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
