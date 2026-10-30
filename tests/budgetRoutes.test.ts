// routes/budget.ts -- the store endpoints the Budget UI syncs through, and the
// keyword categorizer that runs whenever Ollama isn't available.
//
// Two things here are load-bearing in a way that isn't obvious from reading:
//
//   1. `table` from the URL is interpolated into SQL inside db.ts
//      (`SELECT ... FROM ${table}`). The only thing standing between a path
//      segment and that string is `isBudgetTable`'s allowlist. It is not
//      defence in depth -- it is the whole defence.
//   2. `PUT /store-config/:key` is registered before `PUT /:table/:id` on
//      purpose. Express matches in registration order, so swapping them makes
//      "store-config" read as a table name. The file's own comment records
//      this as a real bug already caught once.
//
// These routes are mounted behind requireAuth + requireUnlocked in server.ts;
// driving the router directly tests them as if those gates had passed, which
// is the right unit -- both gates have their own tests in auth.test.ts.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, putScopedItem, putScopedItemAs, getScopedItems, getConfig, setConfig } = await loadDb();
const {
  budgetRoutes,
  basicFallbackCategorizer,
  ensureCategoryExists,
  BUDGET_SCOPED_TABLES,
  FALLBACK_CATEGORIES,
  normalizeStatementDate,
  parseStatementAmount,
} = await import("../routes/budget.ts");
// securityLog.ts statically imports db.ts, so -- same reasoning as routes/budget.ts
// above -- it's reached through a dynamic import after loadDb() has already run,
// never a static one at the top of this file.
const { appendSecurityEvent } = await import("../securityLog.ts");

let alice: string;
let bob: string;
let admin: string;
const ADMIN_PASSWORD = "correct horse battery";

const asAlice = () => ({ session: { userId: alice } });
const asBob = () => ({ session: { userId: bob } });
const asAdmin = () => ({ session: { userId: admin } });

before(async () => {
  alice = createUser("alice-broutes", "not-a-real-hash", "Alice");
  bob = createUser("bob-broutes", "not-a-real-hash", "Bob");
  // Real bcrypt hash, unlike alice/bob above -- POST /store/reset is
  // requireAdmin plus a verifyPassword re-check now (the project notes
  // 10.20), so its tests need a password that actually verifies.
  admin = createUser("admin-broutes", await bcrypt.hash(ADMIN_PASSWORD, 4), "Admin", "admin");
});

after(cleanupDb);

describe("GET /store", () => {
  test("returns every table the Budget UI loads, in one response", async () => {
    const result = await callRoute(budgetRoutes, "GET", "/store", asAlice());

    assert.equal(result.status, 200);
    for (const key of [
      "transactions",
      "budgets",
      "bankConnections",
      "creditCards",
      "alerts",
      "goals",
      "bills",
      "categories",
      "incomeCategories",
      "billCategories",
      "securityLog",
    ]) {
      assert.ok(key in result.body, `GET /store should include ${key}`);
    }
  });

  test("unset config keys come back null, so the client can tell 'unset' from 'empty'", async () => {
    // Budget.tsx falls back to its own defaults on null. If these came back as
    // [] the UI would render an empty category list as though it were real.
    const result = await callRoute(budgetRoutes, "GET", "/store", asAlice());
    assert.equal(result.body.categories, null);
  });

  test("does not leak the other member's personal rows", async () => {
    putScopedItemAs("transactions", bob, "tx-bob-private", {
      id: "tx-bob-private",
      scope: "personal",
      description: "Bob's private purchase",
      amount: -50,
      category: "Shopping",
      date: "2026-01-01",
      merchantName: "Somewhere",
      bankName: "Test",
      status: "cleared",
    });

    const result = await callRoute(budgetRoutes, "GET", "/store", asAlice());
    assert.equal(
      result.body.transactions.some((t: any) => t.id === "tx-bob-private"),
      false
    );
  });

  // The kiosk login (auth.ts's forbidKiosk) reaches every section including
  // Budget -- this is the guarantee that's supposed to keep it from seeing
  // anyone's personal spending anyway: it owns no personal rows of its own,
  // so getScopedItems' ownership filter (owner_user_id IS NULL OR = caller)
  // naturally leaves it with joint data only, no Budget-specific code needed.
  test("a kiosk session sees joint transactions but not a real member's personal ones", async () => {
    const kiosk = createUser("kiosk-broutes", "not-a-real-hash", "Kiosk", "kiosk");

    putScopedItemAs("transactions", alice, "tx-alice-private", {
      id: "tx-alice-private",
      scope: "personal",
      description: "Alice's private purchase",
      amount: -20,
      category: "Shopping",
      date: "2026-01-01",
      merchantName: "Somewhere",
      bankName: "Test",
      status: "cleared",
    });
    putScopedItem("transactions", alice, {
      id: "tx-joint-broutes",
      scope: "joint",
      description: "Groceries",
      amount: -80,
      category: "Food",
      date: "2026-01-01",
      merchantName: "Store",
      bankName: "Test",
      status: "cleared",
    });

    const result = await callRoute(budgetRoutes, "GET", "/store", { session: { userId: kiosk } });
    const ids = result.body.transactions.map((t: any) => t.id);
    assert.ok(ids.includes("tx-joint-broutes"), "joint transactions should still be visible");
    assert.equal(ids.includes("tx-alice-private"), false, "a real member's personal row must not leak");
  });
});

describe("PUT /:table/:id -- the table allowlist", () => {
  test("accepts every table the client is meant to sync", async () => {
    for (const table of BUDGET_SCOPED_TABLES) {
      const id = table === "budgets" ? "AllowlistCheck" : `${table}-allow-1`;
      const item = table === "budgets" ? { category: id, limit: 10, spent: 0 } : { id, scope: "joint" };

      const result = await callRoute(budgetRoutes, "PUT", `/${table}/${encodeURIComponent(id)}`, {
        ...asAlice(),
        body: { item },
      });
      assert.equal(result.status, 200, `${table} should be writable`);
    }
  });

  test("refuses a table that is not on the allowlist", async () => {
    // `table` reaches a template string inside db.ts. Anything not on the
    // allowlist must never get that far.
    for (const table of ["users", "sessions", "app_config", "merchant_rules", "plaid_cursors"]) {
      const result = await callRoute(budgetRoutes, "PUT", `/${table}/x`, {
        ...asAlice(),
        body: { item: { id: "x" } },
      });
      assert.equal(result.status, 404, `${table} must not be writable through this route`);
      assert.equal(result.body.error, "Unknown store table");
    }
  });

  test("refuses a SQL-shaped table name outright", async () => {
    const result = await callRoute(budgetRoutes, "PUT", "/transactions;DROP TABLE users--/x", {
      ...asAlice(),
      body: { item: { id: "x" } },
    });
    assert.equal(result.status, 404);

    // And the database is still intact.
    const stillThere = await callRoute(budgetRoutes, "GET", "/store", asAlice());
    assert.equal(stillThere.status, 200);
  });
});

describe("PUT /:table/:id -- body validation", () => {
  test("requires a { item: {...} } body", async () => {
    for (const body of [{}, { item: null }, { item: "a string" }, { item: 42 }]) {
      const result = await callRoute(budgetRoutes, "PUT", "/transactions/tx-1", { ...asAlice(), body });
      assert.equal(result.status, 400, `${JSON.stringify(body)} should be refused`);
    }
  });

  test("refuses when the body's key disagrees with the URL", async () => {
    // Otherwise a client could write row B while the URL says row A, and the
    // diff-sync hook's idea of what the server holds would silently diverge.
    const result = await callRoute(budgetRoutes, "PUT", "/transactions/tx-url", {
      ...asAlice(),
      body: { item: { id: "tx-body", scope: "joint" } },
    });

    assert.equal(result.status, 400);
    assert.match(result.body.error, /does not match/);
  });

  test("budgets are keyed by category, not by id", async () => {
    const result = await callRoute(budgetRoutes, "PUT", "/budgets/Groceries", {
      ...asAlice(),
      body: { item: { category: "Groceries", limit: 600, spent: 0, scope: "joint" } },
    });

    assert.equal(result.status, 200);
    const stored = (getScopedItems("budgets", alice) as any[]).find((b) => b.category === "Groceries");
    assert.equal(stored.limit, 600);
  });
});

describe("PUT /:table/:id -- cross-member writes", () => {
  test("answers 403 rather than reporting success on a refused write", async () => {
    // putScopedItemAs refuses at the SQL level and returns false; without the
    // route checking that, the client would be told the write landed.
    putScopedItem("goals", bob, { id: "goal-bobs", scope: "personal", name: "Bob's goal", targetAmount: 100 });

    const result = await callRoute(budgetRoutes, "PUT", "/goals/goal-bobs", {
      ...asAlice(),
      body: { item: { id: "goal-bobs", scope: "personal", name: "Hijacked", targetAmount: 1 } },
    });

    assert.equal(result.status, 403);
    const bobsGoal = (getScopedItems("goals", bob) as any[]).find((g) => g.id === "goal-bobs");
    assert.equal(bobsGoal.name, "Bob's goal", "the row must be unchanged");
  });

  test("a joint row is writable by either member", async () => {
    await callRoute(budgetRoutes, "PUT", "/goals/goal-joint", {
      ...asAlice(),
      body: { item: { id: "goal-joint", scope: "joint", name: "Ours", targetAmount: 500 } },
    });
    const result = await callRoute(budgetRoutes, "PUT", "/goals/goal-joint", {
      ...asBob(),
      body: { item: { id: "goal-joint", scope: "joint", name: "Ours, edited", targetAmount: 500 } },
    });

    assert.equal(result.status, 200);
  });
});

describe("DELETE /:table/:id", () => {
  test("removes a row the caller may see", async () => {
    putScopedItem("alerts", alice, { id: "alert-doomed", scope: "joint", message: "x" });

    const result = await callRoute(budgetRoutes, "DELETE", "/alerts/alert-doomed", asAlice());

    assert.equal(result.status, 200);
    assert.equal((getScopedItems("alerts", alice) as any[]).some((a) => a.id === "alert-doomed"), false);
  });

  test("enforces the same table allowlist as the write path", async () => {
    const result = await callRoute(budgetRoutes, "DELETE", "/users/some-id", asAlice());
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Unknown store table");
  });

  test("a row that isn't there (or isn't yours) is a 404", async () => {
    putScopedItem("alerts", bob, { id: "alert-bobs", scope: "personal", message: "private" });

    assert.equal((await callRoute(budgetRoutes, "DELETE", "/alerts/nope", asAlice())).status, 404);
    assert.equal(
      (await callRoute(budgetRoutes, "DELETE", "/alerts/alert-bobs", asAlice())).status,
      404,
      "another member's personal row must read as absent, not as forbidden"
    );
    assert.equal((getScopedItems("alerts", bob) as any[]).some((a) => a.id === "alert-bobs"), true);
  });
});

describe("PUT /store-config/:key -- and the route ordering it depends on", () => {
  test("a known config key is stored under the budget. prefix", async () => {
    const result = await callRoute(budgetRoutes, "PUT", "/store-config/categories", {
      ...asAlice(),
      body: { value: ["Groceries", "Gas & Transport"] },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(getConfig("budget.categories", null), ["Groceries", "Gas & Transport"]);
    assert.equal(getConfig("categories", null), null, "must not collide with another section's key");
  });

  test("an unknown config key is refused as a config key, not read as a table", async () => {
    // This assertion is the route-ordering regression test. If PUT
    // "/:table/:id" were registered first, this would come back as "Unknown
    // store table" -- the exact bug the file's comment records.
    const result = await callRoute(budgetRoutes, "PUT", "/store-config/sessionSecret", {
      ...asAlice(),
      body: { value: "malicious" },
    });

    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Unknown config key", "reached the config handler, not the table handler");
  });

  test("only the four known config keys are writable", async () => {
    for (const key of ["securityLog", "categories", "incomeCategories", "billCategories"]) {
      const result = await callRoute(budgetRoutes, "PUT", `/store-config/${key}`, {
        ...asAlice(),
        body: { value: [] },
      });
      assert.equal(result.status, 200, `${key} should be writable`);
    }

    for (const key of ["lock_pin_hash", "session_secret", "anything"]) {
      const result = await callRoute(budgetRoutes, "PUT", `/store-config/${key}`, {
        ...asAlice(),
        body: { value: "x" },
      });
      assert.equal(result.status, 404, `${key} must not be writable`);
    }

    assert.notEqual(getConfig("lock_pin_hash", "untouched"), "x", "the PIN hash must be unreachable from here");
  });
});

describe("merchant rules", () => {
  test("round-trips a rule and keeps it per-member", async () => {
    const created = await callRoute(budgetRoutes, "POST", "/merchant-rules", {
      ...asAlice(),
      body: { merchantName: "Chipotle", category: "Eating Out" },
    });
    assert.equal(created.status, 200);

    const mine = await callRoute(budgetRoutes, "GET", "/merchant-rules", asAlice());
    assert.equal(mine.body.rules.some((r: any) => r.merchantDisplay === "Chipotle"), true);

    const theirs = await callRoute(budgetRoutes, "GET", "/merchant-rules", asBob());
    assert.equal(
      theirs.body.rules.some((r: any) => r.merchantDisplay === "Chipotle"),
      false,
      "one member's correction must not re-categorize the other's data"
    );
  });

  test("requires both fields", async () => {
    for (const body of [{ merchantName: "X" }, { category: "Y" }, {}]) {
      const result = await callRoute(budgetRoutes, "POST", "/merchant-rules", { ...asAlice(), body });
      assert.equal(result.status, 400);
    }
  });

  test("DELETE /merchant-rules/:merchant forgets a rule", async () => {
    // Registered before DELETE "/:table/:id", so "merchant-rules" must not be
    // read as a table name -- the same ordering hazard as store-config.
    const result = await callRoute(budgetRoutes, "DELETE", "/merchant-rules/Chipotle", asAlice());

    assert.equal(result.status, 200);
    const after = await callRoute(budgetRoutes, "GET", "/merchant-rules", asAlice());
    assert.equal(after.body.rules.some((r: any) => r.merchantDisplay === "Chipotle"), false);
  });

  test("handles a merchant name with a slash or spaces once decoded", async () => {
    await callRoute(budgetRoutes, "POST", "/merchant-rules", {
      ...asAlice(),
      body: { merchantName: "AMZN MKTPLC US", category: "Shopping" },
    });

    const result = await callRoute(
      budgetRoutes,
      "DELETE",
      `/merchant-rules/${encodeURIComponent("AMZN MKTPLC US")}`,
      asAlice()
    );

    assert.equal(result.status, 200);
    const after = await callRoute(budgetRoutes, "GET", "/merchant-rules", asAlice());
    assert.equal(after.body.rules.some((r: any) => r.merchantDisplay === "AMZN MKTPLC US"), false);
  });
});

describe("POST /categorize", () => {
  test("a remembered merchant short-circuits before any model call", async () => {
    // No Ollama is running in this suite, so reaching the model would hang or
    // error -- that this returns cleanly is itself the assertion.
    await callRoute(budgetRoutes, "POST", "/merchant-rules", {
      ...asAlice(),
      body: { merchantName: "Kroger", category: "Groceries" },
    });

    const result = await callRoute(budgetRoutes, "POST", "/categorize", {
      ...asAlice(),
      body: { description: "KROGER #422 CINCINNATI OH", amount: -84.2 },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.category, "Groceries");
    assert.equal(result.body.merchantName, "Kroger");
    assert.equal(result.body.fromMerchantRule, true);
    assert.equal(result.body.aiProcessed, false);
  });

  test("requires a description and a numeric amount", async () => {
    for (const body of [{ amount: -5 }, { description: "X" }, { description: "X", amount: "-5" }]) {
      const result = await callRoute(budgetRoutes, "POST", "/categorize", { ...asAlice(), body });
      assert.equal(result.status, 400, `${JSON.stringify(body)} should be refused`);
    }
  });

  test("falls back to the keyword categorizer instead of hanging when the model never answers", async () => {
    // Adding a transaction used to wait on this call with no timeout at all --
    // it hung 20+ seconds in real testing (the project notes 11.3). A real
    // 8s default would make this one test take 8s for nothing it's actually
    // checking, so BUDGET_CATEGORIZE_TIMEOUT_MS lets it inject a short one.
    const realFetch = globalThis.fetch;
    process.env.BUDGET_CATEGORIZE_TIMEOUT_MS = "50";
    // Never resolves -- stands in for a model call that's still loading/thinking
    // when the timeout should already have fired.
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;

    try {
      const started = Date.now();
      const result = await callRoute(budgetRoutes, "POST", "/categorize", {
        ...asAlice(),
        body: { description: "STARBUCKS STORE 45", amount: -6.5 },
      });
      const elapsed = Date.now() - started;

      assert.equal(result.status, 200);
      assert.equal(result.body.aiProcessed, false);
      assert.equal(result.body.timedOut, true);
      const expected = basicFallbackCategorizer("STARBUCKS STORE 45", -6.5);
      assert.equal(result.body.category, expected.category);
      assert.equal(result.body.merchantName, expected.merchantName);
      assert.ok(elapsed < 2000, `expected the timeout fallback well under 2s, took ${elapsed}ms`);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.BUDGET_CATEGORIZE_TIMEOUT_MS;
    }
  });
});

describe("bills table (Phase 6)", () => {
  test("round-trips a bill through PUT and GET /store", async () => {
    const bill = {
      id: "bill-internet",
      name: "Xfinity Internet",
      amount: 79.99,
      dueDay: 15,
      frequency: "monthly",
      startMonth: "2026-01",
      category: "Utilities & Bills",
      matchText: "XFINITY",
      scope: "joint",
      active: true,
    };

    const put = await callRoute(budgetRoutes, "PUT", "/bills/bill-internet", { ...asAlice(), body: { item: bill } });
    assert.equal(put.status, 200);

    const store = await callRoute(budgetRoutes, "GET", "/store", asAlice());
    const stored = store.body.bills.find((b: any) => b.id === "bill-internet");
    assert.ok(stored, "the bill should come back from GET /store");
    assert.equal(stored.amount, 79.99);
    assert.equal(stored.matchText, "XFINITY");
  });

  test("another member's personal bill is invisible and unwritable", async () => {
    putScopedItem("bills", bob, {
      id: "bill-bobs-private",
      name: "Bob's gym",
      amount: 40,
      dueDay: 1,
      frequency: "monthly",
      startMonth: "2026-01",
      category: "Shopping",
      scope: "personal",
      active: true,
    });

    const store = await callRoute(budgetRoutes, "GET", "/store", asAlice());
    assert.equal(store.body.bills.some((b: any) => b.id === "bill-bobs-private"), false);

    const write = await callRoute(budgetRoutes, "PUT", "/bills/bill-bobs-private", {
      ...asAlice(),
      body: { item: { id: "bill-bobs-private", name: "Hijacked", amount: 1, dueDay: 1, frequency: "monthly", startMonth: "2026-01", category: "Shopping", scope: "personal", active: true } },
    });
    assert.equal(write.status, 403);

    const untouched = (getScopedItems("bills", bob) as any[]).find((b) => b.id === "bill-bobs-private");
    assert.equal(untouched.name, "Bob's gym", "the row must be unchanged");
  });

  test("POST /store/reset clears bills", async () => {
    putScopedItem("bills", admin, {
      id: "bill-to-reset",
      name: "Doomed",
      amount: 10,
      dueDay: 1,
      frequency: "monthly",
      startMonth: "2026-01",
      category: "Shopping",
      scope: "personal",
      active: true,
    });

    const result = await callRoute(budgetRoutes, "POST", "/store/reset", { ...asAdmin(), body: { password: ADMIN_PASSWORD } });
    assert.equal(result.status, 200);
    assert.equal((getScopedItems("bills", admin) as any[]).some((b) => b.id === "bill-to-reset"), false);
  });
});

describe("POST /store/reset", () => {
  test("clears the caller's own rows and leaves the other member's alone", async () => {
    putScopedItem("alerts", admin, { id: "alert-mine", scope: "personal", message: "mine" });
    putScopedItem("alerts", bob, { id: "alert-theirs", scope: "personal", message: "theirs" });

    const result = await callRoute(budgetRoutes, "POST", "/store/reset", { ...asAdmin(), body: { password: ADMIN_PASSWORD } });

    assert.equal(result.status, 200);
    assert.equal((getScopedItems("alerts", admin) as any[]).some((a) => a.id === "alert-mine"), false);
    assert.equal(
      (getScopedItems("alerts", bob) as any[]).some((a) => a.id === "alert-theirs"),
      true,
      "a reset must not wipe the other member's data"
    );
  });

  test("refuses a parent session even with no password sent -- admin only", async () => {
    const result = await callRoute(budgetRoutes, "POST", "/store/reset", asAlice());
    assert.equal(result.status, 403);
  });

  test("refuses an admin session without the right password", async () => {
    const result = await callRoute(budgetRoutes, "POST", "/store/reset", { ...asAdmin(), body: { password: "wrong" } });
    assert.equal(result.status, 401);
  });
});

describe("ensureCategoryExists", () => {
  beforeEach(() => {
    setConfig("budget.categories", ["Groceries"]);
  });

  test("adds an unknown category and gives it a zero-limit budget row", async () => {
    // The budget row is what makes a newly-invented category show up in the
    // planner straight away rather than only once something is spent.
    assert.equal(ensureCategoryExists(alice, "Hot Air Ballooning"), true);

    assert.ok((getConfig("budget.categories", []) as string[]).includes("Hot Air Ballooning"));
    const budget = (getScopedItems("budgets", alice) as any[]).find((b) => b.category === "Hot Air Ballooning");
    assert.equal(budget.limit, 0);
  });

  test("is a no-op for a category that already exists", async () => {
    assert.equal(ensureCategoryExists(alice, "Groceries"), false);
    assert.deepEqual(getConfig("budget.categories", []), ["Groceries"]);
  });

  test("a category name collision with another member's personal budget no longer vanishes silently", async () => {
    // budgets is keyed by category name, not a generated id -- Bob already
    // owns a personal "Side Hustle" row, so Alice inventing the same name
    // must not silently report success while writing nothing. See
    // the project notes 10.11/section 14 for the real incident this
    // reproduces (Income and Eating Out collided the same way).
    putScopedItemAs("budgets", bob, "Side Hustle", { category: "Side Hustle", limit: 50, spent: 0, scope: "personal" });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      assert.equal(ensureCategoryExists(alice, "Side Hustle"), true, "still added to the shared picklist");
    } finally {
      console.warn = originalWarn;
    }

    assert.ok((getConfig("budget.categories", []) as string[]).includes("Side Hustle"));
    assert.equal(
      (getScopedItems("budgets", alice) as any[]).find((b) => b.category === "Side Hustle"),
      undefined,
      "Alice must not see Bob's row as her own"
    );
    assert.match(warnings[0] || "", /Side Hustle.*another member/);
  });
});

describe("basicFallbackCategorizer -- what runs when Ollama is down", () => {
  // Categorization must never hard-fail just because the local model isn't
  // running, so this keyword pass is the floor under every import.
  const cases: [string, number, string, string][] = [
    ["ONLINE TRANSFER TO SAVINGS", -500, "Transfer", "Account Transfer"],
    ["JG MANAGEMENT APARTMENTS RENT", -1200, "Mortgage/Rent", "Rent / Mortgage Payment"],
    ["GEICO AUTO INSURANCE", -140, "Car Insurance", "Car Insurance"],
    ["MCDONALDS F1234", -9.5, "Eating Out", "McDonald's"],
    ["STARBUCKS STORE 4412", -6.25, "Eating Out", "Starbucks"],
    ["KROGER #422", -84.2, "Groceries", "Kroger"],
    ["TRADER JOE'S #556", -60, "Groceries", "Trader Joe's"],
    ["NETFLIX.COM", -15.49, "Subscriptions", "Netflix"],
    ["COMCAST CABLE COMM", -89, "Utilities & Bills", "Xfinity Comcast"],
    ["AMAZON MKTPLACE PMTS", -32.1, "Shopping", "Amazon"],
    ["SHELL OIL 574", -45, "Gas & Transport", "Shell Gas"],
    ["CVS PHARMACY #8842", -22, "Medical & Health", "CVS Pharmacy"],
    ["KINGS ISLAND TICKETS", -180, "Family Activities", "Kings Island"],
    ["EMPLOYER PAYROLL DIRECT DEP", 3200, "Income", "Employer Deposit"],
  ];

  for (const [description, amount, category, merchantName] of cases) {
    test(`"${description}" -> ${category}`, () => {
      const result = basicFallbackCategorizer(description, amount);
      assert.equal(result.category, category);
      assert.equal(result.merchantName, merchantName);
    });
  }

  test("is case-insensitive", () => {
    assert.equal(basicFallbackCategorizer("kroger #422", -10).category, "Groceries");
    assert.equal(basicFallbackCategorizer("KrOgEr #422", -10).category, "Groceries");
  });

  test("any unrecognized positive amount is treated as income", () => {
    // A deposit from an unknown source is far more likely income than a
    // purchase, and miscategorizing it as Shopping would show a phantom spend.
    assert.equal(basicFallbackCategorizer("UNKNOWN DEPOSIT XYZ", 500).category, "Income");
  });

  test("an unrecognized spend falls back to Shopping with its raw description", () => {
    const result = basicFallbackCategorizer("SOME OBSCURE VENDOR LLC", -42);
    assert.equal(result.category, "Shopping");
    assert.equal(result.merchantName, "SOME OBSCURE VENDOR LLC", "the raw text is kept so a person can still read it");
  });

  test("every category it can produce is a real one", () => {
    // A category invented here that isn't in the household's list would leave
    // transactions in a bucket the planner never shows.
    for (const [description, amount] of cases) {
      const { category } = basicFallbackCategorizer(description, amount);
      assert.ok(FALLBACK_CATEGORIES.includes(category), `${category} is not a known category`);
    }
  });

  test("never returns an empty merchant name", () => {
    for (const description of ["", "   ", "???", "12345"]) {
      const result = basicFallbackCategorizer(description, -1);
      assert.equal(typeof result.merchantName, "string");
      assert.equal(typeof result.category, "string");
      assert.ok(result.category.length > 0);
    }
  });
});

describe("POST /security-log", () => {
  beforeEach(() => {
    setConfig("budget.securityLog", []);
  });

  test("appends to the front", async () => {
    const first = await callRoute(budgetRoutes, "POST", "/security-log", {
      ...asAlice(),
      body: { event: "First event", type: "info" },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.entry.event, "First event");

    const second = await callRoute(budgetRoutes, "POST", "/security-log", {
      ...asAlice(),
      body: { event: "Second event", type: "warning" },
    });
    assert.equal(second.status, 200);

    const log = getConfig("budget.securityLog", []) as any[];
    assert.equal(log[0].event, "Second event");
    assert.equal(log[1].event, "First event");
  });

  test("preserves an entry appended directly via appendSecurityEvent in between -- the clobber scenario", async () => {
    // This is exactly the bug the route replaces: the old client PUT its whole
    // local array to /store-config/securityLog, so an event the server
    // appended between two client writes (a PIN lockout from routes/lock.ts,
    // for instance) got silently overwritten. Routing every append through
    // this one route's read-modify-write means neither writer loses the other's entry.
    await callRoute(budgetRoutes, "POST", "/security-log", {
      ...asAlice(),
      body: { event: "Client event A", type: "info" },
    });
    appendSecurityEvent("Server-appended lockout event", "warning");
    await callRoute(budgetRoutes, "POST", "/security-log", {
      ...asAlice(),
      body: { event: "Client event B", type: "info" },
    });

    const events = (getConfig("budget.securityLog", []) as any[]).map((e) => e.event);
    assert.deepEqual(events, ["Client event B", "Server-appended lockout event", "Client event A"]);
  });

  test("caps at 50 entries", async () => {
    for (let i = 0; i < 55; i++) {
      await callRoute(budgetRoutes, "POST", "/security-log", {
        ...asAlice(),
        body: { event: `Event ${i}`, type: "info" },
      });
    }
    const log = getConfig("budget.securityLog", []) as any[];
    assert.equal(log.length, 50);
    assert.equal(log[0].event, "Event 54");
  });

  test("400 for an empty event", async () => {
    for (const event of ["", "   "]) {
      const result = await callRoute(budgetRoutes, "POST", "/security-log", {
        ...asAlice(),
        body: { event, type: "info" },
      });
      assert.equal(result.status, 400);
    }
  });

  test("400 for a type outside success/warning/critical/info", async () => {
    for (const type of ["danger", "", undefined, 5]) {
      const result = await callRoute(budgetRoutes, "POST", "/security-log", {
        ...asAlice(),
        body: { event: "Something happened", type },
      });
      assert.equal(result.status, 400, `type ${JSON.stringify(type)} should be refused`);
    }
  });

  test("truncates a 1000-char event to 300 rather than rejecting it", async () => {
    const longEvent = "x".repeat(1000);
    const result = await callRoute(budgetRoutes, "POST", "/security-log", {
      ...asAlice(),
      body: { event: longEvent, type: "info" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.entry.event.length, 300);
  });
});

describe("normalizeStatementDate", () => {
  // A fixed "today" so every case is deterministic regardless of when the
  // suite actually runs.
  const today = new Date(2026, 8, 23); // 2026-09-23
  const todayISO = "2026-09-23";

  test("passes an already-ISO date through", () => {
    assert.equal(normalizeStatementDate("2026-09-23", today), "2026-09-23");
    assert.equal(normalizeStatementDate("2026/09/23", today), "2026-09-23");
  });

  test("parses M/D/YYYY", () => {
    assert.equal(normalizeStatementDate("9/23/2026", today), "2026-09-23");
  });

  test("parses M-D-YYYY", () => {
    assert.equal(normalizeStatementDate("09-23-2026", today), "2026-09-23");
  });

  test("a two-digit year is read as 2000+yy", () => {
    assert.equal(normalizeStatementDate("9/23/26", today), "2026-09-23");
  });

  test("a bare M/D with no year uses today's year when that isn't far in the future", () => {
    assert.equal(normalizeStatementDate("9/23", today), todayISO);
  });

  test("a bare M/D that would land more than 7 days in the future rolls back a year", () => {
    // Statements are about the past -- parsing "12/25" while "today" is in
    // September almost certainly means LAST December, not three months out.
    assert.equal(normalizeStatementDate("12/25", today), "2025-12-25");
  });

  test("an invalid day for its month falls back to today", () => {
    // 2026 is not a leap year, so February tops out at 28.
    assert.equal(normalizeStatementDate("2/30/2026", today), todayISO);
  });

  test("unparseable input falls back to today", () => {
    assert.equal(normalizeStatementDate("not a date", today), todayISO);
    assert.equal(normalizeStatementDate("", today), todayISO);
    assert.equal(normalizeStatementDate(undefined, today), todayISO);
  });
});

describe("parseStatementAmount", () => {
  test("a leading minus before the $ is negative", () => {
    assert.equal(parseStatementAmount("-$50.00"), -50);
  });

  test("a minus between the $ and the digits is negative", () => {
    assert.equal(parseStatementAmount("$-50.00"), -50);
  });

  test("parentheses mean negative -- the standard accounting notation", () => {
    assert.equal(parseStatementAmount("(50.00)"), -50);
  });

  test("an explicit leading plus is positive", () => {
    assert.equal(parseStatementAmount("+$3,200.00"), 3200);
  });

  test("an unsigned amount on a line with an income keyword is positive", () => {
    // Bug 10.10: the old regex matched a leading '-' outside its capture group
    // and every caller then hard-coded the result negative, so a line like this
    // imported as a $3,200 CHARGE instead of the deposit it plainly is.
    assert.equal(parseStatementAmount("PAYROLL DEPOSIT $3,200.00"), 3200);
  });

  test("an unsigned amount with no income keyword defaults to spending", () => {
    assert.equal(parseStatementAmount("STARBUCKS $4.50"), -4.5);
  });

  test("no amount in the line returns null", () => {
    assert.equal(parseStatementAmount("Just some text with no numbers"), null);
  });

  test("a separator dash before the amount is not a minus sign", () => {
    // Only a sign touching the "$" or the digits counts -- otherwise the
    // common "DESCRIPTION - $amount" layout flips every deposit negative.
    assert.equal(parseStatementAmount("PAYROLL DEPOSIT - $3,200.00"), 3200);
    assert.equal(parseStatementAmount("STARBUCKS - 4.50"), -4.5);
    assert.equal(parseStatementAmount("REFUND -$12.00"), -12);
  });

  test("a credit card payment is spending, not income", () => {
    assert.equal(parseStatementAmount("CREDIT CARD PAYMENT $300.00"), -300);
  });
});
