// get_budget_summary on a household with transactions but no budget categories.
// Its own file (so its own database) because "joint" budget rows are
// household-wide -- tools-budget.test.ts's categories would be visible here.
//
// A bare [] made the local model answer "I'm unable to retrieve the budget
// summary" on a live database with 690 transactions and no categories.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { serverMonth } from "../nutrition/dates.ts";

const { createUser, putScopedItemAs, setConfig } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

const THIS_MONTH = serverMonth();
let userId: string;

function tx(id: string, date: string, merchantName: string, amount: number, category: string) {
  putScopedItemAs("transactions", userId, id, {
    id, date, description: merchantName, merchantName, amount, category,
    bankName: "Test Bank", status: "cleared", scope: "joint",
  });
}

before(() => {
  userId = createUser("nobudget-user", "not-a-real-hash", "No Budget");
  setConfig("budget.incomeCategories", ["Income"]);
  tx("nb-1", `${THIS_MONTH}-03`, "Costco", -100.25, "Groceries");
  tx("nb-2", `${THIS_MONTH}-09`, "Aldi", -20.5, "Groceries");
  tx("nb-3", `${THIS_MONTH}-04`, "Shell", -45, "Gas");
  tx("nb-4", `${THIS_MONTH}-10`, "Costco Refund", 10, "Groceries"); // refund: not spending
  tx("nb-5", `${THIS_MONTH}-01`, "Employer Payroll", 3200, "Income"); // income: not spending
  tx("nb-6", "2020-01-15", "Old Shop", -999, "Gas"); // other month
});

after(cleanupDb);

function summary(args: Record<string, any>): Promise<any> {
  const tool = buildTools(userId).find((t) => t.name === "get_budget_summary");
  assert.ok(tool);
  return tool.run(args);
}

test("says it isn't an error and totals the month's spending per category", async () => {
  const result = await summary({ month: THIS_MONTH });
  assert.deepEqual(result.categories, []);
  assert.match(result.note, /not an error/);
  assert.equal(result.month, THIS_MONTH);
  assert.deepEqual(result.spendingByCategory, [
    { category: "Groceries", spent: 120.75 },
    { category: "Gas", spent: 45 },
  ]);
});

test("no month (or a malformed one) falls back to the current month", async () => {
  for (const args of [{}, { month: "Sept" }]) {
    const result = await summary(args);
    assert.equal(result.month, THIS_MONTH);
    assert.equal(result.spendingByCategory.length, 2);
  }
});
