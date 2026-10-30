import React, { useState } from 'react';
import { Plus, Trash2, Link as LinkIcon, PiggyBank, CheckCircle2 } from 'lucide-react';
import { SavingsGoal, BankConnection } from '../types';

interface FinancialGoalsProps {
  goals: SavingsGoal[];
  onAddGoal: (goal: SavingsGoal) => void;
  onUpdateGoal: (id: string, updates: Partial<SavingsGoal>) => void;
  onDeleteGoal: (id: string) => void;
  bankConnections: BankConnection[];
  currency?: string;
}

function goalProgress(goal: SavingsGoal, bankConnections: BankConnection[]): number {
  if (goal.linkedBankConnectionId) {
    const linked = bankConnections.find((b) => b.id === goal.linkedBankConnectionId);
    return linked ? linked.balance : 0;
  }
  return goal.manualAmount || 0;
}

export default function FinancialGoals({
  goals,
  onAddGoal,
  onUpdateGoal,
  onDeleteGoal,
  bankConnections,
  currency = '$',
}: FinancialGoalsProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [scope, setScope] = useState<'personal' | 'joint'>('personal');
  const [linkedId, setLinkedId] = useState<string>('');
  const [manualAddAmount, setManualAddAmount] = useState<Record<string, string>>({});

  const savingsAccounts = bankConnections.filter((b) => b.accountType === 'savings');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(targetAmount);
    if (!name.trim() || isNaN(amount) || amount <= 0) return;

    onAddGoal({
      id: `goal-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      name: name.trim(),
      targetAmount: amount,
      scope,
      linkedBankConnectionId: linkedId || undefined,
      manualAmount: linkedId ? undefined : 0,
      alertedMilestones: [],
    });

    setName('');
    setTargetAmount('');
    setLinkedId('');
    setIsAdding(false);
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs flex flex-col max-w-4xl mx-auto" id="financial-goals">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-5 mb-5 shrink-0">
        <div className="flex flex-col gap-1">
          <h3 className="font-bold text-gray-900 dark:text-slate-100 text-base">
            Goals
          </h3>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Link a goal to a real linked savings account for automatic progress, or track one manually.
          </p>
        </div>
        <button
          onClick={() => setIsAdding((v) => !v)}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer self-start sm:self-auto"
        >
          <Plus className="w-3.5 h-3.5" /> New Goal
        </button>
      </div>

      {isAdding && (
        <form onSubmit={handleSubmit} className="p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl space-y-3 mb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Goal Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. New Car Down Payment"
                className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Target Amount</label>
              <input
                type="number"
                required
                min="1"
                step="0.01"
                value={targetAmount}
                onChange={(e) => setTargetAmount(e.target.value)}
                placeholder="5000"
                className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Scope</label>
              <select value={scope} onChange={(e) => setScope(e.target.value as 'personal' | 'joint')} className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
                <option value="personal">Mine</option>
                <option value="joint">Joint</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Link to Savings Account (optional)</label>
              <select value={linkedId} onChange={(e) => setLinkedId(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
                <option value="">— Track manually instead —</option>
                {savingsAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>{acc.accountName} ({acc.bankName})</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setIsAdding(false)} className="flex-1 py-2 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-xs font-bold cursor-pointer text-slate-700 dark:text-slate-300">Cancel</button>
            <button type="submit" className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold cursor-pointer">Create Goal</button>
          </div>
        </form>
      )}

      {goals.length === 0 ? (
        <div className="py-10 text-center text-slate-400">
          <PiggyBank className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-xs font-semibold">No savings goals yet. Create one to start tracking progress.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {goals.map((goal) => {
            const current = goalProgress(goal, bankConnections);
            const pct = Math.min(100, (current / goal.targetAmount) * 100);
            const linked = goal.linkedBankConnectionId ? bankConnections.find((b) => b.id === goal.linkedBankConnectionId) : null;
            return (
              <div key={goal.id} className="p-4 border border-slate-200 dark:border-slate-800 rounded-xl">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate flex items-center gap-1.5">
                      {goal.name}
                      {pct >= 100 && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                      {linked && (
                        <span title={`Linked to ${linked.accountName}`}>
                          <LinkIcon className="w-3 h-3 text-indigo-400 dark:text-indigo-500 shrink-0" />
                        </span>
                      )}
                    </p>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                      {currency}{current.toLocaleString(undefined, { minimumFractionDigits: 2 })} / {currency}{goal.targetAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} · {goal.scope === 'joint' ? 'Joint' : 'Mine'}
                    </p>
                  </div>
                  <button onClick={() => onDeleteGoal(goal.id)} className="flex items-center justify-center min-h-10 min-w-10 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg cursor-pointer shrink-0" title="Delete goal" aria-label={`Delete goal ${goal.name}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-emerald-500' : 'bg-indigo-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 text-right">{pct.toFixed(0)}%</p>

                {!goal.linkedBankConnectionId && (
                  <div className="flex gap-2 mt-2">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Add funds..."
                      value={manualAddAmount[goal.id] || ''}
                      onChange={(e) => setManualAddAmount((prev) => ({ ...prev, [goal.id]: e.target.value }))}
                      className="flex-1 px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded-lg font-mono bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                    <button
                      onClick={() => {
                        const add = parseFloat(manualAddAmount[goal.id] || '0');
                        if (!isNaN(add) && add !== 0) {
                          onUpdateGoal(goal.id, { manualAmount: (goal.manualAmount || 0) + add });
                          setManualAddAmount((prev) => ({ ...prev, [goal.id]: '' }));
                        }
                      }}
                      className="px-3 py-1 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-950/50 text-indigo-700 dark:text-indigo-400 rounded-lg text-[11px] font-bold cursor-pointer"
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
