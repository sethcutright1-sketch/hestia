import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Plus, ArrowUpRight, ArrowDownRight, Layers, Trash2, Download,
  UploadCloud, X, ChevronDown,
} from 'lucide-react';
import { Transaction, TransactionCategory, BankConnection } from '../types';
import { formatMonthLabel, filterTransactions, summarizeTransactions, sortTransactions, isTransfer, NEEDS_REVIEW_FILTER, type TransactionFilters, type TransactionSortBy, type SortOrder } from '../budgetMath';
import { formatMoney } from '../format';
import { buildTransactionsCsv } from '../csv';
import { useMediaQuery } from '../useMediaQuery';
import TransactionEditSheet, { type TransactionEditPatch } from './TransactionEditSheet';
import ImportStatementSheet from './ImportStatementSheet';
import type { ConfirmFn } from './ConfirmDialog';

const PAGE_SIZE = 50;

interface TransactionListProps {
  transactions: Transaction[];
  onAddTransaction: (desc: string, amount: number, scope: 'personal' | 'joint', date: string, category?: TransactionCategory) => Promise<void>;
  onUpdateCategory: (id: string, category: TransactionCategory) => void;
  onEditTransaction: (id: string, patch: TransactionEditPatch) => void;
  onUpdateScope?: (id: string, scope: 'personal' | 'joint') => void;
  onDeleteTransaction?: (id: string) => void;
  onBulkUpdate: (ids: string[], patch: { category?: string; scope?: 'personal' | 'joint' }) => void;
  onBulkDelete: (ids: string[]) => void;
  onImportStatement: (transactions: Transaction[]) => void;
  onNewCategories?: (categories: string[]) => void;
  isAddingFromFeed: boolean;
  selectedCategory?: string;
  onCategoryChange?: (category: string) => void;
  categories: string[];
  bankConnections: BankConnection[];
  currency?: string;
  // Read-only here -- the header now owns month selection (see BudgetHeader's
  // month stepper). Only used to decide whether to show month-group headers
  // (grouping only makes sense when the list spans more than one month) and
  // to reset pagination/selection when the month changes.
  selectedMonth?: string;
  confirm: ConfirmFn;
}

// Aesthetic/distinctive badge colors for category rendering
const getCategoryBadgeStyles = (category: string) => {
  switch (category) {
    case 'Groceries': return 'bg-amber-50 dark:bg-amber-950/25 text-amber-700 dark:text-amber-400 border-amber-200/60 dark:border-amber-800/60 focus:ring-amber-300 hover:bg-amber-100/50 dark:hover:bg-amber-950/40';
    case 'Eating Out': return 'bg-orange-50 dark:bg-orange-950/25 text-orange-700 dark:text-orange-400 border-orange-200/60 dark:border-orange-800/60 focus:ring-orange-300 hover:bg-orange-100/50 dark:hover:bg-orange-950/40';
    case 'Utilities & Bills': return 'bg-emerald-50 dark:bg-emerald-950/25 text-emerald-700 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-800/60 focus:ring-emerald-300 hover:bg-emerald-100/50 dark:hover:bg-emerald-950/40';
    case 'Shopping': return 'bg-blue-50 dark:bg-blue-950/25 text-blue-700 dark:text-blue-400 border-blue-200/60 dark:border-blue-800/60 focus:ring-blue-300 hover:bg-blue-100/50 dark:hover:bg-blue-950/40';
    case 'Gas & Transport': return 'bg-purple-50 dark:bg-purple-950/25 text-purple-700 dark:text-purple-400 border-purple-200/60 dark:border-purple-800/60 focus:ring-purple-300 hover:bg-purple-100/50 dark:hover:bg-purple-950/40';
    case 'Family Activities': return 'bg-pink-50 dark:bg-pink-950/25 text-pink-700 dark:text-pink-400 border-pink-200/60 dark:border-pink-800/60 focus:ring-pink-300 hover:bg-pink-100/50 dark:hover:bg-pink-950/40';
    case 'Medical & Health': return 'bg-red-50 dark:bg-red-950/25 text-red-700 dark:text-red-400 border-red-200/60 dark:border-red-800/60 focus:ring-red-300 hover:bg-red-100/50 dark:hover:bg-red-950/40';
    case 'Mortgage/Rent': return 'bg-indigo-50 dark:bg-indigo-950/25 text-indigo-700 dark:text-indigo-400 border-indigo-200/60 dark:border-indigo-800/60 focus:ring-indigo-300 hover:bg-indigo-100/50 dark:hover:bg-indigo-950/40';
    case 'Car Payment': return 'bg-violet-50 dark:bg-violet-950/25 text-violet-700 dark:text-violet-400 border-violet-200/60 dark:border-violet-800/60 focus:ring-violet-300 hover:bg-violet-100/50 dark:hover:bg-violet-950/40';
    case 'Car Insurance': return 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200/60 dark:border-slate-700 focus:ring-slate-300 hover:bg-slate-100/50 dark:hover:bg-slate-800/70';
    case 'Subscriptions': return 'bg-fuchsia-50 dark:bg-fuchsia-950/25 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-200/60 dark:border-fuchsia-800/60 focus:ring-fuchsia-300 hover:bg-fuchsia-100/50 dark:hover:bg-fuchsia-950/40';
    case 'Credit Cards & Debt': return 'bg-rose-50 dark:bg-rose-950/25 text-rose-700 dark:text-rose-400 border-rose-200/60 dark:border-rose-800/60 focus:ring-rose-300 hover:bg-rose-100/50 dark:hover:bg-rose-950/40';
    case 'Savings': return 'bg-cyan-50 dark:bg-cyan-950/25 text-cyan-700 dark:text-cyan-400 border-cyan-200/60 dark:border-cyan-800/60 focus:ring-cyan-300 hover:bg-cyan-100/50 dark:hover:bg-cyan-950/40';
    case 'Clothing': return 'bg-sky-50 dark:bg-sky-950/25 text-sky-700 dark:text-sky-400 border-sky-200/60 dark:border-sky-800/60 focus:ring-sky-300 hover:bg-sky-100/50 dark:hover:bg-sky-950/40';
    case 'Child Support': return 'bg-lime-50 dark:bg-lime-950/25 text-lime-700 dark:text-lime-400 border-lime-200/60 dark:border-lime-800/60 focus:ring-lime-300 hover:bg-lime-100/50 dark:hover:bg-lime-950/40';
    case 'Income': return 'bg-teal-50 dark:bg-teal-950/25 text-teal-700 dark:text-teal-400 border-teal-200/60 dark:border-teal-800/60 focus:ring-teal-300 hover:bg-teal-100/50 dark:hover:bg-teal-950/40';
    case 'Transfer': return 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-300/60 dark:border-slate-700 focus:ring-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70';
    default: {
      let hash = 0;
      for (let i = 0; i < category.length; i++) {
        hash = category.charCodeAt(i) + ((hash << 5) - hash);
      }
      const options = [
        'bg-rose-50 dark:bg-rose-950/25 text-rose-700 dark:text-rose-400 border-rose-200/60 dark:border-rose-800/60 focus:ring-rose-300 hover:bg-rose-100/50 dark:hover:bg-rose-950/40',
        'bg-cyan-50 dark:bg-cyan-950/25 text-cyan-700 dark:text-cyan-400 border-cyan-200/60 dark:border-cyan-800/60 focus:ring-cyan-300 hover:bg-cyan-100/50 dark:hover:bg-cyan-950/40',
        'bg-orange-50 dark:bg-orange-950/25 text-orange-700 dark:text-orange-400 border-orange-200/60 dark:border-orange-800/60 focus:ring-orange-300 hover:bg-orange-100/50 dark:hover:bg-orange-950/40',
        'bg-fuchsia-50 dark:bg-fuchsia-950/25 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-200/60 dark:border-fuchsia-800/60 focus:ring-fuchsia-300 hover:bg-fuchsia-100/50 dark:hover:bg-fuchsia-950/40',
        'bg-sky-50 dark:bg-sky-950/25 text-sky-700 dark:text-sky-400 border-sky-200/60 dark:border-sky-800/60 focus:ring-sky-300 hover:bg-sky-100/50 dark:hover:bg-sky-950/40',
      ];
      return options[Math.abs(hash) % options.length];
    }
  }
};

// Masks or formats long IDs from feeds into pleasant, legible bank source labels
const formatBankName = (name: string) => {
  if (!name) return "External Account";
  if (name.startsWith("account_") || name.startsWith("plaid-") || name.length > 20) {
    return "Plaid Linked Checking";
  }
  return name;
};

const TYPE_LABELS: Record<TransactionFilters['type'], string> = {
  all: 'All types',
  expenses: 'Expenses',
  income: 'Income',
  transfers: 'Transfers',
};

export default function TransactionList({
  transactions,
  onAddTransaction,
  onUpdateCategory,
  onEditTransaction,
  onUpdateScope,
  onDeleteTransaction,
  onBulkUpdate,
  onBulkDelete,
  onImportStatement,
  onNewCategories,
  isAddingFromFeed,
  selectedCategory,
  onCategoryChange,
  categories,
  bankConnections,
  currency = '$',
  selectedMonth = 'all',
  confirm,
}: TransactionListProps) {
  // Local (not UTC) "today", so a household in any timezone gets their own
  // calendar date as the default rather than whatever date UTC midnight falls
  // on -- same reasoning as every other en-CA date default in this section.
  const todayLocal = () => new Date().toLocaleDateString('en-CA');

  const [searchTerm, setSearchTerm] = useState('');
  const [localCategoryFilter, setLocalCategoryFilter] = useState<string>('All');
  const [typeFilter, setTypeFilter] = useState<TransactionFilters['type']>('all');
  const [accountFilter, setAccountFilter] = useState<string>('All');

  const [newDesc, setNewDesc] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newKind, setNewKind] = useState<'expense' | 'income'>('expense');
  const [newDate, setNewDate] = useState<string>(todayLocal());
  const [newScope, setNewScope] = useState<'personal' | 'joint'>('personal');
  const [newCategory, setNewCategory] = useState<string>('Auto');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const bulkBarRef = useRef<HTMLDivElement | null>(null);

  // Default: newest first, same as the list this replaced. Applied after
  // filtering and before pagination -- see the `sorted`/`visibleRows` memos
  // below.
  const [sortBy, setSortBy] = useState<TransactionSortBy>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const categoryFilter = selectedCategory !== undefined ? selectedCategory : localCategoryFilter;
  const setCategoryFilter = onCategoryChange !== undefined ? onCategoryChange : setLocalCategoryFilter;

  const isDesktop = useMediaQuery('(min-width: 768px)');

  // Selection and pagination reset when the filters, the sort, or the
  // header's month change -- a selection made against last month's rows (now
  // invisible) would otherwise silently linger and confuse a bulk action, and
  // "first 50" means something different under a different sort.
  useEffect(() => {
    setSelectedIds(new Set());
    setVisibleCount(PAGE_SIZE);
  }, [searchTerm, categoryFilter, typeFilter, accountFilter, selectedMonth, sortBy, sortOrder]);

  // On phones, the bulk-action bar and the toast stack both sit at the
  // bottom of the screen -- without this, a toast (e.g. "2 transactions
  // updated" right after a bulk action) renders on top of the bar and hides
  // its Delete button. Publishing the bar's own measured height as a CSS
  // custom property on #budget-root lets the toast stack (see Toast.tsx)
  // shift itself above the bar without either component needing to know the
  // other's exact size. Cleared whenever the bar isn't mounted.
  useEffect(() => {
    const root = document.getElementById('budget-root');
    if (!root) return;
    if (selectedIds.size === 0 || !bulkBarRef.current) {
      root.style.removeProperty('--budget-bottom-offset');
      return;
    }
    const el = bulkBarRef.current;
    // +8px so the toast has a small visible gap above the bar instead of
    // touching its top edge exactly.
    const updateOffset = () => root.style.setProperty('--budget-bottom-offset', `${el.offsetHeight + 8}px`);
    updateOffset();
    const observer = new ResizeObserver(updateOffset);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--budget-bottom-offset');
    };
  }, [selectedIds.size]);

  const accountOptions = useMemo(
    () => Array.from(new Set(transactions.map((t) => t.bankName))).filter(Boolean).sort(),
    [transactions]
  );

  const filtered = useMemo(
    () =>
      filterTransactions(transactions, {
        search: searchTerm,
        category: categoryFilter,
        type: typeFilter,
        account: accountFilter,
      }),
    [transactions, searchTerm, categoryFilter, typeFilter, accountFilter]
  );

  const sorted = useMemo(() => sortTransactions(filtered, sortBy, sortOrder), [filtered, sortBy, sortOrder]);

  const summary = useMemo(() => summarizeTransactions(filtered), [filtered]);
  const visibleRows = sorted.slice(0, visibleCount);

  // Month-group headers only read cleanly in date order -- sorted by amount,
  // months would otherwise be interleaved.
  const showMonthHeaders = selectedMonth === 'all' && sortBy === 'date';

  const handleToggleSort = (field: TransactionSortBy) => {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  type SortChoice = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc';
  const sortChoice: SortChoice = `${sortBy}-${sortOrder}`;
  const handleSortChoiceChange = (choice: SortChoice) => {
    const [by, order] = choice.split('-') as [TransactionSortBy, SortOrder];
    setSortBy(by);
    setSortOrder(order);
  };

  const nonSystemCategories = categories.filter((c) => c !== 'Uncategorized');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDesc.trim() || !newAmount) return;

    const magnitude = parseFloat(newAmount);
    if (!Number.isFinite(magnitude) || magnitude <= 0) return;
    const signedAmount = newKind === 'expense' ? -Math.abs(magnitude) : Math.abs(magnitude);

    setIsSubmitting(true);
    try {
      await onAddTransaction(newDesc, signedAmount, newScope, newDate, newCategory === 'Auto' ? undefined : newCategory);
      setNewDesc('');
      setNewAmount('');
      setNewDate(todayLocal());
      setNewCategory('Auto');
    } catch (e) {
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExportCsv = () => {
    // Exports exactly what the filters currently show -- not just the month --
    // so the file on disk matches what's on screen.
    const csv = buildTransactionsCsv(sorted);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', `transactions_${Date.now()}.csv`);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((t) => selectedIds.has(t.id));
  const toggleSelectAllShown = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleRows.forEach((t) => next.delete(t.id));
        return next;
      }
      const next = new Set(prev);
      visibleRows.forEach((t) => next.add(t.id));
      return next;
    });
  };

  const handleBulkDeleteClick = async () => {
    const ids = Array.from(selectedIds);
    const confirmed = await confirm({
      title: 'Delete transactions',
      message: `Delete ${ids.length} transaction${ids.length === 1 ? '' : 's'}? Any linked transfer legs are removed too.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;
    onBulkDelete(ids);
    setSelectedIds(new Set());
  };

  // Row click opens the editor, but not when the click originated on one of
  // the row's own interactive controls (checkbox, select, button) -- checked
  // via closest() rather than stopPropagation on every single control, since
  // that's one rule in one place instead of N event handlers to keep in sync.
  const handleRowClick = (t: Transaction, e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, select, button, a')) return;
    setEditingTx(t);
  };

  const activeChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (searchTerm) activeChips.push({ key: 'search', label: `Search: "${searchTerm}"`, onRemove: () => setSearchTerm('') });
  if (categoryFilter !== 'All') {
    activeChips.push({
      key: 'category',
      label: `Category: ${categoryFilter === NEEDS_REVIEW_FILTER || categoryFilter === 'Uncategorized' ? 'Needs review' : categoryFilter}`,
      onRemove: () => setCategoryFilter('All'),
    });
  }
  if (typeFilter !== 'all') activeChips.push({ key: 'type', label: TYPE_LABELS[typeFilter], onRemove: () => setTypeFilter('all') });
  if (accountFilter !== 'All') activeChips.push({ key: 'account', label: `Account: ${formatBankName(accountFilter)}`, onRemove: () => setAccountFilter('All') });

  const clearAllFilters = () => {
    setSearchTerm('');
    setCategoryFilter('All');
    setTypeFilter('all');
    setAccountFilter('All');
  };

  const renderCategorySelect = (t: Transaction, sizeClass: string) => (
    <select
      value={t.category}
      onChange={(e) => onUpdateCategory(t.id, e.target.value)}
      disabled={Boolean(t.transferId)}
      title={t.category === 'Transfer' ? 'A move between your own accounts -- excluded from Available Cash totals' : undefined}
      className={`${sizeClass} font-bold tracking-tight uppercase rounded-md border focus:outline-hidden cursor-pointer disabled:cursor-not-allowed transition-all truncate ${getCategoryBadgeStyles(t.category)}`}
    >
      {(t.transferId ? ['Transfer'] : categories).map((cat) => (
        <option key={cat} value={cat} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
          {cat}
        </option>
      ))}
    </select>
  );

  const renderScopeButton = (t: Transaction, extraClass: string) => (
    <button
      onClick={() => onUpdateScope && onUpdateScope(t.id, t.scope === 'joint' ? 'personal' : 'joint')}
      className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1 text-[10px] font-bold tracking-tight uppercase rounded-md border border-dashed transition-all cursor-pointer ${extraClass} ${
        t.scope === 'joint'
          ? 'bg-sky-50 dark:bg-sky-950/25 text-sky-700 dark:text-sky-400 border-sky-300 dark:border-sky-700 hover:bg-sky-100 dark:hover:bg-sky-950/40'
          : 'bg-indigo-50 dark:bg-indigo-950/25 text-indigo-700 dark:text-indigo-400 border-indigo-300 dark:border-indigo-700 hover:bg-indigo-100 dark:hover:bg-indigo-950/40'
      }`}
      title="Click to toggle between Mine and Joint"
    >
      {t.scope === 'joint' ? 'Joint' : 'Mine'}
    </button>
  );

  return (
    <div className="w-full min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 md:p-6 shadow-sm space-y-6 overflow-hidden" id="transaction-list">
      {/* Upper header section */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-1 border-b border-slate-100/60 dark:border-slate-800/60">
        <div className="min-w-0 flex items-center gap-2 flex-wrap">
          <h3 className="font-bold text-gray-900 dark:text-slate-100 text-lg tracking-tight">Transactions</h3>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-1 min-h-9 px-2.5 py-1 border border-slate-200 dark:border-slate-700 rounded-lg text-[11px] font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
          >
            <UploadCloud className="w-3.5 h-3.5" /> Import statement
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            title="Export the transactions currently matching your filters as a CSV file"
            className="flex items-center gap-1 min-h-9 px-2.5 py-1 border border-slate-200 dark:border-slate-700 rounded-lg text-[11px] font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>

        {/* Manual Addition Trigger Form with highly responsive wraps */}
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
          <input
            type="text"
            required
            placeholder="McDonalds, Uber, Comcast..."
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            className="flex-1 min-w-[140px] sm:min-w-[160px] px-3 py-1.5 min-h-10 text-xs text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-slate-50/20 dark:bg-slate-800/40 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none transition-colors"
          />
          <div className="flex p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg shrink-0" role="group" aria-label="Transaction type">
            <button
              type="button"
              onClick={() => setNewKind('expense')}
              aria-pressed={newKind === 'expense'}
              className={`min-h-9 px-2.5 py-1 text-[10px] font-bold uppercase rounded-md transition-all cursor-pointer ${
                newKind === 'expense'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              Expense
            </button>
            <button
              type="button"
              onClick={() => setNewKind('income')}
              aria-pressed={newKind === 'income'}
              className={`min-h-9 px-2.5 py-1 text-[10px] font-bold uppercase rounded-md transition-all cursor-pointer ${
                newKind === 'income'
                  ? 'bg-white dark:bg-slate-700 text-emerald-700 dark:text-emerald-400 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              Income
            </button>
          </div>
          <div className="relative w-24">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-xs">{currency}</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              required
              placeholder="0.00"
              value={newAmount}
              onChange={(e) => setNewAmount(e.target.value)}
              className="w-full pl-5 pr-2 py-1.5 min-h-10 text-xs text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-slate-50/20 dark:bg-slate-800/40 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none transition-colors"
            />
          </div>
          <input
            type="date"
            required
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            title="Transaction date"
            className="px-2 py-1.5 min-h-10 text-xs text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none transition-colors shrink-0"
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            title="Auto asks the AI to categorize this; choosing a category skips that step"
            className="px-2.5 py-1.5 min-h-10 text-xs text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none transition-colors cursor-pointer shrink-0 max-w-[120px] truncate"
          >
            <option value="Auto">Auto</option>
            {nonSystemCategories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <select
            value={newScope}
            onChange={(e) => setNewScope(e.target.value as 'personal' | 'joint')}
            className="px-2.5 py-1.5 min-h-10 text-xs text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 outline-none transition-colors cursor-pointer shrink-0"
            title="Classify transaction scope (Personal vs Joint)"
          >
            <option value="personal">Mine</option>
            <option value="joint">Joint</option>
          </select>
          <button
            type="submit"
            disabled={isSubmitting || isAddingFromFeed}
            className="w-full sm:w-auto min-h-10 py-1.5 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 dark:disabled:bg-indigo-800 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors shrink-0"
          >
            {isSubmitting ? (
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            Add Transaction
          </button>
        </form>
      </div>

      {/* Filters row */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search transactions"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 min-h-10 text-xs border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-50/55 dark:focus:ring-indigo-900/30 focus:border-slate-300 dark:focus:border-slate-600 outline-none bg-slate-50/20 dark:bg-slate-800/40 text-slate-800 dark:text-slate-200"
          />
        </div>

        <select
          value={categoryFilter === 'Uncategorized' ? NEEDS_REVIEW_FILTER : categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="w-full sm:w-auto min-h-10 px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:border-slate-400 dark:focus:border-slate-500 bg-white dark:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-300"
        >
          <option value="All">All Categories</option>
          <option value={NEEDS_REVIEW_FILTER}>Needs review</option>
          {nonSystemCategories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>

        <div className="flex p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg" role="group" aria-label="Transaction type filter">
          {(['all', 'expenses', 'income', 'transfers'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              aria-pressed={typeFilter === t}
              className={`min-h-9 px-2.5 text-[10px] font-bold uppercase rounded-md transition-all cursor-pointer ${
                typeFilter === t
                  ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-400 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>

        {accountOptions.length > 1 && (
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="w-full sm:w-auto min-h-10 px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:border-slate-400 dark:focus:border-slate-500 bg-white dark:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-300"
          >
            <option value="All">All Accounts</option>
            {accountOptions.map((name) => (
              <option key={name} value={name}>
                {formatBankName(name)}
              </option>
            ))}
          </select>
        )}

        {/* Desktop sorts by clicking the Date/Amount column headers instead --
            this select is the phone equivalent, since the table (and its
            headers) isn't shown there. */}
        {!isDesktop && (
          <select
            value={sortChoice}
            onChange={(e) => handleSortChoiceChange(e.target.value as SortChoice)}
            aria-label="Sort transactions"
            className="w-full sm:w-auto min-h-10 px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:border-slate-400 dark:focus:border-slate-500 bg-white dark:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-300"
          >
            <option value="date-desc">Sort: Newest first</option>
            <option value="date-asc">Sort: Oldest first</option>
            <option value="amount-desc">Sort: Largest amount</option>
            <option value="amount-asc">Sort: Smallest amount</option>
          </select>
        )}
      </div>

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-2">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onRemove}
              className="flex items-center gap-1 min-h-8 px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400 border border-indigo-200/70 dark:border-indigo-800/60 hover:bg-indigo-100 dark:hover:bg-indigo-950/50 cursor-pointer"
            >
              {chip.label} <X className="w-2.5 h-2.5" />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAllFilters}
            className="min-h-8 px-2.5 py-1 text-[10px] font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer underline"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Summary line */}
      <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 -mt-2">
        {summary.count} transaction{summary.count === 1 ? '' : 's'} · spent {formatMoney(summary.spent, currency)} · received{' '}
        {formatMoney(summary.received, currency)}
      </p>

      {/* Select-all-shown, only meaningful once there's something to select */}
      {visibleRows.length > 0 && (
        <label className="flex items-center gap-2 -mt-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400 cursor-pointer select-none w-fit">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleSelectAllShown}
            className="w-3.5 h-3.5 accent-indigo-600 cursor-pointer"
          />
          Select all shown ({visibleRows.length})
        </label>
      )}

      {isDesktop ? (
        <div className="overflow-x-auto border border-slate-100 dark:border-slate-800 rounded-xl bg-slate-50/10 dark:bg-slate-900 w-full max-w-full">
          <table className="w-full text-left text-xs border-collapse table-fixed min-w-[1020px] overflow-hidden">
            <thead>
              <tr className="bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 font-semibold select-none">
                <th className="p-3 pl-4 w-[36px]" />
                <th
                  onClick={() => handleToggleSort('date')}
                  className="p-3 w-[100px] cursor-pointer hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                >
                  Date {sortBy === 'date' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th className="p-3 w-[220px]">Merchant</th>
                <th className="p-3 w-[150px]">Category</th>
                <th className="p-3 w-[100px]">Mine/Joint</th>
                <th className="p-3 w-[150px]">Account</th>
                <th
                  onClick={() => handleToggleSort('amount')}
                  className="p-3 pr-4 text-right w-[110px] cursor-pointer hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                >
                  Amount {sortBy === 'amount' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th className="p-3 pr-4 text-center w-[50px]">Del</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-800 dark:text-slate-200">
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-400 dark:text-slate-500 font-medium bg-white dark:bg-slate-900">
                    No matching transactions or transfers found.
                  </td>
                </tr>
              ) : (
                visibleRows.map((t, idx) => {
                  const isExpense = t.amount < 0 && !isTransfer(t);
                  const month = t.date.slice(0, 7);
                  const prevMonth = idx > 0 ? visibleRows[idx - 1].date.slice(0, 7) : null;
                  const isNewMonth = showMonthHeaders && month !== prevMonth;

                  return (
                    <React.Fragment key={t.id}>
                      {isNewMonth && (
                        <tr className="bg-slate-100/70 dark:bg-slate-800/60">
                          <td colSpan={8} className="px-4 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                            {formatMonthLabel(month)}
                          </td>
                        </tr>
                      )}
                      <tr
                        onClick={(e) => handleRowClick(t, e)}
                        className="hover:bg-slate-50/40 dark:hover:bg-slate-800/40 bg-white dark:bg-slate-900 transition-colors cursor-pointer"
                      >
                        <td className="p-3 pl-4">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(t.id)}
                            onChange={() => toggleSelected(t.id)}
                            aria-label={`Select ${t.merchantName}`}
                            className="w-3.5 h-3.5 accent-indigo-600 cursor-pointer"
                          />
                        </td>
                        <td className="p-3 whitespace-nowrap text-slate-400 dark:text-slate-500 font-mono text-[11px] truncate w-[100px]">
                          {t.date}
                        </td>
                        <td className="p-3 w-[220px] overflow-hidden">
                          <div className="min-w-0 max-w-full">
                            <div className="font-semibold text-slate-800 dark:text-slate-200 text-xs truncate" title={t.merchantName}>
                              {t.merchantName}
                            </div>
                            {t.description !== t.merchantName && (
                              <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate max-w-full mt-0.5" title={t.description}>
                                {t.description}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="p-3 w-[150px] min-w-0 overflow-hidden">
                          {renderCategorySelect(t, 'w-full p-1 px-2 text-[10px]')}
                        </td>
                        <td className="p-3 w-[100px] overflow-hidden whitespace-nowrap">
                          {renderScopeButton(t, '')}
                        </td>
                        <td className="p-3 w-[150px] min-w-0 overflow-hidden">
                          <span className="inline-flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-0.5 rounded-full text-[10px] text-slate-700 dark:text-slate-300 max-w-full truncate" title={t.bankName}>
                            <Layers className="w-2.5 h-2.5 text-slate-400 dark:text-slate-500 shrink-0" />
                            <span className="truncate">{formatBankName(t.bankName)}</span>
                          </span>
                        </td>
                        <td className="p-3 pr-4 text-right whitespace-nowrap w-[110px]">
                          <span
                            className={`font-semibold font-mono text-xs flex items-center justify-end ${
                              isExpense ? 'text-slate-900 dark:text-slate-100' : 'text-emerald-600 dark:text-emerald-400'
                            }`}
                          >
                            {isExpense ? (
                              <ArrowDownRight className="w-3 h-3 text-slate-500 dark:text-slate-400 inline mr-0.5 shrink-0" />
                            ) : (
                              <ArrowUpRight className="w-3 h-3 text-emerald-500 dark:text-emerald-400 inline mr-0.5 shrink-0" />
                            )}
                            {formatMoney(t.amount, currency, { sign: true })}
                          </span>
                        </td>
                        <td className="p-3 pr-4 text-center w-[50px]">
                          <button
                            onClick={() => onDeleteTransaction && onDeleteTransaction(t.id)}
                            className="p-1 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
                            title="Delete transaction"
                            aria-label="Delete transaction"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-3 w-full">
          {visibleRows.length === 0 ? (
            <div className="p-8 text-center text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-700 rounded-xl font-medium bg-slate-50/30 dark:bg-slate-800/30">
              No matching transactions or transfers found.
            </div>
          ) : (
            visibleRows.map((t, idx) => {
              const isExpense = t.amount < 0 && !isTransfer(t);
              const month = t.date.slice(0, 7);
              const prevMonth = idx > 0 ? visibleRows[idx - 1].date.slice(0, 7) : null;
              const isNewMonth = showMonthHeaders && month !== prevMonth;

              return (
                <React.Fragment key={t.id}>
                  {isNewMonth && (
                    <div className="pt-2 pb-1 px-1 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                      {formatMonthLabel(month)}
                    </div>
                  )}
                  <div
                    onClick={(e) => handleRowClick(t, e)}
                    className="p-4 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-indigo-200 dark:hover:border-indigo-800 bg-white dark:bg-slate-900 transition-all shadow-2xs space-y-3 overflow-hidden min-w-0 cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(t.id)}
                          onChange={() => toggleSelected(t.id)}
                          aria-label={`Select ${t.merchantName}`}
                          className="w-4 h-4 min-h-10 min-w-10 -m-2.5 accent-indigo-600 cursor-pointer shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <span className="font-bold text-slate-800 dark:text-slate-200 text-xs truncate block" title={t.merchantName}>
                            {t.merchantName}
                          </span>
                          {t.description !== t.merchantName && (
                            <span className="text-[10px] text-slate-400 dark:text-slate-500 block truncate mt-0.5" title={t.description}>
                              {t.description}
                            </span>
                          )}
                        </div>
                      </div>
                      <span
                        className={`font-bold font-mono text-xs shrink-0 inline-flex items-center ${
                          isExpense ? 'text-slate-900 dark:text-slate-100' : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {isExpense ? (
                          <ArrowDownRight className="w-3 h-3 text-slate-400 dark:text-slate-500 mr-0.5 shrink-0" />
                        ) : (
                          <ArrowUpRight className="w-3 h-3 text-emerald-500 dark:text-emerald-400 mr-0.5 shrink-0" />
                        )}
                        {formatMoney(t.amount, currency, { sign: true })}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-slate-100 dark:border-slate-800 min-w-0">
                      <div className="flex flex-col gap-1 min-w-0 flex-1">
                        <span className="text-slate-400 dark:text-slate-500 font-mono text-[10px]">{t.date}</span>
                        <div className="flex flex-wrap gap-1 items-center">
                          <span className="inline-flex items-center gap-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded-full text-[9px] text-slate-600 dark:text-slate-400 font-medium max-w-full truncate" title={t.bankName}>
                            <Layers className="w-2 h-2 text-slate-400 dark:text-slate-500 shrink-0" />
                            <span className="truncate">{formatBankName(t.bankName)}</span>
                          </span>
                          {renderScopeButton(t, 'min-h-10 min-w-16')}
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-1.5">
                        {renderCategorySelect(t, 'p-1 px-2 text-[9px] max-w-[110px]')}
                        <button
                          onClick={() => onDeleteTransaction && onDeleteTransaction(t.id)}
                          className="flex items-center justify-center min-h-10 min-w-10 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/30 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer shrink-0"
                          title="Delete transaction"
                          aria-label="Delete transaction"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>
      )}

      {filtered.length > visibleRows.length && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="flex items-center gap-1.5 min-h-10 px-4 py-2 text-xs font-bold text-indigo-700 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/25 hover:bg-indigo-100 dark:hover:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 rounded-xl transition-colors cursor-pointer"
          >
            <ChevronDown className="w-3.5 h-3.5" /> Show {Math.min(PAGE_SIZE, filtered.length - visibleRows.length)} more
          </button>
        </div>
      )}

      {/* Sticky bulk-action bar -- only rendered while something's selected. */}
      {selectedIds.size > 0 && (
        <div className="fixed left-0 right-0 bottom-0 sm:sticky sm:bottom-2 z-40 flex justify-center px-4 pb-4 sm:pb-0 pointer-events-none">
          <div
            ref={bulkBarRef}
            className="pointer-events-auto w-full sm:w-auto flex flex-wrap items-center gap-2 p-3 bg-slate-900 dark:bg-slate-800 border border-slate-800 dark:border-slate-700 rounded-2xl shadow-2xl"
          >
            <span className="text-xs font-bold text-white px-1">{selectedIds.size} selected</span>
            <select
              onChange={(e) => {
                if (e.target.value) onBulkUpdate(Array.from(selectedIds), { category: e.target.value });
                e.target.value = '';
              }}
              defaultValue=""
              className="min-h-9 px-2 py-1 text-[11px] font-semibold bg-slate-800 dark:bg-slate-700 text-white border border-slate-700 rounded-lg cursor-pointer"
            >
              <option value="" disabled>
                Set category…
              </option>
              {nonSystemCategories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onBulkUpdate(Array.from(selectedIds), { scope: 'personal' })}
              className="min-h-9 px-2.5 text-[11px] font-bold text-white bg-slate-800 dark:bg-slate-700 hover:bg-slate-700 dark:hover:bg-slate-600 border border-slate-700 rounded-lg cursor-pointer"
            >
              Mine
            </button>
            <button
              type="button"
              onClick={() => onBulkUpdate(Array.from(selectedIds), { scope: 'joint' })}
              className="min-h-9 px-2.5 text-[11px] font-bold text-white bg-slate-800 dark:bg-slate-700 hover:bg-slate-700 dark:hover:bg-slate-600 border border-slate-700 rounded-lg cursor-pointer"
            >
              Joint
            </button>
            <button
              type="button"
              onClick={handleBulkDeleteClick}
              className="flex items-center gap-1 min-h-9 px-2.5 text-[11px] font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="flex items-center gap-1 min-h-9 px-2.5 text-[11px] font-bold text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          </div>
        </div>
      )}

      {editingTx && (
        <TransactionEditSheet
          transaction={editingTx}
          categories={categories}
          bankConnections={bankConnections}
          currency={currency}
          onSave={onEditTransaction}
          onClose={() => setEditingTx(null)}
        />
      )}

      <ImportStatementSheet
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        categories={categories}
        existingTransactions={transactions}
        currency={currency}
        onImportStatement={onImportStatement}
        onNewCategories={onNewCategories}
      />
    </div>
  );
}
