// A throwaway database for one test file.
//
// Importing this module FIRST -- before anything that reaches db.ts -- is what
// makes it work, so every test file that uses it does:
//
//     import { loadDb, cleanupDb } from "./helpers/testdb.ts";
//     const db = await loadDb();          // dynamic, never a static import
//
// The ordering rule is the same one env.ts and scripts/seed-dev-db.ts already
// document: db.ts reads process.env.DB_PATH in its own top-level code, and ES
// module imports are fully evaluated before the importing module's statements
// run. A static `import ... from "../db.ts"` anywhere in a test file would
// therefore open the REAL database before the override below ever executed.
// Dynamic import() is what defers it to after these assignments.

// env.ts explicitly and first: dotenv loads .env.local with override: true, so
// an assignment made before that load would be clobbered back to whatever
// .env.local says for DB_PATH.
import "../../env.ts";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Unique per test file: `node --test` gives each file its own process, and the
 *  random suffix means two of them can never collide even if pids are reused. */
export const TEST_DB_PATH = path.join(
  "data",
  `test-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`
);

process.env.DB_PATH = TEST_DB_PATH;

// Set here rather than read from .env.local, so these tests pass on a fresh
// checkout with no key configured and never touch the real one.
process.env.DB_ENCRYPTION_KEY = "0".repeat(64);

// No test may reach a real Ollama: the recipe calorie flow (nutrition/recipeAi.ts) treats this as
// "no local model", and a test that wants one installs a fake with setRecipeModel().
process.env.HOUSEHOLD_LOCAL_MODEL = "off";

// Nor the real USDA key from a developer's .env.local: a test that wants the USDA step passes a key itself.
delete process.env.FDC_API_KEY;

// Nor Kroger with the developer's real app keys: kroger.ts reports "not set up" without these, and
// tests/kroger.test.ts sets fake ones and a fake fetch.
delete process.env.KROGER_CLIENT_ID;
delete process.env.KROGER_CLIENT_SECRET;
delete process.env.KROGER_REDIRECT_URI;
delete process.env.KROGER_API_BASE;

type DbModule = typeof import("../../db.ts");

let loaded: DbModule | undefined;

/** Imports db.ts against the throwaway path, and asserts it actually took. */
export async function loadDb(): Promise<DbModule> {
  if (loaded) return loaded;
  const mod = await import("../../db.ts");
  if (path.resolve(mod.DB_PATH) !== path.resolve(TEST_DB_PATH)) {
    // A guard, not a formality. If the override silently failed, every test
    // below would start writing fixtures into the real household.db.
    throw new Error(
      `refusing to run: DB_PATH resolved to ${mod.DB_PATH}, not the throwaway ${TEST_DB_PATH}`
    );
  }
  loaded = mod;
  return mod;
}

/** Closes the handle and removes the file. Call from an `after()` hook.
 *  Windows will not unlink a file that still has an open handle, so the close
 *  is required there -- on Linux/macOS the unlink would succeed either way. */
export function cleanupDb(): void {
  try {
    loaded?.db.close();
  } catch {
    // Already closed, or never opened. Nothing to do.
  }
  for (const leftover of [TEST_DB_PATH, `${TEST_DB_PATH}-journal`]) {
    // Best-effort: a leftover throwaway file is untidy, not a test failure.
    try {
      if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
    } catch (err) {
      console.error(`Could not remove ${leftover}:`, err);
    }
  }
}
