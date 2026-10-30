// Budget tools. See ./README.md for the contract every domain module follows.
//
// This is the only module with sensitivity "financial" -- Stage 2 provider routing reads
// that field and nothing else. (Stage 6 money_only confirmation and Stage 6.5 child-account
// gating are planned to key off it too, but neither is built yet; the only confirmation that
// exists is for bulk deletes, in ../confirmations.ts, and no budget tool uses it.)

import type { DomainTool, ToolModule } from "../registry.ts";
import { getScopedItems, putScopedItemAs, newId, getConfig } from "../../db.ts";
import { ensureCategoryExists, type Transaction, type Budget } from "../../routes/budget.ts";
import { inMonth, round2 } from "./shared.ts";
import { serverToday, serverMonth } from "../../nutrition/dates.ts";
import { limitFor, carryInto, billStatuses, currentMonthOf, isTransferCategory } from "../../src/sections/budget/budgetMath.ts";
import type { Bill } from "../../src/sections/budget/types.ts";

// 'YYYY-MM', and only that -- rejects "2026-8", "2026/08", a full date, or
// free text, so a malformed month from the model surfaces as a clear error
// instead of silently matching nothing (inMonth's plain startsWith check would
// never match a wrongly-shaped month, and get_budget_summary would just look
// like every category has zero activity that month).
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function isValidMonth(month: unknown): month is string {
  return typeof month === "string" && MONTH_RE.test(month);
}

// A required numeric field must actually be missing to be rejected -- but a bare
// Number(x) coerces null, "" and [] all to 0, which is finite, so an omitted or
// blank value would silently pass as a valid zero instead of surfacing an error
// the model can recover from. Coerce only from a real number or a non-blank
// string, and yield NaN for everything else so the caller's Number.isFinite
// check catches it.
function toRequiredNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

// Budget's tables are local now (folded in from the standalone Budget Sync app),
// so these read straight from the scoped store like every other section's tools.
// The three read tool contracts (name/description/params) are kept identical to
// what they were when this went over HTTP to the standalone app.
function budgetTools(userId: string): DomainTool[] {
  const incomeCategories = (): string[] => getConfig("budget.incomeCategories", ["Income"]) || ["Income"];

  return [
    {
      name: "get_budget_summary",
      description:
        "Budget categories with their spending limit and how much has been spent. " +
        "Pass month to restrict to one calendar month -- this also folds in any monthly " +
        "override and rollover carry for that month, so `limit` is what's actually " +
        "available, not just the category's default. Omit month for the current month.",
      parameters: {
        type: "object",
        properties: { month: { type: "string", description: 'Calendar month as "YYYY-MM", e.g. "2026-08".' } },
      },
      run: async ({ month: requestedMonth }) => {
        // No month used to compare each MONTHLY limit with ALL-TIME spending, so "remaining" was meaningless (the eval's
        // Groceries came out 202.50 instead of this month's 272.50). A budget question without a month is about this
        // month, so default to it and run the very same path as an explicit month (overrides and rollover applied).
        const month: string = requestedMonth || serverMonth();
        const budgets = getScopedItems("budgets", userId) as Budget[];
        const transactions = getScopedItems("transactions", userId) as Transaction[];
        const income = incomeCategories();

        // Spending in a category with no budget entry (a miscategorized charge, or
        // a new category) would otherwise be missing from every row below -- the
        // same blind spot buildDisplayBudgets fixes for the Budget page.
        const unbudgetedRows = (m: string) => {
          const totals = new Map<string, number>();
          const budgeted = new Set(budgets.map((b) => b.category));
          for (const t of transactions) {
            if (t.amount >= 0 || !t.category || budgeted.has(t.category) || income.includes(t.category)) continue;
            if (isTransferCategory(t.category) || !inMonth(t, m)) continue;
            totals.set(t.category, (totals.get(t.category) || 0) + Math.abs(t.amount));
          }
          return [...totals].map(([category, spent]) => ({
            category,
            type: "expense",
            limit: 0,
            baseLimit: 0,
            carriedIn: 0,
            spent: round2(spent),
            remaining: round2(-spent),
            unbudgeted: true,
          }));
        };

        // No categories set up yet. A bare [] reads to a small local model as
        // "the lookup failed" (it answered "I'm unable to retrieve the budget
        // summary"), so say what the empty result means and hand over the
        // month's actual spending per category -- what building a budget
        // starts from, and a sum the model shouldn't have to do itself.
        if (budgets.length === 0) {
          const m = isValidMonth(month) ? month : serverMonth();
          const totals = new Map<string, number>();
          for (const t of transactions) {
            if (t.amount >= 0 || !t.category || income.includes(t.category) || !inMonth(t, m)) continue;
            totals.set(t.category, (totals.get(t.category) || 0) + Math.abs(t.amount));
          }
          return {
            categories: [],
            note:
              "No budget categories have been set up yet -- this is not an error. Offer to build a " +
              "budget: suggest a monthly limit per category from spendingByCategory, and only call " +
              "set_budget_limit for the ones the user agrees to.",
            month: m,
            spendingByCategory: [...totals]
              .map(([category, spent]) => ({ category, spent: round2(spent) }))
              .sort((a, b) => b.spent - a.spent),
          };
        }

        const spentInMonth = (category: string, isIncome: boolean, m: string): number =>
          transactions
            .filter((t) => t.category === category && (isIncome ? t.amount > 0 : t.amount < 0) && inMonth(t, m))
            .reduce((sum, t) => sum + Math.abs(t.amount), 0);

        return [...budgets.map((b) => {
          const isIncome = income.includes(b.category);
          const baseLimit = limitFor(b, month);
          const spent = spentInMonth(b.category, isIncome, month);
          // Income never rolls over -- see budgetMath's buildDisplayBudgets,
          // which this mirrors.
          const carriedIn = isIncome ? 0 : carryInto(b, month, (m) => spentInMonth(b.category, false, m));
          const availableLimit = baseLimit + carriedIn;
          return {
            category: b.category,
            type: isIncome ? "income" : "expense",
            limit: round2(availableLimit),
            baseLimit: round2(baseLimit),
            carriedIn: round2(carriedIn),
            spent: round2(spent),
            remaining: round2(availableLimit - spent),
          };
        }), ...unbudgetedRows(month)];
      },
    },

    {
      name: "get_recent_transactions",
      description:
        "Individual transactions, newest first. Filter by category and/or month, or by an exact " +
        "from/to date range (e.g. \"between the 1st and the 15th\") when month is too coarse.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: 'Exact budget category, e.g. "Groceries".' },
          month: { type: "string", description: 'Calendar month as "YYYY-MM". Ignored if from/to are given.' },
          from: { type: "string", description: "Earliest date to include, YYYY-MM-DD. Optional." },
          to: { type: "string", description: "Latest date to include, YYYY-MM-DD. Optional." },
          limit: { type: "number", description: "How many to return. Defaults to 20." },
        },
      },
      run: async ({ category, month, from, to, limit }) => {
        const transactions = getScopedItems("transactions", userId) as Transaction[];
        const max = Math.min(Number(limit) || 20, 100);
        const hasRange = typeof from === "string" || typeof to === "string";
        return transactions
          .filter(
            (t) =>
              (!category || t.category === category) &&
              (hasRange
                ? (!from || t.date >= from) && (!to || t.date <= to)
                : inMonth(t, month))
          )
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .slice(0, max)
          .map((t) => ({
            date: t.date,
            merchant: t.merchantName,
            category: t.category,
            amount: round2(t.amount),
          }));
      },
    },

    {
      name: "get_accounts",
      description:
        "Available cash across bank accounts, plus credit card balances. " +
        "Use for questions about whether the household can afford something.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const bankConnections = getScopedItems("bank_connections", userId) as any[];
        const creditCards = getScopedItems("credit_cards", userId) as any[];
        // Loans and savings are excluded from spendable cash, matching the ledger.
        const spendableAccounts = bankConnections.filter((b) => b.accountType !== "loan" && b.accountType !== "savings");
        // Bug 10.19: summing blindly meant one connection with a missing/non-numeric
        // balance turned the whole total NaN, which JSON-serializes to null and reads
        // to the model as "no cash available" -- a false negative far worse than just
        // leaving that one account out. Skip non-finite balances and say so explicitly:
        // an honest "unknown" for that account beats a silently invented number.
        const missingBalance: string[] = [];
        const spendable = spendableAccounts.reduce((sum, b) => {
          if (!Number.isFinite(b.balance)) {
            missingBalance.push(b.bankName || b.accountName || b.id);
            return sum;
          }
          return sum + b.balance;
        }, 0);
        return {
          availableCash: round2(spendable),
          ...(missingBalance.length > 0 ? { accountsMissingBalance: missingBalance } : {}),
          creditCards: creditCards.map((c) => ({
            name: c.cardName,
            balance: round2(c.balance),
            creditLimit: c.creditLimit,
            dueDate: c.dueDate,
          })),
        };
      },
    },

    {
      name: "get_credit_cards",
      description: "The household's active credit cards: balance, limit, utilization, APR, and due date.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const cards = (getScopedItems("credit_cards", userId) as any[]).filter((c) => c.status === "active");
        return cards.map((c) => ({
          name: c.cardName,
          issuer: c.issuer,
          balance: round2(c.balance),
          creditLimit: c.creditLimit,
          utilizationPercent: c.creditLimit > 0 ? round2((c.balance / c.creditLimit) * 100) : null,
          apr: c.apr,
          dueDate: c.dueDate,
          minPayment: c.minPayment,
        }));
      },
    },

    {
      name: "get_savings_goals",
      description: "The household's savings goals and progress toward each.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const goals = getScopedItems("goals", userId) as any[];
        const bankConnections = getScopedItems("bank_connections", userId) as any[];
        return goals.map((g) => {
          const current = g.linkedBankConnectionId
            ? bankConnections.find((b) => b.id === g.linkedBankConnectionId)?.balance ?? 0
            : g.manualAmount || 0;
          return {
            name: g.name,
            targetAmount: g.targetAmount,
            currentAmount: round2(current),
            percent: g.targetAmount > 0 ? round2((current / g.targetAmount) * 100) : null,
            targetDate: g.targetDate,
          };
        });
      },
    },

    {
      name: "get_upcoming_bills",
      description:
        "This month's recurring bills: name, amount, due date, and whether each has been paid yet. " +
        "Falls back to the older category-based tracker (limit and whether anything posted this " +
        "month, per tracked bill category) for a household that hasn't set up real bills yet.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const bills = getScopedItems("bills", userId) as Bill[];
        const activeBills = bills.filter((b) => b.active);

        if (activeBills.length > 0) {
          const transactions = getScopedItems("transactions", userId) as Transaction[];
          const today = new Date();
          const currentMonth = currentMonthOf(today);
          return billStatuses(activeBills, currentMonth, transactions, today).map((s) => ({
            name: s.bill.name,
            amount: s.bill.amount,
            dueDate: s.dueDate,
            status: s.state,
            daysUntil: s.daysUntil,
            paid: s.state === "paid",
            paidAmount: s.paidAmount !== undefined ? round2(s.paidAmount) : undefined,
            autopay: Boolean(s.bill.autopay),
          }));
        }

        // No real bills set up yet -- fall back to the pre-Phase-6 behaviour
        // exactly: the tracked bill categories, their limit, and whether
        // anything posted against them this calendar month.
        const billCategories: string[] = getConfig("budget.billCategories", []) || [];
        if (billCategories.length === 0) return { error: "No bill categories configured yet." };
        const budgets = getScopedItems("budgets", userId) as Budget[];
        const transactions = getScopedItems("transactions", userId) as Transaction[];
        // Server-local month, not UTC: after 8 pm Eastern the UTC month can already be next month on the last day.
        const currentMonth = serverMonth();

        return billCategories.map((category) => {
          const budget = budgets.find((b) => b.category === category);
          const paidThisMonth = transactions
            .filter((t) => t.category === category && t.amount < 0 && inMonth(t, currentMonth))
            .reduce((sum, t) => sum + Math.abs(t.amount), 0);
          return {
            category,
            limit: budget?.limit ?? null,
            paidThisMonth: round2(paidThisMonth),
            paidThisMonthAlready: paidThisMonth > 0,
          };
        });
      },
    },

    {
      name: "add_transaction",
      mutates: true,
      description:
        "Add a transaction to the ledger. Only call this once the user has clearly asked to log a " +
        "purchase or income -- never as a side effect of just answering a question.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: 'What it was, e.g. "Coffee at Starbucks".' },
          amount: { type: "number", description: "Negative for spending, positive for income." },
          category: { type: "string", description: 'Budget category, e.g. "Eating Out". Invented if none fits.' },
          scope: { type: "string", description: '"joint" or "personal". Defaults to joint.' },
        },
        required: ["description", "amount", "category"],
      },
      run: async ({ description, amount, category, scope }) => {
        // amount is required, but Number(null), Number("") and Number([]) are all 0,
        // so a bare finite check would book a $0.00 row and report success instead of
        // telling the model it dropped the field.
        const amt = toRequiredNumber(amount);
        if (!Number.isFinite(amt)) return { error: "amount must be a number." };
        const finalCategory = String(category || "Uncategorized").trim() || "Uncategorized";
        ensureCategoryExists(userId, finalCategory);

        const tx: Transaction = {
          id: newId("tx"),
          // Local date: "add $20 for lunch" at 9 pm must land on today, and toISOString() would file it under tomorrow.
          date: serverToday(),
          description: String(description).trim(),
          merchantName: String(description).trim(),
          amount: amt,
          category: finalCategory,
          bankName: "Manual Entry",
          status: "cleared",
          scope: scope === "personal" ? "personal" : "joint",
        };
        putScopedItemAs("transactions", userId, tx.id, tx);
        return { added: tx.description, amount: tx.amount, category: tx.category, scope: tx.scope };
      },
    },

    {
      name: "set_budget_limit",
      mutates: true,
      description:
        "Set (or create) the spending limit for a budget category. Omit month to change the " +
        "category's standing default limit (every month without its own override). Pass month " +
        '("YYYY-MM") to set a one-off limit for just that month instead, leaving the default ' +
        "and every other month untouched.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: 'Budget category, e.g. "Groceries".' },
          limit: { type: "number", description: "The new limit." },
          month: { type: "string", description: 'Optional: "YYYY-MM" to set this limit for that month only, instead of the standing default.' },
        },
        required: ["category", "limit"],
      },
      run: async ({ category, limit, month }) => {
        // Same coercion trap as add_transaction's amount -- see the comment there.
        const lim = toRequiredNumber(limit);
        if (!Number.isFinite(lim) || lim < 0) return { error: "limit must be a non-negative number." };
        const cat = String(category).trim();
        if (!cat) return { error: "category is required." };
        if (month !== undefined && !isValidMonth(month)) {
          return { error: 'month must be in "YYYY-MM" format, e.g. "2026-08".' };
        }

        const existing = (getScopedItems("budgets", userId) as Budget[]).find((b) => b.category === cat);
        if (!existing) ensureCategoryExists(userId, cat);

        if (month) {
          // A one-off override for this exact month only -- the standing
          // default and every other month's own override are untouched.
          const budget: Budget = {
            category: cat,
            limit: existing?.limit ?? 0,
            spent: existing?.spent ?? 0,
            scope: existing?.scope,
            monthlyLimits: { ...(existing?.monthlyLimits || {}), [month]: lim },
            rollover: existing?.rollover,
            rolloverSince: existing?.rolloverSince,
          };
          // budgets is keyed by category name -- see the comment on
          // ensureCategoryExists in routes/budget.ts. `existing` came back
          // empty/undefined here precisely when another member already owns
          // this exact category name personally, so this can genuinely refuse.
          if (!putScopedItemAs("budgets", userId, cat, budget)) {
            return { error: `Couldn't save that -- "${cat}" is already someone else's personal budget category.` };
          }
          return { category: cat, limit: lim, month };
        }

        // No month: today's behaviour exactly -- sets the standing default
        // limit, preserving everything else already on the row (including any
        // monthlyLimits/rollover set through the UI).
        const budget: Budget = {
          ...existing,
          category: cat,
          limit: lim,
          spent: existing?.spent ?? 0,
          scope: existing?.scope,
        };
        if (!putScopedItemAs("budgets", userId, cat, budget)) {
          return { error: `Couldn't save that -- "${cat}" is already someone else's personal budget category.` };
        }
        return { category: cat, limit: lim };
      },
    },
  ];
}

export const budgetModule: ToolModule = {
  domain: "budget",
  sensitivity: "financial",
  label: "household finances",
  promptRules: [
    "To build or set up a budget, call get_budget_summary first. If it returns no categories, " +
      "propose limits from its spendingByCategory (a previous full month gives a truer picture than " +
      "a partial current one) and ask before calling set_budget_limit.",
  ],
  build: budgetTools,
};
