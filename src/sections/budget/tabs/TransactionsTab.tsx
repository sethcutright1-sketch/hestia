// src/sections/budget/tabs/TransactionsTab.tsx -- Budget.tsx's old
// "transactions" tab: just the TransactionList, wired to the store/view
// instead of Budget.tsx's own local state and handlers. CSV export, filtering,
// pagination, bulk actions, and the edit/import sheets now live inside
// TransactionList itself (Phase 4) -- this tab is just the wiring.

import TransactionList from '../components/TransactionList';
import type { BudgetStore } from '../useBudgetStore';
import type { BudgetView } from '../viewTypes';

interface TransactionsTabProps {
  store: BudgetStore;
  view: BudgetView;
}

export default function TransactionsTab({ store, view }: TransactionsTabProps) {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      <TransactionList
        transactions={view.monthFilteredTransactions}
        onAddTransaction={store.handleAddNewTransaction}
        onUpdateCategory={store.handleUpdateCategory}
        onEditTransaction={store.handleEditTransaction}
        onUpdateScope={store.handleUpdateScope}
        onDeleteTransaction={store.handleDeleteTransaction}
        onBulkUpdate={store.handleBulkUpdate}
        onBulkDelete={store.handleBulkDelete}
        onImportStatement={store.handleImportStatement}
        onNewCategories={store.handleNewCategoriesFromAI}
        isAddingFromFeed={store.isAddingTransaction}
        selectedCategory={view.categoryFilter}
        onCategoryChange={view.onCategoryFilterChange}
        categories={store.categories}
        bankConnections={store.bankConnections}
        currency={view.currency}
        selectedMonth={view.month}
        confirm={store.confirm}
      />
    </div>
  );
}
