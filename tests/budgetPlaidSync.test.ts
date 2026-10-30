// routes/budget-plaid.ts's POST /fetch_transactions -- specifically how a synced
// transaction gets its category. Runs against a local mock of Plaid's two
// endpoints (PLAID_API_BASE is the route's own test seam), so nothing here
// touches the real Plaid.
//
// Regression: a saved merchant rule ("Children's Hospital" -> Eating Out) used
// to be offered only as a dismissable banner suggestion, so new charges kept
// landing as Plaid's own "medical" -> Medical & Health.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, upsertMerchantRule, putScopedItem, putBankConnectionWithToken } = await loadDb();
const { budgetPlaidRoutes, resolveAccessToken } = await import("../routes/budget-plaid.ts");

let userId: string;
const plaidBodies: any[] = [];
let server: http.Server;

function plaidTx(id: string, name: string, primary: string, detailed: string) {
  return {
    transaction_id: id,
    account_id: "acct-1",
    date: "2026-10-01",
    name,
    merchant_name: name,
    amount: 6.5,
    pending: false,
    personal_finance_category: { primary, detailed },
  };
}

before(async () => {
  userId = createUser("sync-user", "not-a-real-hash", "Sync User");
  upsertMerchantRule(userId, "Children's Hospital", "Eating Out");
  const otherUserId = createUser("sync-other", "not-a-real-hash", "Other");
  putBankConnectionWithToken(userId, { id: "bank-mine", scope: "personal", plaidAccountId: "acct-1" }, "access-sandbox-test-token");
  putBankConnectionWithToken(otherUserId, { id: "bank-theirs", scope: "personal" }, "access-sandbox-OTHERS-token");
  putScopedItem("bank_connections", userId, { id: "bank-no-token", scope: "personal" });

  server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { plaidBodies.push(JSON.parse(raw)); } catch { /* not JSON */ }
    });
    if (req.url === "/accounts/balance/get") {
      res.end(JSON.stringify({ item: { institution_name: "Test Bank" }, accounts: [{ account_id: "acct-1", name: "Checking", balances: { current: 100 } }] }));
    } else if (req.url === "/transactions/sync") {
      res.end(
        JSON.stringify({
          added: [
            plaidTx("tx-hospital", "Children's Hospital", "MEDICAL", "MEDICAL_OTHER_MEDICAL"),
            plaidTx("tx-pharmacy", "CVS Pharmacy", "MEDICAL", "MEDICAL_PHARMACIES_AND_SUPPLEMENTS"),
          ],
          modified: [plaidTx("tx-hospital-2", "Children's Hospital", "MEDICAL", "MEDICAL_OTHER_MEDICAL")],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
        })
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.PLAID_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PLAID_CLIENT_ID = "test-client";
  process.env.PLAID_SECRET = "test-secret";
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.PLAID_API_BASE;
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
  cleanupDb();
});

describe("POST /budget/plaid/fetch_transactions -- remembered merchant rules", () => {
  test("a remembered rule overrides Plaid's own category on new and modified transactions", async () => {
    const result = await callRoute(budgetPlaidRoutes, "POST", "/fetch_transactions", {
      session: { userId },
      body: { bankConnectionId: "bank-mine" },
    });

    assert.equal(result.status, 200);
    const hospital = result.body.transactions.find((t: any) => t.id === "tx-hospital");
    assert.equal(hospital.category, "Eating Out", "the saved rule must win over Plaid's medical category");
    const hospitalModified = result.body.modified.find((t: any) => t.id === "tx-hospital-2");
    assert.equal(hospitalModified.category, "Eating Out");
  });

  test("a merchant with no saved rule still gets Plaid's category", async () => {
    const result = await callRoute(budgetPlaidRoutes, "POST", "/fetch_transactions", {
      session: { userId },
      body: { bankConnectionId: "bank-mine", reset: true },
    });

    const pharmacy = result.body.transactions.find((t: any) => t.id === "tx-pharmacy");
    assert.equal(pharmacy.category, "Medical & Health");
  });
});

describe("POST /budget/plaid/fetch_transactions -- the token is looked up on the server (audit 10.7)", () => {
  const call = (body: any) => callRoute(budgetPlaidRoutes, "POST", "/fetch_transactions", { session: { userId }, body });

  test("uses the stored token of the named connection", async () => {
    plaidBodies.length = 0;
    const result = await call({ bankConnectionId: "bank-mine" });
    assert.equal(result.status, 200);
    assert.ok(plaidBodies.length > 0 && plaidBodies.every((b) => b.access_token === "access-sandbox-test-token"));
  });

  test("an access_token in the body is ignored, not trusted", async () => {
    plaidBodies.length = 0;
    const result = await call({ access_token: "access-sandbox-OTHERS-token" });
    assert.equal(result.status, 400);
    assert.equal(plaidBodies.length, 0, "nothing may be sent to Plaid");
  });

  test("another user's personal connection cannot be named", async () => {
    plaidBodies.length = 0;
    const result = await call({ bankConnectionId: "bank-theirs" });
    assert.equal(result.status, 400);
    assert.equal(plaidBodies.length, 0);
  });

  test("a connection with no token, or an unknown id, is a 400", async () => {
    for (const id of ["bank-no-token", "nope"]) {
      assert.equal((await call({ bankConnectionId: id })).status, 400);
    }
  });

  test("an item that was never just exchanged resolves to nothing", () => {
    assert.equal(resolveAccessToken(userId, { itemId: "never-exchanged" }), null);
  });
});
