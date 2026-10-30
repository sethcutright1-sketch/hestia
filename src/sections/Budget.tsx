import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertOctagon, Lock, TrendingUp, CalendarDays, Target, Landmark, Receipt } from 'lucide-react';
import BankConnectionModal from './budget/components/BankConnectionModal';
import SettingsModal from './budget/components/SettingsModal';
import BudgetHeader from './budget/components/BudgetHeader';
import { BudgetToast, useToast } from './budget/components/Toast';
import { useConfirm } from './budget/components/ConfirmDialog';
import OverviewTab from './budget/tabs/OverviewTab';
import TransactionsTab from './budget/tabs/TransactionsTab';
import BudgetTab from './budget/tabs/BudgetTab';
import AccountsTab from './budget/tabs/AccountsTab';
import BillsGoalsTab from './budget/tabs/BillsGoalsTab';
import { useBudgetStore } from './budget/useBudgetStore';
import {
  listAvailableMonths,
  filterByScope,
  filterByMonth,
  buildDisplayBudgets,
  spendableBalance,
  safeToSpend,
  currentMonthOf,
  defaultMonth,
} from './budget/budgetMath';
import type { BudgetTabConfig, BudgetView, TabId } from './budget/viewTypes';

// The one deliberate change of Phase 2: 7 tabs become 5 -- Connection
// Feeds + Credit Cards merge into Accounts, and Bills Paid + Goals merge into
// Bills & Goals (see AccountsTab.tsx and BillsGoalsTab.tsx for their stacked
// content). Count suffixes carry over only where BudgetHeader still shows one
// (see the `tabs` memo below), and only from `sm` up.
const TAB_DEFS: { id: TabId; label: string; icon: BudgetTabConfig['icon'] }[] = [
  { id: 'overview', label: 'Overview', icon: TrendingUp },
  { id: 'transactions', label: 'Transactions', icon: CalendarDays },
  { id: 'budget', label: 'Budget', icon: Target },
  { id: 'accounts', label: 'Accounts', icon: Landmark },
  { id: 'bills', label: 'Bills & Goals', icon: Receipt },
];

interface BudgetProps {
  // Whether App.tsx's PIN lock is currently armed for the Financial section.
  // App.tsx only used to prompt for the PIN on navigating INTO Budget -- if
  // the lock re-armed while already here, the panel kept showing loaded data
  // while the server quietly 423'd every write. `locked` lets Budget swap to
  // a lock screen instead of pretending everything still works.
  locked?: boolean;
  onRequestUnlock?: () => void;
  // The kiosk login (see forbidKiosk, auth.ts) reaches Budget's data but is
  // still narrower than a real member in a few other ways -- isKioskAccount
  // stays a separate prop since it drives that other UI.
  isKioskAccount?: boolean;
  // Admin-only account/security actions reachable from within Budget:
  // /api/backup/download, configuring Plaid credentials, and the factory
  // reset are all requireAdmin server-side now (the project notes 10.20).
  // A kiosk is never admin, so isAdmin alone covers hiding these for both a
  // kiosk session and a plain parent session -- the "hide a control that
  // would just 403" reasoning isKioskAccount used to cover alone for backup.
  isAdmin?: boolean;
}

export default function Budget({ locked = false, onRequestUnlock, isKioskAccount = false, isAdmin = false }: BudgetProps) {
  const { toasts, showToast, dismissToast } = useToast();
  // window.confirm/prompt are blocked outright in the desktop app's embedded
  // browser and some kiosk browsers -- this in-app dialog works everywhere.
  // `dialog` is rendered once below; `confirm` is handed to the store and to
  // SettingsModal exactly like `showToast`.
  const { confirm, dialog: confirmDialog } = useConfirm();

  // UI preferences -- unlike the six data arrays and category lists, these
  // live only in this browser (localStorage), not the household's server
  // record, so they stay outside useBudgetStore. (The accent-color preference
  // that used to live here was removed in Phase 3 -- see SettingsModal.tsx.)
  const [currency, setCurrency] = useState<string>(() => {
    return localStorage.getItem('budget_sync_currency_symbol') || '$';
  });

  const store = useBudgetStore({ showToast, currency, confirm });

  useEffect(() => {
    localStorage.setItem('budget_sync_currency_symbol', currency);
  }, [currency]);

  const [isBankModalOpen, setIsBankModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [ledgerScope, setLedgerScope] = useState<'all' | 'personal' | 'joint'>('all');
  // 'YYYY-MM' or 'all'. Defaults once transaction data has loaded (see effect below)
  // via budgetMath's defaultMonth -- the real current month if it has data, else the
  // most recent month that does, else the current month.
  const [selectedMonth, setSelectedMonth] = useState<string>('all');
  const [hasSetDefaultMonth, setHasSetDefaultMonth] = useState(false);
  // Shared state for filtering transaction ledger by clicking from charts or settings
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<string>('All');
  const [activeMainTab, setActiveMainTab] = useState<TabId>('overview');

  // Jumps to the Transactions tab filtered to one category or to
  // "Uncategorized" -- Overview's Needs Attention list and Budget vs Spent
  // rows both drive this. Purely navigation, so (unlike an action with a
  // result to report) it doesn't toast.
  const handleCategoryFilterSelect = (category: string) => {
    setActiveCategoryFilter(category);
    setActiveMainTab('transactions');
    // Smooth scroll to transaction-list
    setTimeout(() => {
      const el = document.getElementById('transaction-list');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  };

  // Switching scope is navigation, not an action with a result -- it used to
  // toast every time, which just added noise to a control people click
  // repeatedly while comparing personal vs. joint spending.
  const handleScopeChange = (scope: 'all' | 'personal' | 'joint') => {
    setLedgerScope(scope);
  };

  // All distinct months present in the data, most recent first, for the month picker.
  const availableMonths = useMemo(() => listAvailableMonths(store.transactions), [store.transactions]);

  useEffect(() => {
    // Wait for the real server data (isDataLoaded) rather than defaulting off the
    // placeholder seed transactions rendered during the initial fetch -- otherwise
    // this locks onto the seed data's month before the real months are known.
    if (store.isDataLoaded && !hasSetDefaultMonth) {
      setSelectedMonth(defaultMonth(availableMonths, new Date()));
      setHasSetDefaultMonth(true);
    }
  }, [store.isDataLoaded, availableMonths, hasSetDefaultMonth]);

  // Warn before leaving while there's unsaved data -- a closed tab or reload
  // mid-save used to just lose the edit silently.
  useEffect(() => {
    const { pending, failed } = store.syncStatus;
    if (pending === 0 && failed === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [store.syncStatus.pending, store.syncStatus.failed]);

  // Re-send anything that failed to save while locked (every write 423's) the
  // moment the household unlocks again, instead of leaving it stuck until the
  // next unrelated change nudges the sync queue.
  const wasLockedRef = useRef(locked);
  useEffect(() => {
    if (wasLockedRef.current && !locked) {
      store.retryFailed();
      // If Budget mounted while already locked, the initial GET 423'd and
      // nothing ever loaded -- load now rather than leaving the error card up.
      if (!store.isDataLoaded) store.loadBudgetData();
    }
    wasLockedRef.current = locked;
  }, [locked]);

  // Filtered transactions list based on active scope switcher context
  const displayedTransactions = useMemo(
    () => filterByScope(store.transactions, ledgerScope),
    [store.transactions, ledgerScope]
  );

  // Further filtered to the selected month -- feeds the ledger, charts, and dashboard
  // stats below so switching months scopes the whole view, not just the ledger list.
  const monthFilteredTransactions = useMemo(
    () => filterByMonth(displayedTransactions, selectedMonth),
    [displayedTransactions, selectedMonth]
  );

  // Dynamic budget spent amounts based on active scope + selected month
  const displayBudgets = useMemo(
    () => buildDisplayBudgets(store.budgets, store.transactions, {
      scope: ledgerScope,
      month: selectedMonth,
      incomeCategories: store.incomeCategories,
    }),
    [store.budgets, store.transactions, ledgerScope, selectedMonth, store.incomeCategories]
  );

  // Budgets are monthly, so anything comparing spend against a limit needs a
  // real month even when the header is on "All time" -- effectiveMonth swaps
  // in the current calendar month for 'all' (see Overview and BudgetTab,
  // which both show a "Budgets are monthly -- showing {Month}" note in that
  // case), and monthBudgets/effectiveMonthTransactions are the same
  // scope-aware derivations as above, but pinned to that month.
  const effectiveMonth = useMemo(
    () => (selectedMonth === 'all' ? currentMonthOf(new Date()) : selectedMonth),
    [selectedMonth]
  );

  const effectiveMonthTransactions = useMemo(
    () => filterByMonth(displayedTransactions, effectiveMonth),
    [displayedTransactions, effectiveMonth]
  );

  const monthBudgets = useMemo(
    () => buildDisplayBudgets(store.budgets, store.transactions, {
      scope: ledgerScope,
      month: effectiveMonth,
      incomeCategories: store.incomeCategories,
    }),
    [store.budgets, store.transactions, ledgerScope, effectiveMonth, store.incomeCategories]
  );

  // "Available Cash" only counts spendable checking money -- never a loan balance
  // (that's debt, not cash) and never savings (real money, but set aside on
  // purpose). Balances aren't month-scoped -- a live account balance is always "now".
  const totalBalance = useMemo(
    () => spendableBalance(store.bankConnections, ledgerScope),
    [store.bankConnections, ledgerScope]
  );

  // Budgeted money that's allocated for this month but not yet spent,
  // subtracted from the balance so "safe to spend" means "cash on hand that
  // isn't already committed". Uses the effective month, same reasoning as above.
  const remainingSafe = useMemo(
    () => safeToSpend(totalBalance, monthBudgets, store.incomeCategories),
    [totalBalance, monthBudgets, store.incomeCategories]
  );

  // Everything a tab needs about "the current view" -- scope/month filters and
  // the numbers derived from them -- bundled once instead of drilled down as
  // 30 individual props. See viewTypes.ts.
  const view: BudgetView = useMemo(() => ({
    scope: ledgerScope,
    onScopeChange: handleScopeChange,
    month: selectedMonth,
    availableMonths,
    onMonthChange: setSelectedMonth,
    categoryFilter: activeCategoryFilter,
    onCategoryFilterChange: setActiveCategoryFilter,
    onCategoryFilterSelect: handleCategoryFilterSelect,
    onNavigateTab: setActiveMainTab,
    currency,
    displayedTransactions,
    monthFilteredTransactions,
    displayBudgets,
    effectiveMonth,
    monthBudgets,
    effectiveMonthTransactions,
    totalBalance,
    safeToSpend: remainingSafe,
  }), [
    ledgerScope, selectedMonth, availableMonths, activeCategoryFilter, currency,
    displayedTransactions, monthFilteredTransactions, displayBudgets,
    effectiveMonth, monthBudgets, effectiveMonthTransactions, totalBalance, remainingSafe,
    handleScopeChange, handleCategoryFilterSelect, setActiveMainTab,
  ]);

  // Live count suffixes: Transactions (N) and Accounts (N), where N for
  // Accounts is bank connections + credit cards combined (the two tabs that
  // merged into it). Goals and Credit Cards no longer show their own counts.
  const tabs: BudgetTabConfig[] = useMemo(
    () => TAB_DEFS.map((t) => {
      if (t.id === 'transactions') return { ...t, count: store.transactions.length };
      if (t.id === 'accounts') return { ...t, count: store.bankConnections.length + store.creditCards.length };
      return t;
    }),
    [store.transactions.length, store.bankConnections.length, store.creditCards.length]
  );

  // Checked before the load/error branches below so a lock that re-armed
  // mid-session shows "Budget is locked" instead of a load-error card (the
  // initial GET 423s too while locked) -- but every hook above this line
  // still runs unconditionally on every render, store included, so any
  // unsaved edit made just before the lock re-armed survives in state and
  // resumes syncing (see the retryFailed effect above) the moment it unlocks.
  if (locked) {
    return (
      <div className="space-y-4" id="budget-root">
        <div className="max-w-md mx-auto bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/60 rounded-2xl p-6 text-center space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center">
            <Lock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
          </div>
          <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">Budget is locked</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Unlock it with your PIN to see or change anything here.
          </p>
          <button
            onClick={onRequestUnlock}
            className="px-4 py-2 min-h-10 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
          >
            Unlock
          </button>
        </div>
      </div>
    );
  }

  // A failed load must never fall through to rendering the panel against empty
  // state -- the category-list save effects inside useBudgetStore would then
  // treat those empty/default values as "the real data" and PUT them over
  // whatever the household actually had saved. Show the error and a way to
  // retry instead. (Every hook above this line runs unconditionally on every
  // render -- this and the loading/locked checks are the only early returns.)
  if (store.loadError) {
    return (
      <div className="space-y-4" id="budget-root">
        <div className="max-w-md mx-auto bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/60 rounded-2xl p-6 text-center space-y-3">
          <AlertOctagon className="w-8 h-8 text-red-500 mx-auto" />
          <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">Couldn't load budget data</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{store.loadError}</p>
          <button
            onClick={store.loadBudgetData}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!store.isDataLoaded) {
    return (
      <div className="space-y-4" id="budget-root">
        <div className="h-7 w-40 rounded-lg bg-slate-200 dark:bg-slate-800 animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-2xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
        <div className="h-64 rounded-2xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
        <div className="h-40 rounded-2xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6" id="budget-root">
      {/* Toast queue -- up to 3 visible at once, bottom on phones, top-right from sm. */}
      <BudgetToast toasts={toasts} onDismiss={dismissToast} />

      {/* Title + save-status pill + Settings, scope/month controls, merchant-rule
          banner, and tab strip. */}
      <BudgetHeader
        store={store}
        scope={ledgerScope}
        onScopeChange={handleScopeChange}
        month={selectedMonth}
        availableMonths={availableMonths}
        onMonthChange={setSelectedMonth}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        tabs={tabs}
        activeTab={activeMainTab}
        onTabChange={setActiveMainTab}
      />

      {/* Tab content conditional rendering */}
      {activeMainTab === 'overview' && <OverviewTab store={store} view={view} />}
      {activeMainTab === 'transactions' && <TransactionsTab store={store} view={view} />}
      {activeMainTab === 'budget' && <BudgetTab store={store} view={view} />}
      {activeMainTab === 'accounts' && (
        <AccountsTab store={store} view={view} onOpenBankModal={() => setIsBankModalOpen(true)} />
      )}
      {activeMainTab === 'bills' && <BillsGoalsTab store={store} view={view} />}

      {/* Linking bank mockups modal */}
      <BankConnectionModal
        isOpen={isBankModalOpen}
        onClose={() => setIsBankModalOpen(false)}
        showToast={showToast}
        onConnect={store.handleBankConnected}
        isAdmin={isAdmin}
      />

      {/* Settings panel -- general (currency) and developer (import/backup/
          export/reset) only now; account, PIN/lock, and the household roster
          live in the header's admin page (AdminSettings.tsx). */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        currency={currency}
        onCurrencyChange={setCurrency}
        onResetAllData={store.handleResetAllData}
        onExportJSON={store.handleExportJSON}
        securityLogLength={store.securityLog.length}
        onClearSecurityLog={store.clearSecurityLog}
        showToast={showToast}
        confirm={confirm}
        hideFullBackup={!isAdmin}
        hideReset={!isAdmin}
      />

      {/* Renders itself only while a confirm() call is pending. */}
      {confirmDialog}
    </div>
  );
}
