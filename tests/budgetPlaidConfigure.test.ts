// routes/budget-plaid.ts's POST /configure -- replaces the Plaid clientId/secret
// every joint bank connection runs on. Same "prove this isn't a left-open or
// kiosk session" pattern as PUT /api/auth/kiosk and /api/backup/download; see
// the project notes security-audit note for why a kiosk session couldn't
// be trusted with this before this fix. Admin-only, not just non-kiosk -- see
// the project notes 10.20's admin/parent follow-up.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, getConfig, decryptSecret } = await loadDb();
const { budgetPlaidRoutes } = await import("../routes/budget-plaid.ts");

const PASSWORD = "correct horse battery";
let admin: string;
let parent: string;
let kiosk: string;

before(async () => {
  admin = createUser("admin-plaid-configure", await bcrypt.hash(PASSWORD, 4), "Admin", "admin");
  parent = createUser("parent-plaid-configure", await bcrypt.hash(PASSWORD, 4), "Parent", "parent");
  kiosk = createUser("kiosk-plaid-configure", "not-a-real-hash", "Kiosk", "kiosk");
});

after(cleanupDb);

function configure(session: any, body: any) {
  return callRoute(budgetPlaidRoutes, "POST", "/configure", { session, body });
}

describe("POST /budget/plaid/configure", () => {
  test("refuses a kiosk session outright, regardless of any password sent", async () => {
    const result = await configure(
      { userId: kiosk },
      { clientId: "new-id", secret: "new-secret", environment: "production", password: "anything" }
    );
    assert.equal(result.status, 403);
  });

  test("refuses a parent session even with the right password -- admin only", async () => {
    const result = await configure(
      { userId: parent },
      { clientId: "new-id", secret: "new-secret", password: PASSWORD }
    );
    assert.equal(result.status, 403);
  });

  test("refuses without the caller's own account password", async () => {
    const result = await configure({ userId: admin }, { clientId: "new-id", secret: "new-secret" });
    assert.equal(result.status, 401);
  });

  test("refuses the wrong password", async () => {
    const result = await configure(
      { userId: admin },
      { clientId: "new-id", secret: "new-secret", password: "not-the-right-password" }
    );
    assert.equal(result.status, 401);
    assert.equal(getConfig("budget.plaid", null), null, "a wrong password must not write anything");
  });

  test("saves the credentials once the right password is given", async () => {
    const result = await configure(
      { userId: admin },
      { clientId: "new-id", secret: "new-secret", environment: "production", password: PASSWORD }
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.configured, true);
    const stored = getConfig("budget.plaid", null);
    assert.equal(stored.clientId, "new-id");
    assert.equal(stored.environment, "production");
    // Encrypted at rest (plaidSecretEncryption.test.ts covers it in full).
    assert.equal(decryptSecret(stored.secret), "new-secret");
    assert.notEqual(stored.secret, "new-secret");
  });
});
