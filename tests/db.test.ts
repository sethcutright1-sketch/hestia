// db.ts -- Plaid token encryption at rest, and the personal/joint row scoping
// that every route delegates to instead of writing its own WHERE clause.
//
// Both are silent when wrong: a scoping bug shows another member's rows in a
// perfectly normal-looking response, and an encryption bug writes a live
// banking credential into a file that gets copied to data/backups/ every day.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const {
  DB_PATH,
  db,
  encryptSecret,
  decryptSecret,
  getScopedItems,
  getScopedItem,
  putBankConnectionWithToken,
  getBankConnectionAccessToken,
  putScopedItem,
  putScopedItemAs,
  deleteScopedItem,
  getConfig,
  setConfig,
  createUser,
  getUserByUsername,
  getUserCount,
  getHouseholdMemberCount,
  getKioskUser,
  deleteKioskUser,
  getMerchantRules,
  matchMerchantRule,
  upsertMerchantRule,
  deleteMerchantRule,
  plaidItemKey,
  newId,
} = await loadDb();

let alice: string;
let bob: string;

// loadDb() has already asserted DB_PATH points at the throwaway file, so
// these fixtures cannot land in a real household.db.
before(() => {
  alice = createUser("alice-test", "not-a-real-hash", "Alice");
  bob = createUser("bob-test", "not-a-real-hash", "Bob");
});

after(cleanupDb);

describe("encryptSecret / decryptSecret", () => {
  test("round-trips a Plaid access token", () => {
    const token = "access-production-11111111-2222-3333-4444-555555555555";
    assert.equal(decryptSecret(encryptSecret(token)), token);
  });

  test("the ciphertext does not contain the plaintext", () => {
    // The entire point: a leaked .db file must not also be a set of live
    // banking credentials.
    const token = "access-production-deadbeef";
    const encrypted = encryptSecret(token);
    assert.equal(encrypted.includes(token), false);
    assert.equal(encrypted.includes("access-production"), false);
    assert.ok(encrypted.startsWith("enc:v1:"));
  });

  test("encrypting the same value twice gives different ciphertext", () => {
    // A fresh random IV each time -- otherwise equal tokens would be visibly
    // equal in the file, which leaks that two connections share an item.
    const token = "access-production-samevalue";
    assert.notEqual(encryptSecret(token), encryptSecret(token));
  });

  test("a not-yet-migrated plaintext value passes through unchanged", () => {
    // decryptSecret has to tolerate rows written before Stage 0.0.5 rather
    // than throwing on them -- that's what the enc:v1: prefix is for.
    assert.equal(decryptSecret("access-production-oldplaintext"), "access-production-oldplaintext");
  });

  test("a tampered ciphertext is rejected, not silently returned", () => {
    // GCM's auth tag is the difference between "encrypted" and "encrypted and
    // not quietly editable by whoever holds the file".
    const encrypted = encryptSecret("access-production-tamper");
    const [, , ivB64, tagB64, dataB64] = encrypted.split(":");
    const flipped = Buffer.from(dataB64, "base64");
    flipped[0] ^= 0xff;
    const tampered = `enc:v1:${ivB64}:${tagB64}:${flipped.toString("base64")}`;
    assert.throws(() => decryptSecret(tampered));
  });

  test("a wrong key cannot decrypt", () => {
    const encrypted = encryptSecret("access-production-wrongkey");
    const realKey = process.env.DB_ENCRYPTION_KEY;
    process.env.DB_ENCRYPTION_KEY = "f".repeat(64);
    try {
      assert.throws(() => decryptSecret(encrypted));
    } finally {
      process.env.DB_ENCRYPTION_KEY = realKey;
    }
  });

  test("a malformed key is refused up front with a readable error", () => {
    const realKey = process.env.DB_ENCRYPTION_KEY;
    process.env.DB_ENCRYPTION_KEY = "tooshort";
    try {
      assert.throws(() => encryptSecret("x"), /32-byte key/);
    } finally {
      process.env.DB_ENCRYPTION_KEY = realKey;
    }
  });
});

describe("bank_connections encryption is applied on the way through db.ts", () => {
  test("the token is stored encrypted, reads only say it exists, and the server-only getter decrypts it", () => {
    const id = newId("bank");
    const token = "access-production-roundtrip-abc";
    putBankConnectionWithToken(alice, { id, scope: "joint", bankName: "Chase" }, token);

    // What a route (and so a browser or a model) sees: no token, just the flag (10.7).
    const row = getScopedItem("bank_connections", alice, id);
    assert.equal("accessToken" in row, false);
    assert.equal(row.hasAccessToken, true);
    // What the Plaid sync route uses.
    assert.equal(getBankConnectionAccessToken(alice, id), token);

    // What the file on disk holds: not the token. Read as raw bytes, because
    // this is precisely the check "is the backup file safe to lose" depends on.
    const raw = fs.readFileSync(DB_PATH).toString("binary");
    assert.equal(raw.includes(token), false, "plaintext access token found in the database file");
  });

  test("non-financial tables are untouched by the encryption path", () => {
    const id = newId("pantry");
    putScopedItem("pantry_items", alice, { id, scope: "joint", name: "Milk", accessToken: "not-a-token" });
    assert.equal(getScopedItem("pantry_items", alice, id).accessToken, "not-a-token");
  });
});

describe("scoping: joint rows are shared, personal rows are not", () => {
  test("a joint row is visible to both members", () => {
    const id = newId("list");
    putScopedItem("shopping_lists", alice, { id, scope: "joint", name: "Weekly Groceries" });

    assert.ok(getScopedItem("shopping_lists", alice, id));
    assert.ok(getScopedItem("shopping_lists", bob, id), "a joint row must be visible to the other member");
  });

  test("a personal row is invisible to the other member", () => {
    const id = newId("list");
    putScopedItem("shopping_lists", alice, { id, scope: "personal", name: "Birthday Surprise" });

    assert.ok(getScopedItem("shopping_lists", alice, id));
    assert.equal(getScopedItem("shopping_lists", bob, id), undefined);
  });

  test("list reads exclude the other member's personal rows", () => {
    const jointId = newId("event");
    const aliceId = newId("event");
    const bobId = newId("event");
    putScopedItem("events", alice, { id: jointId, scope: "joint", name: "Trash Day" });
    putScopedItem("events", alice, { id: aliceId, scope: "personal", name: "Alice therapy" });
    putScopedItem("events", bob, { id: bobId, scope: "personal", name: "Bob interview" });

    const bobSees = getScopedItems("events", bob).map((e: any) => e.id);
    assert.ok(bobSees.includes(jointId));
    assert.ok(bobSees.includes(bobId));
    assert.equal(bobSees.includes(aliceId), false, "Bob must not see Alice's personal event");
  });

  test("a missing id is undefined, not a throw", () => {
    assert.equal(getScopedItem("shopping_lists", alice, "list-does-not-exist"), undefined);
  });
});

describe("scoping: writes are guarded too, not just reads", () => {
  test("one member cannot overwrite the other's personal row", () => {
    // The asymmetry putScopedItemAs's comment describes: reads and deletes were
    // always guarded, this write path was not. Budgets are keyed by CATEGORY,
    // so the id to aim at is guessable -- this is reachable, not theoretical.
    const id = newId("list");
    putScopedItem("shopping_lists", alice, { id, scope: "personal", name: "Alice's list" });

    const wrote = putScopedItem("shopping_lists", bob, { id, scope: "personal", name: "Hijacked" });

    assert.equal(wrote, false, "the write must be refused and say so");
    assert.equal(getScopedItem("shopping_lists", alice, id).name, "Alice's list");
  });

  test("a refused write cannot flip someone's personal row to joint", () => {
    const id = newId("list");
    putScopedItem("shopping_lists", alice, { id, scope: "personal", name: "Private" });

    assert.equal(putScopedItem("shopping_lists", bob, { id, scope: "joint", name: "Now ours" }), false);
    assert.equal(getScopedItem("shopping_lists", bob, id), undefined, "still invisible to Bob");
  });

  test("either member may write a joint row", () => {
    const id = newId("list");
    assert.equal(putScopedItem("shopping_lists", alice, { id, scope: "joint", name: "Ours" }), true);
    assert.equal(putScopedItem("shopping_lists", bob, { id, scope: "joint", name: "Ours, edited" }), true);
    assert.equal(getScopedItem("shopping_lists", alice, id).name, "Ours, edited");
  });

  test("a row with no scope defaults to joint", () => {
    const id = newId("list");
    putScopedItem("shopping_lists", alice, { id, name: "Unscoped" });
    assert.ok(getScopedItem("shopping_lists", bob, id), "an unscoped row should be shared, not orphaned");
  });

  test("putScopedItemAs keys budgets by category rather than id", () => {
    assert.equal(putScopedItemAs("budgets", alice, "Groceries", { category: "Groceries", limit: 600, scope: "joint" }), true);
    assert.equal(getScopedItem("budgets", bob, "Groceries").limit, 600);
  });

  test("one member cannot delete the other's personal row", () => {
    const id = newId("list");
    putScopedItem("shopping_lists", alice, { id, scope: "personal", name: "Alice only" });

    assert.equal(deleteScopedItem("shopping_lists", bob, id), false);
    assert.ok(getScopedItem("shopping_lists", alice, id), "still there after a refused delete");

    assert.equal(deleteScopedItem("shopping_lists", alice, id), true);
    assert.equal(getScopedItem("shopping_lists", alice, id), undefined);
  });

  test("deleting something already gone reports false rather than throwing", () => {
    assert.equal(deleteScopedItem("shopping_lists", alice, "list-never-existed"), false);
  });
});

describe("merchant rules are per-member", () => {
  test("one member's rule never matches against the other's data", () => {
    // "This is my lunch spot" must not silently recategorize the other
    // member's transactions at the same merchant.
    upsertMerchantRule(alice, "Chipotle", "Eating Out");

    assert.equal(matchMerchantRule(alice, "CHIPOTLE 2481 CHICAGO IL")?.category, "Eating Out");
    assert.equal(matchMerchantRule(bob, "CHIPOTLE 2481 CHICAGO IL"), undefined);
  });

  test("the most specific matching rule wins", () => {
    upsertMerchantRule(alice, "AMZN", "Shopping");
    upsertMerchantRule(alice, "AMZN MKTPLC", "Groceries");
    assert.equal(matchMerchantRule(alice, "AMZN MKTPLC US*1A2B3")?.category, "Groceries");
  });

  test("upsert replaces rather than duplicates, case-insensitively", () => {
    upsertMerchantRule(bob, "Costco", "Groceries");
    upsertMerchantRule(bob, "COSTCO", "Shopping");

    const rules = getMerchantRules(bob);
    assert.equal(rules.filter((r) => r.merchantKey === "costco").length, 1);
    assert.equal(matchMerchantRule(bob, "COSTCO WHSE #1104")?.category, "Shopping");
  });

  test("forgetting a rule removes it", () => {
    upsertMerchantRule(bob, "Shell", "Gas & Transport");
    deleteMerchantRule(bob, "shell");
    assert.equal(matchMerchantRule(bob, "SHELL OIL 574"), undefined);
  });
});

describe("plaidItemKey", () => {
  test("is stable, and is not the token itself", () => {
    // It becomes a primary key and can land in a query log, so it must not be
    // the access token in disguise.
    const token = "access-production-cursorkey";
    const key = plaidItemKey(token);
    assert.equal(key, plaidItemKey(token));
    assert.equal(key.includes(token), false);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  test("different tokens give different keys", () => {
    assert.notEqual(plaidItemKey("access-production-a"), plaidItemKey("access-production-b"));
  });
});

describe("app_config", () => {
  test("returns the fallback when unset, and round-trips structured values", () => {
    assert.equal(getConfig("nothing_here", "fallback"), "fallback");
    setConfig("budget.categories", ["Groceries", "Gas & Transport"]);
    assert.deepEqual(getConfig("budget.categories", []), ["Groceries", "Gas & Transport"]);
  });

  test("setConfig overwrites rather than accumulating", () => {
    setConfig("lock_timeout_kiosk_minutes", 5);
    setConfig("lock_timeout_kiosk_minutes", 15);
    assert.equal(getConfig("lock_timeout_kiosk_minutes", 5), 15);
  });

  test("a stored null is returned as null, not as the fallback", () => {
    // How the PIN is cleared (routes/lock.ts's DELETE /pin sets it to null) --
    // if this came back as the fallback, removing the PIN would be a no-op.
    setConfig("lock_pin_hash", null);
    assert.equal(getConfig("lock_pin_hash", "some-hash"), null);
  });
});

describe("users", () => {
  test("lookup is by exact username", () => {
    assert.equal(getUserByUsername("alice-test")?.id, alice);
    assert.equal(getUserByUsername("nobody-test"), undefined);
  });

  test("defaults to role parent when none is given", () => {
    assert.equal(getUserByUsername("alice-test")?.role, "parent");
  });

  test("an explicit admin role round-trips", () => {
    const id = createUser("admin-db-test", "not-a-real-hash", "Admin", "admin");
    assert.equal(getUserByUsername("admin-db-test")?.role, "admin");
    assert.equal(id, getUserByUsername("admin-db-test")?.id);
  });

  test("a leftover 'member'-role row is normalized by the migration's own SQL", () => {
    // Simulates an install from before the admin tier existed: a raw row still
    // sitting with role='member' at boot gets rewritten to 'parent'. db.ts's
    // migration runs once at module load, so this re-runs its exact statement
    // against the same connection rather than reimporting the module.
    db.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, created_at, role) VALUES (?, ?, ?, ?, ?, 'member')`
    ).run("user-leftover-member-test", "leftover-member-test", "not-a-real-hash", "Leftover", new Date().toISOString());

    db.exec(`UPDATE users SET role = 'parent' WHERE role = 'member'`);

    assert.equal(getUserByUsername("leftover-member-test")?.role, "parent");
  });

  describe("role: kiosk", () => {
    after(deleteKioskUser);

    test("getHouseholdMemberCount only counts admin+parent -- a kiosk account doesn't take a household slot", () => {
      const before = getHouseholdMemberCount();
      createUser("kiosk-db-test", "not-a-real-hash", "Kiosk", "kiosk");
      assert.equal(getHouseholdMemberCount(), before, "creating a kiosk account must not move the member count");
      assert.equal(getUserCount("kiosk"), 1);
    });

    test("getKioskUser finds it by role, not by a known id", () => {
      const kiosk = getKioskUser();
      assert.equal(kiosk?.username, "kiosk-db-test");
      assert.equal(kiosk?.role, "kiosk");
    });

    test("deleteKioskUser removes it and leaves member accounts alone", () => {
      deleteKioskUser();
      assert.equal(getKioskUser(), undefined);
      assert.equal(getUserByUsername("alice-test")?.id, alice, "unrelated member account must survive");
    });
  });
});

describe("newId", () => {
  test("is prefixed and unique", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("list")));
    assert.equal(ids.size, 500);
    assert.ok([...ids][0].startsWith("list-"));
  });
});
