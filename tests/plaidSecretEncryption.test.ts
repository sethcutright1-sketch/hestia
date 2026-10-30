// The Plaid client secret in app_config `budget.plaid` is stored encrypted (the project notes
// 10.6), and one saved before that is encrypted once at boot. The database is copied into every
// nightly backup and every admin download, and this secret is what makes a leaked access token
// usable again.
//
// The boot migration is tested as a real boot: a plaintext secret is written into the throwaway
// database BEFORE db.ts is imported for the first time, the way an existing live database looks
// on the first start after this ships.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";

import { TEST_DB_PATH, loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const OLD_PLAINTEXT = "plaintext-secret-from-before";
{
  // Only app_config, with exactly db.ts's columns; CREATE TABLE IF NOT EXISTS leaves it be.
  const raw = new DatabaseSync(TEST_DB_PATH);
  raw.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  raw.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)`).run(
    "budget.plaid",
    JSON.stringify({ clientId: "client-1", secret: OLD_PLAINTEXT, environment: "sandbox" })
  );
  raw.close();
}

const { db, createUser, getConfig, setConfig, decryptSecret, encryptStoredPlaidSecret } = await loadDb();
const { budgetPlaidRoutes } = await import("../routes/budget-plaid.ts");

const PASSWORD = "correct horse battery";
let admin: string;
let server: http.Server;
let lastPlaidBody: any;

before(async () => {
  admin = createUser("admin-plaid-secret", await bcrypt.hash(PASSWORD, 4), "Admin", "admin");
  // A stand-in for Plaid, to see which secret actually goes out on the wire.
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastPlaidBody = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ link_token: "link-sandbox-test" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.PLAID_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.PLAID_API_BASE;
  cleanupDb();
});

/** The raw text in the database, as a backup file would carry it. */
function rawPlaidRow(): string {
  return (db.prepare(`SELECT value FROM app_config WHERE key = 'budget.plaid'`).get() as { value: string }).value;
}

describe("the boot migration", () => {
  test("encrypted a plaintext secret the first time db.ts loaded", () => {
    const stored = getConfig("budget.plaid", null);
    assert.match(stored.secret, /^enc:v1:/);
    assert.equal(decryptSecret(stored.secret), OLD_PLAINTEXT);
    assert.equal(stored.clientId, "client-1", "the rest of the config is untouched");
    assert.equal(stored.environment, "sandbox");
    assert.ok(!rawPlaidRow().includes(OLD_PLAINTEXT));
  });

  test("is idempotent: running again changes nothing", () => {
    const before = rawPlaidRow();
    assert.equal(encryptStoredPlaidSecret(), "unchanged");
    assert.equal(rawPlaidRow(), before, "not even a fresh IV");
  });

  test("leaves a missing config, or an empty secret, alone", () => {
    const saved = getConfig("budget.plaid", null);
    try {
      setConfig("budget.plaid", null);
      assert.equal(encryptStoredPlaidSecret(), "unchanged");
      setConfig("budget.plaid", { clientId: "x", secret: "", environment: "sandbox" });
      assert.equal(encryptStoredPlaidSecret(), "unchanged");
      assert.equal(getConfig("budget.plaid", null).secret, "");
    } finally {
      setConfig("budget.plaid", saved);
    }
  });

  test("without a key it leaves the value and doesn't throw, so the server still starts", () => {
    const saved = getConfig("budget.plaid", null);
    const key = process.env.DB_ENCRYPTION_KEY;
    try {
      setConfig("budget.plaid", { clientId: "x", secret: "still-plain", environment: "sandbox" });
      delete process.env.DB_ENCRYPTION_KEY;
      assert.equal(encryptStoredPlaidSecret(), "no-key");
      assert.equal(getConfig("budget.plaid", null).secret, "still-plain");
    } finally {
      process.env.DB_ENCRYPTION_KEY = key;
      setConfig("budget.plaid", saved);
    }
  });
});

describe("POST /configure", () => {
  const configure = (body: any) => callRoute(budgetPlaidRoutes, "POST", "/configure", { session: { userId: admin }, body });

  test("stores the new secret encrypted, never in the clear", async () => {
    const result = await configure({ clientId: "client-2", secret: "brand-new-secret", environment: "production", password: PASSWORD });
    assert.equal(result.status, 200);
    assert.ok(!rawPlaidRow().includes("brand-new-secret"));
    const stored = getConfig("budget.plaid", null);
    assert.match(stored.secret, /^enc:v1:/);
    assert.equal(decryptSecret(stored.secret), "brand-new-secret");
  });

  test("refuses rather than saving in the clear when the key is missing", async () => {
    const before = rawPlaidRow();
    const key = process.env.DB_ENCRYPTION_KEY;
    delete process.env.DB_ENCRYPTION_KEY;
    try {
      const result = await configure({ clientId: "client-3", secret: "would-be-plain", environment: "sandbox", password: PASSWORD });
      assert.equal(result.status, 500);
      assert.ok(!JSON.stringify(result.body).includes("would-be-plain"));
    } finally {
      process.env.DB_ENCRYPTION_KEY = key;
    }
    assert.equal(rawPlaidRow(), before, "nothing was written");
  });
});

describe("using the stored secret", () => {
  test("Plaid is sent the decrypted secret, not the enc:v1: text", async () => {
    await callRoute(budgetPlaidRoutes, "POST", "/configure", {
      session: { userId: admin },
      body: { clientId: "client-4", secret: "wire-secret", environment: "sandbox", password: PASSWORD },
    });
    const result = await callRoute(budgetPlaidRoutes, "POST", "/create_link_token", { session: { userId: admin } });
    assert.equal(result.status, 200);
    assert.equal(lastPlaidBody.client_id, "client-4");
    assert.equal(lastPlaidBody.secret, "wire-secret");
  });

  test("GET /status reports configured without needing the key", async () => {
    const key = process.env.DB_ENCRYPTION_KEY;
    delete process.env.DB_ENCRYPTION_KEY;
    try {
      const result = await callRoute(budgetPlaidRoutes, "GET", "/status", { session: { userId: admin } });
      assert.equal(result.status, 200);
      assert.equal(result.body.configured, true);
      assert.equal(result.body.environment, "sandbox");
    } finally {
      process.env.DB_ENCRYPTION_KEY = key;
    }
  });
});
