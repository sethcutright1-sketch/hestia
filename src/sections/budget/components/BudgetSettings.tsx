// src/sections/budget/components/BudgetSettings.tsx -- Phase 5's rewrite of
// the Budget tab body: a "budget every dollar" planner instead of a plain
// limit editor. Each row's amount is inline-editable (tap to edit, no modal),
// a row's ⋯ menu holds the less-common actions (a one-month-only override,
// rollover, moving between Expenses/Income, delete), and a summary card up
// top answers "have we budgeted all of our income yet?" at a glance.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MoreVertical, Plus, Trash2, ArrowLeftRight, Check, AlertTriangle } from 'lucide-react';
import { DisplayBudget, TransactionCategory } from '../types';
import { budgetLevel, monthProgress, stepMonth, isTransferCategory } from '../budgetMath';
import { formatMoney } from '../format';

interface BudgetSettingsProps {
  // Fed Budget.tsx's monthBudgets -- displayBudgets recomputed for the
  // effective month (the selected month, or the current month when "All
  // time" is selected) -- see the DisplayBudget comment in types.ts.
  budgets: DisplayBudget[];
  // 'YYYY-MM' -- the month every inline edit and row-menu action here applies
  // to (Budget.tsx's effectiveMonth).
  effectiveMonth: string;
  // True when the header is on "All time" -- budgets are monthly, so this
  // shows a one-line note that the numbers below are for the current month
  // instead of silently comparing all-time spending against a monthly limit.
  showAllTimeNote?: boolean;
  effectiveMonthLabel?: string;
  // The store builds its own toast (including, for mode 'default', the
  // "Only for {Month}" action) -- see useBudgetStore's handleSetBudgetAmount --
  // so this just forwards the edit.
  onSetBudgetAmount: (category: TransactionCategory, amount: number, mode: 'month' | 'default', month: string) => void;
  onSetRollover: (category: TransactionCategory, on: boolean, month: string) => void;
  onCategoryClick?: (category: TransactionCategory) => void;
  incomeCategories: string[];
  currency?: string;
  onAddCategory: (category: string, isIncome: boolean) => void;
  onRemoveCategory: (category: string) => void;
  onToggleCategoryIncome: (category: string) => void;
}

function money(n: number, currency: string, decimals: 0 | 2 = 2): string {
  return formatMoney(n, currency, { decimals });
}

// 'YYYY-MM' -> "September" / "Sep" -- built from the string's own numeric
// parts (never by parsing "YYYY-MM-01" as a date string) so the label is
// identical regardless of the machine's timezone, same reasoning as
// budgetMath's formatMonthLabel.
function monthName(month: string, style: 'long' | 'short' = 'long'): string {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(year, monthNum - 1, 1).toLocaleDateString('en-US', { month: style });
}

// A thin bar with an optional vertical "pace" tick showing where today falls
// in the month -- same idea as Overview's ProgressBar.
function ProgressBar({ percent, paceFraction, colorClass }: { percent: number; paceFraction?: number; colorClass: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="relative w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
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

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      {/* No `truncate` -- at 375px a 3-across grid left "Expected income" and
          "Left to budget" ellipsized as "EXPECTED INC…" / "LEFT TO BUDG…".
          Letting the label wrap (it's at most 2 short words) keeps every
          word readable instead of cutting it off. */}
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest leading-tight">{label}</p>
      <p className={`text-sm sm:text-base font-black font-mono mt-0.5 truncate ${valueClass || 'text-slate-900 dark:text-slate-100'}`}>{value}</p>
    </div>
  );
}

function SummaryCard({
  expectedIncome,
  budgeted,
  currency,
}: {
  expectedIncome: number;
  budgeted: number;
  currency: string;
}) {
  const leftToBudget = expectedIncome - budgeted;
  return (
    <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl p-5 shadow-xs space-y-4">
      <div>
        <h3 className="font-bold text-gray-900 dark:text-slate-100 text-base">Budget</h3>
        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Budget every dollar of expected income.</p>
      </div>
      {/* One column at phone width so none of these three labels have to
          squeeze into a third of the screen -- 3-across only from `sm` up. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <Stat label="Expected income" value={money(expectedIncome, currency, 0)} valueClass="text-emerald-600 dark:text-emerald-400" />
        <Stat label="Budgeted" value={money(budgeted, currency, 0)} />
        <Stat
          label="Left to budget"
          value={leftToBudget < 0 ? `Over by ${money(Math.abs(leftToBudget), currency, 0)}` : money(leftToBudget, currency, 0)}
          valueClass={leftToBudget < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}
        />
      </div>
    </div>
  );
}

// The row's ⋯ menu: a one-month-only override, the rollover toggle (hidden
// for income -- it never rolls over), moving between Expenses/Income, and
// delete. Closes on Escape or a click anywhere outside it.
function RowMenu({
  budget,
  isIncome,
  isSystem,
  effectiveMonth,
  currency,
  onSetBudgetAmount,
  onSetRollover,
  onToggleCategoryIncome,
  onRemoveCategory,
  onClose,
}: {
  budget: DisplayBudget;
  isIncome: boolean;
  isSystem: boolean;
  effectiveMonth: string;
  currency: string;
  onSetBudgetAmount: BudgetSettingsProps['onSetBudgetAmount'];
  onSetRollover: BudgetSettingsProps['onSetRollover'];
  onToggleCategoryIncome: BudgetSettingsProps['onToggleCategoryIncome'];
  onRemoveCategory: BudgetSettingsProps['onRemoveCategory'];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [monthOnlyEditing, setMonthOnlyEditing] = useState(false);
  const [monthOnlyValue, setMonthOnlyValue] = useState(() => String(budget.baseLimit));

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose]);

  const submitMonthOnly = (e: React.FormEvent) => {
    e.preventDefault();
    const numeric = parseFloat(monthOnlyValue);
    if (!isNaN(numeric) && numeric >= 0) {
      onSetBudgetAmount(budget.category, numeric, 'month', effectiveMonth);
    }
    onClose();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Options for ${budget.category}`}
      className="absolute right-0 top-full mt-1 w-64 max-w-[calc(100vw-2rem)] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg z-20 p-2 space-y-1"
    >
      {monthOnlyEditing ? (
        <form onSubmit={submitMonthOnly} className="flex items-center gap-1.5 p-1.5">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">{currency}</span>
          <input
            type="number"
            autoFocus
            value={monthOnlyValue}
            onChange={(e) => setMonthOnlyValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
            className="w-20 min-h-9 px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded-lg font-mono bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-hidden focus:border-indigo-500"
          />
          <button
            type="submit"
            aria-label={`Set ${budget.category} for ${monthName(effectiveMonth)} only`}
            className="px-2.5 py-1.5 min-h-9 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold cursor-pointer shrink-0"
          >
            Set
          </button>
        </form>
      ) : (
        <button
          type="button"
          role="menuitem"
          onClick={() => setMonthOnlyEditing(true)}
          className="w-full text-left px-2.5 py-2.5 min-h-10 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
        >
          Set for {monthName(effectiveMonth)} only…
        </button>
      )}

      {!isIncome && (
        <label className="flex items-start gap-2 px-2.5 py-2.5 min-h-10 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(budget.rollover)}
            onChange={(e) => onSetRollover(budget.category, e.target.checked, effectiveMonth)}
            className="mt-0.5 w-4 h-4 accent-indigo-600 shrink-0 cursor-pointer"
          />
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300">Roll over leftover money</span>
            <span className="block text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">
              Unspent money carries into next month; overspending reduces it
            </span>
          </span>
        </label>
      )}

      {!isSystem && (
        <button
          type="button"
          role="menuitem"
          onClick={() => { onToggleCategoryIncome(budget.category); onClose(); }}
          className="w-full text-left px-2.5 py-2.5 min-h-10 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
        >
          <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
          {isIncome ? 'Move to Expenses' : 'Move to Income'}
        </button>
      )}

      {!isSystem && (
        <button
          type="button"
          role="menuitem"
          onClick={() => { onRemoveCategory(budget.category); onClose(); }}
          className="w-full text-left px-2.5 py-2.5 min-h-10 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer flex items-center gap-1.5"
        >
          <Trash2 className="w-3.5 h-3.5 shrink-0" />
          Delete category
        </button>
      )}
    </div>
  );
}

function CarryBadge({ carriedIn, currency, prevMonthLabel }: { carriedIn: number; currency: string; prevMonthLabel: string }) {
  const positive = carriedIn >= 0;
  return (
    <span
      className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap ${
        positive
          ? 'bg-emerald-50 dark:bg-emerald-950/25 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60'
          : 'bg-red-50 dark:bg-red-950/25 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800/60'
      }`}
      title={`${positive ? 'Rolled over' : 'Carried overspend'} from ${prevMonthLabel}`}
    >
      {positive ? '+' : '−'}{money(Math.abs(carriedIn), currency, 0)} from {prevMonthLabel}
    </span>
  );
}

function BudgetRow({
  budget,
  isIncome,
  effectiveMonth,
  currency,
  paceFraction,
  onCategoryClick,
  onSetBudgetAmount,
  onSetRollover,
  onToggleCategoryIncome,
  onRemoveCategory,
}: {
  budget: DisplayBudget;
  isIncome: boolean;
  effectiveMonth: string;
  currency: string;
  paceFraction: number;
  onCategoryClick?: (category: TransactionCategory) => void;
  onSetBudgetAmount: BudgetSettingsProps['onSetBudgetAmount'];
  onSetRollover: BudgetSettingsProps['onSetRollover'];
  onToggleCategoryIncome: BudgetSettingsProps['onToggleCategoryIncome'];
  onRemoveCategory: BudgetSettingsProps['onRemoveCategory'];
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  // Removing the input on Enter/Escape can itself trigger a `blur` (some
  // browsers fire it synchronously when a focused element is unmounted) --
  // without this guard, Escape's cancel gets immediately overwritten by
  // blur's save, and Enter's save fires a second time on top of itself. Reset
  // on every startEdit, and the first of commit/cancel to run wins.
  const settledRef = useRef(true);

  const isSystem = budget.category === 'Income' || budget.category === 'Uncategorized';
  const level = !isIncome ? budgetLevel(budget.spent, budget.limit) : null;
  const percent = budget.limit > 0 ? (budget.spent / budget.limit) * 100 : budget.spent > 0 ? 100 : 0;

  const startEdit = () => {
    setEditValue(String(budget.limit));
    settledRef.current = false;
    setEditing(true);
  };

  const commitEdit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
    const numeric = parseFloat(editValue);
    if (isNaN(numeric) || numeric < 0) return;
    if (numeric === budget.limit) return;

    // A category that already has an override for THIS month saves silently
    // back into that same override -- there's no ambiguity to ask about. Only
    // a plain default-limit edit needs the "from now on / just this month"
    // choice, which the store's own toast offers via its "Only for {Month}"
    // action (see handleSetBudgetAmount) -- this just forwards the mode.
    const hasOverrideThisMonth = budget.monthlyLimits?.[effectiveMonth] !== undefined;
    onSetBudgetAmount(budget.category, numeric, hasOverrideThisMonth ? 'month' : 'default', effectiveMonth);
  };

  const cancelEdit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
    setEditValue('');
  };

  const colorClass = isIncome
    ? 'bg-emerald-500'
    : level === 'over'
    ? 'bg-red-500'
    : level === 'at'
    ? 'bg-slate-400 dark:bg-slate-500'
    : level === 'warning'
    ? 'bg-amber-500'
    : 'bg-indigo-500';

  const leftText = isIncome
    ? (budget.limit - budget.spent <= 0 ? `${money(budget.spent - budget.limit, currency)} over target` : `${money(budget.limit - budget.spent, currency)} to go`)
    : level === 'at'
    ? 'Fully used'
    : level === 'over'
    ? `${money(Math.abs(budget.limit - budget.spent), currency)} over`
    : `${money(budget.limit - budget.spent, currency)} left`;

  const leftClass = isIncome
    ? (budget.spent >= budget.limit ? 'text-emerald-600 dark:text-emerald-400' : 'text-teal-700 dark:text-teal-400')
    : level === 'over'
    ? 'text-red-600 dark:text-red-400'
    : level === 'at'
    ? 'text-slate-600 dark:text-slate-300'
    : level === 'warning'
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-emerald-600 dark:text-emerald-400';

  return (
    <div className="p-4 border border-slate-200 dark:border-slate-800 rounded-xl hover:bg-slate-50/50 dark:hover:bg-slate-800/40 transition-all shadow-xs bg-slate-50/10 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isIncome ? 'bg-emerald-500' : 'bg-indigo-500'}`} />
          <button
            type="button"
            onClick={() => onCategoryClick?.(budget.category)}
            className="text-xs font-bold text-slate-800 dark:text-slate-200 hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline cursor-pointer transition-colors truncate min-h-9"
            title="Click to view transactions in this category"
          >
            {budget.category}
          </button>
          {isSystem && (
            <span className="text-[8px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded font-black uppercase tracking-wider scale-90 select-none">
              Protected
            </span>
          )}
          {budget.carriedIn !== 0 && (
            <CarryBadge carriedIn={budget.carriedIn} currency={currency} prevMonthLabel={monthName(stepMonth(effectiveMonth, -1), 'short')} />
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono hidden sm:inline">{money(budget.spent, currency)} ·</span>
          {editing ? (
            <span className="flex items-center gap-1">
              <span className="text-xs text-gray-500 dark:text-slate-400 font-mono">{currency}</span>
              <input
                type="number"
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                }}
                className="w-24 min-h-9 px-2 py-1 text-xs text-right border border-indigo-300 dark:border-indigo-700 rounded font-mono bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-hidden"
              />
            </span>
          ) : (
            <button
              type="button"
              onClick={startEdit}
              aria-label={`Edit budgeted amount for ${budget.category}`}
              className="text-[11px] font-bold text-slate-600 dark:text-slate-400 bg-slate-100/80 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-2 py-1.5 min-h-10 rounded font-mono cursor-pointer transition-colors"
            >
              {money(budget.limit, currency, 0)}
            </button>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={`Options for ${budget.category}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center justify-center min-h-10 min-w-10 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer transition-colors"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {menuOpen && (
              <RowMenu
                budget={budget}
                isIncome={isIncome}
                isSystem={isSystem}
                effectiveMonth={effectiveMonth}
                currency={currency}
                onSetBudgetAmount={onSetBudgetAmount}
                onSetRollover={onSetRollover}
                onToggleCategoryIncome={onToggleCategoryIncome}
                onRemoveCategory={onRemoveCategory}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      <ProgressBar percent={percent} paceFraction={paceFraction} colorClass={colorClass} />

      <div className="flex justify-between items-center mt-2">
        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-bold font-mono leading-tight uppercase">
          {isIncome ? `${percent.toFixed(0)}% received` : `${percent.toFixed(0)}% spent`}
        </span>
        <span className={`text-[10px] font-sans font-black leading-tight ${leftClass}`}>
          {level === 'at' ? (
            <span className="inline-flex items-center gap-1"><Check className="w-3 h-3" /> Fully used</span>
          ) : level === 'over' ? (
            <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {leftText}</span>
          ) : (
            leftText
          )}
        </span>
      </div>
    </div>
  );
}

function AddCategoryRow({ isIncome, onAdd }: { isIncome: boolean; onAdd: (category: string, isIncome: boolean) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          onAdd(trimmed, isIncome);
          setValue('');
        }
      }}
      className="flex items-center gap-2"
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={isIncome ? 'Add income category…' : 'Add expense category…'}
        maxLength={25}
        className="flex-1 min-w-0 px-3 py-2 min-h-10 text-xs text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-xl focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-hidden transition-all font-medium"
      />
      <button
        type="submit"
        aria-label={isIncome ? 'Add income category' : 'Add expense category'}
        className="px-3.5 py-2 min-h-10 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1 shrink-0 shadow-xs"
      >
        <Plus className="w-3.5 h-3.5" /> Add
      </button>
    </form>
  );
}

function Section({
  title,
  budgets,
  isIncome,
  effectiveMonth,
  currency,
  paceFraction,
  onCategoryClick,
  onSetBudgetAmount,
  onSetRollover,
  onToggleCategoryIncome,
  onRemoveCategory,
  onAddCategory,
}: {
  title: string;
  budgets: DisplayBudget[];
  isIncome: boolean;
  effectiveMonth: string;
  currency: string;
  paceFraction: number;
  onCategoryClick?: (category: TransactionCategory) => void;
  onSetBudgetAmount: BudgetSettingsProps['onSetBudgetAmount'];
  onSetRollover: BudgetSettingsProps['onSetRollover'];
  onToggleCategoryIncome: BudgetSettingsProps['onToggleCategoryIncome'];
  onRemoveCategory: BudgetSettingsProps['onRemoveCategory'];
  onAddCategory: BudgetSettingsProps['onAddCategory'];
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl p-5 shadow-xs space-y-3">
      <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${isIncome ? 'bg-emerald-500' : 'bg-indigo-500'}`} />
        {title} ({budgets.length})
      </h4>
      <div className="space-y-2.5">
        {budgets.map((b) => (
          <BudgetRow
            key={b.category}
            budget={b}
            isIncome={isIncome}
            effectiveMonth={effectiveMonth}
            currency={currency}
            paceFraction={paceFraction}
            onCategoryClick={onCategoryClick}
            onSetBudgetAmount={onSetBudgetAmount}
            onSetRollover={onSetRollover}
            onToggleCategoryIncome={onToggleCategoryIncome}
            onRemoveCategory={onRemoveCategory}
          />
        ))}
        {budgets.length === 0 && (
          <p className="text-[11px] text-slate-400 dark:text-slate-500 italic text-center py-4">No categories here yet.</p>
        )}
      </div>
      <AddCategoryRow isIncome={isIncome} onAdd={onAddCategory} />
    </div>
  );
}

export default function BudgetSettings({
  budgets,
  effectiveMonth,
  showAllTimeNote,
  effectiveMonthLabel,
  onSetBudgetAmount,
  onSetRollover,
  onCategoryClick,
  incomeCategories,
  currency = '$',
  onAddCategory,
  onRemoveCategory,
  onToggleCategoryIncome,
}: BudgetSettingsProps) {
  const today = useMemo(() => new Date(), []);
  const progress = useMemo(() => monthProgress(effectiveMonth, today), [effectiveMonth, today]);

  const expenseBudgets = useMemo(
    () => budgets.filter((b) => !incomeCategories.includes(b.category) && !isTransferCategory(b.category)),
    [budgets, incomeCategories]
  );
  const incomeBudgets = useMemo(() => budgets.filter((b) => incomeCategories.includes(b.category)), [budgets, incomeCategories]);

  const expectedIncome = useMemo(() => incomeBudgets.reduce((sum, b) => sum + b.limit, 0), [incomeBudgets]);
  const budgeted = useMemo(() => expenseBudgets.reduce((sum, b) => sum + b.limit, 0), [expenseBudgets]);

  return (
    <div className="space-y-6" id="budget-settings">
      <SummaryCard
        expectedIncome={expectedIncome}
        budgeted={budgeted}
        currency={currency}
      />

      {showAllTimeNote && effectiveMonthLabel && (
        <p className="text-[11px] text-indigo-700 dark:text-indigo-400 font-semibold bg-indigo-50 dark:bg-indigo-950/25 border border-indigo-100 dark:border-indigo-900/50 rounded-lg px-3 py-1.5">
          Budgets are monthly — showing {effectiveMonthLabel}
        </p>
      )}

      <Section
        title="Expenses"
        budgets={expenseBudgets}
        isIncome={false}
        effectiveMonth={effectiveMonth}
        currency={currency}
        paceFraction={progress.fraction}
        onCategoryClick={onCategoryClick}
        onSetBudgetAmount={onSetBudgetAmount}
        onSetRollover={onSetRollover}
        onToggleCategoryIncome={onToggleCategoryIncome}
        onRemoveCategory={onRemoveCategory}
        onAddCategory={onAddCategory}
      />

      <Section
        title="Income"
        budgets={incomeBudgets}
        isIncome={true}
        effectiveMonth={effectiveMonth}
        currency={currency}
        paceFraction={progress.fraction}
        onCategoryClick={onCategoryClick}
        onSetBudgetAmount={onSetBudgetAmount}
        onSetRollover={onSetRollover}
        onToggleCategoryIncome={onToggleCategoryIncome}
        onRemoveCategory={onRemoveCategory}
        onAddCategory={onAddCategory}
      />
    </div>
  );
}
