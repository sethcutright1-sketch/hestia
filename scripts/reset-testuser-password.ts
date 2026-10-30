// One-shot: reset testuser's password to a known value so it can be used for a
// manual browser walkthrough (original password was never recorded anywhere).
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { db, DB_PATH } from "../db.ts";

const USERNAME = "testuser";
const NEW_PASSWORD = "testpass123";

const backupDir = path.join(path.dirname(DB_PATH), "backups");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(DB_PATH, path.join(backupDir, `household-pre-password-reset-${stamp}.db`));

const user = db.prepare(`SELECT id FROM users WHERE username = ?`).get(USERNAME) as { id: string } | undefined;
if (!user) {
  console.error(`No user found with username "${USERNAME}".`);
  process.exit(1);
}

const hash = await bcrypt.hash(NEW_PASSWORD, 12);
db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, user.id);
console.log(`Password for "${USERNAME}" reset.`);
