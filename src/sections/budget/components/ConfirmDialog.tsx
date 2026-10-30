// src/sections/budget/components/ConfirmDialog.tsx -- an in-app replacement
// for window.confirm(), which the desktop app's embedded browser (and some
// kiosk browsers) block outright -- window.prompt() already threw "prompt()
// is not supported" there, and window.confirm() was silently failing the
// same way, so the confirmation just never happened and the delete/reset
// action ran unconfirmed (or, depending on the browser's stub return value,
// never ran at all). useConfirm() returns a `confirm()` function with the
// same "ask, then act" shape as window.confirm, plus a `dialog` element that
// the caller renders once; Budget.tsx renders it and hands `confirm` down
// into useBudgetStore and SettingsModal exactly like `showToast`.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: 'danger' | 'default';
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function useConfirm(): { confirm: ConfirmFn; dialog: ReactNode } {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const close = useCallback((result: boolean) => {
    setPending((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  // Focus a button once the dialog mounts, so a keyboard user lands somewhere
  // sensible -- Cancel for a destructive action (a stray Enter must never be
  // the thing that deletes data), the confirm button otherwise.
  useEffect(() => {
    if (!pending) return;
    const target = pending.tone === 'danger' ? cancelButtonRef : confirmButtonRef;
    const id = window.setTimeout(() => target.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pending, close]);

  const dialog = pending ? (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-slate-950/60 dark:bg-slate-950/75 backdrop-blur-xs p-0 sm:p-4"
      onClick={() => close(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-150"
      >
        <div className="space-y-1.5">
          <h3 id="confirm-dialog-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">
            {pending.title}
          </h3>
          <p id="confirm-dialog-message" className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed whitespace-pre-line">
            {pending.message}
          </p>
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={() => close(false)}
            className="w-full py-2.5 px-4 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer min-h-11 sm:min-h-0"
          >
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={() => close(true)}
            className={`w-full py-2.5 px-4 rounded-xl text-xs font-bold text-white transition-colors cursor-pointer min-h-11 sm:min-h-0 ${
              pending.tone === 'danger' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {pending.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}
