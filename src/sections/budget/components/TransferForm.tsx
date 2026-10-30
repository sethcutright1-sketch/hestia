import React, { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { BankConnection } from '../types';

interface TransferFormProps {
  bankConnections: BankConnection[];
  onTransfer: (fromAccountId: string, toAccountId: string, amount: number) => void;
  currency?: string;
}

export default function TransferForm({ bankConnections, onTransfer, currency = '$' }: TransferFormProps) {
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');

  const hasEnoughAccounts = bankConnections.length >= 2;
  const numericAmount = parseFloat(amount);
  const isValid =
    hasEnoughAccounts &&
    fromId &&
    toId &&
    fromId !== toId &&
    !Number.isNaN(numericAmount) &&
    numericAmount > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    onTransfer(fromId, toId, numericAmount);
    setAmount('');
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl shadow-3xs">
      <div className="flex items-center gap-1.5 mb-2">
        <ArrowRightLeft className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        <h4 className="font-extrabold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider">Transfer Between Accounts</h4>
      </div>

      {!hasEnoughAccounts ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed mt-2">
          Link at least 2 accounts above to move money between them.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-2.5 mt-3">
          <select
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            className="w-full px-3 py-2 text-xs text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-800 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none cursor-pointer"
          >
            <option value="">From account...</option>
            {bankConnections.map((b) => (
              <option key={b.id} value={b.id}>
                {b.bankName} — {b.accountName}
              </option>
            ))}
          </select>

          <select
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            className="w-full px-3 py-2 text-xs text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-800 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none cursor-pointer"
          >
            <option value="">To account...</option>
            {bankConnections
              .filter((b) => b.id !== fromId)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.bankName} — {b.accountName}
                </option>
              ))}
          </select>

          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-xs">{currency}</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full pl-6 pr-3 py-2 text-xs text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-800 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none"
            />
          </div>

          {fromId && toId && fromId === toId && (
            <p className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">From and To accounts must be different.</p>
          )}

          <button
            type="submit"
            disabled={!isValid}
            className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 dark:disabled:bg-indigo-900/50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
          >
            Transfer Funds
          </button>
        </form>
      )}
    </div>
  );
}
