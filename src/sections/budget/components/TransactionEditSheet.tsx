// src/sections/budget/components/TransactionEditSheet.tsx -- the Transactions
// tab's row editor: tapping/clicking a row (not one of its inline controls)
// opens this instead of the old "click a cell to change just that one field"
// pattern. Same bottom-sheet-on-phones/centered-card-on-sm+ visual language as
// ConfirmDialog.tsx, including its focus/Esc/backdrop handling, since this is
// the same class of "modal floating over the tab" as that dialog.

import { useEffect, useRef, useState } from 'react';
import { X, Info } from 'lucide-react';
import type { Transaction } from '../types';
import type { BankConnection } from '../types';

export interface TransactionEditPatch {
  date?: string;
  merchantName?: string;
  amount?: number;
  category?: string;
  scope?: 'personal' | 'joint';
}

interface TransactionEditSheetProps {
  transaction: Transaction;
  categories: string[];
  bankConnections: BankConnection[];
  currency: string;
  onSave: (id: string, patch: TransactionEditPatch) => void;
  onClose: () => void;
}

export default function TransactionEditSheet({
  transaction,
  categories,
  bankConnections,
  currency,
  onSave,
  onClose,
}: TransactionEditSheetProps) {
  const isTransferLeg = Boolean(transaction.transferId);
  // Plaid-synced rows carry accountId = the CONNECTION's plaidAccountId (not
  // its own id) -- see handleUpdateBankScope's comment in useBudgetStore.ts,
  // the one other place that same match is made.
  const isBankSynced = Boolean(
    transaction.accountId && bankConnections.some((b) => b.plaidAccountId === transaction.accountId)
  );
  const amountDateLocked = isTransferLeg || isBankSynced;

  const [date, setDate] = useState(transaction.date);
  const [merchantName, setMerchantName] = useState(transaction.merchantName);
  const [kind, setKind] = useState<'expense' | 'income'>(transaction.amount < 0 ? 'expense' : 'income');
  const [magnitude, setMagnitude] = useState(String(Math.abs(transaction.amount)));
  const [category, setCategory] = useState(transaction.category);
  const [scope, setScope] = useState<'personal' | 'joint'>(transaction.scope || 'personal');

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedMagnitude = parseFloat(magnitude);
    const patch: TransactionEditPatch = {
      merchantName: merchantName.trim() || transaction.merchantName,
      category: isTransferLeg ? 'Transfer' : category,
      scope,
    };
    if (!amountDateLocked) {
      patch.date = date;
      if (Number.isFinite(parsedMagnitude) && parsedMagnitude > 0) {
        patch.amount = kind === 'expense' ? -Math.abs(parsedMagnitude) : Math.abs(parsedMagnitude);
      }
    }
    onSave(transaction.id, patch);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-slate-950/60 dark:bg-slate-950/75 backdrop-blur-xs p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-edit-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 id="tx-edit-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Edit transaction
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center min-h-10 min-w-10 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {(isTransferLeg || isBankSynced) && (
          <div className="flex items-start gap-2 p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/25 border border-amber-200/70 dark:border-amber-900/60 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {isTransferLeg
                ? 'This is one leg of a transfer -- edit transfers by deleting and re-creating them. The amount, date, and category are fixed.'
                : "Comes from your bank -- the next sync would overwrite date or amount changes, so those are fixed here."}
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="tx-edit-date" className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Date
              </label>
              <input
                id="tx-edit-date"
                type="date"
                value={date}
                disabled={amountDateLocked}
                onChange={(e) => setDate(e.target.value)}
                className="w-full min-h-10 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:bg-slate-100 dark:disabled:bg-slate-900 disabled:text-slate-400 dark:disabled:text-slate-500 rounded-lg outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Mine / Joint
              </label>
              <div className="flex p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg" role="group" aria-label="Scope">
                <button
                  type="button"
                  onClick={() => setScope('personal')}
                  aria-pressed={scope === 'personal'}
                  className={`flex-1 min-h-9 px-2 text-[11px] font-bold rounded-md transition-all cursor-pointer ${
                    scope === 'personal'
                      ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-400 shadow-xs'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  Mine
                </button>
                <button
                  type="button"
                  onClick={() => setScope('joint')}
                  aria-pressed={scope === 'joint'}
                  className={`flex-1 min-h-9 px-2 text-[11px] font-bold rounded-md transition-all cursor-pointer ${
                    scope === 'joint'
                      ? 'bg-white dark:bg-slate-700 text-sky-700 dark:text-sky-400 shadow-xs'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  Joint
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="tx-edit-merchant" className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Merchant name
            </label>
            <input
              ref={firstFieldRef}
              id="tx-edit-merchant"
              type="text"
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}
              className="w-full min-h-10 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40"
            />
          </div>

          {transaction.description !== transaction.merchantName && (
            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Original description
              </label>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 px-2.5 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 rounded-lg break-words">
                {transaction.description}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Amount
              </label>
              <div className="flex items-center gap-1.5">
                <div className="flex p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg shrink-0" role="group" aria-label="Transaction type">
                  <button
                    type="button"
                    disabled={amountDateLocked}
                    onClick={() => setKind('expense')}
                    aria-pressed={kind === 'expense'}
                    className={`min-h-9 px-2 text-[10px] font-bold uppercase rounded-md transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
                      kind === 'expense'
                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    Exp
                  </button>
                  <button
                    type="button"
                    disabled={amountDateLocked}
                    onClick={() => setKind('income')}
                    aria-pressed={kind === 'income'}
                    className={`min-h-9 px-2 text-[10px] font-bold uppercase rounded-md transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
                      kind === 'income'
                        ? 'bg-white dark:bg-slate-700 text-emerald-700 dark:text-emerald-400 shadow-xs'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    Inc
                  </button>
                </div>
                <div className="relative flex-1 min-w-0">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-xs">{currency}</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    disabled={amountDateLocked}
                    value={magnitude}
                    onChange={(e) => setMagnitude(e.target.value)}
                    className="w-full min-h-10 pl-5 pr-2 py-1.5 text-xs text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:bg-slate-100 dark:disabled:bg-slate-900 disabled:text-slate-400 dark:disabled:text-slate-500 rounded-lg outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="tx-edit-category" className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Category
              </label>
              <select
                id="tx-edit-category"
                value={isTransferLeg ? 'Transfer' : category}
                disabled={isTransferLeg}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full min-h-10 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 disabled:bg-slate-100 dark:disabled:bg-slate-900 disabled:text-slate-400 dark:disabled:text-slate-500 rounded-lg outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 cursor-pointer disabled:cursor-not-allowed"
              >
                {(isTransferLeg ? ['Transfer'] : categories).map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 px-4 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer min-h-11"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="w-full py-2.5 px-4 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors cursor-pointer min-h-11"
            >
              Save changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
