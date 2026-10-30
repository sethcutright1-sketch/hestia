// src/sections/budget/viewTypes.ts -- shared prop-shape types for the Budget
// panel's header and its five tab components, so Budget.tsx (the shell) and
// every tab agree on what "the current view" means without a 30-prop
// drill-down into each tab component.

import type { LucideIcon } from 'lucide-react';
import type { Transaction, DisplayBudget } from './types';

export type TabId = 'overview' | 'transactions' | 'budget' | 'accounts' | 'bills';

export interface BudgetTabConfig {
  id: TabId;
  label: string;
  icon: LucideIcon;
  // Only Transactions and Accounts show a live count suffix today.
  count?: number;
}

// The scope/month filters and the numbers derived from them -- Budget.tsx's
// old displayBudgets/displayedTransactions/monthFilteredTransactions/
// totalBalance/etc. memos, computed once in the shell and handed to whichever
// tab is active instead of every tab re-deriving its own copy.
export interface BudgetView {
  scope: 'all' | 'personal' | 'joint';
  onScopeChange: (scope: 'all' | 'personal' | 'joint') => void;
  month: string;
  availableMonths: string[];
  onMonthChange: (month: string) => void;
  categoryFilter: string;
  onCategoryFilterChange: (category: string) => void;
  // Jumps to the Transactions tab filtered to one category -- charts and the
  // budget planner both drive this (Budget.tsx's old handleCategoryFilterSelect).
  onCategoryFilterSelect: (category: string) => void;
  // Plain tab switch with no filter side-effect -- Overview's "set up your
  // budget" prompt uses this to jump to the Budget tab.
  onNavigateTab: (tab: TabId) => void;
  // A UI preference owned by the shell (see Budget.tsx), not the store, but
  // carried here too since almost every tab needs it purely for formatting.
  currency: string;
  displayedTransactions: Transaction[];
  monthFilteredTransactions: Transaction[];
  displayBudgets: DisplayBudget[];
  // Budgets are monthly, so anything that shows a limit vs. spent needs a real
  // month even when the header is on "All time" -- effectiveMonth is `month`
  // itself, or the current calendar month when `month === 'all'`.
  // monthBudgets is displayBudgets recomputed for that effective month (as
  // opposed to `displayBudgets`, which follows the header's own `month`
  // literally, including 'all'). See Budget.tsx.
  effectiveMonth: string;
  monthBudgets: DisplayBudget[];
  effectiveMonthTransactions: Transaction[];
  totalBalance: number;
  safeToSpend: number;
}
