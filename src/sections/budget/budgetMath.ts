// Pure budget math shared between the client and server. No React imports --
// this module is also imported from server-side code (routes/budget.ts), and
// is expected to grow with more of the ledger's derived math in later phases.
//
// "What counts as a transfer" used to be decided three different ways in three
// different places (VisualCharts' category check, Budget.tsx's totalOutflow/
// totalInflow's category+description checks, and nothing at all for rows with
// a transferId), so a transfer could slip through one total but not another.
// This is the one definition everything else should call.
//
// Phase 2 (decomposition) moved the rest of Budget.tsx's derived math here too:
// scope/month filtering, the displayBudgets/totals/burn-rate calculations, the
// threshold-alert crossing logic, and the Plaid-refresh dedupe rule. None of it
// depends on "now" implicitly -- anything time-sensitive takes a `today: Date`
// (or an explicit month string) parameter instead of calling `new Date()`
// itself, so it can be tested without a clock.

import type { Transaction, Budget, DisplayBudget, BankConnection, Bill } from './types';

// A transfer between two of the household's own accounts is money moving
// sideways, not real income or spending -- it must never count toward either
// side of the household's totals. Matches on the category name alone (no
// Transaction needed), used both here and directly where only a category
// string is on hand (e.g. VisualCharts' budget-bar list, which has no
// per-transaction description to check).
export function isTransferCategory(category: string): boolean {
  return category.toLowerCase().includes('transfer');
}

// The union of every rule that has independently grown up around "is this a
// transfer": the category name, a handful of description substrings picked up
// from real statement text, and a transferId -- the reliable signal on rows
// created by Budget.tsx's own handleAddTransfer, which the older checks predate.
export function isTransfer(
  t: Pick<Transaction, 'category' | 'description'> & { transferId?: string }
): boolean {
  if (Boolean(t.transferId)) return true;
  if (isTransferCategory(t.category)) return true;
  const desc = t.description.toLowerCase();
  return (
    desc.includes('transfer between accounts') ||
    desc.includes('internal transfer') ||
    desc.includes('money transfer')
  );
}

// A transaction with no `scope` predates the personal/joint split and is
// treated as personal -- the same fallback used everywhere a transaction's
// scope is read.
export function txScope(t: Pick<Transaction, 'scope'>): 'personal' | 'joint' {
  return t.scope || 'personal';
}

export function inScope(t: Pick<Transaction, 'scope'>, scope: 'all' | 'personal' | 'joint'): boolean {
  return scope === 'all' || txScope(t) === scope;
}

// A budget with no `scope` predates the personal/joint split and is treated
// as joint -- matches the server's own fallback when writing one (see
// putScopedItemAs's `scope = item.scope || "joint"`), which is the opposite
// default from a transaction's (see txScope above) since every budget was
// implicitly shared before personal categories existed.
export function budgetScope(b: Pick<Budget, 'scope'>): 'personal' | 'joint' | 'all' {
  return b.scope || 'joint';
}

// Whether a budget row belongs in the view for the given scope tab. A row
// explicitly marked 'all' (spanning both) shows up under every tab, same as
// selecting the 'all' tab itself shows every row.
export function inBudgetScope(b: Pick<Budget, 'scope'>, scope: 'all' | 'personal' | 'joint'): boolean {
  const rowScope = budgetScope(b);
  return scope === 'all' || rowScope === 'all' || rowScope === scope;
}

// 'YYYY-MM' out of an ISO/localized 'YYYY-MM-DD' date string.
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function monthMatches(date: string, month: string | 'all'): boolean {
  return month === 'all' || monthOf(date) === month;
}

// All distinct months present in the data, most recent first -- feeds the
// month picker and the "default to the most recent month with data" logic.
export function listAvailableMonths(transactions: Transaction[]): string[] {
  const months = new Set(transactions.map((t) => monthOf(t.date)));
  return Array.from(months).sort((a, b) => (a < b ? 1 : -1));
}

export function filterByScope(transactions: Transaction[], scope: 'all' | 'personal' | 'joint'): Transaction[] {
  return transactions.filter((t) => inScope(t, scope));
}

export function filterByMonth(transactions: Transaction[], month: string | 'all'): Transaction[] {
  return transactions.filter((t) => monthMatches(t.date, month));
}

// Phase 5 (monthly budgets with rollover): whether a month's OVERSPEND also
// carries into the next month (a negative carry, i.e. next month's available
// amount shrinks), or whether overspending is simply forgiven and the carry
// floors at zero. True is the default and matches "rollover" as most budgeting
// apps define it -- flip this one constant to change the household-wide rule.
export const CARRY_OVERSPEND = true;

// This month's limit before rollover: an explicit one-off override for this
// exact month if one was set, otherwise the category's default `limit`.
export function limitFor(b: Pick<Budget, 'limit' | 'monthlyLimits'>, month: string): number {
  return b.monthlyLimits?.[month] ?? b.limit;
}

// How much a rollover category carries INTO `month` -- the running total of
// (limit - spent) for every month from `rolloverSince` up to (not including)
// `month`, each month's limit taken via limitFor so a mid-chain override
// changes the carry from that month on. Walked month-by-month (not
// recursively) so a multi-year chain can't blow the stack, and capped at 120
// iterations as a hard backstop against a corrupted/far-future rolloverSince
// turning this into a runaway loop.
//
// Zero when rollover is off, when rolloverSince is missing, or when `month`
// is at or before rolloverSince (the chain hasn't started yet). `spentByMonth`
// is injected rather than computed here so the caller can apply the same
// scope filtering it uses for the category's own `spent` -- see
// buildDisplayBudgets below, the only real caller.
export function carryInto(
  b: Pick<Budget, 'limit' | 'monthlyLimits' | 'rollover' | 'rolloverSince'>,
  month: string,
  spentByMonth: (month: string) => number
): number {
  if (!b.rollover || !b.rolloverSince) return 0;
  if (month <= b.rolloverSince) return 0;

  let carry = 0;
  let cursor = b.rolloverSince;
  let iterations = 0;
  while (cursor < month && iterations < 120) {
    const monthLimit = limitFor(b, cursor);
    const monthSpent = spentByMonth(cursor);
    const next = monthLimit + carry - monthSpent;
    carry = CARRY_OVERSPEND ? next : Math.max(0, next);
    cursor = stepMonth(cursor, 1);
    iterations++;
  }
  return carry;
}

// Dynamic budget spent amounts for the active scope + selected month. An
// income category's "spent" is really "received" (positive amounts); every
// other category sums its negative (spending) amounts as a positive total.
//
// Also filters which budget ROWS are included at all, via inBudgetScope --
// a personal category has no business showing up (or being counted toward
// Expected Income/Budgeted) while viewing the joint tab, and vice versa.
//
// Phase 5: when `month` is a real month (not 'all'), `limit` becomes the
// AVAILABLE amount for that month -- limitFor's result plus whatever rolled in
// from prior months (carryInto) -- so every existing consumer that reads
// `limit` picks up rollover automatically. Income categories never roll over.
// 'all' keeps the pre-Phase-5 behaviour exactly: `limit` is just the row's
// default `limit`, no monthlyLimits/rollover applied (there's no single month
// to resolve either against).
export function buildDisplayBudgets(
  budgets: Budget[],
  transactions: Transaction[],
  opts: { scope: 'all' | 'personal' | 'joint'; month: string | 'all'; incomeCategories: string[] }
): DisplayBudget[] {
  const { scope, month, incomeCategories } = opts;

  const spentFor = (category: string, isIncome: boolean, forMonth: string | 'all'): number => {
    if (isIncome) {
      return transactions
        .filter((t) => t.category === category && t.amount > 0 && inScope(t, scope) && monthMatches(t.date, forMonth))
        .reduce((sum, t) => sum + t.amount, 0);
    }
    return transactions
      .filter((t) => t.category === category && t.amount < 0 && inScope(t, scope) && monthMatches(t.date, forMonth))
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  };

  const rows: DisplayBudget[] = budgets.filter((b) => inBudgetScope(b, scope)).map((b) => {
    const isIncome = incomeCategories.includes(b.category);
    const spent = spentFor(b.category, isIncome, month);

    if (month === 'all') {
      return { ...b, spent, baseLimit: b.limit, carriedIn: 0 };
    }

    const baseLimit = limitFor(b, month);
    const carriedIn = isIncome ? 0 : carryInto(b, month, (m) => spentFor(b.category, false, m));
    return { ...b, spent, baseLimit, carriedIn, limit: baseLimit + carriedIn };
  });

  // Money spent in a category nobody budgeted for (a miscategorized charge, or
  // a brand-new category) used to vanish from every budget view, because rows
  // only existed for categories with a budget entry. Surface each as a $0-limit
  // row, flagged `unbudgeted`, so it counts as spent and can be given a limit.
  const shown = new Set(rows.map((r) => r.category));
  const unbudgeted = new Map<string, { spent: number; allPersonal: boolean }>();
  for (const t of transactions) {
    if (t.amount >= 0 || shown.has(t.category) || incomeCategories.includes(t.category)) continue;
    if (isTransferCategory(t.category) || isTransfer(t)) continue;
    if (!inScope(t, scope) || !monthMatches(t.date, month)) continue;
    const entry = unbudgeted.get(t.category) || { spent: 0, allPersonal: true };
    entry.spent += Math.abs(t.amount);
    entry.allPersonal = entry.allPersonal && txScope(t) === 'personal';
    unbudgeted.set(t.category, entry);
  }
  for (const [category, { spent, allPersonal }] of unbudgeted) {
    rows.push({
      category,
      limit: 0,
      spent,
      baseLimit: 0,
      carriedIn: 0,
      scope: allPersonal ? 'personal' : 'joint',
      unbudgeted: true,
    });
  }
  return rows;
}

// Applies one budget-amount edit to a row, pure and total. Used both for the
// store's live write and for the "Only for {Month}" toast action, which must
// reapply mode 'month' on top of the row exactly as it was BEFORE the
// original edit -- not on top of whatever the store holds by the time someone
// clicks the toast (see useBudgetStore's handleSetBudgetAmount, and the bug
// this fixed: editing $900 -> $950 "from now on" then choosing "Only for
// September" used to leave the standing default at $950 instead of putting it
// back to $900).
export function applyBudgetAmount(row: Budget, amount: number, mode: 'month' | 'default', month: string): Budget {
  if (mode === 'month') {
    return { ...row, monthlyLimits: { ...(row.monthlyLimits || {}), [month]: amount } };
  }
  // 'default': set the standing limit, and clear any override for `month`
  // and every LATER month -- otherwise "$X from now on" would silently keep
  // losing to an old override sitting on a future month. Earlier months'
  // overrides are history and are left alone.
  const keptOverrides = Object.fromEntries(Object.entries(row.monthlyLimits || {}).filter(([m]) => m < month));
  return {
    ...row,
    limit: amount,
    monthlyLimits: Object.keys(keptOverrides).length > 0 ? keptOverrides : undefined,
  };
}

// "Available Cash" only counts spendable checking money -- never a loan balance
// (that's debt, not cash) and never savings (real money, but set aside on
// purpose). Balances aren't month-scoped -- a live account balance is always "now".
export function spendableBalance(bankConnections: BankConnection[], scope: 'all' | 'personal' | 'joint'): number {
  return bankConnections
    .filter((b) => (scope === 'all' || (b.scope || 'personal') === scope) && b.accountType !== 'loan' && b.accountType !== 'savings')
    .reduce((sum, b) => sum + b.balance, 0);
}

export function totalOutflow(transactions: Transaction[], incomeCategories: string[]): number {
  return transactions
    .filter((t) => t.amount < 0 && !incomeCategories.includes(t.category) && !isTransfer(t))
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
}

export function totalInflow(transactions: Transaction[], incomeCategories: string[]): number {
  return transactions
    .filter((t) => (t.amount > 0 || incomeCategories.includes(t.category)) && !isTransfer(t))
    .reduce((sum, t) => sum + t.amount, 0);
}

export function countOverLimit(displayBudgets: DisplayBudget[]): number {
  return displayBudgets.filter((b) => b.spent > b.limit).length;
}

// Days to divide the outflow by for a daily burn rate. A finished month uses its
// full length; the month in progress uses only the days elapsed so far, since
// dividing a partial month's spending across all 31 days understates the real
// rate. `today` is injected rather than read from `new Date()` so this is
// testable without a clock.
export function burnDays(month: string, transactions: Transaction[], today: Date): number {
  if (month === 'all') {
    const dates = transactions.map((t) => t.date).sort();
    if (dates.length === 0) return 1;
    const spanMs = new Date(`${dates[dates.length - 1]}T00:00:00`).getTime() - new Date(`${dates[0]}T00:00:00`).getTime();
    return Math.max(1, Math.round(spanMs / 86400000) + 1);
  }
  const [year, monthNum] = month.split('-').map(Number);
  if (today.getFullYear() === year && today.getMonth() + 1 === monthNum) return Math.max(1, today.getDate());
  return new Date(year, monthNum, 0).getDate();
}

// Budgeted money that's allocated for this month but not yet spent. Used for
// "safe to spend" so it means "cash on hand that isn't already committed" --
// subtracting the month's outflow from the current balance instead would
// double-count spending the balance already reflects.
export function committedRemaining(displayBudgets: DisplayBudget[], incomeCategories: string[]): number {
  return displayBudgets
    .filter((b) => !incomeCategories.includes(b.category))
    .reduce((sum, b) => sum + Math.max(0, b.limit - b.spent), 0);
}

export function safeToSpend(balance: number, displayBudgets: DisplayBudget[], incomeCategories: string[]): number {
  return balance - committedRemaining(displayBudgets, incomeCategories);
}

export function savingsRatio(inflow: number, outflow: number): number {
  return inflow > 0 ? ((inflow - outflow) / inflow) * 100 : 0;
}

export interface ThresholdCrossing {
  category: string;
  level: 'critical' | 'warning';
  prevSpent: number;
  newSpent: number;
  limit: number;
  batchAmount: number;
}

// The pure core of the store's checkThresholdAlerts: which categories just
// crossed a spending threshold because of this batch of new transactions.
// Batched -- called once with every new row from one import/sync/manual-add,
// rather than once per transaction -- so a category fires at most one crossing
// per batch, and so "spending so far this month" is one consistent snapshot
// rather than a moving target that changes between rows in the same batch.
//
// Deliberately scoped to `currentMonth` AND to real spending (amount < 0,
// transfers excluded via isTransfer): comparing against the current month's
// spending but adding a new transaction dated in some OTHER month, or
// comparing against ALL-TIME spending, both produce false "EXCEEDED" crossings
// against categories that were never actually over budget this month -- e.g. a
// Plaid backfill of two years of history, or importing last March's statement.
export function thresholdCrossings(
  existing: Transaction[],
  batch: Transaction[],
  budgets: Budget[],
  currentMonth: string
): ThresholdCrossing[] {
  const relevant = batch.filter((t) => t.amount < 0 && !isTransfer(t) && t.date.slice(0, 7) === currentMonth);
  if (relevant.length === 0) return [];

  const batchIds = new Set(batch.map((t) => t.id));
  const batchSpentByCategory = new Map<string, number>();
  for (const t of relevant) {
    batchSpentByCategory.set(t.category, (batchSpentByCategory.get(t.category) || 0) + Math.abs(t.amount));
  }

  const crossings: ThresholdCrossing[] = [];
  for (const [category, batchAmount] of batchSpentByCategory) {
    const targetBudget = budgets.find((b) => b.category === category);
    if (!targetBudget || targetBudget.limit <= 0) continue;
    const limit = targetBudget.limit;

    // Existing current-month spending in this category, excluding any row
    // that's part of THIS batch -- those rows haven't landed in `transactions`
    // yet (this runs before the batch is added to state).
    const prevSpent = existing
      .filter((t) => t.category === category && t.amount < 0 && !isTransfer(t) && t.date.slice(0, 7) === currentMonth && !batchIds.has(t.id))
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const newSpent = prevSpent + batchAmount;
    const previousPercent = (prevSpent / limit) * 100;
    const currentPercent = (newSpent / limit) * 100;

    // Critical overspending crossing.
    if (currentPercent >= 100 && previousPercent < 100) {
      crossings.push({ category, level: 'critical', prevSpent, newSpent, limit, batchAmount });
    }
    // High warning crossing (85%) -- mutually exclusive with critical above,
    // since a category that just crossed 100% also crossed 85% in the same
    // batch and should only fire the one, more severe, alert.
    else if (currentPercent >= 85 && previousPercent < 85) {
      crossings.push({ category, level: 'warning', prevSpent, newSpent, limit, batchAmount });
    }
  }
  return crossings;
}

// ---------------------------------------------------------------------------
// Month navigation (Phase 3 header: the ‹ Month › stepper + "All time" select)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Local calendar month as 'YYYY-MM', built from the Date object's own
// year/month fields (never toISOString/UTC) -- a household west of UTC would
// otherwise see "today" roll to the next month several hours early.
export function currentMonthOf(today: Date): string {
  return `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
}

// Adds `delta` calendar months to 'YYYY-MM', rolling the year over in either
// direction. Done with plain integer arithmetic (total zero-indexed months
// since year 0) rather than the Date object, so there's no timezone or
// day-of-month clamping surprise (e.g. Date rolling Jan 31 + 1 month into
// March) to worry about -- a month string has no day component to begin with.
export function stepMonth(month: string, delta: number): string {
  const [year, monthNum] = month.split('-').map(Number);
  const zeroIndexed = monthNum - 1 + delta;
  const newYear = year + Math.floor(zeroIndexed / 12);
  const newMonthIndex = ((zeroIndexed % 12) + 12) % 12;
  return `${newYear}-${pad2(newMonthIndex + 1)}`;
}

// 'YYYY-MM' -> "September 2026". Built from the string's own numeric parts via
// the Date(year, monthIndex, day) constructor -- never by parsing a
// "YYYY-MM-01" string, whose interpretation as local-vs-UTC time can vary by
// JS engine/environment -- so the label is identical regardless of the
// machine's timezone.
export function formatMonthLabel(month: string): string {
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// The month picker's full option list, newest first: from the earliest month
// with any data through the LATER of (the latest month with data, one month
// ahead of the real current month) -- so a household whose data stops last
// spring still sees this month in the list to switch to, one mid-import of
// future-dated statement rows doesn't get cut off before its own newest data,
// and everyone can always plan next month's budget ahead of time without
// waiting for the calendar to actually turn over (a category's `limit` isn't
// month-scoped anyway -- see buildDisplayBudgets -- so there's real,
// actionable planning to do in a month that has no transactions yet).
export function monthRange(availableMonths: string[], today: Date): string[] {
  const current = currentMonthOf(today);
  const nextMonth = stepMonth(current, 1);
  if (availableMonths.length === 0) return [nextMonth, current];

  const sorted = [...availableMonths].sort();
  const earliest = sorted[0];
  const latestData = sorted[sorted.length - 1];
  const latest = latestData > nextMonth ? latestData : nextMonth;

  const months: string[] = [];
  let cursor = latest;
  while (cursor >= earliest) {
    months.push(cursor);
    cursor = stepMonth(cursor, -1);
  }
  return months;
}

// The header's default-month rule: prefer the real current month if the
// household actually has data there, otherwise fall back to the most recent
// month that has data (demo/imported data is often entirely in the past, so
// defaulting to "now" would frequently start on an empty view), otherwise the
// current month (a brand new household with no data at all yet).
export function defaultMonth(availableMonths: string[], today: Date): string {
  const current = currentMonthOf(today);
  if (availableMonths.includes(current)) return current;
  if (availableMonths.length > 0) {
    return [...availableMonths].sort().reverse()[0];
  }
  return current;
}

export interface MonthProgress {
  daysInMonth: number;
  daysElapsed: number;
  daysLeft: number;
  fraction: number;
  isCurrent: boolean;
  isPast: boolean;
  isFuture: boolean;
}

// How far a given month has progressed relative to `today`. A finished month
// reads as fully elapsed (fraction 1) and a not-yet-started month as not
// elapsed at all (fraction 0) -- only the current month actually depends on
// today's date. `daysLeft` counts today itself as a day still ahead of you
// (matching "N days left" copy read at any point during that day), so
// daysElapsed + daysLeft is daysInMonth + 1, not daysInMonth.
export function monthProgress(month: string, today: Date): MonthProgress {
  const [year, monthNum] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const current = currentMonthOf(today);
  const isCurrent = month === current;
  const isPast = month < current;
  const isFuture = month > current;

  if (isPast) {
    return { daysInMonth, daysElapsed: daysInMonth, daysLeft: 0, fraction: 1, isCurrent, isPast, isFuture };
  }
  if (isFuture) {
    return { daysInMonth, daysElapsed: 0, daysLeft: daysInMonth, fraction: 0, isCurrent, isPast, isFuture };
  }
  const daysElapsed = today.getDate();
  const daysLeft = daysInMonth - daysElapsed + 1;
  const fraction = daysElapsed / daysInMonth;
  return { daysInMonth, daysElapsed, daysLeft, fraction, isCurrent, isPast, isFuture };
}

export interface MonthSummary {
  budgeted: number;
  spent: number;
  left: number;
  expectedIncome: number;
  receivedIncome: number;
}

// Overview's hero numbers for one month. `spent` is the month's total outflow
// -- NOT the sum of each category's `spent` -- so spending in a category with
// no budget row (or $0 limit) still reduces `left`; only `budgeted` itself is
// scoped to categories that actually have a limit set.
export function monthSummary(
  displayBudgets: DisplayBudget[],
  monthTransactions: Transaction[],
  incomeCategories: string[]
): MonthSummary {
  const budgeted = displayBudgets
    .filter((b) => !incomeCategories.includes(b.category) && !isTransferCategory(b.category))
    .reduce((sum, b) => sum + b.limit, 0);
  const expectedIncome = displayBudgets
    .filter((b) => incomeCategories.includes(b.category))
    .reduce((sum, b) => sum + b.limit, 0);
  const spent = totalOutflow(monthTransactions, incomeCategories);
  const receivedIncome = totalInflow(monthTransactions, incomeCategories);
  return { budgeted, spent, left: budgeted - spent, expectedIncome, receivedIncome };
}

// A hair's width of floating-point slop for comparing spent to limit (repeated
// cents-level arithmetic can leave e.g. 1200.0000000000002 instead of 1200).
const BUDGET_FLOAT_TOLERANCE = 0.005;

export type BudgetLevel = 'over' | 'at' | 'warning' | 'safe';

// Where a category's spending sits against its limit -- the single place this
// is decided, so Needs Attention, the Budget-vs-spent bar colors, and
// BudgetSettings' badges never disagree about the same row. "At budget" (spent
// equals limit, within BUDGET_FLOAT_TOLERANCE) is deliberately its own
// neutral level, distinct from "over" (spent > limit, strictly) -- a bill paid
// exactly to its $1,200 limit is on plan, not a problem.
export function budgetLevel(spent: number, limit: number): BudgetLevel {
  if (limit <= 0) return 'safe';
  if (spent > limit + BUDGET_FLOAT_TOLERANCE) return 'over';
  if (Math.abs(spent - limit) <= BUDGET_FLOAT_TOLERANCE) return 'at';
  const percent = (spent / limit) * 100;
  if (percent >= 85) return 'warning';
  return 'safe';
}

// Phase 6 adds a `bill` kind (an overdue or soon-due bill) alongside these
// two, placed ABOVE categories in needsAttention's returned order (see below).
export type NeedsAttentionItem =
  | { kind: 'category'; category: string; level: 'warning' | 'over'; percent: number; spent: number; limit: number }
  | { kind: 'uncategorized'; count: number }
  | { kind: 'bill'; category: string; name: string; level: 'warning' | 'over'; dueInDays: number; amount: number };

// Categories running hot (over, or >=85% and not yet at/over) worst first,
// plus a nudge to categorize anything still sitting in "Uncategorized" this
// month. Zero/negative-limit rows are excluded -- an unset budget isn't "at
// risk", it's just not tracked yet (see Overview's "Budget vs spent" list
// instead). A category spent exactly to its limit ("at budget") is
// deliberately NOT flagged here -- see budgetLevel's comment.
//
// `bills`, when passed, folds in overdue/due-soon bills (Phase 6) ABOVE the
// category items, worst (most overdue) first -- a bill due date is a harder
// deadline than a category running warm, so it leads. `allTransactions`
// should be scope-filtered but NOT month-filtered: a bill's auto-match window
// (billStatus) can reach a few days into the neighboring month.
export function needsAttention(
  displayBudgets: DisplayBudget[],
  monthTransactions: Transaction[],
  incomeCategories: string[],
  bills?: { items: Bill[]; month: string; allTransactions: Transaction[]; today: Date }
): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = displayBudgets
    .filter((b) => !incomeCategories.includes(b.category) && !isTransferCategory(b.category) && b.limit > 0)
    .map((b) => ({ category: b.category, percent: (b.spent / b.limit) * 100, spent: b.spent, limit: b.limit, level: budgetLevel(b.spent, b.limit) }))
    .filter((b) => b.level === 'over' || b.level === 'warning')
    .sort((a, b) => b.percent - a.percent)
    .map((b): NeedsAttentionItem => ({
      kind: 'category',
      category: b.category,
      level: b.level as 'over' | 'warning',
      percent: b.percent,
      spent: b.spent,
      limit: b.limit,
    }));

  const uncategorizedCount = monthTransactions.filter((t) => t.category === 'Uncategorized').length;
  if (uncategorizedCount > 0) {
    items.push({ kind: 'uncategorized', count: uncategorizedCount });
  }

  if (!bills) return items;

  const billItems: NeedsAttentionItem[] = billStatuses(bills.items, bills.month, bills.allTransactions, bills.today)
    .filter((s) => s.state === 'overdue' || s.state === 'due_today' || s.state === 'due_soon')
    .sort((a, b) => (a.daysUntil ?? 0) - (b.daysUntil ?? 0))
    .map((s) => ({
      kind: 'bill',
      category: s.bill.category,
      name: s.bill.name,
      level: s.state === 'overdue' ? 'over' : 'warning',
      dueInDays: s.daysUntil ?? 0,
      amount: s.bill.amount,
    }));

  return [...billItems, ...items];
}

// ---------------------------------------------------------------------------
// Phase 6: recurring bills -- due dates, payment status, and detecting
// recurring charges from transaction history.
// ---------------------------------------------------------------------------

function daysInMonth(year: number, monthNum: number): number {
  return new Date(year, monthNum, 0).getDate();
}

// Whole calendar months from `a` to `b` (both 'YYYY-MM'), signed -- negative
// when `b` is before `a`.
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// Whole days from ISO date `a` to ISO date `b`, built from each string's own
// year/month/day via the local Date constructor (never a raw ms subtraction
// on parsed strings) so a DST transition between the two dates can't shift
// the count by an hour and round to the wrong day.
function daysBetweenISO(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const fromMs = new Date(ay, am - 1, ad).getTime();
  const toMs = new Date(by, bm - 1, bd).getTime();
  return Math.round((toMs - fromMs) / 86400000);
}

// This bill's due date for `month` ('YYYY-MM'), or null when it isn't due
// that month at all -- before `startMonth`, or a month that doesn't line up
// with a quarterly/yearly cadence. `dueDay` is clamped to the month's real
// length (a bill due the 31st is due the 28th/29th in February).
export function billDueDate(bill: Pick<Bill, 'dueDay' | 'frequency' | 'startMonth'>, month: string): string | null {
  const diff = monthsBetween(bill.startMonth, month);
  if (diff < 0) return null;
  if (bill.frequency === 'quarterly' && diff % 3 !== 0) return null;
  if (bill.frequency === 'yearly' && diff % 12 !== 0) return null;

  const [year, monthNum] = month.split('-').map(Number);
  const day = Math.min(bill.dueDay, daysInMonth(year, monthNum));
  return `${year}-${pad2(monthNum)}-${pad2(day)}`;
}

export interface BillStatus {
  state: 'paid' | 'due_soon' | 'due_today' | 'overdue' | 'upcoming' | 'not_due';
  dueDate: string | null;
  daysUntil: number | null;
  matchedTransactionId?: string;
  paidAmount?: number;
}

function unpaidBillStatus(dueDate: string, daysUntil: number): BillStatus {
  const state: BillStatus['state'] =
    daysUntil < 0 ? 'overdue' : daysUntil === 0 ? 'due_today' : daysUntil <= 7 ? 'due_soon' : 'upcoming';
  return { state, dueDate, daysUntil };
}

// One bill's status for one month: not due, paid (manually marked/linked, or
// auto-matched against a transaction), or unpaid (overdue/due today/due soon/
// upcoming, by whole local days from `today`).
//
// Auto-matching looks for the FIRST transaction (in the order given) that is
// real spending (amount < 0) in the bill's category, contains `matchText`
// (case-insensitive, in either the merchant name or description) when set,
// and falls within +/-7 days of the due date -- and hasn't already been
// claimed by an earlier bill this same call (see `claimedIds`, and
// billStatuses below, which walks bills in due-date order so two bills
// sharing a category can't both claim one charge). A matched transaction's id
// is added to `claimedIds` as a side effect.
export function billStatus(
  bill: Bill,
  month: string,
  transactions: Transaction[],
  today: Date,
  claimedIds: Set<string> = new Set()
): BillStatus {
  const dueDate = billDueDate(bill, month);
  if (!dueDate) return { state: 'not_due', dueDate: null, daysUntil: null };

  const todayISO = today.toLocaleDateString('en-CA');
  const daysUntil = daysBetweenISO(todayISO, dueDate);

  const manual = bill.payments?.[month];
  // Explicit "not paid" for this month -- never auto-match, even if a
  // matching transaction exists (e.g. the household paid a friend back the
  // same amount, in the same category, right around the due date).
  if (manual === null) return unpaidBillStatus(dueDate, daysUntil);

  if (manual) {
    const linked = manual.transactionId ? transactions.find((t) => t.id === manual.transactionId) : undefined;
    // A manually linked charge is spoken for -- don't let a later bill in the
    // same category auto-match it too.
    if (manual.transactionId) claimedIds.add(manual.transactionId);
    return {
      state: 'paid',
      dueDate,
      daysUntil,
      matchedTransactionId: manual.transactionId,
      paidAmount: linked ? Math.abs(linked.amount) : undefined,
    };
  }

  const matchText = bill.matchText?.trim().toLowerCase();
  const match = transactions.find((t) => {
    if (claimedIds.has(t.id)) return false;
    if (t.amount >= 0) return false;
    if (t.category !== bill.category) return false;
    if (matchText) {
      const haystack = `${t.merchantName} ${t.description}`.toLowerCase();
      if (!haystack.includes(matchText)) return false;
    }
    return Math.abs(daysBetweenISO(dueDate, t.date)) <= 7;
  });

  if (match) {
    claimedIds.add(match.id);
    return { state: 'paid', dueDate, daysUntil, matchedTransactionId: match.id, paidAmount: Math.abs(match.amount) };
  }

  return unpaidBillStatus(dueDate, daysUntil);
}

// Every bill's status for one month, walked in due-date order so a shared
// claimedIds set stops two bills in the same category (two subscriptions,
// say) from both auto-matching the same charge. Bills not due this month
// sort last (order among them doesn't matter -- 'not_due' never claims
// anything). Inactive bills are left out entirely.
export function billStatuses(
  bills: Bill[],
  month: string,
  transactions: Transaction[],
  today: Date
): (BillStatus & { bill: Bill })[] {
  const withDueDates = bills
    .filter((b) => b.active)
    .map((bill) => ({ bill, dueDate: billDueDate(bill, month) }))
    .sort((a, b) => {
      if (a.dueDate === b.dueDate) return 0;
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    });

  const claimed = new Set<string>();
  return withDueDates.map(({ bill }) => ({ bill, ...billStatus(bill, month, transactions, today, claimed) }));
}

export interface RecurringBillSuggestion {
  name: string;
  matchText: string;
  category: string;
  amount: number;
  dueDay: number;
  frequency: 'monthly';
  months: string[];
}

// Trims, lowercases, and strips a trailing store number ("KROGER #422" /
// "STARBUCKS STORE 1123" / "STORE 45") so the same physical merchant's
// slightly different location suffixes group together instead of each
// reading as a one-off charge.
function normalizeMerchantKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s*#?\d{2,}\s*$/, '').trim();
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Finds merchants that look like recurring bills: real spending (never a
// transfer or a positive/income row) showing up in at least 3 of the last 4
// full calendar months before `today` (the current, still-in-progress month
// doesn't count as "full"), with every one of those charges within 15% of
// their median amount -- a merchant whose amount swings more than that isn't
// a fixed bill, it's just a place the household happens to shop often.
// `opts.categories`, when given, limits detection to those categories (used
// by the one-time migration banner, which only wants suggestions for the
// household's already-tracked bill categories).
export function detectRecurring(
  transactions: Transaction[],
  today: Date,
  opts: { categories?: string[] } = {}
): RecurringBillSuggestion[] {
  const currentMonth = currentMonthOf(today);
  const lastFourMonths = [4, 3, 2, 1].map((n) => stepMonth(currentMonth, -n));
  const monthSet = new Set(lastFourMonths);

  const candidates = transactions.filter((t) => {
    if (t.amount >= 0) return false;
    if (isTransfer(t)) return false;
    if (!monthSet.has(monthOf(t.date))) return false;
    if (opts.categories && !opts.categories.includes(t.category)) return false;
    return true;
  });

  const groups = new Map<string, Transaction[]>();
  for (const t of candidates) {
    const key = normalizeMerchantKey(t.merchantName || t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const suggestions: RecurringBillSuggestion[] = [];
  for (const txs of groups.values()) {
    const monthsPresent = Array.from(new Set(txs.map((t) => monthOf(t.date))));
    if (monthsPresent.length < 3) continue;

    const amounts = txs.map((t) => Math.abs(t.amount));
    const med = median(amounts);
    if (med <= 0) continue;
    if (!amounts.every((a) => Math.abs(a - med) <= med * 0.15)) continue;

    const days = txs.map((t) => Number(t.date.slice(8, 10)));
    const dueDay = Math.round(median(days));

    const latest = [...txs].sort((a, b) => (a.date < b.date ? 1 : -1))[0];

    const categoryCounts = new Map<string, number>();
    for (const t of txs) categoryCounts.set(t.category, (categoryCounts.get(t.category) || 0) + 1);
    const category = Array.from(categoryCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];

    const displayName = (latest.merchantName || latest.description).trim();
    suggestions.push({
      name: displayName,
      matchText: displayName,
      category,
      amount: Math.round(med * 100) / 100,
      dueDay,
      frequency: 'monthly',
      months: monthsPresent.sort(),
    });
  }

  return suggestions.sort((a, b) => a.name.localeCompare(b.name));
}

// The pure core of handlePlaidRefresh's dedupe logic. A first-time backfill
// replays history Plaid has always had, including months already seeded from a
// PDF statement import -- same real-world events, different ids, so an
// id-only check would double-enter them all. Keyed on accountId too, since two
// DIFFERENT real transactions can share a date/amount/merchant, but not
// usually the same account as well. Counted rather than set-based so a genuine
// repeat (two $9.99 DoorDash orders on one day, same account) still comes
// through once the first is matched off.
// ---------------------------------------------------------------------------
// Transactions tab (Phase 4): filtering, summary, and import-preview dedupe.
// ---------------------------------------------------------------------------

export const NEEDS_REVIEW_CATEGORY = 'Uncategorized';

export interface TransactionFilters {
  search: string;
  // 'All', a real category name, or NEEDS_REVIEW_CATEGORY ('__needs_review' is
  // also accepted as an alias -- see the sentinel comment below -- so callers
  // that already have that string on hand (Overview's link) don't need to
  // know the real category name is "Uncategorized").
  category: string;
  type: 'all' | 'expenses' | 'income' | 'transfers';
  // 'All' or a bankName. Omitted/'All' shows every account.
  account: string;
}

// Overview's "N uncategorized transactions -> Review" link needs a filter
// value that means "needs review" without hard-coding the literal category
// name "Uncategorized" at every call site -- this is that sentinel.
export const NEEDS_REVIEW_FILTER = '__needs_review';

// The Transactions tab's one filtering pass: search (merchant or description,
// case-insensitive), category (a real category, 'All', or the needs-review
// sentinel), type (expense/income/transfer via the shared isTransfer/amount-sign
// rule so this never disagrees with the rest of the app about what a transfer
// is), and account (by bankName, 'All' shows every account).
export function filterTransactions(transactions: Transaction[], filters: TransactionFilters): Transaction[] {
  const search = filters.search.trim().toLowerCase();
  const wantsNeedsReview = filters.category === NEEDS_REVIEW_FILTER || filters.category === NEEDS_REVIEW_CATEGORY;

  return transactions.filter((t) => {
    if (search) {
      const haystack = `${t.merchantName} ${t.description}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    if (wantsNeedsReview) {
      if (t.category !== NEEDS_REVIEW_CATEGORY) return false;
    } else if (filters.category !== 'All' && t.category !== filters.category) {
      return false;
    }

    if (filters.type !== 'all') {
      const transfer = isTransfer(t);
      if (filters.type === 'transfers' && !transfer) return false;
      if (filters.type === 'expenses' && (transfer || t.amount >= 0)) return false;
      if (filters.type === 'income' && (transfer || t.amount <= 0)) return false;
    }

    if (filters.account !== 'All' && t.bankName !== filters.account) return false;

    return true;
  });
}

export interface TransactionsSummary {
  count: number;
  spent: number;
  received: number;
  net: number;
}

// The filtered list's summary line -- transfers are excluded from both spent
// and received, same reasoning as totalOutflow/totalInflow: a move between the
// household's own accounts is neither real spending nor real income.
export function summarizeTransactions(transactions: Transaction[]): TransactionsSummary {
  let spent = 0;
  let received = 0;
  for (const t of transactions) {
    if (isTransfer(t)) continue;
    if (t.amount < 0) spent += Math.abs(t.amount);
    else if (t.amount > 0) received += t.amount;
  }
  return { count: transactions.length, spent, received, net: received - spent };
}

// Statement-import preview: flags incoming rows that look like duplicates of
// transactions already on the ledger, so they land unchecked by default
// instead of quietly doubling up a household's spending. Matched on date +
// amount + normalized (trimmed, case-insensitive) merchant name -- NOT
// account, since a pasted statement line has no accountId to compare (unlike
// dedupeIncoming's Plaid-sync dedupe, which does). Counted like dedupeIncoming
// rather than set-based, so two genuinely separate same-day/same-amount/
// same-merchant charges (two identical coffee runs) still let the second
// incoming row through once the first is matched off against an existing row.
export function markLikelyDuplicates(existing: Transaction[], incoming: Transaction[]): boolean[] {
  const contentKey = (t: { date: string; amount: number; merchantName: string }) =>
    `${t.date}|${t.amount}|${(t.merchantName || '').trim().toLowerCase()}`;

  const available = new Map<string, number>();
  for (const t of existing) {
    const k = contentKey(t);
    available.set(k, (available.get(k) || 0) + 1);
  }

  return incoming.map((t) => {
    const k = contentKey(t);
    const remaining = available.get(k) || 0;
    if (remaining > 0) {
      available.set(k, remaining - 1);
      return true;
    }
    return false;
  });
}

// Adds two money amounts and rounds to the nearest cent. Plain floating-point
// addition on dollars-and-cents values drifts (0.1 + 0.2 !== 0.3), and a chain
// of adds/subtracts against a stored balance -- one edit, one undo, one
// transfer -- compounds that into visible dust like 3164.3599999999997. Every
// site in useBudgetStore.ts that adds or subtracts money into a stored
// balance goes through this; transaction amounts themselves are stored as
// given, not rounded here.
export function addMoney(a: number, b: number): number {
  return Math.round((a + b) * 100) / 100;
}

export type TransactionSortBy = 'date' | 'amount';
export type SortOrder = 'asc' | 'desc';

// The Transactions tab's row order: applied after filtering, before
// pagination. Defaults to date descending (newest first). Ties break on `id`
// (ascending, regardless of overall sort order) purely so the order is stable
// across re-renders -- two transactions dated/amounted identically shouldn't
// visually swap places on every re-sort.
export function sortTransactions(transactions: Transaction[], by: TransactionSortBy, order: SortOrder): Transaction[] {
  const dir = order === 'desc' ? -1 : 1;
  return [...transactions].sort((a, b) => {
    let diff: number;
    if (by === 'date') {
      diff = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    } else {
      diff = a.amount - b.amount;
    }
    if (diff !== 0) return diff * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function dedupeIncoming(base: Transaction[], incoming: Transaction[]): Transaction[] {
  const contentKey = (t: { accountId?: string; date: string; amount: number; merchantName: string }) =>
    `${t.accountId || ''}|${t.date}|${t.amount}|${(t.merchantName || '').trim().toLowerCase()}`;

  const baseIds = new Set(base.map((t) => t.id));
  const unmatched = new Map<string, number>();
  for (const t of base) {
    const k = contentKey(t);
    unmatched.set(k, (unmatched.get(k) || 0) + 1);
  }
  return incoming.filter((t) => {
    if (baseIds.has(t.id)) return false;
    const k = contentKey(t);
    const remaining = unmatched.get(k) || 0;
    if (remaining > 0) {
      unmatched.set(k, remaining - 1);
      return false;
    }
    return true;
  });
}
