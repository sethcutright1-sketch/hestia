// tests/budgetCsv.test.ts -- the Transactions tab's CSV export, pulled out of
// Budget.tsx into src/sections/budget/csv.ts so its escaping rules (quote
// doubling, the Excel/Sheets formula-injection guard) have direct tests
// instead of only being exercised through the UI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildTransactionsCsv } from "../src/sections/budget/csv.ts";
import type { Transaction } from "../src/sections/budget/types.ts";

function tx(fields: Partial<Transaction> & { id: string }): Transaction {
  return {
    id: fields.id,
    date: fields.date ?? "2026-06-01",
    description: fields.description ?? "Test",
    merchantName: fields.merchantName ?? "Test Merchant",
    amount: fields.amount ?? -10,
    category: fields.category ?? "Groceries",
    bankName: fields.bankName ?? "Test Bank",
    status: fields.status ?? "cleared",
    scope: fields.scope,
  };
}

describe("buildTransactionsCsv", () => {
  test("writes a header row followed by one row per transaction", () => {
    const csv = buildTransactionsCsv([
      tx({ id: "t1", date: "2026-06-01", description: "Groceries run", merchantName: "Whole Foods", amount: -42.5, category: "Groceries", scope: "personal", bankName: "Chase" }),
    ]);
    const lines = csv.split("\n");
    assert.equal(lines[0], "Date,Description,Merchant,Amount,Category,Scope,Bank");
    assert.equal(lines[1], '"2026-06-01","Groceries run","Whole Foods",-42.5,"Groceries","personal","Chase"');
  });

  test("doubles embedded quotes so they don't terminate the cell early", () => {
    const csv = buildTransactionsCsv([
      tx({ id: "t1", merchantName: 'Bob"s Diner' }),
    ]);
    assert.match(csv, /"Bob""s Diner"/);
  });

  test("guards a leading =, +, -, or @ against being read as a spreadsheet formula", () => {
    const csv = buildTransactionsCsv([
      tx({ id: "t1", description: "=SUM(A1:A10)" }),
      tx({ id: "t2", description: "+1 (555) 123-4567" }),
      tx({ id: "t3", description: "-100 refund" }),
      tx({ id: "t4", description: "@mention" }),
    ]);
    const lines = csv.split("\n").slice(1);
    assert.match(lines[0], /"'=SUM\(A1:A10\)"/);
    assert.match(lines[1], /"'\+1 \(555\) 123-4567"/);
    assert.match(lines[2], /"'-100 refund"/);
    assert.match(lines[3], /"'@mention"/);
  });

  test("a missing scope defaults to personal", () => {
    const csv = buildTransactionsCsv([tx({ id: "t1", scope: undefined })]);
    assert.match(csv, /"personal"/);
  });

  test("the amount column is a plain unquoted number", () => {
    const csv = buildTransactionsCsv([tx({ id: "t1", amount: -42.5 })]);
    const cells = csv.split("\n")[1].split(",");
    assert.equal(cells[3], "-42.5");
  });

  test("an empty transaction list is just the header", () => {
    assert.equal(buildTransactionsCsv([]), "Date,Description,Merchant,Amount,Category,Scope,Bank\n");
  });
});
