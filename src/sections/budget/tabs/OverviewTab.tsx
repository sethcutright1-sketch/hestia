// src/sections/budget/tabs/OverviewTab.tsx -- Phase 3 rebuild answering "how
// are we doing this month?" instead of the old three stat cards + two charts.
// Budgets are monthly, so every number here that compares against a limit
// uses view.effectiveMonth/monthBudgets/effectiveMonthTransactions -- the
// selected month, or the current month when the header is on "All time" (see
// Budget.tsx) -- with a one-line note when that substitution happened.

import { useMemo, useState } from 'react';
import { PiggyBank } from 'lucide-react';
import SpendingDonut from '../components/SpendingDonut';
import { isTransferCategory, monthProgress, monthSummary, needsAttention, formatMonthLabel, budgetLevel, stepMonth } from '../budgetMath';
import type { NeedsAttentionItem } from '../budgetMath';
import { formatMoney } from '../format';
import type { BudgetStore } from '../useBudgetStore';
import type { BudgetView } from '../viewTypes';
import type { BudgetAlert } from '../types';

interface OverviewTabProps {
  store: BudgetStore;
  view: BudgetView;
}

function money(n: number, currency: string): string {
  return formatMoney(n, currency);
}

// A thin bar with an optional vertical "pace" tick showing where today falls
// in the month -- lets a glance compare "how much of the month is gone" against
// "how much of the budget is gone" without reading two separate numbers.
function ProgressBar({ percent, paceFraction, colorClass }: { percent: number; paceFraction?: number; colorClass: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="relative w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${colorClass}`} style={{ width: `${clamped}%` }} />
      {paceFraction !== undefined && paceFraction > 0 && paceFraction < 1 && (
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-slate-900/40 dark:bg-white/50"
          style={{ left: `${Math.min(100, Math.max(0, paceFraction * 100))}%` }}
          title="Where today falls in the month"
        />
      )}
    </div>
  );
}

function Tile({ label, value, valueClass, hint }: { label: string; value: string; valueClass?: string; hint?: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm min-w-0">
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest truncate">{label}</p>
      <p className={`text-base font-black font-mono mt-1 truncate ${valueClass || 'text-slate-900 dark:text-slate-100'}`}>{value}</p>
      {hint && <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

function NeedsAttentionSection({
  items,
  failedCount,
  currency,
  onCategoryClick,
  onBillClick,
  onRetry,
}: {
  items: NeedsAttentionItem[];
  failedCount: number;
  currency: string;
  onCategoryClick: (category: string) => void;
  onBillClick: () => void;
  onRetry: () => void;
}) {
  if (items.length === 0 && failedCount === 0) return null;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-2.5">
      <h4 className="font-bold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-widest">Needs attention</h4>
      <div className="space-y-1.5">
        {failedCount > 0 && (
          <button
            type="button"
            onClick={onRetry}
            className="w-full flex items-center justify-between gap-2 p-2.5 min-h-10 rounded-xl border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-950/25 text-left cursor-pointer hover:bg-red-100 dark:hover:bg-red-950/40 transition-colors"
          >
            <span className="text-xs font-semibold text-red-700 dark:text-red-400">
              {failedCount} change{failedCount === 1 ? '' : 's'} didn't save
            </span>
            <span className="text-[10px] font-bold text-red-600 dark:text-red-400 uppercase shrink-0">Retry</span>
          </button>
        )}
        {items.map((item) => {
          if (item.kind === 'bill') {
            const over = item.level === 'over';
            const dueLabel =
              item.dueInDays < 0
                ? `${Math.abs(item.dueInDays)} day${Math.abs(item.dueInDays) === 1 ? '' : 's'} overdue`
                : item.dueInDays === 0
                ? 'due today'
                : `due in ${item.dueInDays} day${item.dueInDays === 1 ? '' : 's'}`;
            return (
              <button
                key={`bill-${item.name}`}
                type="button"
                onClick={onBillClick}
                className={`w-full flex items-center justify-between gap-2 p-2.5 min-h-10 rounded-xl border text-left cursor-pointer transition-colors ${
                  over
                    ? 'border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-950/25 hover:bg-red-100 dark:hover:bg-red-950/40'
                    : 'border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/25 hover:bg-amber-100 dark:hover:bg-amber-950/40'
                }`}
              >
                <span className={`text-xs font-semibold truncate ${over ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
                  {item.name} · {dueLabel}
                </span>
                <span className="text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400 shrink-0">
                  {money(item.amount, currency)}
                </span>
              </button>
            );
          }
          if (item.kind === 'uncategorized') {
            return (
              <button
                key="uncategorized"
                type="button"
                onClick={() => onCategoryClick('Uncategorized')}
                className="w-full flex items-center justify-between gap-2 p-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-left cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {item.count} uncategorized transaction{item.count === 1 ? '' : 's'}
                </span>
                <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase shrink-0">Review</span>
              </button>
            );
          }
          if (item.kind === 'category') {
            const over = item.level === 'over';
            return (
              <button
                key={item.category}
                type="button"
                onClick={() => onCategoryClick(item.category)}
                className={`w-full flex items-center justify-between gap-2 p-2.5 min-h-10 rounded-xl border text-left cursor-pointer transition-colors ${
                  over
                    ? 'border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-950/25 hover:bg-red-100 dark:hover:bg-red-950/40'
                    : 'border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/25 hover:bg-amber-100 dark:hover:bg-amber-950/40'
                }`}
              >
                <span className={`text-xs font-semibold truncate ${over ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
                  {item.category} · {item.percent.toFixed(0)}% used
                </span>
                <span className="text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400 shrink-0">
                  {money(item.spent, currency)} / {money(item.limit, currency)}
                </span>
              </button>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function ActivityCard({
  alerts,
  onMarkAllRead,
  onClear,
}: {
  alerts: BudgetAlert[];
  onMarkAllRead: () => void;
  onClear: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const unreadCount = alerts.filter((a) => !a.isRead).length;
  const visible = showAll ? alerts : alerts.slice(0, 5);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm flex flex-col">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <h4 className="font-bold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-widest">Activity</h4>
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-600 text-white text-[10px] font-bold">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {unreadCount > 0 && (
            <button type="button" onClick={onMarkAllRead} className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline uppercase cursor-pointer min-h-9 px-1">
              Mark all read
            </button>
          )}
          <button type="button" onClick={onClear} className="text-[10px] font-bold text-slate-500 dark:text-slate-400 hover:underline uppercase cursor-pointer min-h-9 px-1">
            Clear
          </button>
        </div>
      </div>

      {alerts.length === 0 ? (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center py-4 italic">No activity yet</p>
      ) : (
        <>
          <div className="space-y-2">
            {visible.map((al, index) => (
              <div
                key={`${al.id}-${index}`}
                className={`p-2.5 border rounded-xl space-y-1 text-[11px] ${!al.isRead ? 'ring-1 ring-indigo-300 dark:ring-indigo-700' : ''} ${
                  al.type === 'critical'
                    ? 'bg-red-50 dark:bg-red-950/25 text-red-950 dark:text-red-300 border-red-200 dark:border-red-800/60'
                    : al.type === 'warning'
                    ? 'bg-amber-50 dark:bg-amber-950/25 text-amber-950 dark:text-amber-300 border-amber-100 dark:border-amber-800/60'
                    : 'bg-indigo-50/50 dark:bg-indigo-950/20 text-indigo-950 dark:text-indigo-300 border-indigo-100 dark:border-indigo-900/50'
                }`}
              >
                <div className="flex justify-between items-center text-[9px] font-bold">
                  <span className="flex items-center gap-1 uppercase tracking-wider font-extrabold text-[8px]">
                    {!al.isRead && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />}
                    {al.type === 'critical' ? 'Critical' : al.type === 'warning' ? 'Warning' : 'Info'}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400 font-mono">{al.date}</span>
                </div>
                <p className="leading-tight font-medium">{al.message}</p>
              </div>
            ))}
          </div>
          {alerts.length > 5 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="w-full text-center text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline uppercase cursor-pointer min-h-9 mt-2"
            >
              {showAll ? 'Show less' : `Show all (${alerts.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function OverviewTab({ store, view }: OverviewTabProps) {
  const today = useMemo(() => new Date(), []);
  const progress = useMemo(() => monthProgress(view.effectiveMonth, today), [view.effectiveMonth, today]);
  const summary = useMemo(
    () => monthSummary(view.monthBudgets, view.effectiveMonthTransactions, store.incomeCategories),
    [view.monthBudgets, view.effectiveMonthTransactions, store.incomeCategories]
  );
  const attentionItems = useMemo(
    () =>
      needsAttention(view.monthBudgets, view.effectiveMonthTransactions, store.incomeCategories, {
        items: store.bills,
        month: view.effectiveMonth,
        // Scope-filtered but NOT month-filtered -- a bill's auto-match window
        // (billStatus) can reach a few days into the neighboring month.
        allTransactions: view.displayedTransactions,
        today,
      }),
    [view.monthBudgets, view.effectiveMonthTransactions, store.incomeCategories, store.bills, view.effectiveMonth, view.displayedTransactions, today]
  );

  const budgetRows = useMemo(() => {
    return view.monthBudgets
      .filter((b) => !store.incomeCategories.includes(b.category) && !isTransferCategory(b.category) && (b.limit > 0 || b.spent > 0))
      .map((b) => ({ ...b, percent: b.limit > 0 ? (b.spent / b.limit) * 100 : b.spent > 0 ? Infinity : 0 }))
      .sort((a, b) => b.percent - a.percent);
  }, [view.monthBudgets, store.incomeCategories]);

  const recentTransactions = useMemo(
    () => [...view.monthFilteredTransactions].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5),
    [view.monthFilteredTransactions]
  );

  const percentOfBudget = summary.budgeted > 0 ? (summary.spent / summary.budgeted) * 100 : 0;
  const perDay = progress.isCurrent && progress.daysLeft > 0 ? Math.max(0, summary.left) / progress.daysLeft : 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {view.month === 'all' && (
        <p className="text-[11px] text-indigo-700 dark:text-indigo-400 font-semibold bg-indigo-50 dark:bg-indigo-950/25 border border-indigo-100 dark:border-indigo-900/50 rounded-lg px-3 py-1.5">
          Budgets are monthly — showing {formatMonthLabel(view.effectiveMonth)}
        </p>
      )}

      {/* Hero card: Left to spend */}
      {summary.budgeted <= 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm text-center space-y-3">
          <PiggyBank className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto" />
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">You haven't set any budgets yet</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
            Set monthly limits for your categories to see how much you have left to spend.
          </p>
          <button
            type="button"
            onClick={() => view.onNavigateTab('budget')}
            className="px-4 py-2 min-h-10 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold cursor-pointer transition-all"
          >
            Set up your budget
          </button>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
          <div>
            <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Left to spend</p>
            <p className={`text-3xl font-black font-mono mt-1 ${summary.left < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>
              {money(summary.left, view.currency)}
            </p>
            {summary.left < 0 && (
              <p className="text-xs font-bold text-red-600 dark:text-red-400 mt-0.5">
                Over budget by {money(Math.abs(summary.left), view.currency)}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Spent {money(summary.spent, view.currency)} of {money(summary.budgeted, view.currency)} budgeted
            </p>
            <ProgressBar percent={percentOfBudget} paceFraction={progress.fraction} colorClass={percentOfBudget > 100 ? 'bg-red-500' : 'bg-indigo-500'} />
          </div>
          {progress.isCurrent && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {progress.daysLeft} day{progress.daysLeft === 1 ? '' : 's'} left · {money(perDay, view.currency)}/day keeps you on budget
            </p>
          )}
        </div>
      )}

      {/* Four small tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <Tile
          label="Income"
          value={money(summary.receivedIncome, view.currency)}
          valueClass="text-emerald-600 dark:text-emerald-400"
          hint={summary.expectedIncome > 0 ? `of ${money(summary.expectedIncome, view.currency)} expected` : undefined}
        />
        <Tile
          label="Spent"
          value={money(summary.spent, view.currency)}
          hint={summary.budgeted > 0 ? `of ${money(summary.budgeted, view.currency)} budgeted` : 'no budget set'}
        />
        <Tile label="Available cash" value={money(view.totalBalance, view.currency)} hint="Checking accounts only" />
        <Tile
          label="Safe to spend"
          value={money(view.safeToSpend, view.currency)}
          valueClass={view.safeToSpend < 0 ? 'text-red-600 dark:text-red-400' : 'text-indigo-600 dark:text-indigo-400'}
          hint="Cash minus what's still budgeted this month"
        />
      </div>

      <NeedsAttentionSection
        items={attentionItems}
        failedCount={store.syncStatus.failed}
        currency={view.currency}
        onCategoryClick={view.onCategoryFilterSelect}
        onBillClick={() => view.onNavigateTab('bills')}
        onRetry={store.retryFailed}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Budget vs spent */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm">
          <div className="mb-3">
            <h4 className="font-bold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-widest">Budget vs spent</h4>
          </div>
          {budgetRows.length === 0 ? (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center py-6 italic">Nothing budgeted or spent this month.</p>
          ) : (
            <div className="space-y-3">
              {budgetRows.map((b) => (
                <button
                  key={b.category}
                  type="button"
                  onClick={() => view.onCategoryFilterSelect(b.category)}
                  className="w-full text-left space-y-1.5 p-1.5 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer min-h-10"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">{b.category}</span>
                      {b.carriedIn !== 0 && (
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap ${
                            b.carriedIn >= 0
                              ? 'bg-emerald-50 dark:bg-emerald-950/25 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60'
                              : 'bg-red-50 dark:bg-red-950/25 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800/60'
                          }`}
                        >
                          {b.carriedIn >= 0 ? '+' : '−'}{money(Math.abs(b.carriedIn), view.currency)} from {formatMonthLabel(stepMonth(view.effectiveMonth, -1)).split(' ')[0]}
                        </span>
                      )}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400 font-mono text-[11px] shrink-0">
                      {b.limit > 0 ? `${money(b.spent, view.currency)} of ${money(b.limit, view.currency)}` : `${money(b.spent, view.currency)} · no budget`}
                    </span>
                  </div>
                  <ProgressBar
                    percent={b.limit > 0 ? (b.spent / b.limit) * 100 : 100}
                    paceFraction={progress.fraction}
                    colorClass={
                      budgetLevel(b.spent, b.limit) === 'over'
                        ? 'bg-red-500'
                        : budgetLevel(b.spent, b.limit) === 'warning'
                        ? 'bg-amber-500'
                        : 'bg-indigo-500'
                    }
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Where it went */}
        <SpendingDonut
          transactions={view.effectiveMonthTransactions}
          incomeCategories={store.incomeCategories}
          currency={view.currency}
          onCategoryClick={view.onCategoryFilterSelect}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent transactions */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-bold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-widest">Recent transactions</h4>
            <button
              type="button"
              onClick={() => view.onCategoryFilterSelect('All')}
              className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline uppercase cursor-pointer min-h-9 px-1"
            >
              See all
            </button>
          </div>
          {recentTransactions.length === 0 ? (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center py-4 italic">No transactions in this view.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {recentTransactions.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 py-2 text-xs min-w-0">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 dark:text-slate-200 truncate">{t.merchantName}</p>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500">{t.date} · {t.category}</p>
                  </div>
                  <span className={`font-mono font-bold shrink-0 ${t.amount < 0 ? 'text-slate-900 dark:text-slate-100' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {formatMoney(t.amount, view.currency, { sign: true })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <ActivityCard alerts={store.alerts} onMarkAllRead={store.markAllAlertsRead} onClear={store.clearAlerts} />
      </div>
    </div>
  );
}
