// Small shared pieces of the Food section: the class strings every form control uses, a labelled
// field, a status line, and the bottom-sheet / centred-panel the section's dialogs open in.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export const inputCls =
  "w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500";
export const btnPrimary =
  "px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
export const btnSecondary =
  "px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium text-slate-800 dark:text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed";
export const btnDanger =
  "px-4 py-2.5 rounded-lg border border-red-300 dark:border-red-900 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-sm font-medium disabled:opacity-50";
export const chipCls =
  "px-2.5 py-1 rounded-full border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
export const chipPrimaryCls =
  "px-2.5 py-1 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50";
export const mutedCls = "text-slate-500 dark:text-slate-400";
/** A card in the Food section's single column. */
export const cardCls = "rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4";

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-slate-600 dark:text-slate-400">
        {label}
      </label>
      {children}
      {hint && <p className={`text-xs ${mutedCls}`}>{hint}</p>}
    </div>
  );
}

const NOTICE_TONES = {
  error: "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60",
  warn: "text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60",
  ok: "text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60",
  info: "text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700",
} as const;

/** A short status or error line. role="alert" for errors so a screen reader says it. */
export function Notice({ tone = "info", children }: { tone?: keyof typeof NOTICE_TONES; children: ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`text-sm rounded-lg border px-3 py-2 ${NOTICE_TONES[tone]}`}>
      {children}
    </p>
  );
}

/**
 * The dialog the Food section's sheets use: a bottom sheet on a phone, a centred panel from `md` up,
 * both over the single centred column (never a second column). Escape and a tap outside close it.
 */
export function Sheet({ title, onClose, children, back }: { title: string; onClose: () => void; children: ReactNode; back?: { label: string; onClick: () => void } }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Land focus inside the dialog, and give it back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Unless something inside (an autoFocus field) already took it.
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // An on-screen keyboard (the fridge tablet's) overlays the page without resizing it, so size the
  // dialog to the visible area instead, or the keyboard covers the options at the sheet's bottom.
  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      setView({ top: vv.offsetTop, height: vv.height });
      // Keep the field being typed in on screen once the keyboard has shrunk the area.
      const el = document.activeElement as HTMLElement | null;
      if (el && panelRef.current?.contains(el) && el.matches("input, textarea, select")) el.scrollIntoView({ block: "nearest" });
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  // Some kiosk browsers (the Family Hub's) never report the keyboard at all. When a text field is
  // focused and the visible area hasn't shrunk, park the dialog at the top, in the half the keyboard
  // can't reach.
  const [typing, setTyping] = useState(false);
  const blurTimer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(blurTimer.current), []);
  const keyboardReported = view !== null && view.height < window.innerHeight * 0.85;
  const dodge = typing && !keyboardReported;

  return (
    <div
      className={`fixed inset-x-0 z-50 flex justify-center bg-slate-950/50 dark:bg-slate-950/70 ${dodge ? "items-start" : "items-end md:items-center"}`}
      style={view ? { top: view.top, height: view.height } : { top: 0, bottom: 0 }}
      onClick={onClose}
      onFocus={(e) => {
        window.clearTimeout(blurTimer.current);
        setTyping(e.target instanceof HTMLElement && e.target.matches("input:not([type=checkbox]):not([type=radio]), textarea"));
      }}
      // Late, so a tap on a button (which blurs the field first) isn't moved out from under the finger.
      onBlur={() => {
        window.clearTimeout(blurTimer.current);
        blurTimer.current = window.setTimeout(() => setTyping(false), 400);
      }}
    >
      <div
        ref={panelRef}
        style={dodge ? { maxHeight: window.innerHeight * 0.5 } : view ? { maxHeight: view.height * 0.92 } : undefined}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full md:max-w-lg max-h-[92dvh] md:max-h-[85vh] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl md:rounded-2xl shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
          {back && (
            <button onClick={back.onClick} className="text-sm text-blue-600 dark:text-blue-400 hover:underline shrink-0">
              {back.label}
            </button>
          )}
          <h3 className="flex-1 min-w-0 truncate font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 -mr-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}
