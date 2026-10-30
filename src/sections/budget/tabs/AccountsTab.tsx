// src/sections/budget/tabs/AccountsTab.tsx -- the merged Accounts tab: bank
// connections + transfer form stacked above the credit card tracker. Phase 3
// drops the "Sync Channels" and "System Metrics / Pro Tip" filler boxes and
// renames the section to plain "Bank accounts" language.

import { Landmark, RefreshCw, Trash2, Plus } from 'lucide-react';
import TransferForm from '../components/TransferForm';
import CreditCardTracker from '../components/CreditCardTracker';
import { formatMoney } from '../format';
import type { BudgetStore } from '../useBudgetStore';
import type { BudgetView } from '../viewTypes';

interface AccountsTabProps {
  store: BudgetStore;
  view: BudgetView;
  onOpenBankModal: () => void;
}

export default function AccountsTab({ store, view, onOpenBankModal }: AccountsTabProps) {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Left: bank connections list */}
        <div className="md:col-span-8 space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">Bank accounts</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Link, sync, and remove connected accounts.</p>
              </div>
              <button
                onClick={onOpenBankModal}
                className="px-4 py-2 min-h-10 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1 shadow-sm shrink-0"
              >
                <Plus className="w-3.5 h-3.5" /> Link a bank
              </button>
            </div>

            <div className="space-y-4">
              {store.bankConnections.length === 0 ? (
                <div className="bg-slate-50 dark:bg-slate-800/40 border border-dashed border-slate-200 dark:border-slate-700 p-8 rounded-2xl text-center space-y-3">
                  <Landmark className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto" />
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-200">No bank accounts linked yet</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                      Connect your bank accounts securely via Plaid, or try the sandbox demo.
                    </p>
                  </div>
                  <button
                    onClick={onOpenBankModal}
                    className="px-4 py-2 min-h-10 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-indigo-700 dark:text-indigo-400 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-2xs"
                  >
                    Link your first bank
                  </button>
                </div>
              ) : (
                store.bankConnections.map((bank) => (
                  <div key={bank.id} className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 hover:border-indigo-200 dark:hover:border-indigo-800 transition-all shadow-2xs flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 relative overflow-hidden">
                    <div className={`absolute top-0 left-0 w-1 h-full ${bank.isPlaid ? 'bg-[#00C08B]' : 'bg-indigo-500'}`} />
                    <div className="pl-2 min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="p-1 px-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-[10px] font-black uppercase tracking-wider">
                          {bank.bankName}
                        </span>
                        {bank.isPlaid && (
                          <span className="px-1.5 py-0.5 bg-emerald-50 dark:bg-emerald-950/25 text-[9px] font-black text-[#00C08B] tracking-wider uppercase border border-emerald-200 dark:border-emerald-800/60 rounded-md">
                            Plaid Secure
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-200 mt-2">{bank.accountName}</p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">Ending in ••••{bank.lastFour}</p>
                    </div>

                    <div className="flex items-center gap-2 sm:gap-4 shrink-0 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 border-slate-100 dark:border-slate-800 pt-3 sm:pt-0">
                      <button
                        onClick={() => store.handleUpdateBankScope(bank.id, bank.scope === 'joint' ? 'personal' : 'joint')}
                        className={`inline-flex items-center justify-center gap-1.5 min-h-10 px-2.5 py-1.5 text-[10px] font-bold tracking-tight uppercase rounded-md border border-dashed transition-all cursor-pointer shrink-0 ${
                          bank.scope === 'joint'
                            ? 'bg-sky-50 dark:bg-sky-950/25 text-sky-700 dark:text-sky-400 border-sky-300 dark:border-sky-700 hover:bg-sky-100 dark:hover:bg-sky-950/40 hover:text-sky-900 dark:hover:text-sky-300'
                            : 'bg-indigo-50 dark:bg-indigo-950/25 text-indigo-700 dark:text-indigo-400 border-indigo-300 dark:border-indigo-700 hover:bg-indigo-100 dark:hover:bg-indigo-950/40 hover:text-indigo-900 dark:hover:text-indigo-300'
                        }`}
                        title="Click to toggle between Mine and Joint"
                      >
                        {bank.scope === 'joint' ? 'Joint' : 'Mine'}
                      </button>
                      <div className="text-left sm:text-right">
                        <p className="text-[9px] text-slate-400 dark:text-slate-500 font-black uppercase tracking-widest">Balance</p>
                        <p className="font-mono font-black text-slate-900 dark:text-slate-100 text-sm leading-tight">
                          {formatMoney(bank.balance, view.currency)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {bank.isPlaid && (
                          <button
                            onClick={() => store.handlePlaidRefresh(bank.id, bank.hasAccessToken)}
                            disabled={store.isSyncingPlaid === bank.id}
                            title="Sync recent transactions from Plaid"
                            aria-label={`Sync ${bank.bankName}`}
                            className="min-h-10 min-w-10 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-[#00C08B]/10 hover:text-[#00C08B] text-slate-500 dark:text-slate-400 transition-all cursor-pointer inline-flex items-center justify-center"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${store.isSyncingPlaid === bank.id ? 'animate-spin text-[#00C08B]' : ''}`} />
                          </button>
                        )}
                        <button
                          onClick={() => store.handleDeleteBankConnection(bank.id, bank.bankName)}
                          title="Remove this account"
                          className="min-h-10 px-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-700 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-800/60 text-slate-600 dark:text-slate-300 transition-all cursor-pointer inline-flex items-center justify-center gap-1.5 text-xs font-bold"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-500 dark:text-red-400" />
                          <span>Remove</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: transfer between accounts */}
        <div className="md:col-span-4 space-y-6">
          <TransferForm
            bankConnections={store.bankConnections}
            onTransfer={store.handleAddTransfer}
            currency={view.currency}
          />
        </div>
      </div>

      {/* Credit Card Tracker section (formerly its own tab) */}
      <div className="max-w-6xl mx-auto">
        <CreditCardTracker
          creditCards={store.creditCards}
          setCreditCards={store.setCreditCards}
          bankConnections={store.bankConnections}
          setBankConnections={store.setBankConnections}
          onAddCardTransaction={store.handleCreditCardTransaction}
          ledgerScope={view.scope}
          currency={view.currency}
          categories={store.categories}
          showToast={store.showToast}
        />
      </div>
    </div>
  );
}
