// src/sections/budget/useBudgetStore.ts -- owns every piece of the household's
// budget data: the six server-synced arrays, the category lists, the security
// log, and every handler that reads or writes them. Budget.tsx (the shell) only
// owns UI preferences (currency, accent color) and view state (active tab,
// ledger scope, selected month, modals) -- everything about the data itself
// lives here so the shell and the tab components can share one source of truth
// without threading three dozen individual props.
//
// Data-safety note (see useSyncedTable.ts): the six data arrays below are
// diff-synced to the server -- any row missing from an array on the next
// render gets DELETEd. Every handler here updates with `setX(prev => ...)`
// derived from previous state. The only wholesale replacements are in
// loadBudgetData (immediately paired with each hook's `.seed(...)`) and the
// pre-existing "clear this list" actions (clearAlerts, clearSecurityLog,
// handleResetAllData) that intentionally wipe a list -- both existed before
// this file did and are moved here unchanged.

import { useEffect, useRef, useState } from 'react';
import type {
  Transaction,
  Budget,
  BankConnection,
  BudgetAlert,
  TransactionCategory,
  SecurityEvent,
  CreditCard,
  SavingsGoal,
  Bill,
} from './types';
import { useSyncedTable, type SyncStatus } from './useSyncedTable';
import {
  thresholdCrossings,
  dedupeIncoming,
  addMoney,
  formatMonthLabel,
  isTransferCategory,
  currentMonthOf,
  applyBudgetAmount,
  type RecurringBillSuggestion,
} from './budgetMath';
import type { ConfirmFn } from './components/ConfirmDialog';

const DEFAULT_CATEGORIES = [
  'Income',
  'Mortgage/Rent',
  'Car Payment',
  'Car Insurance',
  'Gas & Transport',
  'Utilities & Bills',
  'Groceries',
  'Eating Out',
  'Subscriptions',
  'Credit Cards & Debt',
  'Savings',
  'Family Activities',
  'Clothing',
  'Medical & Health',
  'Child Support',
  'Shopping',
  'Transfer',
  'Uncategorized',
];

// Recurring, bill-like categories tracked by default on the Bills Paid tab -- the
// user can customize this list from that tab. Child Support is intentionally excluded
// since it's income for this household, not a bill paid out.
const DEFAULT_BILL_CATEGORIES = [
  'Mortgage/Rent',
  'Utilities & Bills',
  'Subscriptions',
  'Car Payment',
  'Car Insurance',
  'Credit Cards & Debt',
];

const DEFAULT_SECURITY_LOG: SecurityEvent[] = [
  {
    id: 'sec-init',
    timestamp: new Date().toLocaleTimeString(),
    event: 'Vault security shield initialized',
    type: 'info',
  }
];

export type ShowToastFn = (
  message: string,
  type: string,
  action?: { label: string; onClick: () => void }
) => void;

export interface PendingRuleSuggestion {
  key: string;
  merchantName: string;
  suggestedCategory: string;
  ids: string[];
}

export function useBudgetStore({ showToast, currency, confirm }: { showToast: ShowToastFn; currency: string; confirm: ConfirmFn }) {
  // All household data lives server-side (SQLite), scoped per-user: "personal"
  // items are private to whoever created them, "joint" items are shared.
  // isDataLoaded guards both the sync hooks below and the derived-state effects
  // so neither fires against empty placeholders before the initial fetch from
  // /api/budget/store completes -- and, since a household's real ledger can
  // genuinely be empty, state starts empty rather than seeded with demo data
  // that a diff-sync PUT would otherwise write straight into the account (see
  // the removed "Reset Ledger Setup" button, which used to do exactly that).
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  // Set only on a FAILED load. isDataLoaded staying false on failure (instead of
  // the old .finally(() => setIsDataLoaded(true))) is what stops the categories/
  // incomeCategories/billCategories effects below from firing against a page
  // that only ever saw its own DEFAULT_* fallbacks -- previously a failed GET
  // still flipped isDataLoaded true, and those effects would PUT the hard-coded
  // defaults over the household's real, customized category lists.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [bankConnections, setBankConnections] = useState<BankConnection[]>([]);
  const [creditCards, setCreditCards] = useState<CreditCard[]>([]);
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [incomeCategories, setIncomeCategories] = useState<string[]>(['Income']);
  const [billCategories, setBillCategories] = useState<string[]>(DEFAULT_BILL_CATEGORIES);
  const [goals, setGoals] = useState<SavingsGoal[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [securityLog, setSecurityLog] = useState<SecurityEvent[]>(DEFAULT_SECURITY_LOG);

  // Suggested "always sort this merchant as X" rules from a background Plaid
  // sync, waiting on a human decision -- see handlePlaidRefresh and the banner
  // BudgetHeader renders above the main tab strip.
  const [pendingRuleSuggestions, setPendingRuleSuggestions] = useState<PendingRuleSuggestion[]>([]);

  // A 423 means the PIN lock re-armed while this tab still had budget open
  // (see Budget.tsx's `locked` prop) -- every write fails until it's
  // unlocked again, so say that plainly instead of the generic message,
  // which just reads as a mystery server error.
  const showErrorToast = (err: Error) =>
    showToast(
      err.message.includes('(423)') ? 'Budget is locked — unlock it to save your changes.' : `Could not save: ${err.message}`,
      'critical'
    );
  const txSync = useSyncedTable('transactions', transactions, { enabled: isDataLoaded, onError: showErrorToast });
  const budgetSync = useSyncedTable('budgets', budgets, {
    enabled: isDataLoaded,
    keyOf: (b: Budget) => b.category,
    onError: showErrorToast,
  });
  const bankSync = useSyncedTable('bank_connections', bankConnections, { enabled: isDataLoaded, onError: showErrorToast });
  const cardSync = useSyncedTable('credit_cards', creditCards, { enabled: isDataLoaded, onError: showErrorToast });
  const alertSync = useSyncedTable('alerts', alerts, { enabled: isDataLoaded, onError: showErrorToast });
  const goalSync = useSyncedTable('goals', goals, { enabled: isDataLoaded, onError: showErrorToast });
  const billSync = useSyncedTable('bills', bills, { enabled: isDataLoaded, onError: showErrorToast });

  // Remembers the JSON of each config value as last loaded/sent, so the
  // effects below only PUT when something actually changed instead of
  // re-sending the same list on every page load (harmless but noisy).
  const lastSentCategories = useRef<string | null>(null);
  const lastSentIncomeCategories = useRef<string | null>(null);
  const lastSentBillCategories = useRef<string | null>(null);

  // Pulled out of the load effect so the error card's Retry button can re-run
  // exactly the same load, rather than duplicating it or forcing a full reload.
  const loadBudgetData = () => {
    setLoadError(null);
    fetch('/api/budget/store')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load household data');
        return res.json();
      })
      .then((data) => {
        // The server is authoritative, even when it returns an empty array — an
        // authenticated account with zero items genuinely has zero items. Falling
        // back to demo placeholder data here would (and previously did) get written
        // straight back to that account as if it were real.
        const loadedTransactions = (data.transactions || []).map((t: any) => ({ ...t, scope: t.scope || 'personal' }));
        const loadedBudgets = data.budgets || [];
        const loadedBankConnections = data.bankConnections || [];
        const loadedCreditCards = data.creditCards || [];
        const loadedAlerts = data.alerts || [];
        const loadedGoals = data.goals || [];
        const loadedBills = data.bills || [];
        const loadedCategories = data.categories || DEFAULT_CATEGORIES;
        const loadedIncomeCategories = data.incomeCategories || ['Income'];
        const loadedBillCategories = data.billCategories || DEFAULT_BILL_CATEGORIES;

        setTransactions(loadedTransactions);
        setBudgets(loadedBudgets);
        setBankConnections(loadedBankConnections);
        setCreditCards(loadedCreditCards);
        setAlerts(loadedAlerts);
        setGoals(loadedGoals);
        setBills(loadedBills);
        setCategories(loadedCategories);
        setIncomeCategories(loadedIncomeCategories);
        setBillCategories(loadedBillCategories);
        setSecurityLog(data.securityLog || DEFAULT_SECURITY_LOG);

        // Seed the diff-sync hooks from what was just loaded, so applying this
        // same data back into state above doesn't turn into a wave of PUTs.
        txSync.seed(loadedTransactions);
        budgetSync.seed(loadedBudgets);
        bankSync.seed(loadedBankConnections);
        cardSync.seed(loadedCreditCards);
        alertSync.seed(loadedAlerts);
        goalSync.seed(loadedGoals);
        billSync.seed(loadedBills);

        // Same idea for the config-value save effects below: seed what the
        // server just gave us as "already sent" so loading doesn't immediately
        // re-PUT it right back.
        lastSentCategories.current = JSON.stringify(loadedCategories);
        lastSentIncomeCategories.current = JSON.stringify(loadedIncomeCategories);
        lastSentBillCategories.current = JSON.stringify(loadedBillCategories);

        // Only now -- after a confirmed-good load and after every seed() above
        // -- is it safe to let the sync hooks and the config-save effects run.
        setIsDataLoaded(true);
      })
      .catch((err) => {
        console.error('Failed to load household data from server:', err);
        setLoadError(err?.message || 'Failed to load household data');
      });
  };

  useEffect(() => {
    loadBudgetData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logSecurityEvent = (event: string, type: 'success' | 'warning' | 'critical' | 'info' = 'info') => {
    const newEv: SecurityEvent = {
      id: `sec-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
      timestamp: new Date().toLocaleTimeString(),
      event,
      type,
    };
    // Optimistic local prepend for immediate display only -- the server is now
    // the sole writer of the persisted log (see POST /security-log). PUTting
    // this client-built array used to be the write of record, which meant any
    // event the server appended after the page's last load (a PIN lockout from
    // routes/lock.ts, for instance) got silently overwritten the next time this
    // ran. The two deliberate whole-log replacements (clearing the log, and a
    // full data reset) still PUT the array directly -- see clearSecurityLog and
    // handleResetAllData.
    setSecurityLog(prev => [newEv, ...prev].slice(0, 50));
    if (isDataLoaded) {
      fetch('/api/budget/security-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, type }),
      }).catch((err) => console.error('Failed to persist security log entry:', err));
    }
  };

  // State for active Plaid syncing loading visual spinners
  const [isSyncingPlaid, setIsSyncingPlaid] = useState<string | null>(null);
  // Set while a manual/AI-categorized transaction add is in flight (renamed
  // from Budget.tsx's isAddingFromSim -- same field, clearer name).
  const [isAddingTransaction, setIsAddingTransaction] = useState(false);

  // Small config values (category lists, security log) are still whole-value
  // PUTs -- they're arrays of strings/small objects, not per-item collections,
  // so there's nothing to diff. The six data tables are synced by the
  // useSyncedTable hooks declared above instead of a save-effect per table.
  const putStoreConfig = (key: string, value: any) => {
    fetch(`/api/budget/store-config/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }).catch((err) => console.error(`Failed to sync ${key}:`, err));
  };

  // Each of these three re-ran on every page load even when nothing had
  // changed, since isDataLoaded flips true exactly once and the value it was
  // just seeded with counts as "changed" on a naive dependency compare. Comparing
  // against the JSON last loaded/sent (seeded in loadBudgetData, updated here
  // after each successful send) turns that into a genuine no-op.
  useEffect(() => {
    if (!isDataLoaded) return;
    const json = JSON.stringify(categories);
    if (lastSentCategories.current === json) return;
    lastSentCategories.current = json;
    putStoreConfig('categories', categories);
  }, [categories, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded) return;
    const json = JSON.stringify(incomeCategories);
    if (lastSentIncomeCategories.current === json) return;
    lastSentIncomeCategories.current = json;
    putStoreConfig('incomeCategories', incomeCategories);
  }, [incomeCategories, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded) return;
    const json = JSON.stringify(billCategories);
    if (lastSentBillCategories.current === json) return;
    lastSentBillCategories.current = json;
    putStoreConfig('billCategories', billCategories);
  }, [billCategories, isDataLoaded]);

  const handleResetAllData = async (password: string) => {
    const res = await fetch('/api/budget/store/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const message = res.status === 401 ? 'Incorrect password.' : `Could not reset budget data -- server returned ${res.status}.`;
      showToast(message, 'critical');
      throw new Error(message);
    }
    await Promise.all([
      putStoreConfig('categories', DEFAULT_CATEGORIES),
      putStoreConfig('incomeCategories', ['Income']),
      putStoreConfig('billCategories', DEFAULT_BILL_CATEGORIES),
      putStoreConfig('securityLog', DEFAULT_SECURITY_LOG),
    ]);

    // Reload browser to re-fetch and re-seed from the now-empty server state.
    window.location.reload();
  };

  // Bank connections carry no Plaid access tokens: the server never sends them to the browser
  // (the project notes 10.7), so this file -- plain JSON in a Downloads folder -- can't hold one.
  const handleExportJSON = () => {
    const exportObj = {
      transactions,
      budgets,
      bankConnections,
      currency,
      securityLog
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `budget_sync_export_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    logSecurityEvent('Active system ledger successfully serialized & exported to JSON document', 'info');
    showToast('Exported your budget data as JSON.', 'success');
  };

  const triggerAlert = (type: 'warning' | 'critical' | 'info', category: TransactionCategory, message: string, amt?: number) => {
    const randomId = `alert-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const newAlert: BudgetAlert = {
      id: randomId,
      type,
      category,
      message,
      date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      isRead: false,
      amount: amt,
    };

    setAlerts((prev) => [newAlert, ...prev]);
    showToast(message, type);
  };

  // Thin wrapper over budgetMath's thresholdCrossings: translates each pure
  // crossing into the exact alert message strings used today. See
  // thresholdCrossings' own comment in budgetMath.ts for the batching and
  // month-scoping rules this depends on.
  const checkThresholdAlerts = (newTxs: Transaction[]) => {
    // Local calendar month, not UTC -- an evening purchase on the last day of
    // the month would otherwise count toward the NEXT month in US timezones.
    const currentMonth = new Date().toLocaleDateString('en-CA').slice(0, 7);
    const crossings = thresholdCrossings(transactions, newTxs, budgets, currentMonth);

    for (const c of crossings) {
      if (c.level === 'critical') {
        const alertMsg = `${c.category} is over budget: ${currency}${c.newSpent.toFixed(2)} of ${currency}${c.limit.toFixed(2)}.`;
        triggerAlert('critical', c.category, alertMsg, c.batchAmount);
      } else {
        const currentPercent = (c.newSpent / c.limit) * 100;
        const alertMsg = `${c.category} is at ${currentPercent.toFixed(0)}% of its budget (${currency}${c.newSpent.toFixed(2)} of ${currency}${c.limit.toFixed(2)}).`;
        triggerAlert('warning', c.category, alertMsg, c.batchAmount);
      }
    }
  };

  // Fires a one-time celebratory alert the first time a goal's progress crosses
  // each 25/50/75/100% threshold. alertedMilestones tracks what's already fired
  // so re-checking on every balance update doesn't spam the same milestone.
  useEffect(() => {
    if (!isDataLoaded) return;
    const MILESTONES = [25, 50, 75, 100];

    goals.forEach((goal) => {
      const current = goal.linkedBankConnectionId
        ? (bankConnections.find((b) => b.id === goal.linkedBankConnectionId)?.balance || 0)
        : (goal.manualAmount || 0);
      const pct = goal.targetAmount > 0 ? (current / goal.targetAmount) * 100 : 0;
      const already = goal.alertedMilestones || [];
      const newlyCrossed = MILESTONES.filter((m) => pct >= m && !already.includes(m));

      if (newlyCrossed.length > 0) {
        const highest = Math.max(...newlyCrossed);
        const message = highest >= 100
          ? `🎉 Goal reached! "${goal.name}" hit its target of ${currency}${goal.targetAmount.toLocaleString()}.`
          : `"${goal.name}" just crossed ${highest}% of its ${currency}${goal.targetAmount.toLocaleString()} goal.`;
        triggerAlert(highest >= 100 ? 'info' : 'info', 'Uncategorized', message);
        setGoals((prev) => prev.map((g) => (g.id === goal.id ? { ...g, alertedMilestones: [...already, ...newlyCrossed] } : g)));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, bankConnections, isDataLoaded]);

  // Add a brand new manually logged/sync transaction. `category` is the
  // Transactions tab's Add form category select: leaving it on "Auto" (the
  // default, passed as undefined) asks /categorize the same as always;
  // choosing a real category skips that round-trip entirely -- there's
  // nothing to ask the model, and the merchant name is just the raw
  // description, same as every fallback path below.
  const handleAddNewTransaction = async (
    description: string,
    amount: number,
    scope?: 'personal' | 'joint',
    date?: string,
    category?: TransactionCategory
  ) => {
    setIsAddingTransaction(true);
    const targetScope = scope || 'personal';
    const targetDate = date || new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD

    // Shared tail end of every path (categorized, chosen up front, or
    // fallen back to Uncategorized): adjusts the matching account's balance,
    // checks thresholds, records the row, and toasts. Only one path ever
    // calls this per add, so the balance is adjusted exactly once.
    const commit = (finalCategory: TransactionCategory, finalMerchant: string) => {
      const accountSource = bankConnections.find((b) => b.status === 'connected' && b.scope === targetScope) ||
                            bankConnections.find((b) => b.status === 'connected') ||
                            bankConnections[0];
      const bankSource = accountSource ? accountSource.bankName : 'Manual Account';

      // A Plaid-linked account's balance is overwritten from Plaid on the next
      // sync, and the real transaction will arrive through that same sync --
      // adjusting it locally here would just be immediately overwritten (best
      // case) or cause visible drift until the next sync (worst case).
      if (accountSource && !accountSource.isPlaid) {
        setBankConnections((prev) =>
          prev.map((ba) =>
            ba.id === accountSource.id ? { ...ba, balance: addMoney(ba.balance, amount) } : ba
          )
        );
      }

      const newTx: Transaction = {
        id: `tx-manual-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        date: targetDate,
        description,
        merchantName: finalMerchant,
        amount,
        category: finalCategory,
        bankName: bankSource,
        status: 'cleared',
        scope: targetScope,
        accountId: accountSource?.id,
      };

      // Check alert check first BEFORE adding so calculations are correct
      checkThresholdAlerts([newTx]);

      setTransactions((prev) => [newTx, ...prev]);

      if (amount < 0) {
        showToast(`Added ${finalMerchant} · ${finalCategory} · -${currency}${Math.abs(amount).toFixed(2)}`, 'success');
      } else {
        showToast(`Added ${finalMerchant} · ${finalCategory} · +${currency}${amount.toFixed(2)}`, 'success');
      }
    };

    if (category) {
      commit(category, description);
      setIsAddingTransaction(false);
      return;
    }

    // The local Ollama model has no built-in timeout, and this used to hang
    // the add for 20+ seconds with the button just spinning while a cold
    // model loaded (the project notes 11.3). This is a client-side
    // backstop on top of the server's own 8s /categorize timeout -- generous
    // enough to cover one real round trip, short enough that "Add
    // Transaction" never feels stuck.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch('/api/budget/categorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description, amount }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error('Endpoint categorization failed');
      }

      const data = await response.json();
      const finalCategory = data.category as TransactionCategory;
      const finalMerchant = data.merchantName;

      // The AI may have invented a brand-new category (e.g. "Pet Care") rather than
      // forcing the transaction into an existing bucket -- the server already persisted
      // it, so mirror that into local state so it shows up immediately without a reload.
      // No `spent` here -- it's a legacy display field, always derived fresh by
      // displayBudgets (see types.ts's Budget.spent comment).
      if (data.isNewCategory) {
        setCategories((prev) => (prev.includes(finalCategory) ? prev : [...prev, finalCategory]));
        setBudgets((prev) => (prev.some((b) => b.category === finalCategory) ? prev : [...prev, { category: finalCategory, limit: 0 }]));
      }

      commit(finalCategory, finalMerchant);
    } catch (e: any) {
      console.error(e);
      commit('Uncategorized', description);
    } finally {
      clearTimeout(abortTimer);
      setIsAddingTransaction(false);
    }
  };

  const handleCreditCardTransaction = (
    description: string,
    amount: number,
    category: string,
    bankName: string,
    scope?: 'personal' | 'joint'
  ) => {
    const targetScope = scope || 'personal';

    const newTx: Transaction = {
      id: `tx-card-${Date.now()}-${Math.floor(Math.random() * 1050000)}`,
      date: new Date().toLocaleDateString('en-CA'), // YYYY-MM-DD
      description,
      merchantName: description,
      amount,
      category,
      bankName,
      status: 'cleared',
      scope: targetScope,
    };

    checkThresholdAlerts([newTx]);

    setTransactions((prev) => [newTx, ...prev]);
  };

  // Moves money between two of the household's own linked accounts. Represented as
  // two paired 'Transfer' transactions (one debit, one credit) sharing a transferId,
  // rather than a single AI-categorized entry -- category is fixed, both real
  // accounts' balances update, and deleting either leg removes both (see
  // handleDeleteTransaction).
  const handleAddTransfer = (fromAccountId: string, toAccountId: string, amount: number) => {
    const fromAccount = bankConnections.find((b) => b.id === fromAccountId);
    const toAccount = bankConnections.find((b) => b.id === toAccountId);
    if (!fromAccount || !toAccount || fromAccountId === toAccountId || amount <= 0) return;

    setBankConnections((prev) =>
      prev.map((b) => {
        if (b.id === fromAccountId) return { ...b, balance: addMoney(b.balance, -amount) };
        if (b.id === toAccountId) return { ...b, balance: addMoney(b.balance, amount) };
        return b;
      })
    );

    const transferId = `transfer-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD

    const debitTx: Transaction = {
      id: `${transferId}-out`,
      date,
      description: `Transfer to ${toAccount.bankName} (${toAccount.accountName})`,
      merchantName: 'Account Transfer',
      amount: -amount,
      category: 'Transfer',
      bankName: fromAccount.bankName,
      status: 'cleared',
      scope: fromAccount.scope || 'personal',
      transferId,
      accountId: fromAccount.id,
    };
    const creditTx: Transaction = {
      id: `${transferId}-in`,
      date,
      description: `Transfer from ${fromAccount.bankName} (${fromAccount.accountName})`,
      merchantName: 'Account Transfer',
      amount,
      category: 'Transfer',
      bankName: toAccount.bankName,
      status: 'cleared',
      scope: toAccount.scope || 'personal',
      transferId,
      accountId: toAccount.id,
    };

    setTransactions((prev) => [debitTx, creditTx, ...prev]);
    showToast(`Transferred ${currency}${amount.toFixed(2)} from ${fromAccount.bankName} to ${toAccount.bankName}.`, 'success');
    logSecurityEvent(`Transferred ${currency}${amount.toFixed(2)}: ${fromAccount.bankName} → ${toAccount.bankName}`, 'info');
  };

  // Import bulk statement lines parsed with AI
  const handleImportStatement = (imported: Transaction[]) => {
    // Alert check first BEFORE adding, same as every other entry point -- see
    // checkThresholdAlerts. This used to have its own copy of the threshold
    // logic that compared the imported batch against ALL-TIME spending, which
    // fired a critical alert on nearly every import (a statement almost always
    // pushes lifetime spend past a monthly limit). checkThresholdAlerts is
    // scoped to the current calendar month instead, like every other call site.
    checkThresholdAlerts(imported);

    setTransactions((prev) => [...imported, ...prev]);
  };

  // The AI may invent new categories while parsing a bulk statement import -- the
  // server already persisted them, so mirror them into local state so they show up
  // immediately without a reload. No `spent` here -- it's a legacy display field,
  // always derived fresh by displayBudgets (see types.ts's Budget.spent comment).
  const handleNewCategoriesFromAI = (newCats: string[]) => {
    setCategories((prev) => {
      const additions = newCats.filter((c) => !prev.includes(c));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    setBudgets((prev) => {
      const existing = new Set(prev.map((b) => b.category));
      const additions = newCats.filter((c) => !existing.has(c)).map((c) => ({ category: c, limit: 0 }));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  };

  // After a category change, asks (via a toast with a Yes action) whether to
  // save a standing "always file this merchant as X" rule -- replaces the old
  // per-row bookmark toggle, which asked nothing and just silently created or
  // didn't create a rule depending on whether a checkbox happened to be
  // checked. Only asks when there's something new to remember: skipped
  // outright for Transfer (its category is fixed, never a real choice) and
  // when the merchant already has a rule for this exact category, so
  // confirming an already-remembered categorization doesn't nag again.
  const checkAndOfferRememberMerchant = async (merchantName: string, category: string) => {
    if (category === 'Transfer') return;
    try {
      const res = await fetch('/api/budget/merchant-rules', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      const rules: { merchantDisplay: string; category: string }[] = data?.rules || [];
      // Rules are keyed server-side by the trimmed, lowercased merchant name
      // (db.ts normalizeMerchantKey), so compare the same way here.
      const key = merchantName.trim().toLowerCase();
      const alreadyRemembered = rules.some((r) => r.merchantDisplay.trim().toLowerCase() === key && r.category === category);
      if (alreadyRemembered) return;
      showToast(`Always file "${merchantName}" as ${category}?`, 'info', {
        label: 'Yes',
        onClick: () => handleRememberMerchant(merchantName, category),
      });
    } catch (err) {
      // Not worth surfacing an error over -- the category change itself
      // already saved and toasted; this is just a missed opportunity to ask.
      console.error('Failed to check merchant rules:', err);
    }
  };

  // Manually override transaction category in real-time
  const handleUpdateCategory = (id: string, newCategory: TransactionCategory) => {
    const tx = transactions.find((t) => t.id === id);
    setTransactions((prev) =>
      prev.map((t) => (t.id === id ? { ...t, category: newCategory } : t))
    );
    showToast(`Category changed to ${newCategory}.`, 'info');
    if (tx && tx.category !== newCategory) {
      checkAndOfferRememberMerchant(tx.merchantName, newCategory);
    }
  };

  // Editing an existing row from the Transactions tab's edit sheet. `patch`
  // only ever carries fields the sheet actually let the user change:
  // - A transfer leg (transferId set) has amount/date locked in the UI and
  //   category fixed to Transfer -- guarded here too in case a caller slips
  //   through with more than the sheet allows.
  // - A bank-synced row (accountId matches a connection's plaidAccountId --
  //   the id namespace Plaid-synced rows use, see handleUpdateBankScope) has
  //   amount/date locked too: the next sync would overwrite any local edit.
  // - Otherwise, if the amount changed and the row is attributed to a
  //   non-Plaid manual account, that account's balance is adjusted by the
  //   delta -- the same rule handleAddNewTransaction and
  //   handleDeleteTransaction already use.
  const handleEditTransaction = (
    id: string,
    patch: Partial<Pick<Transaction, 'date' | 'merchantName' | 'amount' | 'category' | 'scope'>>
  ) => {
    const tx = transactions.find((t) => t.id === id);
    if (!tx) return;
    const prevTx = { ...tx };

    const safePatch = { ...patch };
    if (tx.transferId) {
      delete safePatch.amount;
      delete safePatch.date;
      safePatch.category = 'Transfer';
    }
    const isBankSynced = Boolean(tx.accountId && bankConnections.some((b) => b.plaidAccountId === tx.accountId));
    if (isBankSynced) {
      delete safePatch.amount;
      delete safePatch.date;
    }

    const amountChanged = safePatch.amount !== undefined && safePatch.amount !== tx.amount;
    const manualAccount = tx.accountId
      ? bankConnections.find((b) => b.id === tx.accountId && !b.isPlaid)
      : undefined;
    const delta = amountChanged && manualAccount ? safePatch.amount! - tx.amount : 0;

    if (delta !== 0 && manualAccount) {
      setBankConnections((prev) =>
        prev.map((b) => (b.id === manualAccount.id ? { ...b, balance: addMoney(b.balance, delta) } : b))
      );
    }

    setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, ...safePatch } : t)));

    const categoryChanged = safePatch.category !== undefined && safePatch.category !== prevTx.category;

    showToast('Transaction updated.', 'success', {
      label: 'Undo',
      onClick: () => {
        if (delta !== 0 && manualAccount) {
          setBankConnections((prev) =>
            prev.map((b) => (b.id === manualAccount.id ? { ...b, balance: addMoney(b.balance, -delta) } : b))
          );
        }
        setTransactions((prev) => prev.map((t) => (t.id === id ? prevTx : t)));
      },
    });

    if (categoryChanged) {
      checkAndOfferRememberMerchant(safePatch.merchantName ?? prevTx.merchantName, safePatch.category!);
    }
  };

  // Category and/or scope for every selected row at once, from the
  // Transactions tab's bulk-action bar. Skips reassigning a transfer leg's
  // category -- its category is fixed and bulk-selecting one shouldn't
  // silently break that -- but a scope change still applies to it.
  const handleBulkUpdate = (ids: string[], patch: { category?: string; scope?: 'personal' | 'joint' }) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setTransactions((prev) =>
      prev.map((t) => {
        if (!idSet.has(t.id)) return t;
        const next = { ...t };
        if (patch.scope) next.scope = patch.scope;
        if (patch.category && !t.transferId) next.category = patch.category;
        return next;
      })
    );
    const parts: string[] = [];
    if (patch.category) parts.push(`category set to ${patch.category}`);
    if (patch.scope) parts.push(`moved to ${patch.scope === 'joint' ? 'Joint' : 'Mine'}`);
    showToast(`${ids.length} transaction${ids.length === 1 ? '' : 's'} updated${parts.length ? `: ${parts.join(', ')}` : ''}.`, 'success');
  };

  // Deletes every selected row, expanding the selection to include both legs
  // of any transfer among them (deleting one leg without the other would
  // leave that account's balance permanently off -- same rule as the single-
  // row delete). Balances are reversed exactly as handleDeleteTransaction
  // does: a transfer's two accounts both reverse, a plain row's own non-Plaid
  // account reverses, everything else is untouched. One Undo restores all of it.
  const handleBulkDelete = (ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);

    const transferIds = new Set(
      transactions.filter((t) => idSet.has(t.id) && t.transferId).map((t) => t.transferId!)
    );
    const fullSet = new Set(ids);
    if (transferIds.size > 0) {
      for (const t of transactions) {
        if (t.transferId && transferIds.has(t.transferId)) fullSet.add(t.id);
      }
    }
    const removed = transactions.filter((t) => fullSet.has(t.id));

    const balanceDeltas = new Map<string, number>();
    for (const t of removed) {
      if (!t.accountId) continue;
      const account = bankConnections.find((b) => b.id === t.accountId);
      // Transfer legs are reversed on any account, Plaid or not -- that's
      // what handleAddTransfer adjusted and what single delete reverses.
      if (!account || (account.isPlaid && !t.transferId)) continue;
      balanceDeltas.set(account.id, (balanceDeltas.get(account.id) || 0) - t.amount);
    }
    if (balanceDeltas.size > 0) {
      setBankConnections((prev) =>
        prev.map((b) => (balanceDeltas.has(b.id) ? { ...b, balance: addMoney(b.balance, balanceDeltas.get(b.id)!) } : b))
      );
    }

    setTransactions((prev) => prev.filter((t) => !fullSet.has(t.id)));
    logSecurityEvent(`Bulk-deleted ${removed.length} transaction(s)`, 'warning');

    showToast(`${removed.length} transaction${removed.length === 1 ? '' : 's'} deleted.`, 'info', {
      label: 'Undo',
      onClick: () => {
        if (balanceDeltas.size > 0) {
          setBankConnections((prev) =>
            prev.map((b) => (balanceDeltas.has(b.id) ? { ...b, balance: addMoney(b.balance, -balanceDeltas.get(b.id)!) } : b))
          );
        }
        setTransactions((prev) => [...removed.filter((r) => !prev.some((p) => p.id === r.id)), ...prev]);
        logSecurityEvent(`Restored ${removed.length} bulk-deleted transaction(s)`, 'info');
      },
    });
  };

  // Saves a household-wide "always sort this merchant as X" rule. Applied
  // directly for manual entries and statement imports; for background Plaid
  // syncs the server only suggests a match and the user confirms (see
  // handlePlaidRefresh's suggestions handling below).
  const handleRememberMerchant = (merchantName: string, category: string) => {
    fetch('/api/budget/merchant-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantName, category }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to save merchant rule');
        showToast(`Got it — future "${merchantName}" transactions will sort to ${category}.`, 'success');
        logSecurityEvent(`Saved merchant rule: "${merchantName}" → ${category}`, 'info');
      })
      .catch((err) => {
        console.error('Failed to save merchant rule:', err);
        showToast('Could not save that merchant rule, please try again.', 'critical');
      });
  };

  // Overriding scope of live/mock transaction line in real-time
  const handleUpdateScope = (id: string, newScope: 'personal' | 'joint') => {
    setTransactions((prev) =>
      prev.map((t) => (t.id === id ? { ...t, scope: newScope } : t))
    );
    showToast(`Moved to ${newScope === 'joint' ? 'Joint' : 'Mine'}.`, 'info');
  };

  // No confirm() here -- an Undo button on the toast (6s, like every other
  // toast) is a safer, less disruptive net for an accidental click than a
  // blocking dialog on every single delete.
  const handleDeleteTransaction = (id: string) => {
    const tx = transactions.find((t) => t.id === id);
    if (!tx) return;

    // A transfer's two legs are deleted together so the accounts stay in sync --
    // removing only one side would leave the other account's balance permanently off.
    if (tx.transferId) {
      const pair = transactions.filter((t) => t.transferId === tx.transferId);
      setBankConnections((prev) =>
        prev.map((ba) => {
          const leg = pair.find((t) => t.accountId === ba.id);
          return leg ? { ...ba, balance: addMoney(ba.balance, -leg.amount) } : ba;
        })
      );
      setTransactions((prev) => prev.filter((t) => t.transferId !== tx.transferId));
      logSecurityEvent(`Removed transfer of ${currency}${Math.abs(tx.amount).toFixed(2)} between linked accounts`, 'warning');
      showToast('Transfer deleted and both account balances reverted.', 'info', {
        label: 'Undo',
        onClick: () => {
          setBankConnections((prev) =>
            prev.map((ba) => {
              const leg = pair.find((t) => t.accountId === ba.id);
              return leg ? { ...ba, balance: addMoney(ba.balance, leg.amount) } : ba;
            })
          );
          setTransactions((prev) => [...pair.filter((r) => !prev.some((p) => p.id === r.id)), ...prev]);
          logSecurityEvent(`Restored transfer of ${currency}${Math.abs(tx.amount).toFixed(2)} between linked accounts`, 'info');
        },
      });
      return;
    }

    // Reverse the balance ONLY for the specific account this row is attributed
    // to, and only when that account isn't Plaid-synced -- a Plaid account's
    // balance is reconciled from the bank on every sync, so adjusting it here
    // too would just cause drift until the next sync. Matching by accountId
    // (rather than the old bankName match) also fixes a real bug: bankName
    // matched EVERY connection sharing that bank's name, so deleting one $50
    // Chase transaction used to shift every account named "Chase" -- checking
    // and savings alike. A legacy row with no accountId touches no balance at
    // all, which is safer than guessing which account it came from.
    const account = tx.accountId ? bankConnections.find((b) => b.id === tx.accountId) : undefined;
    const shouldAdjustBalance = Boolean(account && !account.isPlaid);
    if (account && shouldAdjustBalance) {
      setBankConnections((prev) =>
        prev.map((ba) => (ba.id === account.id ? { ...ba, balance: addMoney(ba.balance, -tx.amount) } : ba))
      );
    }

    const removed = [tx];
    setTransactions((prev) => prev.filter((t) => t.id !== id));
    logSecurityEvent(`Removed transaction "${tx.merchantName}" value ${tx.amount < 0 ? '-' : '+'}${currency}${Math.abs(tx.amount).toFixed(2)}`, 'warning');
    showToast('Transaction deleted.', 'info', {
      label: 'Undo',
      onClick: () => {
        if (account && shouldAdjustBalance) {
          setBankConnections((prev) =>
            prev.map((ba) => (ba.id === account.id ? { ...ba, balance: addMoney(ba.balance, tx.amount) } : ba))
          );
        }
        setTransactions((prev) => [...removed.filter((r) => !prev.some((p) => p.id === r.id)), ...prev]);
        logSecurityEvent(`Restored transaction "${tx.merchantName}"`, 'info');
      },
    });
  };

  const handleDeleteBankConnection = async (id: string, bankName: string) => {
    const account = bankConnections.find((b) => b.id === id);
    const linkedGoals = goals.filter((g) => g.linkedBankConnectionId === id);

    const warningLines = [`Delete the "${bankName}" connection?`];
    if (linkedGoals.length > 0) {
      warningLines.push(`Goal(s) linked to it: ${linkedGoals.map((g) => g.name).join(', ')} will switch to manual tracking.`);
    }
    // window.confirm is blocked outright in the desktop app's embedded
    // browser and some kiosk browsers (same family of issue as
    // window.prompt, which already throws there) -- an in-app dialog works
    // everywhere instead. See components/ConfirmDialog.tsx.
    const confirmed = await confirm({
      title: 'Delete bank connection',
      message: warningLines.join('\n\n'),
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;

    setBankConnections((prev) => prev.filter((b) => b.id !== id));

    // A goal tracking this account's live balance would otherwise silently
    // read as $0 the moment the connection is gone -- freeze its last known
    // balance into manualAmount so progress isn't lost, just no longer live.
    if (linkedGoals.length > 0) {
      const lastBalance = account?.balance ?? 0;
      setGoals((prev) =>
        prev.map((g) =>
          g.linkedBankConnectionId === id
            ? { ...g, linkedBankConnectionId: undefined, manualAmount: lastBalance }
            : g
        )
      );
    }

    showToast(`Removed "${bankName}".`, 'info');
  };

  const handleUpdateBankScope = (id: string, newScope: 'personal' | 'joint') => {
    const account = bankConnections.find((b) => b.id === id);
    setBankConnections((prev) =>
      prev.map((b) => (b.id === id ? { ...b, scope: newScope } : b))
    );
    // Re-scoping a bank account only changes that account's own record --
    // transactions already synced from it keep whatever scope they were
    // stamped with at sync time (see routes/budget-plaid.ts's mapTransaction)
    // unless moved along with it here, so a re-scope also relocates its
    // existing transactions rather than only affecting future syncs.
    if (account?.plaidAccountId) {
      setTransactions((prev) =>
        prev.map((t) => (t.accountId === account.plaidAccountId ? { ...t, scope: newScope } : t))
      );
    }
    showToast(`Moved to ${newScope === 'joint' ? 'Joint' : 'Mine'}.`, 'info');
  };

  // Phase 5: sets a category's budgeted amount either as a one-off override for
  // exactly `month` (mode 'month', writes monthlyLimits[month]) or as the
  // standing default (mode 'default', writes `limit`, clearing month's and
  // every LATER month's own override -- see applyBudgetAmount). The write
  // itself goes through applyBudgetAmount applied to `prevSnapshot` -- the row
  // as it was the MOMENT this call started -- rather than to whatever the live
  // `prev` in setBudgets happens to hold, because the 'default' branch's own
  // toast offers a delayed "Only for {Month}" action that must reapply mode
  // 'month' on top of THIS snapshot too (fixed bug: clicking it used to leave
  // the standing default at the just-edited amount instead of restoring it,
  // because it re-derived from the store's current -- already-edited -- state
  // instead of from the pre-edit row).
  const handleSetBudgetAmount = (category: TransactionCategory, amount: number, mode: 'month' | 'default', month: string) => {
    // An "unbudgeted" category (spending but no stored row, see buildDisplayBudgets)
    // has nothing to find here -- the first amount set creates its row.
    const existingRow = budgets.find((b) => b.category === category);
    const prevRow: Budget = existingRow ?? { category, limit: 0, spent: 0, scope: 'joint' };
    const prevSnapshot = { ...prevRow };

    setBudgets((prev) =>
      prev.some((b) => b.category === category)
        ? prev.map((b) => (b.category === category ? applyBudgetAmount(prevSnapshot, amount, mode, month) : b))
        : [...prev, applyBudgetAmount(prevSnapshot, amount, mode, month)]
    );

    if (mode === 'default') {
      const monthOnlyName = formatMonthLabel(month).split(' ')[0];
      showToast(`${category} set to ${currency}${amount.toLocaleString()} from now on.`, 'info', {
        label: `Only for ${monthOnlyName}`,
        // Reapplies mode 'month' onto `prevSnapshot` -- the row from BEFORE
        // this edit -- not onto the live store state, so the standing default
        // this 'default' write just set is correctly put back.
        onClick: () =>
          setBudgets((prev) =>
            prev.map((b) => (b.category === category ? applyBudgetAmount(prevSnapshot, amount, 'month', month) : b))
          ),
      });
      return;
    }

    showToast(`${category} set to ${currency}${amount.toLocaleString()} for ${formatMonthLabel(month)} only.`, 'info', {
      label: 'Undo',
      onClick: () => setBudgets((prev) => prev.map((b) => (b.category === category ? prevSnapshot : b))),
    });
  };

  // Turns rollover (carry unspent -- or overspent -- money into next month) on
  // or off for a category. Turning it ON keeps an already-running chain's
  // start month rather than resetting it to `month` -- only a fresh start (it
  // was off) stamps `rolloverSince` with the current month. Turning it OFF
  // leaves `rolloverSince` in place: it's the history of when rollover was
  // last turned on, useful if it's turned back on later, and costs nothing to
  // keep around on a row that no longer rolls over.
  const handleSetRollover = (category: TransactionCategory, on: boolean, month: string) => {
    const prevRow = budgets.find((b) => b.category === category);
    if (!prevRow) return;
    const prevSnapshot = { ...prevRow };

    setBudgets((prev) =>
      prev.map((b) => {
        if (b.category !== category) return b;
        if (!on) return { ...b, rollover: false };
        const rolloverSince = b.rollover && b.rolloverSince ? b.rolloverSince : month;
        return { ...b, rollover: true, rolloverSince };
      })
    );

    showToast(
      on ? `${category} will roll over unspent money starting ${formatMonthLabel(month)}.` : `${category} will no longer roll over unspent money.`,
      'info',
      { label: 'Undo', onClick: () => setBudgets((prev) => prev.map((b) => (b.category === category ? prevSnapshot : b))) }
    );
  };


  const handleAddCategory = (newCat: string, isIncome: boolean = false) => {
    const trimmed = newCat.trim();
    if (!trimmed) return;
    if (categories.some(c => c.toLowerCase() === trimmed.toLowerCase())) {
      showToast(`Category "${trimmed}" already exists.`, 'warning');
      return;
    }

    setCategories(prev => [...prev, trimmed]);
    if (isIncome) {
      setIncomeCategories(prev => [...prev, trimmed]);
    }

    // Create corresponding budget with limit $0. No `spent` here -- it's a
    // legacy display field, always derived fresh by displayBudgets (see
    // types.ts's Budget.spent comment).
    setBudgets(prev => {
      if (prev.some(b => b.category === trimmed)) return prev;
      return [...prev, { category: trimmed, limit: 0 }];
    });
    showToast(`Added category ${trimmed}.`, 'success');
  };

  const handleRemoveCategory = async (catToRemove: string) => {
    if (catToRemove === 'Income' || catToRemove === 'Uncategorized') {
      showToast('System protected categories cannot be deleted', 'critical');
      return;
    }

    const affectedCount = transactions.filter((t) => t.category === catToRemove).length;
    const message = `Delete "${catToRemove}"?${affectedCount > 0 ? ` ${affectedCount} transaction(s) will move to Uncategorized.` : ''}`;
    const confirmed = await confirm({ title: 'Delete category', message, confirmLabel: 'Delete', tone: 'danger' });
    if (!confirmed) return;

    // Remove from categories list
    setCategories(prev => prev.filter(c => c !== catToRemove));

    // Remove from income categories list
    setIncomeCategories(prev => prev.filter(c => c !== catToRemove));

    // Remove from budgets list
    setBudgets(prev => prev.filter(b => b.category !== catToRemove));

    // Re-assign transactions belonging to this category to 'Uncategorized'
    setTransactions(prev => prev.map(t => t.category === catToRemove ? { ...t, category: 'Uncategorized' } : t));

    showToast(`Category "${catToRemove}" removed. Transactions moved to "Uncategorized".`, 'info');
  };

  // Moves a category between the Expenses and Income sections -- e.g. "Child Support"
  // may be money received rather than a bill paid, and that isn't fixed at creation time.
  const handleToggleCategoryIncome = (category: string) => {
    if (category === 'Income' || category === 'Uncategorized') {
      showToast('System protected categories cannot be reclassified', 'critical');
      return;
    }
    const isCurrentlyIncome = incomeCategories.includes(category);
    setIncomeCategories((prev) =>
      isCurrentlyIncome ? prev.filter((c) => c !== category) : [...prev, category]
    );
    // Also drop it from the tracked bill list if it just became income -- a category
    // can't sensibly be both a bill to pay and income received.
    if (!isCurrentlyIncome) {
      setBillCategories((prev) => prev.filter((c) => c !== category));
    }
    showToast(
      `"${category}" moved to ${isCurrentlyIncome ? 'Expenses' : 'Income'}.`,
      'info'
    );
  };

  // Toggles whether a category is tracked as a "bill" on the Bills Paid tab.
  const handleToggleBillCategory = (category: string) => {
    setBillCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  };

  const handlePlaidRefresh = async (bankId: string, hasAccessToken?: boolean) => {
    // A connection the server holds no access token for can't be synced at all -- it was
    // either never fully linked or the token was cleared out from under it. The token itself
    // stays on the server (10.7); the browser only learns whether there is one.
    if (!hasAccessToken) {
      showToast("This bank connection is missing its access token — remove it and link the bank again.", "critical");
      return;
    }

    setIsSyncingPlaid(bankId);
    showToast("Syncing with your bank…", "info");

    try {
      // Real production-grade Plaid transaction live sync request
      const res = await fetch("/api/budget/plaid/fetch_transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankConnectionId: bankId })
      });

      if (!res.ok) {
        const errObj = await res.json();
        throw new Error(errObj.error || "Plaid fetch_transactions request failed");
      }

      const data = await res.json();
      const incoming = data.transactions || [];
      const modified: Transaction[] = data.modified || [];
      const removed: string[] = data.removed || [];
      const suggestions: { id: string; merchantName: string; currentCategory: string; suggestedCategory: string }[] = data.suggestions || [];
      const balances: { accountId: string; balance: number }[] = data.balances || [];

      // the project notes #5: this balance previously only ever moved by
      // locally-incrementing it per transaction, so it drifted from the bank's
      // real balance over time (interest, holds, anything Plaid didn't sync as
      // a transaction). A sync now carries a fresh balance per account
      // straight from Plaid; reconcile it here instead of trusting the running
      // total forever.
      if (balances.length > 0) {
        const byAccountId = new Map(balances.map((b) => [b.accountId, b.balance]));
        setBankConnections((prev) =>
          prev.map((b) =>
            b.plaidAccountId && byAccountId.has(b.plaidAccountId)
              ? { ...b, balance: byAccountId.get(b.plaidAccountId)! }
              : b
          )
        );
      }

      // Plaid revises and reverses transactions after they post, so a sync that
      // only reads `added` leaves corrected amounts and cancelled charges stale.
      if (modified.length > 0) {
        const byId = new Map(modified.map((t) => [t.id, t]));
        setTransactions((prev) =>
          prev.map((t) => (byId.has(t.id) ? { ...t, ...byId.get(t.id)!, scope: t.scope } : t))
        );
      }
      if (removed.length > 0) {
        const gone = new Set(removed);
        setTransactions((prev) => prev.filter((t) => !gone.has(t.id)));
      }

      if (incoming.length === 0 && modified.length === 0 && removed.length === 0) {
        showToast("Up to date — no new transactions.", "success");
      } else {
        // Computed twice on purpose: once here against the state this closure
        // captured, to drive the toast/alerts/suggestions below, and again
        // inside the setTransactions updater against `prev` -- the live state
        // at apply time -- so two syncs firing close together (e.g. an
        // impatient double-click) can't each dedupe against a stale snapshot
        // and both insert the same "new" rows. dedupeIncoming is budgetMath's
        // pure content+id dedupe rule -- see its comment there.
        const uniqueIncoming = dedupeIncoming(transactions, incoming);
        const uniqueIncomingIds = new Set(uniqueIncoming.map((t: Transaction) => t.id));

        if (uniqueIncoming.length > 0) {
          checkThresholdAlerts(uniqueIncoming);
          setTransactions((prev) => [...dedupeIncoming(prev, incoming), ...prev]);
        }

        const parts = [`${uniqueIncoming.length} new`];
        if (modified.length > 0) parts.push(`${modified.length} updated`);
        if (removed.length > 0) parts.push(`${removed.length} removed`);
        showToast(
          `Synced: ${parts.join(', ')}${data.backfilled ? ` (full history backfill, ${data.pages} page${data.pages === 1 ? '' : 's'})` : ''}.`,
          "success"
        );

        // Surface a remembered merchant rule as a dismissable banner instead of
        // a blocking window.confirm per merchant -- this fires from a background
        // sync, so a modal-style prompt would freeze the whole page (badly, on
        // the household's kiosk screen) until someone walked over to dismiss it.
        // Grouped so one merchant with several transactions only shows once.
        const relevantSuggestions = suggestions.filter((s) => uniqueIncomingIds.has(s.id));
        const grouped = new Map<string, { merchantName: string; suggestedCategory: string; ids: string[] }>();
        for (const s of relevantSuggestions) {
          const key = `${s.merchantName}→${s.suggestedCategory}`;
          if (!grouped.has(key)) grouped.set(key, { merchantName: s.merchantName, suggestedCategory: s.suggestedCategory, ids: [] });
          grouped.get(key)!.ids.push(s.id);
        }
        if (grouped.size > 0) {
          setPendingRuleSuggestions((prev) => {
            const byKey = new Map(prev.map((s) => [s.key, s]));
            for (const [key, s] of grouped) {
              if (!byKey.has(key)) byKey.set(key, { key, ...s });
            }
            return Array.from(byKey.values());
          });
        }
      }
    } catch (err: any) {
      console.error(err);
      showToast(`Couldn't sync with the bank: ${err.message}`, "critical");
    } finally {
      setIsSyncingPlaid(null);
    }
  };

  // Body of the BankConnectionModal's onConnect callback -- moved here
  // unchanged so the shell only wires it to the modal.
  const handleBankConnected = (
    connection: BankConnection | BankConnection[],
    initialTransactions?: Transaction[],
    newCreditCards?: CreditCard[]
  ) => {
    const connections = Array.isArray(connection) ? connection : [connection];
    if (connections.length > 0) {
      setBankConnections((prev) => [...connections, ...prev]);
    }
    if (newCreditCards && newCreditCards.length > 0) {
      setCreditCards((prev) => [...newCreditCards, ...prev]);
    }

    if (initialTransactions && initialTransactions.length > 0) {
      // Check for overspending triggers BEFORE adding, same as every
      // other entry point -- see checkThresholdAlerts.
      checkThresholdAlerts(initialTransactions);

      // Prepend new synced transactions from Plaid
      setTransactions((prev) => [...initialTransactions, ...prev]);
    }

    const linkedNames = Array.from(new Set([
      ...connections.map(c => c.bankName),
      ...(newCreditCards || []).map(c => c.issuer),
    ])).join(', ');
    const parts = [
      connections.length > 0 ? `${connections.length} account(s)` : null,
      newCreditCards && newCreditCards.length > 0 ? `${newCreditCards.length} credit card(s)` : null,
      initialTransactions && initialTransactions.length > 0 ? `${initialTransactions.length} recent transactions` : null,
    ].filter(Boolean).join(', ');
    triggerAlert('info', 'Uncategorized', `Connected ${linkedNames}: synced ${parts}.`);
  };

  // Applies/dismisses a suggested merchant rule from the banner. `key` and
  // `pendingRuleSuggestions` are both read from this render's closure, same as
  // the inline `.map()` handlers this replaced.
  const applyRuleSuggestion = (key: string) => {
    const suggestion = pendingRuleSuggestions.find((s) => s.key === key);
    if (!suggestion) return;
    const idSet = new Set(suggestion.ids);
    setTransactions((prev) => prev.map((t) => (idSet.has(t.id) ? { ...t, category: suggestion.suggestedCategory } : t)));
    setPendingRuleSuggestions((prev) => prev.filter((p) => p.key !== key));
  };

  const dismissRuleSuggestion = (key: string) => {
    setPendingRuleSuggestions((prev) => prev.filter((p) => p.key !== key));
  };

  const dismissAllRuleSuggestions = () => {
    setPendingRuleSuggestions([]);
  };

  const clearAlerts = () => {
    setAlerts([]);
    showToast('Activity cleared.', 'info');
  };

  // Marks every alert read at once -- the Overview tab's Activity card's
  // "Mark all read" button (Clear removes them outright; this just clears the
  // unread count without losing the history).
  const markAllAlertsRead = () => {
    setAlerts((prev) => prev.map((a) => ({ ...a, isRead: true })));
  };

  const clearSecurityLog = () => {
    setSecurityLog(DEFAULT_SECURITY_LOG);
    putStoreConfig('securityLog', DEFAULT_SECURITY_LOG);
    showToast('Security event logs cleared successfully.', 'info');
  };

  const handleAddGoal = (goal: SavingsGoal) => {
    setGoals((prev) => [...prev, goal]);
    showToast(`New goal created: "${goal.name}"`, 'success');
  };

  const handleUpdateGoal = (id: string, updates: Partial<SavingsGoal>) => {
    setGoals((prev) => prev.map((g) => (g.id === id ? { ...g, ...updates } : g)));
  };

  const handleDeleteGoal = (id: string) => {
    setGoals((prev) => prev.filter((g) => g.id !== id));
    showToast('Goal removed.', 'info');
  };

  // ---------------------------------------------------------------------
  // Phase 6: recurring bills.
  // ---------------------------------------------------------------------

  const handleAddBill = (bill: Bill) => {
    setBills((prev) => [...prev, bill]);
    showToast(`Added bill "${bill.name}".`, 'success');
  };

  const handleUpdateBill = (id: string, updates: Partial<Bill>) => {
    const prevBill = bills.find((b) => b.id === id);
    if (!prevBill) return;
    const prevSnapshot = { ...prevBill };

    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, ...updates } : b)));
    showToast(`Updated "${prevBill.name}".`, 'success', {
      label: 'Undo',
      onClick: () => setBills((prev) => prev.map((b) => (b.id === id ? prevSnapshot : b))),
    });
  };

  const handleDeleteBill = async (id: string) => {
    const bill = bills.find((b) => b.id === id);
    if (!bill) return;

    const confirmed = await confirm({
      title: 'Delete bill',
      message: `Delete "${bill.name}"? This only removes the bill -- any transactions already recorded against it stay on the ledger.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;

    setBills((prev) => prev.filter((b) => b.id !== id));
    showToast(`Deleted "${bill.name}".`, 'info', {
      label: 'Undo',
      onClick: () => setBills((prev) => (prev.some((b) => b.id === id) ? prev : [...prev, bill])),
    });
  };

  // Manually marks a bill paid for `month` -- either linked to a real
  // transaction (from the "Link a transaction" picker) or just marked paid
  // with nothing to link (a cash payment, an autopay the household trusts
  // without cross-checking the ledger).
  const handleMarkBillPaid = (billId: string, month: string, transactionId?: string) => {
    const bill = bills.find((b) => b.id === billId);
    if (!bill) return;
    const prevPayments = bill.payments;

    setBills((prev) =>
      prev.map((b) =>
        b.id === billId
          ? { ...b, payments: { ...(b.payments || {}), [month]: { transactionId, markedAt: new Date().toISOString() } } }
          : b
      )
    );
    showToast(`Marked "${bill.name}" paid for ${formatMonthLabel(month)}.`, 'success', {
      label: 'Undo',
      onClick: () => setBills((prev) => prev.map((b) => (b.id === billId ? { ...b, payments: prevPayments } : b))),
    });
  };

  // `payments[month] = null` explicitly means "not paid" and blocks
  // auto-matching for that month (see budgetMath's billStatus) -- otherwise
  // clearing a wrong manual mark would just have the same transaction (or a
  // different one within the window) auto-match right back.
  const handleMarkBillUnpaid = (billId: string, month: string) => {
    const bill = bills.find((b) => b.id === billId);
    if (!bill) return;
    const prevPayments = bill.payments;

    setBills((prev) =>
      prev.map((b) => (b.id === billId ? { ...b, payments: { ...(b.payments || {}), [month]: null } } : b))
    );
    showToast(`Marked "${bill.name}" unpaid.`, 'info', {
      label: 'Undo',
      onClick: () => setBills((prev) => prev.map((b) => (b.id === billId ? { ...b, payments: prevPayments } : b))),
    });
  };

  // "Find recurring bills" / the migration banner both funnel through here:
  // turns a batch of accepted suggestions into real bill rows in one go.
  // Nothing is created until this is called -- detectRecurring itself is
  // read-only.
  const handleAddBillsFromSuggestions = (suggestions: RecurringBillSuggestion[]) => {
    if (suggestions.length === 0) return;
    const newBills: Bill[] = suggestions.map((s, i) => ({
      id: `bill-${Date.now()}-${i}-${Math.floor(Math.random() * 1000000)}`,
      name: s.name,
      amount: s.amount,
      dueDay: s.dueDay,
      frequency: s.frequency,
      // Anchored at the earliest month the pattern was actually seen (not
      // "now") so looking back at a recent month still recognizes the bill as
      // due/paid there instead of only starting from the moment it was added.
      startMonth: [...s.months].sort()[0] || currentMonthOf(new Date()),
      category: s.category,
      matchText: s.matchText,
      scope: 'joint',
      active: true,
    }));
    setBills((prev) => [...prev, ...newBills]);
    showToast(`Added ${newBills.length} bill${newBills.length === 1 ? '' : 's'} from your spending history.`, 'success');
  };

  // Combined sync status across the seven tables -- total pending writes,
  // total rows that gave up retrying, and the first non-null error.
  const syncStatus: SyncStatus = {
    pending: txSync.status.pending + budgetSync.status.pending + bankSync.status.pending + cardSync.status.pending + alertSync.status.pending + goalSync.status.pending + billSync.status.pending,
    failed: txSync.status.failed + budgetSync.status.failed + bankSync.status.failed + cardSync.status.failed + alertSync.status.failed + goalSync.status.failed + billSync.status.failed,
    lastError: txSync.status.lastError || budgetSync.status.lastError || bankSync.status.lastError || cardSync.status.lastError || alertSync.status.lastError || goalSync.status.lastError || billSync.status.lastError || null,
  };

  const retryFailed = () => {
    txSync.retryFailed();
    budgetSync.retryFailed();
    bankSync.retryFailed();
    cardSync.retryFailed();
    alertSync.retryFailed();
    goalSync.retryFailed();
    billSync.retryFailed();
  };

  return {
    // Data
    isDataLoaded,
    loadError,
    loadBudgetData,
    transactions,
    budgets,
    bankConnections,
    creditCards,
    alerts,
    categories,
    incomeCategories,
    billCategories,
    goals,
    bills,
    securityLog,
    pendingRuleSuggestions,
    isSyncingPlaid,
    isAddingTransaction,
    // Raw setters some child components (CreditCardTracker) take directly.
    setCreditCards,
    setBankConnections,
    // Pass-through so components that need the raw toast function directly
    // (CreditCardTracker) can take it as a normal prop.
    showToast,
    // Pass-through so tabs (Transactions' bulk-delete) can raise their own
    // in-app confirmation without Budget.tsx drilling it down separately.
    confirm,
    // Handlers
    logSecurityEvent,
    triggerAlert,
    checkThresholdAlerts,
    handleAddNewTransaction,
    handleCreditCardTransaction,
    handleAddTransfer,
    handleImportStatement,
    handleNewCategoriesFromAI,
    handleUpdateCategory,
    handleEditTransaction,
    handleBulkUpdate,
    handleBulkDelete,
    handleRememberMerchant,
    handleUpdateScope,
    handleDeleteTransaction,
    handleDeleteBankConnection,
    handleUpdateBankScope,
    handleSetBudgetAmount,
    handleSetRollover,
    handleAddCategory,
    handleRemoveCategory,
    handleToggleCategoryIncome,
    handleToggleBillCategory,
    handleResetAllData,
    handleExportJSON,
    handlePlaidRefresh,
    handleBankConnected,
    applyRuleSuggestion,
    dismissRuleSuggestion,
    dismissAllRuleSuggestions,
    clearAlerts,
    markAllAlertsRead,
    clearSecurityLog,
    handleAddGoal,
    handleUpdateGoal,
    handleDeleteGoal,
    handleAddBill,
    handleUpdateBill,
    handleDeleteBill,
    handleMarkBillPaid,
    handleMarkBillUnpaid,
    handleAddBillsFromSuggestions,
    syncStatus,
    retryFailed,
  };
}

export type BudgetStore = ReturnType<typeof useBudgetStore>;
