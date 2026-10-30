// keyRotation.ts and scripts/rotate-encryption-key.ts -- changing DB_ENCRYPTION_KEY without
// losing a single bank token. The live key is in an old backup zip (security audit 2026-10-16,
// A2), so this runs once on the live database: it has to be right the first time, it has to
// stop rather than half-finish, and it must never print a secret.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { db, putScopedItemAs, setConfig, getConfig, encryptSecret, DB_PATH } = await loadDb();
const { dryRunRotation, applyRotation, countEncryptedValues, RotationError } = await import("../keyRotation.ts");
const { parseKey, decryptWithKey, encryptWithKey } = await import("../secretBox.ts");

const OLD_HEX = process.env.DB_ENCRYPTION_KEY!; // testdb.ts's "000..."
const OLD = parseKey(OLD_HEX, "old");
const newHex = () => crypto.randomBytes(32).toString("hex");

const TOKENS = ["access-sandbox-aaa", "access-sandbox-bbb", "access-production-ccc"];
const PLAID_SECRET = "plaid-secret-xyz";

/** Puts the database back to: 3 tokens + the Plaid secret, all under the old key, and no Kroger sign-in. */
function seed() {
  db.exec(`DELETE FROM bank_connections`);
  db.exec(`DELETE FROM app_config WHERE key = 'grocery.kroger'`);
  TOKENS.forEach((token, i) => putScopedItemAs("bank_connections", "", `bank-${i}`, { id: `bank-${i}`, institution: `Bank ${i}` }, token));
  // A manually-added account with no Plaid token at all.
  putScopedItemAs("bank_connections", "", "manual-1", { id: "manual-1", institution: "Cash" });
  setConfig("budget.plaid", { clientId: "client", secret: encryptSecret(PLAID_SECRET), environment: "sandbox" });
}

function readAll(key: Buffer): { tokens: string[]; secret: string } {
  const rows = db.prepare(`SELECT data FROM bank_connections WHERE item_id LIKE 'bank-%' ORDER BY item_id`).all() as { data: string }[];
  return {
    tokens: rows.map((r) => decryptWithKey(JSON.parse(r.data).accessToken, key)),
    secret: decryptWithKey(getConfig("budget.plaid", null).secret, key),
  };
}

const snapshot = () => JSON.stringify(db.prepare(`SELECT * FROM bank_connections ORDER BY item_id`).all()) + JSON.stringify(getConfig("budget.plaid", null));

after(cleanupDb);

describe("dry run", () => {
  test("checks everything and writes nothing", () => {
    seed();
    const before = snapshot();
    const report = dryRunRotation(db, OLD, parseKey(newHex(), "new"));
    assert.deepEqual(report, {
      bankTokens: 3,
      plaintextBankTokens: 0,
      rowsWithoutToken: 1,
      plaidSecret: "rotated",
      krogerToken: "none",
      encryptedValuesFound: 4,
      applied: false,
    });
    assert.equal(snapshot(), before);
  });

  test("a wrong old key is caught before anything happens", () => {
    seed();
    assert.throws(() => dryRunRotation(db, parseKey(newHex(), "x"), parseKey(newHex(), "y")), RotationError);
  });

  test("the same key twice is refused", () => {
    seed();
    assert.throws(() => dryRunRotation(db, OLD, OLD), /same as the old key/);
  });
});

describe("apply", () => {
  test("every value decrypts with the new key, to what it was, and no longer with the old one", () => {
    seed();
    const NEW = parseKey(newHex(), "new");
    const report = applyRotation(db, OLD, NEW);
    assert.equal(report.applied, true);
    assert.equal(report.bankTokens, 3);

    assert.deepEqual(readAll(NEW), { tokens: TOKENS, secret: PLAID_SECRET });
    assert.throws(() => readAll(OLD), "the old key must not open anything any more");
    assert.equal(countEncryptedValues(db).total, 4);
  });

  test("the rest of each row is untouched", () => {
    seed();
    applyRotation(db, OLD, parseKey(newHex(), "new"));
    const row = JSON.parse((db.prepare(`SELECT data FROM bank_connections WHERE item_id = 'bank-1'`).get() as { data: string }).data);
    assert.equal(row.institution, "Bank 1");
    const manual = JSON.parse((db.prepare(`SELECT data FROM bank_connections WHERE item_id = 'manual-1'`).get() as { data: string }).data);
    assert.deepEqual(manual, { id: "manual-1", institution: "Cash" });
    assert.equal(getConfig("budget.plaid", null).clientId, "client");
  });

  test("a plaintext token or secret left from before encryption is encrypted with the new key", () => {
    seed();
    db.prepare(`UPDATE bank_connections SET data = ? WHERE item_id = 'bank-0'`).run(JSON.stringify({ id: "bank-0", accessToken: TOKENS[0] }));
    setConfig("budget.plaid", { clientId: "client", secret: PLAID_SECRET, environment: "sandbox" });

    const NEW = parseKey(newHex(), "new");
    const report = applyRotation(db, OLD, NEW);
    assert.equal(report.plaintextBankTokens, 1);
    assert.equal(report.bankTokens, 2);
    assert.equal(report.plaidSecret, "encrypted");
    assert.deepEqual(readAll(NEW), { tokens: TOKENS, secret: PLAID_SECRET });
  });

  test("one token under a different key stops the whole rotation, and nothing changes", () => {
    seed();
    const stray = encryptWithKey("access-sandbox-stray", parseKey(newHex(), "other"));
    db.prepare(`UPDATE bank_connections SET data = ? WHERE item_id = 'bank-2'`).run(JSON.stringify({ id: "bank-2", accessToken: stray }));
    const before = snapshot();

    assert.throws(() => applyRotation(db, OLD, parseKey(newHex(), "new")), /does not decrypt with the old key/);
    assert.equal(snapshot(), before, "rolled back");
  });

  test("an encrypted value somewhere it doesn't know about is refused, not orphaned", () => {
    seed();
    setConfig("some.future.secret", encryptSecret("future"));
    const before = snapshot();
    try {
      assert.throws(() => applyRotation(db, OLD, parseKey(newHex(), "new")), /app_config\.value: 2/);
      assert.equal(snapshot(), before);
    } finally {
      db.prepare(`DELETE FROM app_config WHERE key = 'some.future.secret'`).run();
    }
  });

  test("errors never carry a token or the secret", () => {
    seed();
    try {
      applyRotation(db, parseKey(newHex(), "wrong"), parseKey(newHex(), "new"));
      assert.fail("expected a throw");
    } catch (err: any) {
      for (const secret of [...TOKENS, PLAID_SECRET, OLD_HEX]) assert.ok(!String(err.message).includes(secret));
    }
  });
});

describe("the household's Kroger sign-in (app_config grocery.kroger)", () => {
  const KROGER_TOKEN = "kroger-refresh-token-abc";
  const STORE = { locationId: "01400513", name: "Kroger", address: "100 E Court St" };

  test("is re-encrypted with everything else, and the rest of the config is untouched", () => {
    seed();
    setConfig("grocery.kroger", { refreshToken: encryptSecret(KROGER_TOKEN), connectedAt: "2026-10-16T00:00:00.000Z", store: STORE });
    const NEW = parseKey(newHex(), "new");

    const report = applyRotation(db, OLD, NEW);
    assert.equal(report.krogerToken, "rotated");
    assert.equal(report.encryptedValuesFound, 5);
    const config = getConfig("grocery.kroger", null);
    assert.equal(decryptWithKey(config.refreshToken, NEW), KROGER_TOKEN);
    assert.throws(() => decryptWithKey(config.refreshToken, OLD));
    assert.deepEqual(config.store, STORE);
    assert.equal(config.connectedAt, "2026-10-16T00:00:00.000Z");
  });

  test("a store chosen with no sign-in is fine: nothing to rotate there", () => {
    seed();
    setConfig("grocery.kroger", { store: STORE });
    const report = dryRunRotation(db, OLD, parseKey(newHex(), "new"));
    assert.equal(report.krogerToken, "none");
  });

  test("a Kroger token under some other key stops the whole rotation", () => {
    seed();
    setConfig("grocery.kroger", { refreshToken: encryptWithKey(KROGER_TOKEN, parseKey(newHex(), "other")) });
    const before = snapshot() + JSON.stringify(getConfig("grocery.kroger", null));
    assert.throws(() => applyRotation(db, OLD, parseKey(newHex(), "new")), /Kroger sign-in token does not decrypt/);
    assert.equal(snapshot() + JSON.stringify(getConfig("grocery.kroger", null)), before, "rolled back");
  });
});

describe("scripts/rotate-encryption-key.ts, run the way Alex will run it", () => {
  const script = fileURLToPath(new URL("../scripts/rotate-encryption-key.ts", import.meta.url));
  const tsx = import.meta.resolve("tsx");
  let dir: string;
  let dbFile: string;

  before(() => {
    seed();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "key-rotation-"));
    dbFile = path.join(dir, "household.db");
    // A file copy of the seeded test database, the way a real household.db sits on disk.
    db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
    assert.ok(path.resolve(DB_PATH) !== path.resolve(dbFile));
    // An app folder of its own: .env.local holds the old key, as on D:. A port nothing listens on.
    fs.writeFileSync(path.join(dir, ".env.local"), `# test\r\nPORT=1\r\nDB_ENCRYPTION_KEY=${OLD_HEX}\r\nSESSION_SECRET=keep-me\r\n`);
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], env: Record<string, string | undefined>) {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    // Nothing from this test process may leak in: the script must find its key in .env.local.
    delete childEnv.DB_ENCRYPTION_KEY;
    delete childEnv.PORT;
    childEnv.DB_PATH = dbFile;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
    const r = spawnSync(process.execPath, ["--import", tsx, script, ...args], { cwd: dir, env: childEnv, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  }

  const openFile = () => new DatabaseSync(dbFile, { readOnly: true });
  const fileTokens = (key: Buffer) => {
    const f = openFile();
    try {
      return (f.prepare(`SELECT data FROM bank_connections WHERE item_id LIKE 'bank-%' ORDER BY item_id`).all() as { data: string }[]).map((r) =>
        decryptWithKey(JSON.parse(r.data).accessToken, key)
      );
    } finally {
      f.close();
    }
  };

  test("refuses without NEW_DB_ENCRYPTION_KEY, naming the variable but no value", () => {
    const r = run([], { NEW_DB_ENCRYPTION_KEY: undefined });
    assert.equal(r.code, 1);
    assert.match(r.out, /NEW_DB_ENCRYPTION_KEY is not set/);
    assert.ok(!r.out.includes(OLD_HEX));
  });

  test("dry run by default: reports, writes nothing, prints no key", () => {
    const newKey = newHex();
    const before = fs.readFileSync(dbFile);
    const r = run([], { NEW_DB_ENCRYPTION_KEY: newKey });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Dry run/);
    assert.match(r.out, /bank tokens re-encrypted:\s+3/);
    assert.ok(fs.readFileSync(dbFile).equals(before), "the database file is byte-for-byte the same");
    assert.ok(!fs.existsSync(path.join(dir, "backups")), "no backup for a dry run");
    for (const secret of [newKey, OLD_HEX, ...TOKENS, PLAID_SECRET]) assert.ok(!r.out.includes(secret), "no secret in the output");
  });

  test("--apply: backs up, rotates, verifies, and moves .env.local to the new key", () => {
    const newKey = newHex();
    const r = run(["--apply"], { NEW_DB_ENCRYPTION_KEY: newKey });
    assert.equal(r.code, 0, r.out);
    for (const secret of [newKey, OLD_HEX, ...TOKENS, PLAID_SECRET]) assert.ok(!r.out.includes(secret), "no secret in the output");

    assert.deepEqual(fileTokens(parseKey(newKey, "new")), TOKENS);

    const backups = fs.readdirSync(path.join(dir, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^household-pre-key-rotation-.*\.db$/);
    const backup = new DatabaseSync(path.join(dir, "backups", backups[0]), { readOnly: true });
    const backupToken = JSON.parse((backup.prepare(`SELECT data FROM bank_connections WHERE item_id = 'bank-0'`).get() as { data: string }).data).accessToken;
    backup.close();
    assert.equal(decryptWithKey(backupToken, OLD), TOKENS[0], "the backup is the database as it was");

    const env = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.equal(env, `# test\r\nPORT=1\r\nDB_ENCRYPTION_KEY=${newKey}\r\nSESSION_SECRET=keep-me\r\n`, "only the key line changed");
    fs.rmSync(path.join(dir, "backups"), { recursive: true });
  });

  test("once rotated, the old key opens nothing: a second run with it is refused and rolled back", () => {
    const r = run(["--apply"], { OLD_DB_ENCRYPTION_KEY: OLD_HEX, NEW_DB_ENCRYPTION_KEY: newHex() });
    assert.equal(r.code, 1);
    assert.match(r.out, /does not decrypt with the old key/);
    assert.match(r.out, /rolled back/);
  });

  test("refuses --apply while the app is answering on its port", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = String((server.address() as import("node:net").AddressInfo).port);
      const before = fs.readFileSync(dbFile);
      // PORT from the shell wins over .env.local's (env.ts), the same as for the app itself.
      const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
        // spawnSync would block this process's event loop, and with it the server it must reach.
        import("node:child_process").then(({ spawn }) => {
          const childEnv: Record<string, string> = {};
          for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
          delete childEnv.DB_ENCRYPTION_KEY;
          Object.assign(childEnv, { DB_PATH: dbFile, PORT: port, NEW_DB_ENCRYPTION_KEY: newHex() });
          const child = spawn(process.execPath, ["--import", tsx, script, "--apply"], { cwd: dir, env: childEnv });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (out += d));
          child.on("close", (code) => resolve({ code, out }));
        });
      });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Stop it first/);
      assert.ok(fs.readFileSync(dbFile).equals(before));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("scripts/new-session-secret.ts and the .env.local writer", () => {
  const script = fileURLToPath(new URL("../scripts/new-session-secret.ts", import.meta.url));
  const tsx = import.meta.resolve("tsx");

  test("writes a fresh 64-hex SESSION_SECRET in place, prints no value, keeps the other lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-secret-"));
    try {
      const file = path.join(dir, ".env.local");
      fs.writeFileSync(file, "PORT=3200\r\nSESSION_SECRET=old-leaked-value\r\nDB_ENCRYPTION_KEY=abc\r\n");
      const r = spawnSync(process.execPath, ["--import", tsx, script], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);

      const lines = fs.readFileSync(file, "utf8").split("\r\n");
      assert.equal(lines[0], "PORT=3200");
      assert.equal(lines[2], "DB_ENCRYPTION_KEY=abc");
      const value = lines[1].replace(/^SESSION_SECRET=/, "");
      assert.match(value, /^[0-9a-f]{64}$/);
      assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value), "the new value is never printed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the writer appends a missing line, and drops a BOM PowerShell may have added", async () => {
    const { setEnvFileValue } = await import("../scripts/envFile.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-file-"));
    try {
      const file = path.join(dir, ".env.local");
      fs.writeFileSync(file, "﻿PORT=3200\n");
      setEnvFileValue(file, "SESSION_SECRET", "x");
      assert.equal(fs.readFileSync(file, "utf8"), "PORT=3200\nSESSION_SECRET=x\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
