// Changes DB_ENCRYPTION_KEY: re-encrypts every bank token and the Plaid secret with a new key, in
// one transaction, and checks every value decrypts with the new key before committing. The logic
// is keyRotation.ts; this file adds the keys, the backup, the safety checks and .env.local.
//
// Run from the app folder, with the app STOPPED (scripts/stop-everything.ps1). PowerShell:
//
//   $env:NEW_DB_ENCRYPTION_KEY = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
//   npx tsx scripts/rotate-encryption-key.ts            # dry run: checks everything, writes nothing
//   npx tsx scripts/rotate-encryption-key.ts --apply    # backup, re-encrypt, verify, commit, update .env.local
//   Remove-Item Env:NEW_DB_ENCRYPTION_KEY
//
// Keys come only from environment variables, never from the command line (it ends up in shell
// history and process lists), and are never printed:
//   NEW_DB_ENCRYPTION_KEY  required, 64 hex characters
//   OLD_DB_ENCRYPTION_KEY  optional; defaults to DB_ENCRYPTION_KEY from .env.local
// The database is the one the app uses from this folder (DB_PATH in .env.local, else
// data/household.db).
//
// With --apply, after the commit it rewrites the DB_ENCRYPTION_KEY line in .env.local to the new
// key (pass --no-env-update to do that by hand), because a database under the new key and an app
// still holding the old one can't read a single bank token.
import "../env.ts";

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseKey } from "../secretBox.ts";
import { applyRotation, dryRunRotation, RotationError, type RotationReport } from "../keyRotation.ts";
import { setEnvFileValue } from "./envFile.ts";

const apply = process.argv.includes("--apply");
const updateEnv = !process.argv.includes("--no-env-update");
const ENV_FILE = path.join(process.cwd(), ".env.local");

function fail(message: string): never {
  console.error(`\nNot done: ${message}`);
  process.exit(1);
}

function secretState(state: RotationReport["plaidSecret"]): string {
  return state === "none" ? "none saved" : state === "rotated" ? "re-encrypted" : "was plaintext, now encrypted";
}

function describe(report: RotationReport): string {
  return [
    `  bank tokens re-encrypted:           ${report.bankTokens}`,
    `  bank tokens that were plaintext:    ${report.plaintextBankTokens} (encrypted with the new key)`,
    `  bank connections with no token:     ${report.rowsWithoutToken}`,
    `  Plaid secret:                       ${secretState(report.plaidSecret)}`,
    `  Kroger sign-in token:               ${secretState(report.krogerToken)}`,
    `  encrypted values in the database:   ${report.encryptedValuesFound} (all accounted for)`,
  ].join("\n");
}

/** True if something answers on the app's port. Writing under a running app would race its
 *  own writes, and it would keep using the old key until restarted. */
async function appIsRunning(): Promise<boolean> {
  const port = Number(process.env.PORT) || 3200;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(process.cwd(), "data", "household.db");
  if (!fs.existsSync(dbPath)) fail(`no database at ${dbPath}.`);

  const oldSource = process.env.OLD_DB_ENCRYPTION_KEY ? "OLD_DB_ENCRYPTION_KEY" : "DB_ENCRYPTION_KEY";
  let oldKey: Buffer;
  let newKey: Buffer;
  try {
    oldKey = parseKey(process.env.OLD_DB_ENCRYPTION_KEY || process.env.DB_ENCRYPTION_KEY, oldSource);
    newKey = parseKey(process.env.NEW_DB_ENCRYPTION_KEY, "NEW_DB_ENCRYPTION_KEY");
  } catch (err: any) {
    fail(err.message);
  }
  const newKeyHex = process.env.NEW_DB_ENCRYPTION_KEY!.trim().toLowerCase();

  console.log(apply ? "Rotating the encryption key (--apply)." : "Dry run: nothing will be written. Add --apply to rotate.");
  console.log(`  database: ${dbPath}`);
  console.log(`  old key from ${oldSource}, new key from NEW_DB_ENCRYPTION_KEY (values not shown)`);

  if (await appIsRunning()) {
    if (apply) fail(`the app is answering on port ${Number(process.env.PORT) || 3200}. Stop it first (scripts/stop-everything.ps1).`);
    console.log(`  note: the app is running on port ${Number(process.env.PORT) || 3200}; stop it before --apply.`);
  }

  if (!apply) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const report = dryRunRotation(db, oldKey, newKey);
      console.log(`\nEverything checks out. With --apply this would do:\n${describe(report)}`);
    } catch (err) {
      fail(err instanceof RotationError ? err.message : String(err));
    } finally {
      db.close();
    }
    return;
  }

  // Backup first. pruneOldBackups (db.ts) only deletes household-YYYY-MM-DD.db, so this one stays
  // until it's deleted by hand. It's under the OLD key, so delete it once the app works again.
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `household-pre-key-rotation-${stamp}.db`);
  fs.copyFileSync(dbPath, backupPath);
  console.log(`  backup: ${backupPath}`);

  const db = new DatabaseSync(dbPath);
  let report: RotationReport;
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    report = applyRotation(db, oldKey, newKey);
  } catch (err) {
    db.close();
    fail(`${err instanceof RotationError ? err.message : String(err)}\nThe transaction was rolled back; the database is unchanged.`);
  }
  // The old ciphertexts sit in freed pages until something overwrites them, and the old key is
  // the leaked one. VACUUM rewrites the file from live rows only.
  try {
    db.exec("VACUUM");
  } catch (err) {
    console.error("  warning: VACUUM failed (the rotation itself is committed):", err);
  }
  db.close();
  console.log(`\nDone. The database now uses the new key:\n${describe(report)}`);

  if (updateEnv) {
    try {
      setEnvFileValue(ENV_FILE, "DB_ENCRYPTION_KEY", newKeyHex);
      console.log(`\n.env.local now has the new DB_ENCRYPTION_KEY (${ENV_FILE}).`);
    } catch (err) {
      console.error(`\nCOULD NOT update ${ENV_FILE}: ${err}`);
      console.error("Set DB_ENCRYPTION_KEY there to the value of NEW_DB_ENCRYPTION_KEY by hand BEFORE starting the app.");
      process.exit(1);
    }
  } else {
    console.log("\n--no-env-update: set DB_ENCRYPTION_KEY in .env.local to the value of NEW_DB_ENCRYPTION_KEY before starting the app.");
  }
  console.log("Next: start the app and check Budget → bank sync. Then delete the backup above and run:");
  console.log("  Remove-Item Env:NEW_DB_ENCRYPTION_KEY");
}

main();
