// src/sections/budget/budgetMath.ts -- the single definition of "is this
// transaction a transfer between the household's own accounts", now shared by
// Budget.tsx's totals and VisualCharts' two filters (they used to each grow
// their own slightly-different rule).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isTransfer,
  isTransferCategory,
  buildDisplayBudgets,
  spendableBalance,
  totalOutflow,
  totalInflow,
  burnDays,
  thresholdCrossings,
  dedupeIncoming,
  stepMonth,
  monthRange,
  formatMonthLabel,
  defaultMonth,
  monthProgress,
  monthSummary,
  needsAttention,
  budgetLevel,
  filterTransactions,
  summarizeTransactions,
  markLikelyDuplicates,
  NEEDS_REVIEW_FILTER,
  addMoney,
  sortTransactions,
  limitFor,
  carryInto,
  CARRY_OVERSPEND,
  billDueDate,
  billStatus,
  billStatuses,
  detectRecurring,
  applyBudgetAmount,
} from "../src/sections/budget/budgetMath.ts";
import type { Transaction, Budget, BankConnection, DisplayBudget, Bill } from "../src/sections/budget/types.ts";

// Minimal-boilerplate Transaction fixture -- fills in the fields every test
// here doesn't care about (description, bankName, status) so each test only
// states what it's actually testing.
function tx(fields: {
  id: string;
  date: string;
  amount: number;
  category: string;
  merchantName?: string;
  description?: string;
  bankName?: string;
  scope?: "personal" | "joint";
  transferId?: string;
  accountId?: string;
}): Transaction {
  return {
    id: fields.id,
    date: fields.date,
    description: fields.description ?? fields.merchantName ?? fields.category,
    merchantName: fields.merchantName ?? fields.category,
    amount: fields.amount,
    category: fields.category,
    bankName: fields.bankName ?? "Test Bank",
    status: "cleared",
    scope: fields.scope,
    transferId: fields.transferId,
    accountId: fields.accountId,
  };
}

describe("isTransferCategory", () => {
  test("matches the category name case-insensitively", () => {
    assert.equal(isTransferCategory("Transfer"), true);
    assert.equal(isTransferCategory("TRANSFER"), true);
    assert.equal(isTransferCategory("Internal Transfer"), true);
  });

  test("a category that merely contains other words is not a transfer", () => {
    // "Gas & Transport" must not match -- it has nothing to do with moving
    // money between the household's own accounts, and a substring rule on the
    // wrong word would silently exclude it from every spending total.
    assert.equal(isTransferCategory("Gas & Transport"), false);
    assert.equal(isTransferCategory("Groceries"), false);
  });
});

describe("isTransfer", () => {
  test("a transferId marks a row as a transfer regardless of category or description", () => {
    assert.equal(
      isTransfer({ category: "Shopping", description: "Whatever", transferId: "transfer-1" }),
      true
    );
  });

  test("the category name alone is enough", () => {
    assert.equal(isTransfer({ category: "Transfer", description: "Anything" }), true);
    assert.equal(isTransfer({ category: "Internal Transfer", description: "Anything" }), true);
  });

  for (const phrase of ["transfer between accounts", "internal transfer", "money transfer"]) {
    test(`a description containing "${phrase}" is a transfer even in an unrelated category`, () => {
      assert.equal(
        isTransfer({ category: "Shopping", description: `ACME BANK ${phrase.toUpperCase()} REF 123` }),
        true
      );
    });
  }

  test("Gas & Transport with an ordinary description is not a transfer", () => {
    assert.equal(isTransfer({ category: "Gas & Transport", description: "SHELL OIL 574" }), false);
  });

  test("an ordinary expense in an ordinary category is not a transfer", () => {
    assert.equal(isTransfer({ category: "Groceries", description: "WHOLE FOODS MARKET" }), false);
  });
});

describe("buildDisplayBudgets", () => {
  // scope: 'all' so these rows are unaffected by the row-level scope
  // filtering covered separately below -- these tests are about the `spent`
  // math, not about which rows a given scope tab should show.
  const budgets: Budget[] = [
    { category: "Groceries", limit: 500, scope: "all" },
    { category: "Income", limit: 3000, scope: "all" },
  ];
  const incomeCategories = ["Income"];

  test("an expense category sums its negative amounts as a positive `spent`", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -100, category: "Groceries" }),
      tx({ id: "t2", date: "2026-06-02", amount: -50, category: "Groceries" }),
      tx({ id: "t3", date: "2026-06-03", amount: 30, category: "Groceries" }), // a refund -- ignored, not negative
    ];
    const result = buildDisplayBudgets(budgets, transactions, { scope: "all", month: "all", incomeCategories });
    assert.equal(result.find((b) => b.category === "Groceries")!.spent, 150);
  });

  describe("spending in a category with no budget entry", () => {
    const base = [tx({ id: "u1", date: "2026-06-01", amount: -40, category: "Medical & Health", scope: "joint" })];

    test("shows up as a $0-limit row flagged unbudgeted, with its spending counted", () => {
      const result = buildDisplayBudgets(budgets, base, { scope: "all", month: "all", incomeCategories });
      const row = result.find((b) => b.category === "Medical & Health")!;
      assert.equal(row.unbudgeted, true);
      assert.equal(row.limit, 0);
      assert.equal(row.spent, 40);
      assert.equal(result.find((b) => b.category === "Groceries")!.unbudgeted, undefined);
    });

    test("respects the selected month and the scope tab", () => {
      const txs = [
        ...base,
        tx({ id: "u2", date: "2026-07-01", amount: -10, category: "Medical & Health", scope: "joint" }),
        tx({ id: "u3", date: "2026-06-05", amount: -5, category: "Pets", scope: "personal" }),
      ];
      const june = buildDisplayBudgets(budgets, txs, { scope: "all", month: "2026-06", incomeCategories });
      assert.equal(june.find((b) => b.category === "Medical & Health")!.spent, 40, "July's charge is not June's");

      const joint = buildDisplayBudgets(budgets, txs, { scope: "joint", month: "all", incomeCategories });
      assert.equal(joint.some((b) => b.category === "Pets"), false, "a personal charge is not in the joint view");
      const personal = buildDisplayBudgets(budgets, txs, { scope: "personal", month: "all", incomeCategories });
      assert.equal(personal.find((b) => b.category === "Pets")!.scope, "personal");
    });

    test("transfers, income and refunds never create an unbudgeted row", () => {
      const txs = [
        tx({ id: "u4", date: "2026-06-01", amount: -500, category: "Transfer" }),
        tx({ id: "u5", date: "2026-06-01", amount: -20, category: "Income" }),
        tx({ id: "u6", date: "2026-06-01", amount: 25, category: "Medical & Health" }),
      ];
      const result = buildDisplayBudgets(budgets, txs, { scope: "all", month: "all", incomeCategories });
      assert.deepEqual(result.map((b) => b.category).sort(), ["Groceries", "Income"]);
    });

    test("a category that already has a budget row is not duplicated", () => {
      const txs = [tx({ id: "u7", date: "2026-06-01", amount: -9, category: "Groceries" })];
      const result = buildDisplayBudgets(budgets, txs, { scope: "all", month: "all", incomeCategories });
      assert.equal(result.filter((b) => b.category === "Groceries").length, 1);
    });
  });

  test("an income category sums its positive amounts as `spent` (really 'received')", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: 3000, category: "Income" }),
      tx({ id: "t2", date: "2026-06-02", amount: -12, category: "Income" }), // a fee -- ignored, not positive
    ];
    const result = buildDisplayBudgets(budgets, transactions, { scope: "all", month: "all", incomeCategories });
    assert.equal(result.find((b) => b.category === "Income")!.spent, 3000);
  });

  test("a transaction with no scope counts as personal", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -100, category: "Groceries" }), // no scope
      tx({ id: "t2", date: "2026-06-01", amount: -40, category: "Groceries", scope: "joint" }),
    ];
    const personalOnly = buildDisplayBudgets(budgets, transactions, { scope: "personal", month: "all", incomeCategories });
    assert.equal(personalOnly.find((b) => b.category === "Groceries")!.spent, 100);

    const jointOnly = buildDisplayBudgets(budgets, transactions, { scope: "joint", month: "all", incomeCategories });
    assert.equal(jointOnly.find((b) => b.category === "Groceries")!.spent, 40);
  });

  test("month filtering excludes other months; 'all' includes every month", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-05-15", amount: -100, category: "Groceries" }),
      tx({ id: "t2", date: "2026-06-15", amount: -40, category: "Groceries" }),
    ];
    const june = buildDisplayBudgets(budgets, transactions, { scope: "all", month: "2026-06", incomeCategories });
    assert.equal(june.find((b) => b.category === "Groceries")!.spent, 40);

    const allMonths = buildDisplayBudgets(budgets, transactions, { scope: "all", month: "all", incomeCategories });
    assert.equal(allMonths.find((b) => b.category === "Groceries")!.spent, 140);
  });

  test("with a real month, baseLimit/carriedIn are always present and default to no carry", () => {
    const result = buildDisplayBudgets(budgets, [], { scope: "all", month: "2026-06", incomeCategories });
    const groceries = result.find((b) => b.category === "Groceries")!;
    assert.equal(groceries.baseLimit, 500);
    assert.equal(groceries.carriedIn, 0);
    assert.equal(groceries.limit, 500, "available = baseLimit + carriedIn with no rollover");
  });

  test("rollover folds leftover money from prior months into `limit`", () => {
    const rolloverBudgets: Budget[] = [
      { category: "Groceries", limit: 500, rollover: true, rolloverSince: "2026-01", scope: "all" },
    ];
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-01-15", amount: -300, category: "Groceries" }), // $200 left over in Jan
    ];
    const result = buildDisplayBudgets(rolloverBudgets, transactions, { scope: "all", month: "2026-02", incomeCategories });
    const groceries = result.find((b) => b.category === "Groceries")!;
    assert.equal(groceries.baseLimit, 500);
    assert.equal(groceries.carriedIn, 200);
    assert.equal(groceries.limit, 700);
  });

  test("an income category never rolls over even if the flag is set", () => {
    const rolloverBudgets: Budget[] = [
      { category: "Income", limit: 3000, rollover: true, rolloverSince: "2026-01", scope: "all" },
    ];
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-01-15", amount: 2000, category: "Income" }),
    ];
    const result = buildDisplayBudgets(rolloverBudgets, transactions, { scope: "all", month: "2026-02", incomeCategories: ["Income"] });
    const income = result.find((b) => b.category === "Income")!;
    assert.equal(income.carriedIn, 0);
    assert.equal(income.limit, 3000);
  });

  test("a personal budget is excluded from the joint view and vice versa", () => {
    const mixed: Budget[] = [
      { category: "Fun Money", limit: 50, scope: "personal" },
      { category: "Mortgage/Rent", limit: 800, scope: "joint" },
    ];
    const personalOnly = buildDisplayBudgets(mixed, [], { scope: "personal", month: "all", incomeCategories });
    assert.equal(personalOnly.some((b) => b.category === "Fun Money"), true);
    assert.equal(personalOnly.some((b) => b.category === "Mortgage/Rent"), false);

    const jointOnly = buildDisplayBudgets(mixed, [], { scope: "joint", month: "all", incomeCategories });
    assert.equal(jointOnly.some((b) => b.category === "Mortgage/Rent"), true);
    assert.equal(jointOnly.some((b) => b.category === "Fun Money"), false);

    const all = buildDisplayBudgets(mixed, [], { scope: "all", month: "all", incomeCategories });
    assert.equal(all.length, 2);
  });

  test("a budget with no scope defaults to joint, unlike a transaction defaulting to personal", () => {
    const legacy: Budget[] = [{ category: "Groceries", limit: 500 }];
    const jointOnly = buildDisplayBudgets(legacy, [], { scope: "joint", month: "all", incomeCategories });
    assert.equal(jointOnly.length, 1);

    const personalOnly = buildDisplayBudgets(legacy, [], { scope: "personal", month: "all", incomeCategories });
    assert.equal(personalOnly.length, 0);
  });

  test("a budget explicitly scoped 'all' shows up under both the personal and joint tabs", () => {
    const shared: Budget[] = [{ category: "Groceries", limit: 500, scope: "all" }];
    assert.equal(buildDisplayBudgets(shared, [], { scope: "personal", month: "all", incomeCategories }).length, 1);
    assert.equal(buildDisplayBudgets(shared, [], { scope: "joint", month: "all", incomeCategories }).length, 1);
  });
});

describe("limitFor", () => {
  test("falls back to the default limit with no override", () => {
    assert.equal(limitFor({ limit: 500 }, "2026-06"), 500);
  });

  test("an override for that exact month wins", () => {
    assert.equal(limitFor({ limit: 500, monthlyLimits: { "2026-06": 650 } }, "2026-06"), 650);
  });

  test("an override for a different month is ignored", () => {
    assert.equal(limitFor({ limit: 500, monthlyLimits: { "2026-05": 650 } }, "2026-06"), 500);
  });
});

describe("carryInto", () => {
  const spendMap = (spend: Record<string, number>) => (month: string) => spend[month] ?? 0;

  test("rollover off is always zero", () => {
    const b: Budget = { category: "Groceries", limit: 500, rolloverSince: "2026-01" };
    assert.equal(carryInto(b, "2026-03", spendMap({})), 0);
  });

  test("at or before rolloverSince is zero -- the chain hasn't started", () => {
    const b: Budget = { category: "Groceries", limit: 500, rollover: true, rolloverSince: "2026-01" };
    assert.equal(carryInto(b, "2026-01", spendMap({})), 0, "the start month itself");
    assert.equal(carryInto(b, "2025-12", spendMap({})), 0, "before the start month");
  });

  test("positive carry compounds across two months", () => {
    const b: Budget = { category: "Groceries", limit: 500, rollover: true, rolloverSince: "2026-01" };
    // Jan: 500 - 300 = 200 left over. Feb: (500 + 200) - 400 = 300 left over.
    const spent = spendMap({ "2026-01": 300, "2026-02": 400 });
    assert.equal(carryInto(b, "2026-02", spent), 200, "carry into Feb is just Jan's leftover");
    assert.equal(carryInto(b, "2026-03", spent), 300, "carry into Mar compounds Jan and Feb");
  });

  test("overspending carries a negative amount by default (CARRY_OVERSPEND)", () => {
    assert.equal(CARRY_OVERSPEND, true, "documents the current household-wide choice");
    const b: Budget = { category: "Groceries", limit: 500, rollover: true, rolloverSince: "2026-01" };
    // Jan: 500 - 700 = -200 overspent.
    const spent = spendMap({ "2026-01": 700 });
    assert.equal(carryInto(b, "2026-02", spent), -200);
  });

  test("a mid-chain monthlyLimits override changes the carry from that month on", () => {
    const b: Budget = {
      category: "Groceries",
      limit: 500,
      monthlyLimits: { "2026-02": 800 },
      rollover: true,
      rolloverSince: "2026-01",
    };
    // Jan: 500 - 300 = 200. Feb uses the 800 override: (800 + 200) - 400 = 600.
    const spent = spendMap({ "2026-01": 300, "2026-02": 400 });
    assert.equal(carryInto(b, "2026-03", spent), 600);
  });

  test("the loop is capped rather than iterating forever on a runaway range", () => {
    const b: Budget = { category: "Groceries", limit: 100, rollover: true, rolloverSince: "1900-01" };
    // No spending anywhere in the (huge) range -- if the cap didn't apply, carry
    // would grow by 100 every month for 1500+ months. The cap stops it at 120.
    const carry = carryInto(b, "2026-06", spendMap({}));
    assert.equal(carry, 100 * 120);
  });
});

describe("applyBudgetAmount", () => {
  test("mode 'month' writes only that month's override", () => {
    const row: Budget = { category: "Groceries", limit: 900 };
    const result = applyBudgetAmount(row, 950, "month", "2026-09");
    assert.deepEqual(result, { category: "Groceries", limit: 900, monthlyLimits: { "2026-09": 950 } });
  });

  test("mode 'default' sets the standing limit and clears this month's and later overrides", () => {
    const row: Budget = {
      category: "Groceries",
      limit: 900,
      monthlyLimits: { "2026-08": 850, "2026-09": 950, "2026-10": 1000 },
    };
    const result = applyBudgetAmount(row, 925, "default", "2026-09");
    assert.equal(result.limit, 925);
    assert.deepEqual(result.monthlyLimits, { "2026-08": 850 }, "earlier months' overrides are history and stay");
  });

  test("mode 'default' drops an empty monthlyLimits object entirely rather than leaving {}", () => {
    const row: Budget = { category: "Groceries", limit: 900, monthlyLimits: { "2026-09": 950 } };
    const result = applyBudgetAmount(row, 925, "default", "2026-09");
    assert.equal(result.monthlyLimits, undefined);
  });

  test("reapplying mode 'month' on the SAME pre-edit row restores the standing default -- the 'Only for {Month}' fix", () => {
    // Reproduces the reported bug: default $900 -> inline-edited to $950 "from
    // now on" (mode 'default') -> user picks "Only for September" instead.
    // That action must reapply mode 'month' on the row as it was BEFORE the
    // edit, not on the store's now-$950 state, or the standing default never
    // goes back to $900.
    const preEditRow: Budget = { category: "Groceries", limit: 900 };
    const afterDefaultEdit = applyBudgetAmount(preEditRow, 950, "default", "2026-09");
    assert.equal(afterDefaultEdit.limit, 950, "sanity: the default write itself worked");

    const afterOnlyForSeptember = applyBudgetAmount(preEditRow, 950, "month", "2026-09");
    assert.deepEqual(afterOnlyForSeptember, {
      category: "Groceries",
      limit: 900,
      monthlyLimits: { "2026-09": 950 },
    });
  });

  test("other fields on the row (rollover, scope) pass through untouched", () => {
    const row: Budget = { category: "Groceries", limit: 900, rollover: true, rolloverSince: "2026-01", scope: "joint" };
    const result = applyBudgetAmount(row, 950, "default", "2026-09");
    assert.equal(result.rollover, true);
    assert.equal(result.rolloverSince, "2026-01");
    assert.equal(result.scope, "joint");
  });
});

describe("spendableBalance", () => {
  const accounts: BankConnection[] = [
    { id: "b1", bankName: "Chase", accountName: "Checking", lastFour: "1111", balance: 1000, status: "connected", accountType: "depository", scope: "personal" },
    { id: "b2", bankName: "Chase", accountName: "Savings", lastFour: "2222", balance: 5000, status: "connected", accountType: "savings", scope: "personal" },
    { id: "b3", bankName: "Auto Loan Co", accountName: "Loan", lastFour: "3333", balance: -12000, status: "connected", accountType: "loan", scope: "joint" },
    { id: "b4", bankName: "Ally", accountName: "Joint Checking", lastFour: "4444", balance: 800, status: "connected", accountType: "depository", scope: "joint" },
  ];

  test("excludes loan and savings accounts", () => {
    assert.equal(spendableBalance(accounts, "all"), 1000 + 800);
  });

  test("respects scope", () => {
    assert.equal(spendableBalance(accounts, "personal"), 1000);
    assert.equal(spendableBalance(accounts, "joint"), 800);
  });
});

describe("totalOutflow and totalInflow", () => {
  const incomeCategories = ["Income"];

  test("transfers are excluded from both totals", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -100, category: "Groceries" }),
      tx({ id: "t2", date: "2026-06-01", amount: -200, category: "Transfer", transferId: "xfer-1" }),
      tx({ id: "t3", date: "2026-06-01", amount: 200, category: "Transfer", transferId: "xfer-1" }),
    ];
    assert.equal(totalOutflow(transactions, incomeCategories), 100);
    assert.equal(totalInflow(transactions, incomeCategories), 0);
  });

  test("an income category's rows count toward inflow regardless of sign, and never toward outflow", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: 3000, category: "Income" }),
      tx({ id: "t2", date: "2026-06-01", amount: -12, category: "Income" }), // a bank fee booked against Income
    ];
    assert.equal(totalOutflow(transactions, incomeCategories), 0);
    assert.equal(totalInflow(transactions, incomeCategories), 2988);
  });

  test("ordinary spending counts toward outflow; an ordinary positive amount (a refund) counts toward inflow", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -50, category: "Groceries" }),
      tx({ id: "t2", date: "2026-06-01", amount: 25, category: "Groceries" }),
    ];
    assert.equal(totalOutflow(transactions, incomeCategories), 50);
    assert.equal(totalInflow(transactions, incomeCategories), 25);
  });
});

describe("burnDays", () => {
  test("'all' spans from the earliest to the latest transaction date, inclusive", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -10, category: "Groceries" }),
      tx({ id: "t2", date: "2026-06-10", amount: -10, category: "Groceries" }),
    ];
    // June 1 through June 10 inclusive = 10 days.
    assert.equal(burnDays("all", transactions, new Date("2026-06-15T12:00:00")), 10);
  });

  test("'all' with no transactions falls back to 1 day", () => {
    assert.equal(burnDays("all", [], new Date("2026-06-15T12:00:00")), 1);
  });

  test("a finished month uses its full length, including February in a leap year", () => {
    // September is in the past relative to `today` below, so it's "finished".
    assert.equal(burnDays("2026-09", [], new Date("2026-10-05T12:00:00")), 30);
    // 2028 is a leap year -- February has 29 days.
    assert.equal(burnDays("2028-02", [], new Date("2028-03-01T12:00:00")), 29);
    // 2026 is not a leap year -- February has 28 days.
    assert.equal(burnDays("2026-02", [], new Date("2026-03-01T12:00:00")), 28);
  });

  test("the current month in progress uses only the days elapsed so far", () => {
    assert.equal(burnDays("2026-09", [], new Date("2026-09-23T09:00:00")), 23);
  });
});

describe("thresholdCrossings", () => {
  const budgets: Budget[] = [{ category: "Groceries", limit: 100 }];
  const currentMonth = "2026-06";

  test("crossing 85% of the limit fires a warning", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-01", amount: -70, category: "Groceries" })];
    const batch: Transaction[] = [tx({ id: "b1", date: "2026-06-02", amount: -20, category: "Groceries" })]; // 70 -> 90
    const crossings = thresholdCrossings(existing, batch, budgets, currentMonth);
    assert.equal(crossings.length, 1);
    assert.equal(crossings[0].level, "warning");
    assert.equal(crossings[0].newSpent, 90);
  });

  test("crossing 100% fires critical, not also a warning", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-01", amount: -70, category: "Groceries" })];
    const batch: Transaction[] = [tx({ id: "b1", date: "2026-06-02", amount: -40, category: "Groceries" })]; // 70 -> 110
    const crossings = thresholdCrossings(existing, batch, budgets, currentMonth);
    assert.equal(crossings.length, 1);
    assert.equal(crossings[0].level, "critical");
  });

  test("already over the limit before the batch fires nothing -- no re-crossing", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-01", amount: -150, category: "Groceries" })];
    const batch: Transaction[] = [tx({ id: "b1", date: "2026-06-02", amount: -10, category: "Groceries" })];
    assert.deepEqual(thresholdCrossings(existing, batch, budgets, currentMonth), []);
  });

  test("a batch row dated in another month doesn't count toward this month's crossing", () => {
    const batch: Transaction[] = [tx({ id: "b1", date: "2026-05-31", amount: -200, category: "Groceries" })];
    assert.deepEqual(thresholdCrossings([], batch, budgets, currentMonth), []);
  });

  test("transfers are never counted as spending", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-01", amount: -70, category: "Groceries" })];
    const batch: Transaction[] = [tx({ id: "b1", date: "2026-06-02", amount: -40, category: "Transfer", transferId: "xfer-1" })];
    assert.deepEqual(thresholdCrossings(existing, batch, budgets, currentMonth), []);
  });

  test("a category with a zero (or missing) limit never crosses", () => {
    const noBudget: Budget[] = [{ category: "Groceries", limit: 0 }];
    const batch: Transaction[] = [tx({ id: "b1", date: "2026-06-02", amount: -500, category: "Groceries" })];
    assert.deepEqual(thresholdCrossings([], batch, noBudget, currentMonth), []);
  });

  test("several rows in the same category in one batch collapse into a single crossing", () => {
    const batch: Transaction[] = [
      tx({ id: "b1", date: "2026-06-02", amount: -40, category: "Groceries" }),
      tx({ id: "b2", date: "2026-06-03", amount: -50, category: "Groceries" }),
    ];
    const crossings = thresholdCrossings([], batch, budgets, currentMonth);
    assert.equal(crossings.length, 1);
    assert.equal(crossings[0].newSpent, 90);
  });
});

describe("dedupeIncoming", () => {
  test("an incoming row whose id already exists in base is dropped", () => {
    const base: Transaction[] = [tx({ id: "tx-1", date: "2026-06-01", amount: -10, category: "Groceries", merchantName: "Costco", accountId: "acc-1" })];
    const incoming: Transaction[] = [tx({ id: "tx-1", date: "2026-06-01", amount: -10, category: "Groceries", merchantName: "Costco", accountId: "acc-1" })];
    assert.deepEqual(dedupeIncoming(base, incoming), []);
  });

  test("a content match (account|date|amount|merchant) is dropped even with a different id", () => {
    const base: Transaction[] = [tx({ id: "tx-1", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "DoorDash", accountId: "acc-1" })];
    const incoming: Transaction[] = [tx({ id: "plaid-99", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "DoorDash", accountId: "acc-1" })];
    assert.deepEqual(dedupeIncoming(base, incoming), []);
  });

  test("the merchant match is case- and leading/trailing-space-insensitive", () => {
    const base: Transaction[] = [tx({ id: "tx-1", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "  DoorDash  ", accountId: "acc-1" })];
    const incoming: Transaction[] = [tx({ id: "plaid-99", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "doordash", accountId: "acc-1" })];
    assert.deepEqual(dedupeIncoming(base, incoming), []);
  });

  test("a different account is not a content match, even with the same date/amount/merchant", () => {
    const base: Transaction[] = [tx({ id: "tx-1", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "DoorDash", accountId: "acc-1" })];
    const incoming: Transaction[] = [tx({ id: "plaid-99", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "DoorDash", accountId: "acc-2" })];
    const result = dedupeIncoming(base, incoming);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "plaid-99");
  });

  test("two genuine identical repeats where only one exists in base -- exactly one comes through", () => {
    const base: Transaction[] = [
      tx({ id: "tx-1", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "DoorDash", accountId: "acc-1" }),
    ];
    const incoming: Transaction[] = [
      tx({ id: "plaid-1", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "DoorDash", accountId: "acc-1" }),
      tx({ id: "plaid-2", date: "2026-06-01", amount: -9.99, category: "Eating Out", merchantName: "DoorDash", accountId: "acc-1" }),
    ];
    const result = dedupeIncoming(base, incoming);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "plaid-2");
  });
});

describe("stepMonth", () => {
  test("steps forward within a year", () => {
    assert.equal(stepMonth("2026-06", 1), "2026-07");
  });

  test("steps backward within a year", () => {
    assert.equal(stepMonth("2026-06", -1), "2026-05");
  });

  test("rolls the year forward over December", () => {
    assert.equal(stepMonth("2026-12", 1), "2027-01");
  });

  test("rolls the year backward over January", () => {
    assert.equal(stepMonth("2026-01", -1), "2025-12");
  });
});

describe("monthRange", () => {
  test("spans from the earliest month with data through one month ahead of the current month", () => {
    const range = monthRange(["2026-04", "2026-06"], new Date("2026-09-23T09:00:00"));
    assert.deepEqual(range, ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]);
  });

  test("spans through the latest month with data when it's further ahead than the one-month lookahead", () => {
    const range = monthRange(["2026-08", "2026-11"], new Date("2026-09-23T09:00:00"));
    assert.deepEqual(range, ["2026-11", "2026-10", "2026-09", "2026-08"]);
  });

  test("with no data at all, the range still includes next month for planning ahead", () => {
    assert.deepEqual(monthRange([], new Date("2026-09-23T09:00:00")), ["2026-10", "2026-09"]);
  });
});

describe("formatMonthLabel", () => {
  test("formats a month string without depending on the machine's timezone", () => {
    assert.equal(formatMonthLabel("2026-09"), "September 2026");
    assert.equal(formatMonthLabel("2026-01"), "January 2026");
    assert.equal(formatMonthLabel("2026-12"), "December 2026");
  });
});

describe("defaultMonth", () => {
  test("prefers the current month when it has data", () => {
    const today = new Date("2026-09-23T09:00:00");
    assert.equal(defaultMonth(["2026-06", "2026-09"], today), "2026-09");
  });

  test("falls back to the latest month with data when the current month has none", () => {
    const today = new Date("2026-09-23T09:00:00");
    assert.equal(defaultMonth(["2026-06", "2026-07"], today), "2026-07");
  });

  test("falls back to the current month when there's no data at all", () => {
    const today = new Date("2026-09-23T09:00:00");
    assert.equal(defaultMonth([], today), "2026-09");
  });
});

describe("monthProgress", () => {
  test("the current month reads today's date as elapsed, including today in daysLeft", () => {
    const p = monthProgress("2026-09", new Date("2026-09-23T09:00:00"));
    assert.equal(p.isCurrent, true);
    assert.equal(p.isPast, false);
    assert.equal(p.isFuture, false);
    assert.equal(p.daysInMonth, 30);
    assert.equal(p.daysElapsed, 23);
    assert.equal(p.daysLeft, 8); // 23..30 inclusive
    assert.equal(p.fraction, 23 / 30);
  });

  test("a past month is fully elapsed", () => {
    const p = monthProgress("2026-06", new Date("2026-09-23T09:00:00"));
    assert.equal(p.isPast, true);
    assert.equal(p.fraction, 1);
    assert.equal(p.daysLeft, 0);
    assert.equal(p.daysElapsed, p.daysInMonth);
  });

  test("a future month has not started", () => {
    const p = monthProgress("2026-12", new Date("2026-09-23T09:00:00"));
    assert.equal(p.isFuture, true);
    assert.equal(p.fraction, 0);
    assert.equal(p.daysElapsed, 0);
    assert.equal(p.daysLeft, p.daysInMonth);
  });

  test("February in a leap year has 29 days", () => {
    const p = monthProgress("2028-02", new Date("2028-01-01T09:00:00"));
    assert.equal(p.daysInMonth, 29);
  });
});

describe("monthSummary", () => {
  const incomeCategories = ["Income"];

  test("spending in a category with no budget row still reduces `left`", () => {
    const displayBudgets: DisplayBudget[] = [
      { category: "Groceries", limit: 300, spent: 100, baseLimit: 300, carriedIn: 0 },
    ];
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -100, category: "Groceries" }),
      // No budget row exists for "Shopping" -- still counts against `spent`/`left`.
      tx({ id: "t2", date: "2026-06-02", amount: -50, category: "Shopping" }),
    ];
    const summary = monthSummary(displayBudgets, transactions, incomeCategories);
    assert.equal(summary.budgeted, 300);
    assert.equal(summary.spent, 150);
    assert.equal(summary.left, 150);
  });

  test("transfers are excluded from spent", () => {
    const displayBudgets: DisplayBudget[] = [{ category: "Groceries", limit: 300, spent: 0, baseLimit: 300, carriedIn: 0 }];
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -200, category: "Transfer", transferId: "x1" }),
    ];
    const summary = monthSummary(displayBudgets, transactions, incomeCategories);
    assert.equal(summary.spent, 0);
    assert.equal(summary.left, 300);
  });

  test("income category limits go to expectedIncome, not budgeted", () => {
    const displayBudgets: DisplayBudget[] = [
      { category: "Groceries", limit: 300, spent: 0, baseLimit: 300, carriedIn: 0 },
      { category: "Income", limit: 4000, spent: 0, baseLimit: 4000, carriedIn: 0 },
    ];
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: 4000, category: "Income" }),
    ];
    const summary = monthSummary(displayBudgets, transactions, incomeCategories);
    assert.equal(summary.budgeted, 300);
    assert.equal(summary.expectedIncome, 4000);
    assert.equal(summary.receivedIncome, 4000);
  });
});

describe("budgetLevel", () => {
  test("spent exactly equal to limit is 'at', not 'over'", () => {
    assert.equal(budgetLevel(1200, 1200), "at");
  });

  test("spent within float dust of the limit is still 'at'", () => {
    assert.equal(budgetLevel(1200.004, 1200), "at");
    assert.equal(budgetLevel(1199.996, 1200), "at");
  });

  test("spent even slightly past the tolerance is 'over'", () => {
    assert.equal(budgetLevel(1200.01, 1200), "over");
  });

  test("85% or more but under the at-budget tolerance is 'warning'", () => {
    assert.equal(budgetLevel(900, 1000), "warning");
  });

  test("under 85% is 'safe'", () => {
    assert.equal(budgetLevel(500, 1000), "safe");
  });

  test("a zero or negative limit is always 'safe'", () => {
    assert.equal(budgetLevel(500, 0), "safe");
  });
});

describe("needsAttention", () => {
  const incomeCategories = ["Income"];

  test("a category spent exactly to its limit is 'at budget', not flagged", () => {
    const displayBudgets: DisplayBudget[] = [{ category: "Mortgage/Rent", limit: 1200, spent: 1200, baseLimit: 1200, carriedIn: 0 }];
    assert.deepEqual(needsAttention(displayBudgets, [], incomeCategories), []);
  });

  test("a category at exactly 85% is a warning", () => {
    const displayBudgets: DisplayBudget[] = [{ category: "Groceries", limit: 100, spent: 85, baseLimit: 100, carriedIn: 0 }];
    const items = needsAttention(displayBudgets, [], incomeCategories);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], { kind: "category", category: "Groceries", level: "warning", percent: 85, spent: 85, limit: 100 });
  });

  test("a category at or above 100% is over", () => {
    const displayBudgets: DisplayBudget[] = [{ category: "Groceries", limit: 100, spent: 120, baseLimit: 100, carriedIn: 0 }];
    const items = needsAttention(displayBudgets, [], incomeCategories);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "category");
    assert.equal((items[0] as any).level, "over");
  });

  test("a zero-limit category is ignored even with heavy spending", () => {
    const displayBudgets: DisplayBudget[] = [{ category: "Groceries", limit: 0, spent: 500, baseLimit: 0, carriedIn: 0 }];
    assert.deepEqual(needsAttention(displayBudgets, [], incomeCategories), []);
  });

  test("categories are sorted by percent used, worst first", () => {
    const displayBudgets: DisplayBudget[] = [
      { category: "Groceries", limit: 100, spent: 90, baseLimit: 100, carriedIn: 0 },
      { category: "Eating Out", limit: 100, spent: 150, baseLimit: 100, carriedIn: 0 },
    ];
    const items = needsAttention(displayBudgets, [], incomeCategories);
    assert.equal(items.length, 2);
    assert.equal((items[0] as any).category, "Eating Out");
    assert.equal((items[1] as any).category, "Groceries");
  });

  test("counts Uncategorized transactions in the month as their own item", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -10, category: "Uncategorized" }),
      tx({ id: "t2", date: "2026-06-02", amount: -20, category: "Uncategorized" }),
      tx({ id: "t3", date: "2026-06-03", amount: -20, category: "Groceries" }),
    ];
    const items = needsAttention([], transactions, incomeCategories);
    assert.deepEqual(items, [{ kind: "uncategorized", count: 2 }]);
  });
});

describe("filterTransactions", () => {
  const base = {
    search: "",
    category: "All",
    type: "all" as const,
    account: "All",
  };
  const transactions: Transaction[] = [
    tx({ id: "t1", date: "2026-06-01", amount: -50, category: "Groceries", merchantName: "Kroger", bankName: "Chase" }),
    tx({ id: "t2", date: "2026-06-02", amount: 2000, category: "Income", merchantName: "Employer", bankName: "Chase" }),
    tx({ id: "t3", date: "2026-06-03", amount: -20, category: "Uncategorized", merchantName: "Mystery Shop", description: "POS 4471", bankName: "Ally" }),
    tx({ id: "t4", date: "2026-06-04", amount: -100, category: "Transfer", merchantName: "Account Transfer", bankName: "Chase", transferId: "xfer-1" }),
  ];

  test("search matches merchant or description, case-insensitively", () => {
    assert.deepEqual(filterTransactions(transactions, { ...base, search: "kroger" }).map((t) => t.id), ["t1"]);
    assert.deepEqual(filterTransactions(transactions, { ...base, search: "pos 4471" }).map((t) => t.id), ["t3"]);
    assert.deepEqual(filterTransactions(transactions, { ...base, search: "nothing matches this" }), []);
  });

  test("category filter matches a real category exactly", () => {
    assert.deepEqual(filterTransactions(transactions, { ...base, category: "Groceries" }).map((t) => t.id), ["t1"]);
  });

  test("the needs-review sentinel and the literal 'Uncategorized' both mean the same thing", () => {
    assert.deepEqual(
      filterTransactions(transactions, { ...base, category: NEEDS_REVIEW_FILTER }).map((t) => t.id),
      ["t3"]
    );
    assert.deepEqual(
      filterTransactions(transactions, { ...base, category: "Uncategorized" }).map((t) => t.id),
      ["t3"]
    );
  });

  test("type 'expenses' excludes income and transfers", () => {
    assert.deepEqual(filterTransactions(transactions, { ...base, type: "expenses" }).map((t) => t.id), ["t1", "t3"]);
  });

  test("type 'income' excludes expenses and transfers", () => {
    assert.deepEqual(filterTransactions(transactions, { ...base, type: "income" }).map((t) => t.id), ["t2"]);
  });

  test("type 'transfers' only returns transfer legs", () => {
    assert.deepEqual(filterTransactions(transactions, { ...base, type: "transfers" }).map((t) => t.id), ["t4"]);
  });

  test("account filter matches bankName", () => {
    assert.deepEqual(
      filterTransactions(transactions, { ...base, account: "Ally" }).map((t) => t.id),
      ["t3"]
    );
  });

  test("filters combine (AND, not OR)", () => {
    assert.deepEqual(
      filterTransactions(transactions, { ...base, type: "expenses", account: "Chase" }).map((t) => t.id),
      ["t1"]
    );
  });
});

describe("summarizeTransactions", () => {
  test("sums spent/received, excludes transfers, counts everything", () => {
    const transactions: Transaction[] = [
      tx({ id: "t1", date: "2026-06-01", amount: -50, category: "Groceries" }),
      tx({ id: "t2", date: "2026-06-02", amount: 2000, category: "Income" }),
      tx({ id: "t3", date: "2026-06-03", amount: -100, category: "Transfer", transferId: "xfer-1" }),
      tx({ id: "t4", date: "2026-06-04", amount: 100, category: "Transfer", transferId: "xfer-1" }),
    ];
    const summary = summarizeTransactions(transactions);
    assert.equal(summary.count, 4);
    assert.equal(summary.spent, 50);
    assert.equal(summary.received, 2000);
    assert.equal(summary.net, 1950);
  });

  test("an empty list summarizes to all zeros", () => {
    assert.deepEqual(summarizeTransactions([]), { count: 0, spent: 0, received: 0, net: 0 });
  });
});

describe("markLikelyDuplicates", () => {
  test("an exact date+amount+merchant match against an existing row is flagged", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-10", amount: -14.5, category: "Eating Out", merchantName: "Starbucks" })];
    const incoming: Transaction[] = [tx({ id: "i1", date: "2026-06-10", amount: -14.5, category: "Eating Out", merchantName: "Starbucks" })];
    assert.deepEqual(markLikelyDuplicates(existing, incoming), [true]);
  });

  test("a genuine repeat (two identical incoming rows) only matches once existing has one", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-10", amount: -5, category: "Eating Out", merchantName: "Coffee Shop" })];
    const incoming: Transaction[] = [
      tx({ id: "i1", date: "2026-06-10", amount: -5, category: "Eating Out", merchantName: "Coffee Shop" }),
      tx({ id: "i2", date: "2026-06-10", amount: -5, category: "Eating Out", merchantName: "Coffee Shop" }),
    ];
    // First incoming row matches the one existing row; the second is a
    // genuine second coffee that day and must let through, not be flagged.
    assert.deepEqual(markLikelyDuplicates(existing, incoming), [true, false]);
  });

  test("a different amount is not a duplicate", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-10", amount: -14.5, category: "Eating Out", merchantName: "Starbucks" })];
    const incoming: Transaction[] = [tx({ id: "i1", date: "2026-06-10", amount: -14.51, category: "Eating Out", merchantName: "Starbucks" })];
    assert.deepEqual(markLikelyDuplicates(existing, incoming), [false]);
  });

  test("merchant match ignores case and surrounding whitespace", () => {
    const existing: Transaction[] = [tx({ id: "e1", date: "2026-06-10", amount: -14.5, category: "Eating Out", merchantName: "Starbucks" })];
    const incoming: Transaction[] = [tx({ id: "i1", date: "2026-06-10", amount: -14.5, category: "Eating Out", merchantName: "  STARBUCKS  " })];
    assert.deepEqual(markLikelyDuplicates(existing, incoming), [true]);
  });
});

describe("addMoney", () => {
  test("classic floating-point drift is rounded away", () => {
    assert.equal(addMoney(0.1, 0.2), 0.3);
  });

  test("a chain of adjustments settles on a clean cent value", () => {
    assert.equal(addMoney(3172.18, -7.82), 3164.36);
  });

  test("handles negative results", () => {
    assert.equal(addMoney(10, -25), -15);
  });
});

describe("sortTransactions", () => {
  const transactions: Transaction[] = [
    tx({ id: "t1", date: "2026-06-01", amount: -50, category: "Groceries" }),
    tx({ id: "t2", date: "2026-06-15", amount: 2000, category: "Income" }),
    tx({ id: "t3", date: "2026-06-02", amount: -20, category: "Shopping" }),
    tx({ id: "t4", date: "2026-06-05", amount: -100, category: "Utilities & Bills" }),
  ];

  test("date desc is newest first (the default)", () => {
    assert.deepEqual(sortTransactions(transactions, "date", "desc").map((t) => t.id), ["t2", "t4", "t3", "t1"]);
  });

  test("date asc is oldest first", () => {
    assert.deepEqual(sortTransactions(transactions, "date", "asc").map((t) => t.id), ["t1", "t3", "t4", "t2"]);
  });

  test("amount desc is largest (most positive) first", () => {
    assert.deepEqual(sortTransactions(transactions, "amount", "desc").map((t) => t.id), ["t2", "t3", "t1", "t4"]);
  });

  test("amount asc is smallest (most negative) first", () => {
    assert.deepEqual(sortTransactions(transactions, "amount", "asc").map((t) => t.id), ["t4", "t1", "t3", "t2"]);
  });

  test("ties break on id so order is stable", () => {
    const tied: Transaction[] = [
      tx({ id: "b", date: "2026-06-01", amount: -10, category: "Shopping" }),
      tx({ id: "a", date: "2026-06-01", amount: -10, category: "Shopping" }),
    ];
    assert.deepEqual(sortTransactions(tied, "date", "desc").map((t) => t.id), ["a", "b"]);
    assert.deepEqual(sortTransactions(tied, "amount", "asc").map((t) => t.id), ["a", "b"]);
  });

  test("does not mutate the input array", () => {
    const copy = [...transactions];
    sortTransactions(transactions, "date", "asc");
    assert.deepEqual(transactions, copy);
  });
});

// ---------------------------------------------------------------------------
// Phase 6: recurring bills.
// ---------------------------------------------------------------------------

function bill(fields: Partial<Bill> & { id: string; category: string }): Bill {
  return {
    id: fields.id,
    name: fields.name ?? fields.id,
    amount: fields.amount ?? 100,
    dueDay: fields.dueDay ?? 15,
    frequency: fields.frequency ?? "monthly",
    startMonth: fields.startMonth ?? "2026-01",
    category: fields.category,
    matchText: fields.matchText,
    autopay: fields.autopay,
    scope: fields.scope,
    payments: fields.payments,
    active: fields.active ?? true,
  };
}

describe("billDueDate", () => {
  test("monthly bill is due every month from startMonth on", () => {
    const b = bill({ id: "b1", category: "Utilities & Bills", dueDay: 15, startMonth: "2026-01" });
    assert.equal(billDueDate(b, "2026-03"), "2026-03-15");
  });

  test("day 31 clamps to a shorter month real length", () => {
    const b = bill({ id: "b1", category: "Utilities & Bills", dueDay: 31, startMonth: "2020-01" });
    assert.equal(billDueDate(b, "2026-02"), "2026-02-28", "2026 is not a leap year");
    assert.equal(billDueDate(b, "2024-02"), "2024-02-29", "2024 is a leap year");
    assert.equal(billDueDate(b, "2026-04"), "2026-04-30");
  });

  test("quarterly bill is only due every third month from startMonth", () => {
    const b = bill({ id: "b1", category: "Insurance", frequency: "quarterly", startMonth: "2026-01", dueDay: 10 });
    assert.equal(billDueDate(b, "2026-01"), "2026-01-10");
    assert.equal(billDueDate(b, "2026-04"), "2026-04-10");
    assert.equal(billDueDate(b, "2026-07"), "2026-07-10");
    assert.equal(billDueDate(b, "2026-02"), null);
    assert.equal(billDueDate(b, "2026-03"), null);
  });

  test("yearly bill is only due the same calendar month each year", () => {
    const b = bill({ id: "b1", category: "Insurance", frequency: "yearly", startMonth: "2026-03", dueDay: 1 });
    assert.equal(billDueDate(b, "2026-03"), "2026-03-01");
    assert.equal(billDueDate(b, "2027-03"), "2027-03-01");
    assert.equal(billDueDate(b, "2026-04"), null);
    assert.equal(billDueDate(b, "2027-02"), null);
  });

  test("never due before startMonth", () => {
    const b = bill({ id: "b1", category: "Utilities & Bills", startMonth: "2026-05" });
    assert.equal(billDueDate(b, "2026-04"), null);
    assert.equal(billDueDate(b, "2025-12"), null);
  });
});

describe("billStatus", () => {
  const category = "Utilities & Bills";

  test("auto-matches a same-category transaction within the due-date window", () => {
    const b = bill({ id: "b1", category, dueDay: 15, matchText: "SPECTRUM" });
    const txs = [tx({ id: "t1", date: "2026-03-18", amount: -79.99, category, merchantName: "SPECTRUM CABLE" })];
    const status = billStatus(b, "2026-03", txs, new Date(2026, 2, 20));
    assert.equal(status.state, "paid");
    assert.equal(status.matchedTransactionId, "t1");
    assert.equal(status.paidAmount, 79.99);
  });

  test("a transaction outside the due-date window is not matched", () => {
    const b = bill({ id: "b1", category, dueDay: 15 });
    const txs = [tx({ id: "t1", date: "2026-03-30", amount: -79.99, category })];
    const status = billStatus(b, "2026-03", txs, new Date(2026, 2, 20));
    assert.notEqual(status.state, "paid");
  });

  test("a manual mark with a linked transaction reports paid", () => {
    const b = bill({
      id: "b1",
      category,
      dueDay: 15,
      payments: { "2026-03": { transactionId: "t1", markedAt: "2026-03-16T00:00:00.000Z" } },
    });
    const txs = [tx({ id: "t1", date: "2026-03-16", amount: -50, category })];
    const status = billStatus(b, "2026-03", txs, new Date(2026, 2, 20));
    assert.equal(status.state, "paid");
    assert.equal(status.matchedTransactionId, "t1");
    assert.equal(status.paidAmount, 50);
  });

  test("an explicit null payment blocks auto-matching even if a matching transaction exists", () => {
    const b = bill({ id: "b1", category, dueDay: 15, payments: { "2026-03": null } });
    const txs = [tx({ id: "t1", date: "2026-03-16", amount: -79.99, category })];
    const status = billStatus(b, "2026-03", txs, new Date(2026, 2, 20));
    assert.notEqual(status.state, "paid");
  });

  test("due_today, due_soon, overdue and upcoming thresholds", () => {
    const b = bill({ id: "b1", category, dueDay: 15 });
    assert.equal(billStatus(b, "2026-03", [], new Date(2026, 2, 15)).state, "due_today");
    assert.equal(billStatus(b, "2026-03", [], new Date(2026, 2, 12)).state, "due_soon");
    assert.equal(billStatus(b, "2026-03", [], new Date(2026, 2, 5)).state, "upcoming");
    assert.equal(billStatus(b, "2026-03", [], new Date(2026, 2, 16)).state, "overdue");
  });

  test("an unpaid bill in a past month is overdue regardless of how far away", () => {
    const b = bill({ id: "b1", category, dueDay: 15 });
    const status = billStatus(b, "2026-01", [], new Date(2026, 5, 1));
    assert.equal(status.state, "overdue");
  });

  test("not due this month reports not_due with a null due date", () => {
    const b = bill({ id: "b1", category, startMonth: "2026-06" });
    const status = billStatus(b, "2026-03", [], new Date(2026, 2, 1));
    assert.deepEqual(status, { state: "not_due", dueDate: null, daysUntil: null });
  });
});

describe("billStatuses", () => {
  test("one transaction is claimed by only one bill, in due-date order", () => {
    const category = "Subscriptions";
    const early = bill({ id: "early", category, dueDay: 5 });
    const late = bill({ id: "late", category, dueDay: 20 });
    const txs = [tx({ id: "t1", date: "2026-03-06", amount: -15.99, category })];

    const statuses = billStatuses([late, early], "2026-03", txs, new Date(2026, 2, 25));
    const byId = new Map(statuses.map((s) => [s.bill.id, s]));

    assert.equal(byId.get("early")!.state, "paid", "the earlier-due bill should claim the one matching charge");
    assert.equal(byId.get("early")!.matchedTransactionId, "t1");
    assert.notEqual(byId.get("late")!.state, "paid", "the later bill must not also claim the same charge");
  });

  test("inactive bills are left out", () => {
    const statuses = billStatuses(
      [bill({ id: "gone", category: "Shopping", active: false })],
      "2026-03",
      [],
      new Date(2026, 2, 1)
    );
    assert.equal(statuses.length, 0);
  });
});

describe("detectRecurring", () => {
  const today = new Date(2026, 8, 24);

  test("suggests a merchant appearing in 3 of the last 4 months", () => {
    const txs = [
      tx({ id: "t1", date: "2026-06-14", amount: -79.99, category: "Utilities & Bills", merchantName: "SPECTRUM" }),
      tx({ id: "t2", date: "2026-07-15", amount: -79.99, category: "Utilities & Bills", merchantName: "SPECTRUM" }),
      tx({ id: "t3", date: "2026-08-15", amount: -80.5, category: "Utilities & Bills", merchantName: "SPECTRUM" }),
    ];
    const suggestions = detectRecurring(txs, today);
    const found = suggestions.find((s) => s.name === "SPECTRUM");
    assert.ok(found, "SPECTRUM should be suggested");
    assert.equal(found!.category, "Utilities & Bills");
    assert.equal(found!.frequency, "monthly");
    assert.equal(found!.dueDay, 15);
  });

  test("a merchant in only 2 of the last 4 months is not suggested", () => {
    const txs = [
      tx({ id: "t1", date: "2026-07-15", amount: -79.99, category: "Utilities & Bills", merchantName: "SPECTRUM" }),
      tx({ id: "t2", date: "2026-08-15", amount: -79.99, category: "Utilities & Bills", merchantName: "SPECTRUM" }),
    ];
    assert.equal(detectRecurring(txs, today).some((s) => s.name === "SPECTRUM"), false);
  });

  test("an amount spread over 15% disqualifies the merchant", () => {
    const txs = [
      tx({ id: "t1", date: "2026-06-14", amount: -50, category: "Shopping", merchantName: "VARIABLE CO" }),
      tx({ id: "t2", date: "2026-07-15", amount: -90, category: "Shopping", merchantName: "VARIABLE CO" }),
      tx({ id: "t3", date: "2026-08-15", amount: -50, category: "Shopping", merchantName: "VARIABLE CO" }),
    ];
    assert.equal(detectRecurring(txs, today).some((s) => s.name === "VARIABLE CO"), false);
  });

  test("trailing store numbers normalize to the same merchant", () => {
    const txs = [
      tx({ id: "t1", date: "2026-06-05", amount: -42, category: "Groceries", merchantName: "KROGER #422" }),
      tx({ id: "t2", date: "2026-07-05", amount: -42, category: "Groceries", merchantName: "KROGER #918" }),
      tx({ id: "t3", date: "2026-08-05", amount: -42, category: "Groceries", merchantName: "KROGER #103" }),
    ];
    const suggestions = detectRecurring(txs, today);
    assert.equal(suggestions.length, 1, "the three differently numbered stores should collapse into one suggestion");
  });

  test("transfers and income are excluded", () => {
    const txs = [
      tx({ id: "t1", date: "2026-06-01", amount: 2000, category: "Income", merchantName: "Employer" }),
      tx({ id: "t2", date: "2026-07-01", amount: 2000, category: "Income", merchantName: "Employer" }),
      tx({ id: "t3", date: "2026-08-01", amount: 2000, category: "Income", merchantName: "Employer" }),
      tx({ id: "t4", date: "2026-06-02", amount: -200, category: "Transfer", merchantName: "Savings Xfer", transferId: "x1" }),
      tx({ id: "t5", date: "2026-07-02", amount: -200, category: "Transfer", merchantName: "Savings Xfer", transferId: "x2" }),
      tx({ id: "t6", date: "2026-08-02", amount: -200, category: "Transfer", merchantName: "Savings Xfer", transferId: "x3" }),
    ];
    assert.equal(detectRecurring(txs, today).length, 0);
  });

  test("opts.categories limits detection to those categories", () => {
    const txs = [
      tx({ id: "t1", date: "2026-06-15", amount: -60, category: "Subscriptions", merchantName: "NETFLIX" }),
      tx({ id: "t2", date: "2026-07-15", amount: -60, category: "Subscriptions", merchantName: "NETFLIX" }),
      tx({ id: "t3", date: "2026-08-15", amount: -60, category: "Subscriptions", merchantName: "NETFLIX" }),
      tx({ id: "t4", date: "2026-06-05", amount: -42, category: "Groceries", merchantName: "KROGER" }),
      tx({ id: "t5", date: "2026-07-05", amount: -42, category: "Groceries", merchantName: "KROGER" }),
      tx({ id: "t6", date: "2026-08-05", amount: -42, category: "Groceries", merchantName: "KROGER" }),
    ];
    const suggestions = detectRecurring(txs, today, { categories: ["Groceries"] });
    assert.deepEqual(suggestions.map((s) => s.name), ["KROGER"]);
  });
});

describe("needsAttention with bills", () => {
  test("overdue/due-soon bills lead the list, worst first, above categories", () => {
    const today = new Date(2026, 2, 20);
    const overdueBill = bill({ id: "b1", category: "Car Insurance", name: "Car insurance", dueDay: 10, amount: 142 });
    const dueSoonBill = bill({ id: "b2", category: "Subscriptions", name: "Internet", dueDay: 25, amount: 80 });
    const displayBudgets: DisplayBudget[] = [
      { category: "Groceries", limit: 100, spent: 150, baseLimit: 100, carriedIn: 0 },
    ];

    const items = needsAttention([], [], [], {
      items: [dueSoonBill, overdueBill],
      month: "2026-03",
      allTransactions: [],
      today,
    });

    assert.equal(items[0].kind, "bill");
    assert.equal((items[0] as any).name, "Car insurance", "the overdue bill should lead");
    assert.equal(items[1].kind, "bill");
    assert.equal((items[1] as any).name, "Internet");

    const withCategories = needsAttention(displayBudgets, [], [], {
      items: [overdueBill],
      month: "2026-03",
      allTransactions: [],
      today,
    });
    assert.equal(withCategories[0].kind, "bill", "bills sit above category items");
    assert.equal(withCategories[1].kind, "category");
  });

  test("a paid bill does not appear", () => {
    const today = new Date(2026, 2, 20);
    const paidBill = bill({
      id: "b1",
      category: "Utilities & Bills",
      dueDay: 10,
      payments: { "2026-03": { markedAt: "2026-03-10T00:00:00.000Z" } },
    });
    const items = needsAttention([], [], [], { items: [paidBill], month: "2026-03", allTransactions: [], today });
    assert.equal(items.some((i) => i.kind === "bill"), false);
  });
});
