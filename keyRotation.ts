// Re-encrypts every stored secret from one DB_ENCRYPTION_KEY to another. The logic behind
// scripts/rotate-encryption-key.ts, kept free of side effects (no env, no backups, no printing) so
// the tests can drive it against a throwaway database.
//
// What it rotates -- every place the app writes an `enc:v1:` value:
//   - bank_connections.data -> accessToken (db.ts encryptBankConnection)
//   - app_config `budget.plaid` -> secret  (routes/budget-plaid.ts)
//   - app_config `grocery.kroger` -> refreshToken  (kroger.ts, the household's Kroger sign-in)
// A value in either place that is still plaintext is encrypted with the new key on the way.
// Before anything is written, the whole database is searched for `enc:v1:`; if any shows up
// somewhere else, the rotation refuses, because a value it doesn't rotate would become unreadable
// the moment the key changes.
//
// Plaintext secrets only ever live in memory here. Nothing in the report carries one.
import type { DatabaseSync } from "node:sqlite";
import { ENCRYPTION_PREFIX, isEncrypted, encryptWithKey, decryptWithKey } from "./secretBox.ts";

// The app_config values holding one encrypted field each. Written out here rather than imported:
// routes/budget-plaid.ts and kroger.ts both import db.ts, which opens the real database on import.
const CONFIG_SECRETS = [
  { key: "budget.plaid", field: "secret", label: "The Plaid secret", report: "plaidSecret" },
  { key: "grocery.kroger", field: "refreshToken", label: "The Kroger sign-in token", report: "krogerToken" },
] as const;

export interface RotationReport {
  /** Encrypted bank tokens re-encrypted with the new key. */
  bankTokens: number;
  /** Bank tokens that were still plaintext and are now encrypted. */
  plaintextBankTokens: number;
  /** Bank connection rows with no token at all (left alone). */
  rowsWithoutToken: number;
  /** "rotated", "encrypted" (was plaintext), or "none" (nothing saved). */
  plaidSecret: "rotated" | "encrypted" | "none";
  /** The household's Kroger refresh token: same three values. */
  krogerToken: "rotated" | "encrypted" | "none";
  /** `enc:v1:` occurrences found in the whole database before the change. */
  encryptedValuesFound: number;
  applied: boolean;
}

export class RotationError extends Error {}

interface PendingWrite {
  table: "bank_connections" | "app_config";
  id: string;
  /** The JSON field holding the secret: `accessToken` for a bank row, else the config's field. */
  field: string;
  label: string;
  data: string;
  /** What the new ciphertext must decrypt to, checked again after the write. */
  plaintext: string;
}

function decryptOld(value: string, oldKey: Buffer, where: string): string {
  try {
    return decryptWithKey(value, oldKey);
  } catch {
    throw new RotationError(`${where} does not decrypt with the old key. Is OLD_DB_ENCRYPTION_KEY (or DB_ENCRYPTION_KEY) the key this database was written with?`);
  }
}

function encryptChecked(plaintext: string, newKey: Buffer): string {
  const value = encryptWithKey(plaintext, newKey);
  if (decryptWithKey(value, newKey) !== plaintext) throw new RotationError("A value re-encrypted with the new key did not decrypt back to the same value.");
  return value;
}

/** Counts every `enc:v1:` occurrence in every text cell of every table. */
export function countEncryptedValues(db: DatabaseSync): { total: number; byColumn: Record<string, number> } {
  const byColumn: Record<string, number> = {};
  let total = 0;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  for (const { name: table } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[];
    for (const { name: column } of columns) {
      const rows = db
        .prepare(`SELECT CAST(${JSON.stringify(column)} AS TEXT) AS v FROM ${JSON.stringify(table)} WHERE CAST(${JSON.stringify(column)} AS TEXT) LIKE ?`)
        .all(`%${ENCRYPTION_PREFIX}%`) as { v: string }[];
      const count = rows.reduce((n, r) => n + r.v.split(ENCRYPTION_PREFIX).length - 1, 0);
      if (count > 0) {
        byColumn[`${table}.${column}`] = count;
        total += count;
      }
    }
  }
  return { total, byColumn };
}

function plan(db: DatabaseSync, oldKey: Buffer, newKey: Buffer): { writes: PendingWrite[]; report: RotationReport } {
  const report: RotationReport = {
    bankTokens: 0,
    plaintextBankTokens: 0,
    rowsWithoutToken: 0,
    plaidSecret: "none",
    krogerToken: "none",
    encryptedValuesFound: 0,
    applied: false,
  };
  const writes: PendingWrite[] = [];
  let known = 0;

  const bankRows = db.prepare(`SELECT item_id, data FROM bank_connections`).all() as { item_id: string; data: string }[];
  for (const row of bankRows) {
    const item = JSON.parse(row.data);
    known += row.data.split(ENCRYPTION_PREFIX).length - 1;
    if (typeof item?.accessToken !== "string" || !item.accessToken) {
      report.rowsWithoutToken++;
      continue;
    }
    const wasEncrypted = isEncrypted(item.accessToken);
    const plaintext = wasEncrypted ? decryptOld(item.accessToken, oldKey, `Bank connection ${row.item_id}'s token`) : item.accessToken;
    item.accessToken = encryptChecked(plaintext, newKey);
    writes.push({ table: "bank_connections", id: row.item_id, field: "accessToken", label: "A stored bank token", data: JSON.stringify(item), plaintext });
    if (wasEncrypted) report.bankTokens++;
    else report.plaintextBankTokens++;
  }

  for (const secret of CONFIG_SECRETS) {
    const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(secret.key) as { value: string } | undefined;
    if (!row) continue;
    known += row.value.split(ENCRYPTION_PREFIX).length - 1;
    const config = JSON.parse(row.value);
    const value = config?.[secret.field];
    if (typeof value !== "string" || !value) continue;
    const wasEncrypted = isEncrypted(value);
    const plaintext = wasEncrypted ? decryptOld(value, oldKey, secret.label) : value;
    config[secret.field] = encryptChecked(plaintext, newKey);
    writes.push({ table: "app_config", id: secret.key, field: secret.field, label: secret.label, data: JSON.stringify(config), plaintext });
    report[secret.report] = wasEncrypted ? "rotated" : "encrypted";
  }

  // Every `enc:v1:` in the database must be one of the values above, and each of those rows must
  // hold exactly one (the token or secret). Anything else would be left behind under the old key.
  const found = countEncryptedValues(db);
  report.encryptedValuesFound = found.total;
  const rotated =
    report.bankTokens + (report.plaidSecret === "rotated" ? 1 : 0) + (report.krogerToken === "rotated" ? 1 : 0);
  if (found.total !== known || known !== rotated) {
    const where = Object.entries(found.byColumn).map(([col, n]) => `${col}: ${n}`).join(", ");
    throw new RotationError(
      `Found ${found.total} encrypted values (${where || "none"}), but only ${rotated} are a bank token, the Plaid secret or the Kroger sign-in. ` +
        "Refusing: anything else would become unreadable. Teach keyRotation.ts about it first."
    );
  }

  return { writes, report };
}

/** Computes and checks the whole rotation without writing anything. */
export function dryRunRotation(db: DatabaseSync, oldKey: Buffer, newKey: Buffer): RotationReport {
  if (oldKey.equals(newKey)) throw new RotationError("The new key is the same as the old key.");
  return plan(db, oldKey, newKey).report;
}

/** Re-encrypts everything in one transaction, then reads every row back and checks it decrypts
 *  with the new key (and that no value is still under the old one) before committing. Any
 *  failure rolls the whole thing back. The caller makes the backup and runs VACUUM afterwards. */
export function applyRotation(db: DatabaseSync, oldKey: Buffer, newKey: Buffer): RotationReport {
  if (oldKey.equals(newKey)) throw new RotationError("The new key is the same as the old key.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const { writes, report } = plan(db, oldKey, newKey);
    const updateBank = db.prepare(`UPDATE bank_connections SET data = ? WHERE item_id = ?`);
    const updateConfig = db.prepare(`UPDATE app_config SET value = ? WHERE key = ?`);
    for (const w of writes) {
      const result = (w.table === "bank_connections" ? updateBank : updateConfig).run(w.data, w.id);
      if (result.changes !== 1) throw new RotationError(`Expected to update exactly one ${w.table} row, updated ${result.changes}.`);
    }

    // Verify from the database itself, not from the in-memory copies just written.
    for (const w of writes) {
      const stored =
        w.table === "bank_connections"
          ? (db.prepare(`SELECT data FROM bank_connections WHERE item_id = ?`).get(w.id) as { data: string }).data
          : (db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(w.id) as { value: string }).value;
      const value = JSON.parse(stored)[w.field];
      let ok = false;
      try {
        ok = isEncrypted(value) && decryptWithKey(value, newKey) === w.plaintext;
      } catch {
        ok = false;
      }
      if (!ok) throw new RotationError(`${w.label} did not verify with the new key after writing.`);
    }
    const after = countEncryptedValues(db);
    if (after.total !== writes.length) {
      throw new RotationError(`After writing, found ${after.total} encrypted values but expected ${writes.length}.`);
    }

    db.exec("COMMIT");
    return { ...report, applied: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
