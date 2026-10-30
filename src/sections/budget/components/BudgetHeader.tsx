// src/sections/budget/components/BudgetHeader.tsx -- everything that sits
// above the active tab's content: the title + save-status pill + Settings
// button, the All/Mine/Joint scope switcher + month stepper, the
// merchant-rule suggestions banner from a background Plaid sync, and the tab
// strip itself.
//
// Phase 3 rewrite: the old "Unified Ledger Workspace" card and its Total
// Balance readout are gone (the balance moved into Overview's tiles), scope
// switching no longer toasts, and the tab strip is a fixed 5-column grid
// instead of a horizontally-scrolling row with arrow buttons -- at 375px
// there's nowhere to scroll to, the grid just fits.

import { ChevronLeft, ChevronRight, Settings2, AlertOctagon, CheckCircle2 } from 'lucide-react';
import type { BudgetTabConfig, TabId } from '../viewTypes';
import type { BudgetStore } from '../useBudgetStore';
import { monthRange, formatMonthLabel, stepMonth } from '../budgetMath';

interface BudgetHeaderProps {
  store: BudgetStore;
  scope: 'all' | 'personal' | 'joint';
  onScopeChange: (scope: 'all' | 'personal' | 'joint') => void;
  month: string;
  availableMonths: string[];
  onMonthChange: (month: string) => void;
  onOpenSettings: () => void;
  tabs: BudgetTabConfig[];
  activeTab: TabId;
  onTabChange: (id: TabId) => void;
}

const SCOPES: { id: 'all' | 'personal' | 'joint'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'personal', label: 'Mine' },
  { id: 'joint', label: 'Joint' },
];

function SaveStatusPill({
  pending,
  failed,
  lastError,
  onRetry,
}: {
  pending: number;
  failed: number;
  lastError: string | null;
  onRetry: () => void;
}) {
  if (failed > 0) {
    return (
      <div
        className="flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-xl border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-[11px] font-bold shrink-0"
        title={lastError || undefined}
      >
        <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden sm:inline whitespace-nowrap">
          {failed} change{failed === 1 ? '' : 's'} didn't save
        </span>
        <span className="hidden sm:inline text-red-300 dark:text-red-700">·</span>
        <button
          type="button"
          onClick={onRetry}
          className="underline decoration-dotted hover:no-underline cursor-pointer whitespace-nowrap min-h-9 sm:min-h-0 px-1.5 sm:px-0.5"
        >
          <span className="sm:hidden">Retry ({failed})</span>
          <span className="hidden sm:inline">Retry</span>
        </button>
      </div>
    );
  }
  if (pending > 0) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-[11px] font-bold shrink-0">
        <span className="w-3 h-3 border-2 border-slate-300 dark:border-slate-600 border-t-slate-500 dark:border-t-slate-300 rounded-full animate-spin shrink-0" />
        <span>Saving…</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-emerald-100 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 text-[11px] font-bold shrink-0">
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
      <span className="hidden sm:inline">All changes saved</span>
      <span className="sm:hidden">Saved</span>
    </div>
  );
}

export default function BudgetHeader({
  store,
  scope,
  onScopeChange,
  month,
  availableMonths,
  onMonthChange,
  onOpenSettings,
  tabs,
  activeTab,
  onTabChange,
}: BudgetHeaderProps) {
  const range = monthRange(availableMonths, new Date());
  const earliest = range[range.length - 1];
  const latest = range[0];
  const isAll = month === 'all';

  // Disabled exactly at either end of the allowed range: the earliest month
  // with data for ‹, and -- since "All time" is the newest end of this
  // timeline -- "All time" itself for ›. ‹ from "All time" jumps to the
  // latest month rather than being disabled, per the header spec.
  const canGoPrev = isAll || month > earliest;
  const canGoNext = !isAll && month < latest;

  const handlePrev = () => {
    if (!canGoPrev) return;
    onMonthChange(isAll ? latest : stepMonth(month, -1));
  };
  const handleNext = () => {
    if (!canGoNext) return;
    onMonthChange(stepMonth(month, 1));
  };

  return (
    <div className="space-y-4">
      {/* Row 1 -- title, save-status pill, Settings. The mono app's own header
          already covers branding/navigation/sign-out, so only budget-specific
          controls live here. */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Budget</h2>
        <div className="flex items-center gap-2">
          <SaveStatusPill {...store.syncStatus} onRetry={store.retryFailed} />
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 min-h-10 sm:min-h-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all cursor-pointer font-bold text-[11px]"
            title="Configure budget preferences"
            aria-label="Budget settings"
            id="budget-settings-trigger-btn"
          >
            <Settings2 className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span className="hidden sm:inline">Settings</span>
          </button>
        </div>
      </div>

      {/* Row 2 -- All/Mine/Joint scope switcher + month stepper. Switching
          either one never toasts (see Budget.tsx's handleScopeChange) --
          these are navigation, not actions with a result to report. */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl self-start shrink-0" role="group" aria-label="Scope">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              onClick={() => onScopeChange(s.id)}
              aria-pressed={scope === s.id}
              className={`px-4 py-1.5 min-h-9 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                scope === s.id
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 self-start sm:self-auto">
          <button
            type="button"
            onClick={handlePrev}
            disabled={!canGoPrev}
            aria-label="Previous month"
            className="flex items-center justify-center min-h-10 min-w-10 sm:min-h-8 sm:min-w-8 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* A native <select> styled to read as plain text -- clicking it
              opens the month list (native picker), but at rest it looks like
              a label between the two arrows, not a dropdown box. */}
          <div className="relative">
            <select
              value={isAll ? 'all' : month}
              onChange={(e) => onMonthChange(e.target.value)}
              aria-label="Select month"
              className="appearance-none bg-transparent border-0 text-sm font-bold text-slate-800 dark:text-slate-100 text-center cursor-pointer focus:outline-none py-1.5 pr-0 min-w-[9.5rem]"
            >
              <option value="all" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All time</option>
              {range.map((m) => (
                <option key={m} value={m} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                  {formatMonthLabel(m)}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={handleNext}
            disabled={!canGoNext}
            aria-label="Next month"
            className="flex items-center justify-center min-h-10 min-w-10 sm:min-h-8 sm:min-w-8 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tab strip -- a fixed 5-column grid so it always fits at 375px with no
          horizontal scroll. Icon-over-label on phones (count suffixes
          dropped there for space), inline icon+label with counts from `sm`. */}
      <div className="grid grid-cols-5 border-b border-slate-200 dark:border-slate-800">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const shortLabel = tab.id === 'bills' ? 'Bills' : tab.label;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 py-2.5 sm:pb-3 sm:pt-0 px-0.5 sm:px-2 border-b-2 transition-all cursor-pointer select-none min-w-0 min-h-11 sm:min-h-0 ${
                isActive
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-extrabold focus:outline-hidden'
                  : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              <tab.icon className="w-4 h-4 shrink-0" />
              {/* Phone labels are plain case with normal letter-spacing at a
                  slightly smaller size -- uppercase + wide tracking made even
                  the shortest labels (e.g. "Transactions") wider than their
                  ~60px column and get ellipsised. Counts are dropped below
                  `sm` for the same reason (no room). */}
              <span className="text-[10.5px] sm:text-xs font-bold normal-case tracking-normal sm:uppercase sm:tracking-wider leading-tight truncate max-w-full">
                <span className="sm:hidden">{shortLabel}</span>
                <span className="hidden sm:inline">
                  {tab.label}
                  {tab.count !== undefined ? ` (${tab.count})` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Merchant-rule suggestions from a background Plaid sync -- an inline
          banner instead of a blocking window.confirm loop, which used to
          freeze the whole page (badly on the household's kiosk screen) until
          someone walked over and clicked through every prompt. */}
      {store.pendingRuleSuggestions.length > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-950/25 border border-indigo-200 dark:border-indigo-800/60 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h4 className="font-bold text-indigo-900 dark:text-indigo-300 text-xs uppercase tracking-wider">
              {store.pendingRuleSuggestions.length} suggested categorization{store.pendingRuleSuggestions.length === 1 ? '' : 's'}
            </h4>
            <button
              type="button"
              onClick={store.dismissAllRuleSuggestions}
              className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline uppercase cursor-pointer min-h-9 px-1"
            >
              Dismiss all
            </button>
          </div>
          <div className="space-y-2">
            {store.pendingRuleSuggestions.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between gap-3 flex-wrap bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900/50 rounded-xl px-3 py-2"
              >
                <p className="text-xs text-slate-700 dark:text-slate-300">
                  {s.ids.length} transaction{s.ids.length === 1 ? '' : 's'} from "{s.merchantName}" → <span className="font-bold">{s.suggestedCategory}</span>
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => store.applyRuleSuggestion(s.key)}
                    className="px-2.5 py-1 min-h-9 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10px] font-bold uppercase cursor-pointer transition-colors"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => store.dismissRuleSuggestion(s.key)}
                    className="px-2.5 py-1 min-h-9 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-[10px] font-bold uppercase cursor-pointer transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
