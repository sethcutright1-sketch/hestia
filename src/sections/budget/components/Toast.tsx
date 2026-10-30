// src/sections/budget/components/Toast.tsx -- the Budget panel's toast queue
// and the useToast() hook that owns it. Every store handler and the shell
// itself call showToast() to surface a message. Phase 3 replaces the old
// single-slot "Automated Budget Monitor" banner (every new toast silently
// replaced whatever was showing) with a real queue: up to 3 visible at once,
// newest last, each with its own 6s auto-dismiss timer and close button.

import { useCallback, useRef, useState } from 'react';
import { CheckCircle2, Info, AlertTriangle, AlertOctagon, X } from 'lucide-react';

export interface ToastState {
  id: string;
  message: string;
  type: string;
  action?: { label: string; onClick: () => void };
}

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 6000;

export function useToast() {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  // A plain incrementing counter, not Date.now() -- two toasts fired in the
  // same millisecond (e.g. a batch of threshold alerts) used to collide on a
  // `toast-${Date.now()}` id, and the second silently clobbered the first.
  const nextId = useRef(0);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // `action` renders one button on the toast (e.g. "Undo") that runs the given
  // callback and dismisses that toast when clicked. Still auto-dismisses after
  // 6s either way, matching every other toast's lifetime. Only the most recent
  // MAX_VISIBLE toasts are kept on screen -- older ones are dropped rather than
  // scrolled off, so a burst of alerts can't wall off the page behind a stack.
  const showToast = useCallback((message: string, type: string, action?: { label: string; onClick: () => void }) => {
    const id = `toast-${nextId.current++}`;
    setToasts((prev) => [...prev, { id, message, type, action }].slice(-MAX_VISIBLE));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  return { toasts, showToast, dismissToast };
}

const TYPE_STYLES: Record<string, { wrap: string; icon: React.ComponentType<{ className?: string }>; iconClass: string }> = {
  critical: {
    wrap: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/60 text-red-900 dark:text-red-200',
    icon: AlertOctagon,
    iconClass: 'text-red-600 dark:text-red-400',
  },
  warning: {
    wrap: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200',
    icon: AlertTriangle,
    iconClass: 'text-amber-600 dark:text-amber-400',
  },
  success: {
    wrap: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60 text-emerald-900 dark:text-emerald-200',
    icon: CheckCircle2,
    iconClass: 'text-emerald-600 dark:text-emerald-400',
  },
  info: {
    wrap: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200',
    icon: Info,
    iconClass: 'text-slate-500 dark:text-slate-400',
  },
};

function ToastRow({ toast, onDismiss }: { toast: ToastState; onDismiss: (id: string) => void }) {
  const styles = TYPE_STYLES[toast.type] || TYPE_STYLES.info;
  const Icon = styles.icon;
  return (
    <div
      className={`pointer-events-auto p-3.5 rounded-2xl shadow-lg border flex items-start gap-2.5 animate-in slide-in-from-bottom-2 sm:slide-in-from-right-4 fade-in duration-200 w-full sm:max-w-sm ${styles.wrap}`}
    >
      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${styles.iconClass}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-relaxed">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="mt-2 px-2.5 py-1 bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 border border-black/10 dark:border-white/20 rounded-lg text-[11px] font-bold uppercase tracking-wide cursor-pointer transition-colors"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="shrink-0 p-1.5 -m-1 rounded-lg text-current opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// Bottom, full-width-minus-gutters on phones; top-right and capped to max-w-sm
// from `sm` up -- a full-width toast on a phone is easy to read one-handed
// without covering the header controls up top. On phones the bottom offset
// also has to clear the Transactions tab's sticky bulk-action bar when it's
// showing -- both sit at the bottom, and a toast used to render right on top
// of the bulk bar's Delete button. TransactionList sets
// --budget-bottom-offset on #budget-root to that bar's measured height (and
// clears it when the bar isn't mounted); this reads it with a 0px fallback so
// nothing changes when the bar is absent. Irrelevant from `sm` up, where
// `sm:bottom-auto` takes over regardless of the custom property's value.
export function BudgetToast({ toasts, onDismiss }: { toasts: ToastState[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-50 pointer-events-none flex flex-col gap-2 left-4 right-4 bottom-[calc(1rem+var(--budget-bottom-offset,0px))] items-stretch sm:left-auto sm:right-5 sm:top-5 sm:bottom-auto sm:items-end"
      id="budget-toast-stack"
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
