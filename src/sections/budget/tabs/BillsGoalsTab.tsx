// src/sections/budget/tabs/BillsGoalsTab.tsx -- the merged Bills & Goals tab:
// Budget.tsx's old "bills" tab (BillsTracker) stacked above the old "goals"
// tab (FinancialGoals). Content moved as-is; only the two former tabs'
// wrappers now sit under one shared fade-in wrapper with space-y-6 between
// them instead of being separate tab panes.

import BillsTracker from '../components/BillsTracker';
import FinancialGoals from '../components/FinancialGoals';
import type { BudgetStore } from '../useBudgetStore';
import type { BudgetView } from '../viewTypes';

interface BillsGoalsTabProps {
  store: BudgetStore;
  view: BudgetView;
}

export default function BillsGoalsTab({ store, view }: BillsGoalsTabProps) {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Bills section (formerly the category-based "Bills Paid" tab, rebuilt
          in Phase 6 around real bills with due dates and amounts). */}
      <BillsTracker
        bills={store.bills}
        transactions={view.displayedTransactions}
        effectiveMonth={view.effectiveMonth}
        showAllTimeNote={view.month === 'all'}
        currency={view.currency}
        categories={store.categories}
        incomeCategories={store.incomeCategories}
        billCategories={store.billCategories}
        onAddBill={store.handleAddBill}
        onUpdateBill={store.handleUpdateBill}
        onDeleteBill={store.handleDeleteBill}
        onMarkBillPaid={store.handleMarkBillPaid}
        onMarkBillUnpaid={store.handleMarkBillUnpaid}
        onAddBillsFromSuggestions={store.handleAddBillsFromSuggestions}
        onCategoryFilterSelect={view.onCategoryFilterSelect}
      />

      {/* Financial Goals section (formerly its own tab) */}
      <div className="max-w-6xl mx-auto">
        <FinancialGoals
          goals={store.goals}
          onAddGoal={store.handleAddGoal}
          onUpdateGoal={store.handleUpdateGoal}
          onDeleteGoal={store.handleDeleteGoal}
          bankConnections={store.bankConnections}
          currency={view.currency}
        />
      </div>
    </div>
  );
}
