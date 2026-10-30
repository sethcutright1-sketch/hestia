// One-shot migration (Stage 0.0.5): encrypts any plaintext Plaid access token
// already sitting in bank_connections.data. Safe to re-run -- rows already
// encrypted (accessToken starting with "enc:v1:") are left untouched, so this
// converges rather than double-encrypting. Run manually, never from the server:
//
//   npx tsx scripts/encrypt-plaid-tokens.ts
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import fs from "fs";
import path from "path";
import { db, DB_PATH, encryptSecret } from "../db.ts";

if (!process.env.DB_ENCRYPTION_KEY) {
  console.error("DB_ENCRYPTION_KEY is not set in .env.local -- see .env.example. Aborting.");
  process.exit(1);
}

const backupDir = path.join(path.dirname(DB_PATH), "backups");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `household-pre-token-encryption-${stamp}.db`);
fs.copyFileSync(DB_PATH, backupPath);
console.log(`Backed up to: ${backupPath}`);

const rows = db.prepare(`SELECT item_id, data FROM bank_connections`).all() as { item_id: string; data: string }[];

let encrypted = 0;
let alreadyDone = 0;
let noToken = 0;

const update = db.prepare(`UPDATE bank_connections SET data = ? WHERE item_id = ?`);
for (const row of rows) {
  const item = JSON.parse(row.data);
  if (typeof item.accessToken !== "string") {
    noToken++;
    continue;
  }
  if (item.accessToken.startsWith("enc:v1:")) {
    alreadyDone++;
    continue;
  }
  item.accessToken = encryptSecret(item.accessToken);
  update.run(JSON.stringify(item), row.item_id);
  encrypted++;
}

console.log(`bank_connections rows: ${rows.length} total, ${encrypted} newly encrypted, ${alreadyDone} already encrypted, ${noToken} with no accessToken field.`);

// SQLite doesn't zero out a page's old bytes on UPDATE -- the plaintext tokens
// just replaced would otherwise keep sitting in freed pages until something
// else overwrites them. VACUUM rebuilds the file from only the live rows,
// which is the whole point of this migration: a leaked .db file shouldn't
// still contain the tokens it was just supposed to stop containing.
if (encrypted > 0) {
  db.exec("VACUUM");
  console.log("Vacuumed the database to purge leftover plaintext from freed pages.");
}
