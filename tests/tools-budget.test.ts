// assistant/tools/budget.ts -- the only module with sensitivity "financial".
//
// Money math fails quietly. A sign handled the wrong way, a savings account
// counted as spendable, a divide-by-zero becoming NaN: none of these throw,
// and each one produces a number that looks perfectly reasonable in a sentence
// like "you have $2,400 available." The system prompt tells the model to report
// tool output as fact, so whatever these functions return is what the household
// is told.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { serverToday, serverMonth } from "../nutrition/dates.ts";

const { createUser, putScopedItem, putScopedItemAs, setConfig, getScopedItems } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

let userId: string;

function call(name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(userId).find((t) => t.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.run(args);
}

// Local month, matching the tools: a UTC month would be next month for a few evening hours on the last day.
const THIS_MONTH = serverMonth();

function tx(id: string, date: string, merchantName: string, amount: number, category: string) {
  putScopedItemAs("transactions", userId, id, {
    id,
    date,
    description: merchantName,
    merchantName,
    amount,
    category,
    bankName: "Test Bank",
    status: "cleared",
    scope: "joint",
  });
}

before(() => {
  userId = createUser("alice-budget", "not-a-real-hash", "Alice");

  setConfig("budget.incomeCategories", ["Income"]);
  setConfig("budget.billCategories", ["Utilities & Bills", "Car Insurance"]);

  putScopedItemAs("budgets", userId, "Groceries", { category: "Groceries", limit: 600, spent: 0, scope: "joint" });
  putScopedItemAs("budgets", userId, "Income", { category: "Income", limit: 3200, spent: 0, scope: "joint" });
  putScopedItemAs("budgets", userId, "Utilities & Bills", { category: "Utilities & Bills", limit: 200, spent: 0, scope: "joint" });

  // Groceries: two spends this month, one last month, plus a refund.
  tx("tx-1", `${THIS_MONTH}-05`, "Costco", -214.86, "Groceries");
  tx("tx-2", `${THIS_MONTH}-12`, "Aldi", -50.14, "Groceries");
  tx("tx-3", "2020-01-15", "Ancient Grocer", -999, "Groceries");
  tx("tx-4", `${THIS_MONTH}-14`, "Costco Refund", 30, "Groceries");

  // Income arrives as a positive amount.
  tx("tx-5", `${THIS_MONTH}-01`, "Employer Payroll", 3200, "Income");
  tx("tx-6", `${THIS_MONTH}-02`, "Bank Fee", -12, "Income");

  tx("tx-7", `${THIS_MONTH}-03`, "Electric Co", -95.5, "Utilities & Bills");

  for (const [id, type, balance] of [
    ["bank-checking", "checking", 2400.5],
    ["bank-savings", "savings", 10000],
    ["bank-loan", "loan", -15000],
  ] as const) {
    putScopedItem("bank_connections", userId, {
      id,
      scope: "joint",
      bankName: `${type} account`,
      accountType: type,
      balance,
    });
  }

  putScopedItem("credit_cards", userId, {
    id: "card-active",
    scope: "joint",
    cardName: "Everyday Visa",
    issuer: "Chase",
    balance: 450,
    creditLimit: 3000,
    apr: 21.99,
    dueDate: "2026-10-01",
    minPayment: 35,
    status: "active",
  });
  putScopedItem("credit_cards", userId, {
    id: "card-closed",
    scope: "joint",
    cardName: "Old Store Card",
    balance: 0,
    creditLimit: 0,
    status: "closed",
  });

  putScopedItem("goals", userId, {
    id: "goal-linked",
    scope: "joint",
    name: "Emergency Fund",
    targetAmount: 20000,
    linkedBankConnectionId: "bank-savings",
    targetDate: "2027-01-01",
  });
  putScopedItem("goals", userId, {
    id: "goal-manual",
    scope: "joint",
    name: "New Couch",
    targetAmount: 1200,
    manualAmount: 300,
  });
  putScopedItem("goals", userId, {
    id: "goal-zero",
    scope: "joint",
    name: "Unset Target",
    targetAmount: 0,
    manualAmount: 50,
  });
});

after(cleanupDb);

describe("get_budget_summary", () => {
  test("an expense category counts only money going out", async () => {
    // The $30 refund is a positive amount in an expense category. Counting its
    // magnitude as spending would overstate the month by $60.
    const groceries = (await call("get_budget_summary", { month: THIS_MONTH })).find(
      (b: any) => b.category === "Groceries"
    );

    assert.equal(groceries.type, "expense");
    assert.equal(groceries.spent, 265, "214.86 + 50.14, with the refund excluded");
    assert.equal(groceries.remaining, 335);
  });

  test("an income category counts only money coming in", async () => {
    // The -$12 bank fee sits in the Income category; treating it as income
    // would report $3,212 earned.
    const income = (await call("get_budget_summary", { month: THIS_MONTH })).find(
      (b: any) => b.category === "Income"
    );

    assert.equal(income.type, "income");
    assert.equal(income.spent, 3200);
  });

  test("omitting the month means the current month, not all time", async () => {
    // Was "covers all time" (1264 with the 2020 transaction), which set a MONTHLY limit against years of spending and made
    // `remaining` meaningless. Now it is exactly the explicit current-month answer.
    const groceries = (await call("get_budget_summary")).find((b: any) => b.category === "Groceries");
    assert.equal(groceries.spent, 265, "this month only: the 2020 transaction is out");
    assert.equal(groceries.remaining, 335);
    assert.deepEqual(await call("get_budget_summary"), await call("get_budget_summary", { month: THIS_MONTH }));
  });

  test("a month with no activity reports zero rather than nothing", async () => {
    const groceries = (await call("get_budget_summary", { month: "1999-01" })).find(
      (b: any) => b.category === "Groceries"
    );

    assert.equal(groceries.spent, 0);
    assert.equal(groceries.remaining, 600);
  });

  test("rounds to cents rather than leaking float dust", async () => {
    for (const row of await call("get_budget_summary", { month: THIS_MONTH })) {
      assert.equal(row.spent, Math.round(row.spent * 100) / 100);
    }
  });
});

describe("get_budget_summary: spending with no budget entry", () => {
  test("is reported as an unbudgeted $0-limit row instead of being dropped", async () => {
    tx("tx-unbudgeted", `${THIS_MONTH}-20`, "Children's Hospital", -18.5, "Unbudgeted Test Category");

    for (const args of [{ month: THIS_MONTH }, {}]) {
      const row = (await call("get_budget_summary", args)).find((b: any) => b.category === "Unbudgeted Test Category");
      assert.ok(row, `missing for ${JSON.stringify(args)}`);
      assert.equal(row.unbudgeted, true);
      assert.equal(row.limit, 0);
      assert.equal(row.spent, 18.5);
      assert.equal(row.remaining, -18.5);
    }
  });
});

describe("get_recent_transactions", () => {
  test("returns newest first", async () => {
    const dates = (await call("get_recent_transactions", { category: "Groceries" })).map((t: any) => t.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  test("filters by category", async () => {
    const rows = await call("get_recent_transactions", { category: "Groceries" });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r: any) => r.category === "Groceries"));
  });

  test("filters by month", async () => {
    const rows = await call("get_recent_transactions", { category: "Groceries", month: "2020-01" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].merchant, "Ancient Grocer");
  });

  test("an explicit from/to range overrides the month", async () => {
    // "between the 1st and the 15th" is finer than a month, and the two filters
    // must not both apply or the range would be silently intersected.
    const rows = await call("get_recent_transactions", {
      category: "Groceries",
      month: "2020-01",
      from: `${THIS_MONTH}-01`,
      to: `${THIS_MONTH}-10`,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].merchant, "Costco");
  });

  test("an open-ended range works from either side", async () => {
    const since = await call("get_recent_transactions", { category: "Groceries", from: `${THIS_MONTH}-10` });
    assert.deepEqual(since.map((r: any) => r.merchant).sort(), ["Aldi", "Costco Refund"]);

    const until = await call("get_recent_transactions", { category: "Groceries", to: "2020-12-31" });
    assert.deepEqual(until.map((r: any) => r.merchant), ["Ancient Grocer"]);
  });

  test("defaults to 20 and caps at 100, however many are asked for", async () => {
    // The cap is what stops one question from replaying the entire ledger into
    // a model's context.
    for (let i = 0; i < 130; i++) {
      tx(`bulk-${i}`, `2019-01-${String((i % 28) + 1).padStart(2, "0")}`, `Merchant ${i}`, -5, "Bulk");
    }

    assert.equal((await call("get_recent_transactions", { category: "Bulk" })).length, 20);
    assert.equal((await call("get_recent_transactions", { category: "Bulk", limit: 5 })).length, 5);
    assert.equal((await call("get_recent_transactions", { category: "Bulk", limit: 500 })).length, 100);
  });

  test("a nonsense limit falls back to the default rather than returning nothing", async () => {
    assert.equal((await call("get_recent_transactions", { category: "Bulk", limit: "lots" })).length, 20);
    assert.equal((await call("get_recent_transactions", { category: "Bulk", limit: 0 })).length, 20);
  });

  test("an unknown category is an empty list, not an error", async () => {
    assert.deepEqual(await call("get_recent_transactions", { category: "Nonexistent" }), []);
  });
});

describe("get_accounts", () => {
  test("savings and loans are excluded from spendable cash", async () => {
    // Counting the $10,000 emergency fund as available cash is how the
    // assistant tells someone they can afford something they cannot.
    const accounts = await call("get_accounts");
    assert.equal(accounts.availableCash, 2400.5, "checking only");
  });

  test("reports credit cards alongside", async () => {
    const accounts = await call("get_accounts");
    const visa = accounts.creditCards.find((c: any) => c.name === "Everyday Visa");
    assert.equal(visa.balance, 450);
    assert.equal(visa.creditLimit, 3000);
  });

  test("bug 10.19: a connection with no numeric balance doesn't poison the total with NaN", async () => {
    // Summing blindly turns the whole total NaN the moment one connection's
    // balance is missing/non-numeric -- and NaN JSON-serializes to null, which
    // reads to the model as "no cash available" rather than "one account's
    // balance is unknown".
    putScopedItem("bank_connections", userId, {
      id: "bank-broken",
      scope: "joint",
      bankName: "Mystery Bank",
      accountType: "checking",
      // balance intentionally omitted
    });

    const accounts = await call("get_accounts");
    assert.equal(Number.isFinite(accounts.availableCash), true);
    assert.equal(accounts.availableCash, 2400.5, "the broken account is skipped, not counted as 0 or NaN");
    assert.ok(accounts.accountsMissingBalance.includes("Mystery Bank"));
  });
});

describe("get_credit_cards", () => {
  test("lists only active cards", async () => {
    const names = (await call("get_credit_cards")).map((c: any) => c.name);
    assert.deepEqual(names, ["Everyday Visa"]);
  });

  test("computes utilization as a percentage", async () => {
    const [card] = await call("get_credit_cards");
    assert.equal(card.utilizationPercent, 15, "450 of 3000");
  });

  test("a zero credit limit reports null, not NaN or Infinity", async () => {
    // A card with no limit on file would otherwise divide by zero, and the
    // model would faithfully report "your utilization is NaN percent".
    putScopedItem("credit_cards", userId, {
      id: "card-nolimit",
      scope: "joint",
      cardName: "No Limit Card",
      balance: 100,
      creditLimit: 0,
      status: "active",
    });

    const card = (await call("get_credit_cards")).find((c: any) => c.name === "No Limit Card");
    assert.equal(card.utilizationPercent, null);
  });
});

describe("get_savings_goals", () => {
  test("a linked goal reads its balance from the account", async () => {
    const goal = (await call("get_savings_goals")).find((g: any) => g.name === "Emergency Fund");
    assert.equal(goal.currentAmount, 10000);
    assert.equal(goal.percent, 50);
  });

  test("an unlinked goal uses its manual amount", async () => {
    const goal = (await call("get_savings_goals")).find((g: any) => g.name === "New Couch");
    assert.equal(goal.currentAmount, 300);
    assert.equal(goal.percent, 25);
  });

  test("a zero target reports null rather than dividing by zero", async () => {
    const goal = (await call("get_savings_goals")).find((g: any) => g.name === "Unset Target");
    assert.equal(goal.percent, null);
  });

  test("a goal linked to an account that no longer exists reads as zero", async () => {
    putScopedItem("goals", userId, {
      id: "goal-orphan",
      scope: "joint",
      name: "Orphaned Goal",
      targetAmount: 500,
      linkedBankConnectionId: "bank-deleted",
    });

    const goal = (await call("get_savings_goals")).find((g: any) => g.name === "Orphaned Goal");
    assert.equal(goal.currentAmount, 0, "a missing account must not become undefined or NaN");
    assert.equal(goal.percent, 0);
  });
});

describe("get_upcoming_bills", () => {
  test("reports each bill category and whether it has been paid this month", async () => {
    const bills = await call("get_upcoming_bills");

    const electric = bills.find((b: any) => b.category === "Utilities & Bills");
    assert.equal(electric.paidThisMonth, 95.5);
    assert.equal(electric.paidThisMonthAlready, true);
    assert.equal(electric.limit, 200);

    const insurance = bills.find((b: any) => b.category === "Car Insurance");
    assert.equal(insurance.paidThisMonthAlready, false);
    assert.equal(insurance.limit, null, "a bill category with no budget row reports null, not undefined");
  });

  test("says so plainly when no bill categories are configured", async () => {
    setConfig("budget.billCategories", []);
    assert.match((await call("get_upcoming_bills")).error, /No bill categories configured/);
    setConfig("budget.billCategories", ["Utilities & Bills", "Car Insurance"]);
  });

  test("prefers real bills over the category tracker once the household has any active ones", async () => {
    const today = new Date();
    const currentMonth = serverMonth(today);
    putScopedItemAs("bills", userId, "bill-electric", {
      id: "bill-electric",
      name: "Electric Co",
      amount: 95.5,
      dueDay: 3,
      frequency: "monthly",
      startMonth: "2026-01",
      category: "Utilities & Bills",
      active: true,
      autopay: true,
    });

    const bills = await call("get_upcoming_bills");
    assert.equal(Array.isArray(bills), true);
    const electric = bills.find((b: any) => b.name === "Electric Co");
    assert.ok(electric, "real bills should be returned instead of the category tracker");
    assert.equal(electric.amount, 95.5);
    assert.equal(electric.autopay, true);
    assert.equal(electric.dueDate, `${currentMonth}-03`);
    // tx-7 (Electric Co, -95.5, day 03 of this month) already matches this bill.
    assert.equal(electric.paid, true);
    assert.equal(electric.paidAmount, 95.5);

    putScopedItem("bills", userId, { id: "bill-electric", active: false } as any);
  });

  test("an inactive-only bill list still falls back to the category tracker", async () => {
    putScopedItemAs("bills", userId, "bill-inactive", {
      id: "bill-inactive",
      name: "Retired bill",
      amount: 10,
      dueDay: 1,
      frequency: "monthly",
      startMonth: "2026-01",
      category: "Shopping",
      active: false,
    });

    const bills = await call("get_upcoming_bills");
    assert.equal(bills.some((b: any) => b.category === "Utilities & Bills"), true, "should be the category tracker shape");
  });
});

describe("add_transaction", () => {
  test("adds a transaction dated today, defaulting to joint", async () => {
    const result = await call("add_transaction", {
      description: "  Coffee at Starbucks  ",
      amount: -4.75,
      category: "Eating Out",
    });

    assert.equal(result.added, "Coffee at Starbucks", "the description is trimmed");
    assert.equal(result.scope, "joint");

    const stored = (getScopedItems("transactions", userId) as any[]).find((t) => t.merchantName === "Coffee at Starbucks");
    assert.equal(stored.date, serverToday());
    assert.equal(stored.bankName, "Manual Entry");
    assert.equal(stored.status, "cleared");
  });

  test("honours an explicit personal scope", async () => {
    const result = await call("add_transaction", {
      description: "Private purchase",
      amount: -20,
      category: "Shopping",
      scope: "personal",
    });
    assert.equal(result.scope, "personal");
  });

  test("an unrecognized scope defaults to joint rather than hiding the row", async () => {
    const result = await call("add_transaction", {
      description: "Scope typo",
      amount: -1,
      category: "Shopping",
      scope: "shared",
    });
    assert.equal(result.scope, "joint");
  });

  test("refuses a non-numeric amount instead of storing NaN", async () => {
    // NaN in the ledger would poison every sum that touches it, silently.
    for (const amount of ["twenty dollars", undefined, NaN, Infinity, -Infinity]) {
      const result = await call("add_transaction", { description: "Bad", amount, category: "Shopping" });
      assert.ok(result.error, `amount ${String(amount)} should be refused`);
    }

    assert.equal(
      (getScopedItems("transactions", userId) as any[]).some((t) => t.merchantName === "Bad"),
      false
    );
  });

  test("refuses an empty amount rather than silently logging $0.00", async () => {
    // `amount` is a REQUIRED parameter, but the guard is
    // `Number.isFinite(Number(amount))`, and Number(null), Number("") and
    // Number([]) are all 0 -- so an omitted or blank amount passes validation
    // and books a $0.00 transaction while reporting success to the model. Only
    // `undefined` happens to fail. A model that drops the field gets a silent
    // junk row in the ledger instead of an error it could recover from.
    for (const amount of [null, "", []]) {
      const result = await call("add_transaction", {
        description: "Empty amount",
        amount,
        category: "Shopping",
      });
      assert.ok(result.error, `amount ${JSON.stringify(amount)} should be refused, not coerced to 0`);
    }

    assert.equal(
      (getScopedItems("transactions", userId) as any[]).some((t) => t.merchantName === "Empty amount"),
      false,
      "no $0.00 rows should have been written"
    );
  });

  test("accepts a numeric string, since models often send one", async () => {
    const result = await call("add_transaction", { description: "Stringy", amount: "-12.50", category: "Shopping" });
    assert.equal(result.amount, -12.5);
  });

  test("an empty category becomes Uncategorized rather than blank", async () => {
    const result = await call("add_transaction", { description: "No category", amount: -3, category: "   " });
    assert.equal(result.category, "Uncategorized");
  });

  test("a new category is registered so the UI can show it", async () => {
    await call("add_transaction", { description: "Novel", amount: -8, category: "Hot Air Ballooning" });
    const { getConfig } = await loadDb();
    assert.ok(
      (getConfig("budget.categories", []) as string[]).includes("Hot Air Ballooning"),
      "otherwise the transaction lands in a category the ledger does not list"
    );
  });
});

describe("set_budget_limit", () => {
  test("sets a limit on an existing category, preserving its spent figure", async () => {
    const result = await call("set_budget_limit", { category: "Groceries", limit: 750 });

    assert.deepEqual(result, { category: "Groceries", limit: 750 });
    const summary = (await call("get_budget_summary", { month: THIS_MONTH })).find(
      (b: any) => b.category === "Groceries"
    );
    assert.equal(summary.limit, 750);
    assert.equal(summary.spent, 265, "changing a limit must not disturb the spending total");
  });

  test("creates a category that did not exist", async () => {
    const result = await call("set_budget_limit", { category: "Pet Supplies", limit: 40 });
    assert.equal(result.limit, 40);

    const summary = (await call("get_budget_summary")).find((b: any) => b.category === "Pet Supplies");
    assert.equal(summary.limit, 40);
  });

  test("refuses a negative or non-numeric limit", async () => {
    for (const limit of [-1, "lots", undefined, NaN]) {
      const result = await call("set_budget_limit", { category: "Groceries", limit });
      assert.ok(result.error, `limit ${String(limit)} should be refused`);
    }

    const summary = (await call("get_budget_summary")).find((b: any) => b.category === "Groceries");
    assert.equal(summary.limit, 750, "the existing limit must be untouched");
  });

  test("refuses an empty limit rather than silently resetting it to 0", async () => {
    // Same coercion trap as add_transaction's amount: `limit` is REQUIRED, but
    // Number(null), Number("") and Number([]) are all 0, which is finite and
    // non-negative -- so an omitted or blank limit would silently reset an
    // existing budget to 0, making every purchase in that category read as
    // over budget instead of surfacing an error the model can recover from.
    for (const limit of [null, "", []]) {
      const result = await call("set_budget_limit", { category: "Groceries", limit });
      assert.ok(result.error, `limit ${JSON.stringify(limit)} should be refused, not coerced to 0`);
    }

    const summary = (await call("get_budget_summary")).find((b: any) => b.category === "Groceries");
    assert.equal(summary.limit, 750, "the existing limit must be untouched");
  });

  test("refuses an empty category name", async () => {
    assert.ok((await call("set_budget_limit", { category: "   ", limit: 100 })).error);
  });

  test("a zero limit is allowed -- it means 'do not spend here'", async () => {
    assert.equal((await call("set_budget_limit", { category: "Eating Out", limit: 0 })).limit, 0);
  });
});

describe("get_budget_summary: monthly overrides and rollover (Phase 5)", () => {
  test("a monthlyLimits override for the requested month becomes baseLimit and limit", async () => {
    putScopedItemAs("budgets", userId, "Override Category", {
      category: "Override Category",
      limit: 100,
      spent: 0,
      monthlyLimits: { "2026-05": 250 },
    });

    const may = (await call("get_budget_summary", { month: "2026-05" })).find((b: any) => b.category === "Override Category");
    assert.equal(may.baseLimit, 250);
    assert.equal(may.carriedIn, 0);
    assert.equal(may.limit, 250);

    const june = (await call("get_budget_summary", { month: "2026-06" })).find((b: any) => b.category === "Override Category");
    assert.equal(june.baseLimit, 100, "a month with no override of its own falls back to the default limit");
  });

  test("rollover folds a positive leftover from the prior month into `limit`", async () => {
    putScopedItemAs("budgets", userId, "Rollover Category", {
      category: "Rollover Category",
      limit: 200,
      spent: 0,
      rollover: true,
      rolloverSince: "2026-01",
    });
    tx("tx-roll-1", "2026-01-10", "Store", -50, "Rollover Category"); // $150 left over in January

    const summary = (await call("get_budget_summary", { month: "2026-02" })).find((b: any) => b.category === "Rollover Category");
    assert.equal(summary.baseLimit, 200);
    assert.equal(summary.carriedIn, 150);
    assert.equal(summary.limit, 350);
  });

  test("rollover carries a negative amount when the prior month overspent", async () => {
    putScopedItemAs("budgets", userId, "Overspent Rollover", {
      category: "Overspent Rollover",
      limit: 100,
      spent: 0,
      rollover: true,
      rolloverSince: "2026-01",
    });
    tx("tx-roll-2", "2026-01-10", "Store", -300, "Overspent Rollover"); // $200 over budget in January

    const summary = (await call("get_budget_summary", { month: "2026-02" })).find((b: any) => b.category === "Overspent Rollover");
    assert.equal(summary.carriedIn, -200);
    assert.equal(summary.limit, -100, "an overspent rollover category can show a negative available limit");
  });

  test("an income category never rolls over even with the flag set", async () => {
    putScopedItemAs("budgets", userId, "Income", {
      category: "Income",
      limit: 3200,
      spent: 0,
      scope: "joint",
      rollover: true,
      rolloverSince: "2026-01",
    });

    const summary = (await call("get_budget_summary", { month: "2026-02" })).find((b: any) => b.category === "Income");
    assert.equal(summary.carriedIn, 0);
    assert.equal(summary.limit, 3200);
  });

  test("omitting month applies overrides and rollover for the current month, the same as passing it", async () => {
    // Used to return the plain default limit against all-time spend (no baseLimit / carriedIn keys at all).
    const summary = (await call("get_budget_summary")).find((b: any) => b.category === "Rollover Category");
    assert.deepEqual(Object.keys(summary).sort(), ["baseLimit", "carriedIn", "category", "limit", "remaining", "spent", "type"]);
    const explicit = (await call("get_budget_summary", { month: THIS_MONTH })).find((b: any) => b.category === "Rollover Category");
    assert.deepEqual(summary, explicit);
  });
});

describe("get_budget_summary with no month", () => {
  test("uses this month's override and only this month's spending, not the default limit against all-time spend", async () => {
    putScopedItemAs("budgets", userId, "Probe Dining", {
      category: "Probe Dining",
      limit: 150,
      monthlyLimits: { [THIS_MONTH]: 200 },
      spent: 0,
      scope: "joint",
    });
    tx("tx-eo-now", `${THIS_MONTH}-03`, "Diner", -15.75, "Probe Dining");
    tx("tx-eo-old", "2025-01-03", "Old Diner", -80, "Probe Dining");

    const row = (await call("get_budget_summary")).find((b: any) => b.category === "Probe Dining");
    assert.equal(row.baseLimit, 200, "the current month's override, not the 150 default");
    assert.equal(row.spent, 15.75, "the old transaction is not counted");
    assert.equal(row.remaining, 184.25);
  });

  test("the description no longer promises all-time totals", () => {
    const tool = buildTools(userId).find((t) => t.name === "get_budget_summary")!;
    assert.doesNotMatch(tool.description, /all-time/);
    assert.match(tool.description, /Omit month for the current month/);
  });
});

describe("set_budget_limit with month (Phase 5)", () => {
  test("writes only that month's override, leaving the standing default untouched", async () => {
    const before = (await call("get_budget_summary")).find((b: any) => b.category === "Groceries");
    const result = await call("set_budget_limit", { category: "Groceries", limit: 900, month: "2026-07" });
    assert.deepEqual(result, { category: "Groceries", limit: 900, month: "2026-07" });

    const july = (await call("get_budget_summary", { month: "2026-07" })).find((b: any) => b.category === "Groceries");
    assert.equal(july.baseLimit, 900);

    const noMonth = (await call("get_budget_summary")).find((b: any) => b.category === "Groceries");
    assert.equal(noMonth.limit, before.limit, "the standing default limit is untouched by a month-scoped write");
  });

  test("rejects a malformed month instead of silently matching nothing", async () => {
    for (const month of ["2026-13", "26-08", "August 2026", "2026/08", "2026-00"]) {
      const result = await call("set_budget_limit", { category: "Groceries", limit: 500, month });
      assert.ok(result.error, `month "${month}" should be rejected`);
    }
  });

  test("a valid month on a brand new category creates it with just that override", async () => {
    const result = await call("set_budget_limit", { category: "Fresh Category", limit: 60, month: "2026-08" });
    assert.deepEqual(result, { category: "Fresh Category", limit: 60, month: "2026-08" });

    const august = (await call("get_budget_summary", { month: "2026-08" })).find((b: any) => b.category === "Fresh Category");
    assert.equal(august.baseLimit, 60);
    const otherMonth = (await call("get_budget_summary", { month: "2026-09" })).find((b: any) => b.category === "Fresh Category");
    assert.equal(otherMonth.baseLimit, 0, "no default limit was ever set, only the August override");
  });
});

describe("set_budget_limit colliding with another member's personal category", () => {
  // budgets is keyed by category name, not a generated id -- see
  // the project notes 10.11/section 14. Before this fix, both writes below
  // reported success while silently writing nothing.
  test("refuses a standing-limit write rather than silently doing nothing", async () => {
    const bob = createUser("bob-budget-standing-collision", "not-a-real-hash", "Bob");
    putScopedItemAs("budgets", bob, "Side Hustle", { category: "Side Hustle", limit: 40, spent: 0, scope: "personal" });

    const result = await call("set_budget_limit", { category: "Side Hustle", limit: 60 });

    assert.ok(result.error, "must not silently report success");
    assert.match(result.error, /Side Hustle/);
    assert.equal(
      (await call("get_budget_summary")).find((b: any) => b.category === "Side Hustle" && b.limit === 60),
      undefined,
      "Alice's write must not have landed"
    );
  });

  test("refuses a month-override write rather than silently doing nothing", async () => {
    const bob = createUser("bob-budget-month-collision", "not-a-real-hash", "Bob");
    putScopedItemAs("budgets", bob, "Side Project", { category: "Side Project", limit: 40, spent: 0, scope: "personal" });

    const result = await call("set_budget_limit", { category: "Side Project", limit: 60, month: "2026-08" });

    assert.ok(result.error, "must not silently report success");
    assert.match(result.error, /Side Project/);
  });
});
