// src/sections/budget/components/BillsTracker.tsx -- Phase 6 rewrite. Replaces
// the old category-based "N of M bills paid" tracker with real bills: a name,
// an expected amount, a due day/frequency, and (per month) either an
// auto-matched transaction or a manual mark -- see budgetMath's billDueDate/
// billStatus/billStatuses for the pure logic this renders.

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  Receipt,
  Plus,
  MoreVertical,
  Zap,
  Sparkles,
  X,
  Link as LinkIcon,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { Bill, Transaction } from '../types';
import { formatMonthLabel, billStatuses, detectRecurring, type RecurringBillSuggestion, type BillStatus } from '../budgetMath';
import { formatMoney } from '../format';

interface BillsTrackerProps {
  bills: Bill[];
  // Scope-filtered but NOT month-filtered -- a bill's auto-match window can
  // reach a few days into the neighboring month (see billStatus).
  transactions: Transaction[];
  effectiveMonth: string;
  showAllTimeNote?: boolean;
  currency?: string;
  categories: string[];
  incomeCategories: string[];
  // The old category-based tracker's config -- kept only to power the
  // one-time "set up bills from your tracked categories" migration banner.
  billCategories: string[];
  onAddBill: (bill: Bill) => void;
  onUpdateBill: (id: string, updates: Partial<Bill>) => void;
  onDeleteBill: (id: string) => void;
  onMarkBillPaid: (billId: string, month: string, transactionId?: string) => void;
  onMarkBillUnpaid: (billId: string, month: string) => void;
  onAddBillsFromSuggestions: (suggestions: RecurringBillSuggestion[]) => void;
  // Jumps to the Transactions tab filtered to a category -- there's no
  // merchant-level filter exposed on BudgetView, so a bill's matched
  // transaction opens filtered by its CATEGORY instead.
  onCategoryFilterSelect: (category: string) => void;
}

const MIGRATION_DISMISSED_KEY = 'budget_sync_bills_migration_dismissed';

function readMigrationDismissed(): boolean {
  try {
    return localStorage.getItem(MIGRATION_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMigrationDismissed() {
  try {
    localStorage.setItem(MIGRATION_DISMISSED_KEY, '1');
  } catch {
    // Not worth surfacing -- worst case the banner comes back next visit.
  }
}

// 'YYYY-MM-DD' -> "Sep 10" -- built from the string's own numeric parts (a
// plain `new Date(year, monthIndex, day)`), never by parsing the ISO string
// itself, so the label is identical regardless of the machine's timezone.
// Used both for a bill's due date and (below) for the date a matched
// transaction actually posted on.
function formatShortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dueLabel(status: BillStatus): string {
  if (!status.dueDate || status.daysUntil === null) return '';
  const [, m, d] = status.dueDate.split('-').map(Number);
  const monthName = new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
  const dateLabel = `Due ${monthName} ${d}`;
  // A paid bill always shows its plain due date -- "9 days overdue" reads
  // like a warning, and a bill someone already paid isn't one.
  if (status.state === 'paid') return dateLabel;
  if (status.state === 'due_today') return 'Due today';
  if (status.daysUntil > 0) return status.daysUntil === 1 ? `Due in 1 day` : `Due in ${status.daysUntil} days`;
  if (status.daysUntil < 0) {
    const overdueBy = Math.abs(status.daysUntil);
    return overdueBy === 1 ? `1 day overdue` : `${overdueBy} days overdue`;
  }
  return dateLabel;
}

function StatusChip({ state }: { state: BillStatus['state'] }) {
  const styles: Record<string, string> = {
    paid: 'bg-emerald-50 dark:bg-emerald-950/25 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60',
    due_soon: 'bg-amber-50 dark:bg-amber-950/25 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/60',
    due_today: 'bg-amber-50 dark:bg-amber-950/25 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/60',
    overdue: 'bg-red-50 dark:bg-red-950/25 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800/60',
    upcoming: 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  };
  const labels: Record<string, string> = {
    paid: 'Paid',
    due_soon: 'Due soon',
    due_today: 'Due today',
    overdue: 'Overdue',
    upcoming: 'Upcoming',
  };
  const icons: Record<string, ReactNode> = {
    paid: <CheckCircle2 className="w-3 h-3" />,
    due_soon: <Clock className="w-3 h-3" />,
    due_today: <Clock className="w-3 h-3" />,
    overdue: <AlertCircle className="w-3 h-3" />,
    upcoming: <Clock className="w-3 h-3" />,
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border shrink-0 ${styles[state] || styles.upcoming}`}>
      {icons[state]} {labels[state] || state}
    </span>
  );
}

interface BillFormValue {
  name: string;
  amount: string;
  dueDay: string;
  frequency: Bill['frequency'];
  startMonth: string;
  category: string;
  matchText: string;
  autopay: boolean;
  scope: 'personal' | 'joint';
}

function emptyForm(effectiveMonth: string, category: string): BillFormValue {
  return {
    name: '',
    amount: '',
    dueDay: '1',
    frequency: 'monthly',
    startMonth: effectiveMonth,
    category,
    matchText: '',
    autopay: false,
    scope: 'joint',
  };
}

function BillForm({
  title,
  initial,
  categories,
  currency,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: BillFormValue;
  categories: string[];
  currency: string;
  onCancel: () => void;
  onSubmit: (value: BillFormValue) => void;
}) {
  const [value, setValue] = useState<BillFormValue>(initial);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.name.trim()) return setError('Name is required.');
    const amount = Number(value.amount);
    if (!Number.isFinite(amount) || amount <= 0) return setError('Amount must be greater than 0.');
    const dueDay = Number(value.dueDay);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return setError('Due day must be between 1 and 31.');
    setError(null);
    onSubmit(value);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-slate-950/60 dark:bg-slate-950/75 backdrop-blur-xs p-0 sm:p-4"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full sm:max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-3 animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{title}</h3>
          <button type="button" onClick={onCancel} aria-label="Close" className="p-2 min-w-10 min-h-10 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && <p className="text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Name</label>
          <input
            type="text"
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            placeholder="Xfinity Internet"
            className="w-full px-3 py-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Amount ({currency})</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={value.amount}
              onChange={(e) => setValue((v) => ({ ...v, amount: e.target.value }))}
              className="w-full px-3 py-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Due day</label>
            <input
              type="number"
              min="1"
              max="31"
              value={value.dueDay}
              onChange={(e) => setValue((v) => ({ ...v, dueDay: e.target.value }))}
              className="w-full px-3 py-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Frequency</label>
            <select
              value={value.frequency}
              onChange={(e) => setValue((v) => ({ ...v, frequency: e.target.value as Bill['frequency'] }))}
              className="w-full px-3 py-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100"
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Start month</label>
            <input
              type="month"
              value={value.startMonth}
              onChange={(e) => setValue((v) => ({ ...v, startMonth: e.target.value }))}
              className="w-full px-3 py-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Category</label>
          <select
            value={value.category}
            onChange={(e) => setValue((v) => ({ ...v, category: e.target.value }))}
            className="w-full px-3 py-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100"
          >
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Match text (optional)</label>
          <input
            type="text"
            value={value.matchText}
            onChange={(e) => setValue((v) => ({ ...v, matchText: e.target.value }))}
            placeholder="Text from the bank line, e.g. SPECTRUM"
            className="w-full px-3 py-2.5 min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 min-h-10 cursor-pointer">
            <input
              type="checkbox"
              checked={value.autopay}
              onChange={(e) => setValue((v) => ({ ...v, autopay: e.target.checked }))}
              className="w-4 h-4"
            />
            Autopay
          </label>
          <div className="flex rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            {(['personal', 'joint'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setValue((v) => ({ ...v, scope: s }))}
                className={`px-3 py-2 min-h-10 text-xs font-bold cursor-pointer ${
                  value.scope === s ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                }`}
              >
                {s === 'personal' ? 'Mine' : 'Joint'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="w-full py-2.5 min-h-11 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="w-full py-2.5 min-h-11 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer"
          >
            Save bill
          </button>
        </div>
      </form>
    </div>
  );
}

function SuggestionsPanel({
  title,
  suggestions,
  currency,
  onCancel,
  onAdd,
}: {
  title: string;
  suggestions: RecurringBillSuggestion[];
  currency: string;
  onCancel: () => void;
  onAdd: (chosen: RecurringBillSuggestion[]) => void;
}) {
  const [checked, setChecked] = useState<Set<number>>(new Set(suggestions.map((_, i) => i)));

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-slate-950/60 dark:bg-slate-950/75 backdrop-blur-xs p-0 sm:p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-3 animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{title}</h3>
          <button type="button" onClick={onCancel} aria-label="Close" className="p-2 min-w-10 min-h-10 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {suggestions.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center italic">
            Nothing recurring enough to suggest yet -- keep spending for a couple more months.
          </p>
        ) : (
          <div className="space-y-2">
            {suggestions.map((s, i) => (
              <label
                key={`${s.name}-${i}`}
                className="flex items-center gap-3 p-3 min-h-11 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} className="w-4 h-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">{s.name}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">{s.category} · Day {s.dueDay} monthly</p>
                </div>
                <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300 shrink-0">{formatMoney(s.amount, currency)}</span>
              </label>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="w-full py-2.5 min-h-11 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            Cancel
          </button>
          {suggestions.length > 0 && (
            <button
              type="button"
              disabled={checked.size === 0}
              onClick={() => onAdd(suggestions.filter((_, i) => checked.has(i)))}
              className="w-full py-2.5 min-h-11 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Add {checked.size} bill{checked.size === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function LinkTransactionMenu({
  candidates,
  currency,
  onPick,
  onClose,
}: {
  candidates: Transaction[];
  currency: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-0 top-full mt-1 z-20 w-64 max-h-64 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl p-1.5" onClick={(e) => e.stopPropagation()}>
      {candidates.length === 0 ? (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 p-2 italic">No spending in this category this month.</p>
      ) : (
        candidates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              onPick(t.id);
              onClose();
            }}
            className="w-full flex items-center justify-between gap-2 p-2 min-h-10 rounded-lg text-left text-[11px] hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <span className="truncate text-slate-700 dark:text-slate-300 font-medium">{t.merchantName} · {t.date}</span>
            <span className="font-mono font-bold text-slate-800 dark:text-slate-200 shrink-0">{formatMoney(-Math.abs(t.amount), currency)}</span>
          </button>
        ))
      )}
    </div>
  );
}

export default function BillsTracker({
  bills,
  transactions,
  effectiveMonth,
  showAllTimeNote,
  currency = '$',
  categories,
  incomeCategories,
  billCategories,
  onAddBill,
  onUpdateBill,
  onDeleteBill,
  onMarkBillPaid,
  onMarkBillUnpaid,
  onAddBillsFromSuggestions,
  onCategoryFilterSelect,
}: BillsTrackerProps) {
  const today = useMemo(() => new Date(), []);
  const expenseCategories = useMemo(
    () => categories.filter((c) => !incomeCategories.includes(c) && c !== 'Uncategorized'),
    [categories, incomeCategories]
  );

  const [formMode, setFormMode] = useState<'add' | 'edit' | null>(null);
  const [editingBillId, setEditingBillId] = useState<string | null>(null);
  const [suggestionMode, setSuggestionMode] = useState<'find' | 'migrate' | null>(null);
  const [suggestionList, setSuggestionList] = useState<RecurringBillSuggestion[]>([]);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [linkMenuFor, setLinkMenuFor] = useState<string | null>(null);
  const [migrationDismissed, setMigrationDismissed] = useState(readMigrationDismissed);

  const statuses = useMemo(
    () => billStatuses(bills, effectiveMonth, transactions, today),
    [bills, effectiveMonth, transactions, today]
  );

  // Only bills actually due this month -- a quarterly/yearly bill sits this
  // month out entirely rather than showing as some pseudo "not due" row.
  const dueThisMonth = useMemo(() => statuses.filter((s) => s.state !== 'not_due'), [statuses]);

  const paidCount = dueThisMonth.filter((s) => s.state === 'paid').length;
  const stillDue = dueThisMonth
    .filter((s) => s.state !== 'paid')
    .reduce((sum, s) => sum + s.bill.amount, 0);

  const existingMatchTexts = useMemo(
    () => new Set(bills.map((b) => (b.matchText || b.name).trim().toLowerCase())),
    [bills]
  );

  const showMigrationBanner = bills.length === 0 && billCategories.length > 0 && !migrationDismissed;

  const openAddForm = () => {
    setFormMode('add');
    setEditingBillId(null);
  };

  const openEditForm = (billId: string) => {
    setFormMode('edit');
    setEditingBillId(billId);
    setOpenMenuId(null);
  };

  const closeForm = () => {
    setFormMode(null);
    setEditingBillId(null);
  };

  const handleFormSubmit = (value: BillFormValue) => {
    const patch = {
      name: value.name.trim(),
      amount: Number(value.amount),
      dueDay: Number(value.dueDay),
      frequency: value.frequency,
      startMonth: value.startMonth,
      category: value.category,
      matchText: value.matchText.trim() || undefined,
      autopay: value.autopay,
      scope: value.scope,
    };
    if (formMode === 'edit' && editingBillId) {
      onUpdateBill(editingBillId, patch);
    } else {
      onAddBill({ id: `bill-${Date.now()}-${Math.floor(Math.random() * 1000000)}`, active: true, ...patch });
    }
    closeForm();
  };

  const runFindRecurring = () => {
    const found = detectRecurring(transactions, today).filter(
      (s) => !existingMatchTexts.has(s.name.trim().toLowerCase())
    );
    setSuggestionList(found);
    setSuggestionMode('find');
  };

  const runMigration = () => {
    const found = detectRecurring(transactions, today, { categories: billCategories }).filter(
      (s) => !existingMatchTexts.has(s.name.trim().toLowerCase())
    );
    setSuggestionList(found);
    setSuggestionMode('migrate');
  };

  const dismissMigrationBanner = () => {
    setMigrationDismissed(true);
    writeMigrationDismissed();
  };

  const editingBill = editingBillId ? bills.find((b) => b.id === editingBillId) : undefined;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {showMigrationBanner && (
        <div className="bg-indigo-50 dark:bg-indigo-950/25 border border-indigo-200 dark:border-indigo-900/50 rounded-2xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <p className="text-xs font-semibold text-indigo-800 dark:text-indigo-300 truncate">
              Set up bills from your {billCategories.length} tracked categor{billCategories.length === 1 ? 'y' : 'ies'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={runMigration} className="px-3 py-1.5 min-h-9 rounded-lg text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer">
              Review
            </button>
            <button type="button" onClick={dismissMigrationBanner} aria-label="Dismiss" className="p-1.5 min-w-9 min-h-9 flex items-center justify-center rounded-lg text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/25 border border-emerald-200 dark:border-emerald-800/60 rounded-xl text-emerald-600 dark:text-emerald-400 shrink-0">
              <Receipt className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 tracking-tight">
                {dueThisMonth.length === 0 ? 'No bills due' : `${paidCount} of ${dueThisMonth.length} paid`}
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                {stillDue > 0 ? `${formatMoney(stillDue, currency)} still due in ${formatMonthLabel(effectiveMonth).split(' ')[0]}` : formatMonthLabel(effectiveMonth)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runFindRecurring}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-10 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Zap className="w-3.5 h-3.5" /> Find recurring bills
            </button>
            <button
              type="button"
              onClick={openAddForm}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-10 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add bill
            </button>
          </div>
        </div>
        {showAllTimeNote && (
          <p className="text-[11px] text-indigo-700 dark:text-indigo-400 font-semibold bg-indigo-50 dark:bg-indigo-950/25 border border-indigo-100 dark:border-indigo-900/50 rounded-lg px-3 py-1.5">
            Bills are monthly — showing {formatMonthLabel(effectiveMonth)}
          </p>
        )}
      </div>

      {bills.length === 0 && dueThisMonth.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-3">
          <Receipt className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto" />
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">No bills tracked yet</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
            Add a bill with its due date and amount, or let us find recurring charges from your spending history.
          </p>
          <div className="flex items-center justify-center gap-2 pt-1">
            <button type="button" onClick={runFindRecurring} className="px-3 py-2 min-h-10 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
              Find recurring bills
            </button>
            <button type="button" onClick={openAddForm} className="px-3 py-2 min-h-10 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer">
              Add bill
            </button>
          </div>
        </div>
      ) : dueThisMonth.length === 0 ? (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center py-4 italic">No bills due in {formatMonthLabel(effectiveMonth)}.</p>
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xs divide-y divide-slate-100 dark:divide-slate-800">
          {dueThisMonth.map((s) => {
            const bill = s.bill;
            const matchedTx = s.matchedTransactionId ? transactions.find((t) => t.id === s.matchedTransactionId) : undefined;
            const linkCandidates = transactions.filter(
              (t) => t.category === bill.category && t.amount < 0 && t.date.slice(0, 7) === effectiveMonth
            );

            return (
              <div key={bill.id} className="p-4 flex items-center gap-3 relative">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-slate-800 dark:text-slate-200 truncate">{bill.name}</span>
                    {bill.autopay && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                        Autopay
                      </span>
                    )}
                    <StatusChip state={s.state} />
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {formatMoney(bill.amount, currency)} · {dueLabel(s)}
                  </p>
                  {s.state === 'paid' && (
                    <button
                      type="button"
                      onClick={() => onCategoryFilterSelect(bill.category)}
                      className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline text-left"
                    >
                      Paid {formatMoney(s.paidAmount ?? bill.amount, currency)}
                      {matchedTx ? ` on ${formatShortDate(matchedTx.date)} · ${matchedTx.merchantName}` : ''}
                    </button>
                  )}
                </div>

                <div className="relative shrink-0">
                  <button
                    type="button"
                    aria-label={`Actions for ${bill.name}`}
                    onClick={() => setOpenMenuId((cur) => (cur === bill.id ? null : bill.id))}
                    className="p-2 min-w-10 min-h-10 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {openMenuId === bill.id && (
                    <div className="absolute right-0 top-full mt-1 z-20 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl p-1.5 space-y-0.5">
                      {s.state === 'paid' ? (
                        <button
                          type="button"
                          onClick={() => {
                            onMarkBillUnpaid(bill.id, effectiveMonth);
                            setOpenMenuId(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 min-h-10 rounded-lg text-left text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" /> Mark unpaid
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            onMarkBillPaid(bill.id, effectiveMonth);
                            setOpenMenuId(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 min-h-10 rounded-lg text-left text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> Mark paid
                        </button>
                      )}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setLinkMenuFor((cur) => (cur === bill.id ? null : bill.id))}
                          className="w-full flex items-center gap-2 p-2 min-h-10 rounded-lg text-left text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <LinkIcon className="w-3.5 h-3.5" /> Link a transaction
                        </button>
                        {linkMenuFor === bill.id && (
                          <LinkTransactionMenu
                            candidates={linkCandidates}
                            currency={currency}
                            onPick={(id) => {
                              onMarkBillPaid(bill.id, effectiveMonth, id);
                              setOpenMenuId(null);
                            }}
                            onClose={() => setLinkMenuFor(null)}
                          />
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => openEditForm(bill.id)}
                        className="w-full flex items-center gap-2 p-2 min-h-10 rounded-lg text-left text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          onDeleteBill(bill.id);
                        }}
                        className="w-full flex items-center gap-2 p-2 min-h-10 rounded-lg text-left text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/25 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formMode && (
        <BillForm
          title={formMode === 'edit' ? 'Edit bill' : 'Add bill'}
          currency={currency}
          categories={expenseCategories}
          initial={
            editingBill
              ? {
                  name: editingBill.name,
                  amount: String(editingBill.amount),
                  dueDay: String(editingBill.dueDay),
                  frequency: editingBill.frequency,
                  startMonth: editingBill.startMonth,
                  category: editingBill.category,
                  matchText: editingBill.matchText || '',
                  autopay: Boolean(editingBill.autopay),
                  scope: editingBill.scope || 'joint',
                }
              : emptyForm(effectiveMonth, expenseCategories[0] || 'Uncategorized')
          }
          onCancel={closeForm}
          onSubmit={handleFormSubmit}
        />
      )}

      {suggestionMode && (
        <SuggestionsPanel
          title={suggestionMode === 'migrate' ? 'Set up bills from your tracked categories' : 'Recurring bills found'}
          suggestions={suggestionList}
          currency={currency}
          onCancel={() => setSuggestionMode(null)}
          onAdd={(chosen) => {
            onAddBillsFromSuggestions(chosen);
            setSuggestionMode(null);
            if (suggestionMode === 'migrate') dismissMigrationBanner();
          }}
        />
      )}
    </div>
  );
}
