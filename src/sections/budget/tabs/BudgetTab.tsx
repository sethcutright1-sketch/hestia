// src/sections/budget/tabs/BudgetTab.tsx -- Budget.tsx's old "planner" tab:
// just BudgetSettings, wired to the store/view instead of Budget.tsx's own
// local state and handlers.

import BudgetSettings from '../components/BudgetSettings';
import { formatMonthLabel } from '../budgetMath';
import type { BudgetStore } from '../useBudgetStore';
import type { BudgetView } from '../viewTypes';

interface BudgetTabProps {
  store: BudgetStore;
  view: BudgetView;
}

export default function BudgetTab({ store, view }: BudgetTabProps) {
  return (
    <div className="max-w-6xl mx-auto animate-in fade-in duration-200">
      <BudgetSettings
        // Budgets are monthly -- when the header is on "All time" this uses
        // the current calendar month instead of showing all-time spending
        // against a monthly limit (see Budget.tsx's effectiveMonth/monthBudgets).
        budgets={view.monthBudgets}
        effectiveMonth={view.effectiveMonth}
        showAllTimeNote={view.month === 'all'}
        effectiveMonthLabel={formatMonthLabel(view.effectiveMonth)}
        onSetBudgetAmount={store.handleSetBudgetAmount}
        onSetRollover={store.handleSetRollover}
        onCategoryClick={view.onCategoryFilterSelect}
        incomeCategories={store.incomeCategories}
        currency={view.currency}
        onAddCategory={store.handleAddCategory}
        onRemoveCategory={store.handleRemoveCategory}
        onToggleCategoryIncome={store.handleToggleCategoryIncome}
      />
    </div>
  );
}
