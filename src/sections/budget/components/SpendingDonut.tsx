// src/sections/budget/components/SpendingDonut.tsx -- the donut chart + legend
// half of the old VisualCharts.tsx (the bar-chart half is superseded by
// Overview's own "Budget vs spent" list, which needed real rows -- name,
// $spent of $limit, a clickable bar -- that a legend can't provide). Split out
// so Overview can place it next to that list instead of pulling in the whole
// old two-chart component.
//
// Two visual fixes from the old chart: `strokeLinecap="round"` made adjacent
// slices visually overlap and overstate their share at the seam (rounded caps
// extend past the slice's actual arc on both ends) -- "butt" caps stop exactly
// at the data. And the legend's per-row pulsing dot was decorative only (nothing
// about a category total is "live"), so it's gone along with the other
// decorative animate-pulse/animate-bounce touches from this phase.

import { useMemo } from 'react';
import { Transaction, TransactionCategory } from '../types';
import { isTransfer } from '../budgetMath';
import { formatMoney } from '../format';

interface SpendingDonutProps {
  transactions: Transaction[];
  onCategoryClick?: (category: TransactionCategory) => void;
  incomeCategories?: string[];
  currency?: string;
}

// Same category color table VisualCharts used, kept identical so a category's
// color doesn't change meaning just because the chart moved files.
const CATEGORY_COLORS: Record<string, string> = {
  'Groceries': '#F59E0B',
  'Eating Out': '#F97316',
  'Utilities & Bills': '#10B981',
  'Shopping': '#3B82F6',
  'Gas & Transport': '#8B5CF6',
  'Family Activities': '#EC4899',
  'Medical & Health': '#EF4444',
  'Mortgage/Rent': '#6366F1',
  'Car Payment': '#7C3AED',
  'Car Insurance': '#64748B',
  'Subscriptions': '#D946EF',
  'Credit Cards & Debt': '#F43F5E',
  'Savings': '#06B6D4',
  'Clothing': '#0EA5E9',
  'Child Support': '#84CC16',
  'Uncategorized': '#94A3B8',
};

function getCategoryColor(category: string): string {
  if (CATEGORY_COLORS[category]) return CATEGORY_COLORS[category];
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = category.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = ['#EC4899', '#14B8A6', '#F43F5E', '#06B6D4', '#F59E0B', '#10B981', '#6366F1', '#F97316', '#A855F7', '#3B82F6'];
  return colors[Math.abs(hash) % colors.length];
}

export default function SpendingDonut({ transactions, onCategoryClick, incomeCategories = ['Income'], currency = '$' }: SpendingDonutProps) {
  const categoryTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    transactions
      .filter((t) => t.amount < 0 && !incomeCategories.includes(t.category) && !isTransfer(t))
      .forEach((t) => {
        const amt = Math.abs(t.amount);
        totals[t.category] = (totals[t.category] || 0) + amt;
      });
    return totals;
  }, [transactions, incomeCategories]);

  const totalExpenses = useMemo(
    () => Object.values(categoryTotals).reduce((sum, v) => sum + v, 0),
    [categoryTotals]
  );

  const sortedExpenseData = useMemo(() => {
    return Object.entries(categoryTotals)
      .map(([category, amount]) => ({
        category,
        amount,
        percent: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0,
        color: getCategoryColor(category),
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [categoryTotals, totalExpenses]);

  const donutSegments = useMemo(() => {
    let currentAngle = 0;
    const radius = 60;
    const strokeWidth = 16;
    const circumference = 2 * Math.PI * radius;

    return sortedExpenseData.map((d) => {
      const angle = (d.percent / 100) * 360;
      const strokeDashoffset = circumference - (d.percent / 100) * circumference;
      const rotation = currentAngle - 90;
      currentAngle += angle;
      return { ...d, strokeDasharray: `${circumference} ${circumference}`, strokeDashoffset, rotation, radius, strokeWidth };
    });
  }, [sortedExpenseData]);

  return (
    <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs flex flex-col justify-between" id="spending-donut">
      <div className="mb-4">
        <h3 className="font-bold text-gray-900 dark:text-slate-100 text-base">Where it went</h3>
        <p className="text-xs text-gray-500 dark:text-slate-400">Spending by category this month.</p>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-around gap-6 py-2">
        <div className="relative w-40 h-40 shrink-0">
          {totalExpenses === 0 ? (
            <div className="w-full h-full rounded-full border-12 border-gray-100 dark:border-slate-800 flex items-center justify-center text-center p-3 text-gray-400 dark:text-slate-500 text-xs font-medium">
              No spending yet
            </div>
          ) : (
            <>
              <svg className="w-full h-full transform" viewBox="0 0 160 160">
                {donutSegments.map((seg, idx) => (
                  <circle
                    key={idx}
                    cx="80"
                    cy="80"
                    r={seg.radius}
                    fill="transparent"
                    stroke={seg.color}
                    strokeWidth={seg.strokeWidth}
                    strokeDasharray={seg.strokeDasharray}
                    strokeDashoffset={seg.strokeDashoffset}
                    transform={`rotate(${seg.rotation} 80 80)`}
                    strokeLinecap="butt"
                    className="transition-all duration-500 hover:opacity-95"
                  />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] uppercase font-semibold tracking-wider text-gray-400 dark:text-slate-500">Total Spent</span>
                <span className="text-sm font-bold text-gray-900 dark:text-slate-100 font-mono">
                  {formatMoney(totalExpenses, currency)}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="space-y-1 shrink-0 max-h-48 overflow-y-auto pr-1 flex-1 w-full">
          {sortedExpenseData.map((d) => (
            <button
              key={d.category}
              type="button"
              onClick={() => onCategoryClick?.(d.category as TransactionCategory)}
              className="w-full flex items-center justify-between gap-3 text-xs cursor-pointer hover:bg-slate-50/80 dark:hover:bg-slate-800/60 p-1.5 min-h-9 rounded-lg transition-colors group text-left"
              title="Click to view transactions in this category"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                <span className="text-gray-600 dark:text-slate-300 font-medium truncate max-w-[110px] group-hover:text-indigo-600 dark:group-hover:text-indigo-400 group-hover:underline">{d.category}</span>
              </div>
              <div className="text-right font-mono text-gray-500 dark:text-slate-400 shrink-0">
                <span className="font-bold text-slate-800 dark:text-slate-200">{formatMoney(d.amount, currency, { decimals: 0 })}</span>
                <span className="text-[10px] text-gray-400 dark:text-slate-500 ml-1">({d.percent.toFixed(0)}%)</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
