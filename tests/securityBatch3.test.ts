// Third security batch (audit 2026-10-16): Plaid access tokens never reach the browser
// (the project notes 10.7, second half), and only an admin may delete a family member who is
// linked to a login (audit L5). The Plaid exchange runs against a local mock (PLAID_API_BASE).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, putScopedItem, putBankConnectionWithToken, getBankConnectionAccessToken, getScopedItems } = await loadDb();
const { budgetRoutes } = await import("../routes/budget.ts");
const { budgetPlaidRoutes } = await import("../routes/budget-plaid.ts");
const { memberRoutes } = await import("../routes/members.ts");
const { rememberFreshLink } = await import("../plaidFreshLinks.ts");

const TOKEN = "access-production-batch3-secret-token";
const EXCHANGED = "access-production-freshly-exchanged-token";
let alice: string;
let bob: string;
let admin: string;
let kiosk: string;
let server: http.Server;

const as = (userId: string) => ({ session: { userId } });
const putBank = (userId: string, item: any) =>
  callRoute(budgetRoutes, "PUT", `/bank_connections/${item.id}`, { ...as(userId), body: { item } });

before(async () => {
  alice = createUser("alice-b3", "not-a-real-hash", "Alice", "parent");
  bob = createUser("bob-b3", "not-a-real-hash", "Bob", "parent");
  admin = createUser("admin-b3", "not-a-real-hash", "Admin", "admin");
  kiosk = createUser("kiosk-b3", "not-a-real-hash", "Kiosk", "kiosk");
  putBankConnectionWithToken(alice, { id: "acct-linked", scope: "joint", bankName: "Chase", isPlaid: true, itemId: "item-1" }, TOKEN);
  putScopedItem("bank_connections", alice, { id: "acct-manual", scope: "joint", bankName: "Cash jar" });

  server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    req.resume();
    if (req.url === "/item/public_token/exchange") res.end(JSON.stringify({ access_token: EXCHANGED, item_id: "item-new" }));
    else if (req.url === "/accounts/balance/get") res.end(JSON.stringify({ accounts: [{ account_id: "acct-new", name: "Checking", balances: { current: 5 } }] }));
    else if (req.url === "/liabilities/get") res.end(JSON.stringify({ liabilities: { credit: [] } }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.PLAID_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PLAID_CLIENT_ID = "test-client";
  process.env.PLAID_SECRET = "test-secret";
});

after(async () => {
  delete process.env.PLAID_API_BASE;
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupDb();
});

describe("10.7: Plaid access tokens stay on the server", () => {
  test("GET /store carries no token, encrypted or not -- only hasAccessToken", async () => {
    const result = await callRoute(budgetRoutes, "GET", "/store", as(alice));
    assert.equal(result.status, 200);
    const text = JSON.stringify(result.body);
    assert.equal(text.includes(TOKEN), false, "decrypted token in the /store response");
    assert.equal(text.includes("enc:v1:"), false, "encrypted token in the /store response");
    assert.equal(text.includes("accessToken"), false);
    const byId = new Map(result.body.bankConnections.map((b: any) => [b.id, b]));
    assert.equal((byId.get("acct-linked") as any).hasAccessToken, true);
    assert.equal((byId.get("acct-manual") as any).hasAccessToken, false);
  });

  test("every server read (the assistant's tools use getScopedItems) is token-free", () => {
    const text = JSON.stringify(getScopedItems("bank_connections", alice));
    assert.equal(text.includes(TOKEN) || text.includes("enc:v1:") || text.includes("accessToken"), false);
  });

  test("a save from the browser (no token, as /store sent it) keeps the stored token", async () => {
    const result = await putBank(alice, { id: "acct-linked", scope: "joint", bankName: "Chase", balance: 42, isPlaid: true, itemId: "item-1", hasAccessToken: true });
    assert.equal(result.status, 200);
    assert.equal(getBankConnectionAccessToken(alice, "acct-linked"), TOKEN);
  });

  test("a token sent by a client is ignored: it can't replace one, and can't plant one", async () => {
    await putBank(alice, { id: "acct-linked", scope: "joint", itemId: "item-1", accessToken: "access-production-attacker" });
    assert.equal(getBankConnectionAccessToken(alice, "acct-linked"), TOKEN);
    await putBank(alice, { id: "acct-manual", scope: "joint", accessToken: "access-production-planted" });
    assert.equal(getBankConnectionAccessToken(alice, "acct-manual"), null);
  });

  test("changing a row's scope keeps its token", async () => {
    await putBank(alice, { id: "acct-linked", scope: "personal", itemId: "item-1" });
    assert.equal(getBankConnectionAccessToken(alice, "acct-linked"), TOKEN);
    await putBank(alice, { id: "acct-linked", scope: "joint", itemId: "item-1" });
    assert.equal(getBankConnectionAccessToken(alice, "acct-linked"), TOKEN);
  });

  test("POST /exchange_public_token never returns the token, and the saved rows get it from the server", async () => {
    const result = await callRoute(budgetPlaidRoutes, "POST", "/exchange_public_token", { ...as(alice), body: { public_token: "public-sandbox-x" } });
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result.body).includes(EXCHANGED), false, "access token in the exchange response");
    assert.equal(result.body.item_id, "item-new");

    // The browser saves the account the person picked: no token, just the item id.
    await putBank(alice, { id: "acct-new", scope: "personal", isPlaid: true, itemId: "item-new", hasAccessToken: true });
    assert.equal(getBankConnectionAccessToken(alice, "acct-new"), EXCHANGED);
  });

  test("a fresh link belongs to the user who made it", async () => {
    rememberFreshLink(alice, "item-alices", "access-production-alices-new");
    await putBank(bob, { id: "acct-bob", scope: "personal", itemId: "item-alices" });
    assert.equal(getBankConnectionAccessToken(bob, "acct-bob"), null);
  });

  test("a second account of an item the user can see gets that item's token; someone else's personal item doesn't", async () => {
    await putBank(alice, { id: "acct-linked-2", scope: "joint", itemId: "item-1" });
    assert.equal(getBankConnectionAccessToken(alice, "acct-linked-2"), TOKEN);

    // acct-new is Alice's PERSONAL row, so Bob can't borrow item-new's token by naming it.
    await putBank(bob, { id: "acct-bob-2", scope: "personal", itemId: "item-new" });
    assert.equal(getBankConnectionAccessToken(bob, "acct-bob-2"), null);
    assert.equal(getBankConnectionAccessToken(bob, "acct-new"), null, "Bob can't read Alice's personal row's token");
  });
});

describe("L5: deleting a family member who is linked to a login is admin-only", () => {
  before(() => {
    putScopedItem("household_members", admin, { id: "mem-linked", name: "Alice", scope: "joint", userId: alice, likes: [], dislikes: [], createdAt: "2026-10-16T00:00:00.000Z" });
    putScopedItem("household_members", admin, { id: "mem-plain", name: "Grandma", scope: "joint", likes: [], dislikes: [], createdAt: "2026-10-16T00:00:00.000Z" });
    putScopedItem("household_members", admin, { id: "mem-plain-2", name: "Uncle", scope: "joint", likes: [], dislikes: [], createdAt: "2026-10-16T00:00:00.000Z" });
  });

  test("a parent and the kiosk are refused for a linked member, and it stays", async () => {
    for (const who of [bob, kiosk]) {
      const result = await callRoute(memberRoutes, "DELETE", "/mem-linked", as(who));
      assert.equal(result.status, 403);
    }
    assert.ok(getScopedItems("household_members", admin).some((m: any) => m.id === "mem-linked"));
  });

  test("a parent can still delete a member with no login", async () => {
    assert.equal((await callRoute(memberRoutes, "DELETE", "/mem-plain", as(bob))).status, 200);
  });

  test("an admin can delete a linked member", async () => {
    assert.equal((await callRoute(memberRoutes, "DELETE", "/mem-linked", as(admin))).status, 200);
    assert.equal((await callRoute(memberRoutes, "DELETE", "/mem-plain-2", as(admin))).status, 200);
  });
});
