// Promotes one existing household login to the "admin" tier -- the
// account/security-settings layer above "parent" (Plaid credentials, the
// household/lock PIN, kiosk login management, backup download, the budget
// reset, the cloud-finance toggle; see requireAdmin's comment in auth.ts).
//
// Deliberately a separate, explicit, one-time script rather than something
// db.ts's own startup migration does automatically: which existing account
// becomes admin is a real decision (whose login is it?), not something a
// blanket migration should guess. db.ts only ever renames 'member' rows to
// 'parent' on its own -- see the comment next to that UPDATE.
//
// Usage -- the database path is a required argument, on purpose:
//   node node_modules\tsx\dist\cli.mjs scripts\promote-to-admin.ts dad "C:path	ohousehold-app\data\household.db"
//
// Deliberately does NOT import ../db.ts: that pulls in env.ts, whose
// .env.local load (override: true) replaces a shell-set DB_PATH -- so in a
// dev checkout it would silently target data/dev.db instead of the live DB.
// Opening the file directly means the path you pass is the path that gets
// changed. Same reasoning as scripts/reset-my-password.ts.
import fs from "fs";
import path from "path";
import readline from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const username = process.argv[2];
const dbArg = process.argv[3];
if (!username || !dbArg) {
  console.error("Usage: promote-to-admin.ts <username> <path-to-household.db>");
  process.exit(1);
}
const DB_PATH = path.resolve(dbArg);
if (!fs.existsSync(DB_PATH)) {
  console.error(`No database file at ${DB_PATH}. Nothing changed.`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);

const user = db.prepare(`SELECT id, role FROM users WHERE username = ?`).get(username) as
  | { id: string; role: string }
  | undefined;
if (!user) {
  const names = (db.prepare(`SELECT username FROM users`).all() as { username: string }[]).map((u) => u.username);
  console.error(`No user "${username}" in ${DB_PATH}. Usernames here: ${names.join(", ")}`);
  process.exit(1);
}
if (user.role === "kiosk") {
  console.error(`"${username}" is the kiosk login -- a shared-device credential, not a person. Refusing to promote it.`);
  process.exit(1);
}
if (user.role === "admin") {
  console.log(`"${username}" is already admin. Nothing to do.`);
  process.exit(0);
}

console.log(`About to promote "${username}" (currently "${user.role}") to admin in ${DB_PATH}`);
const confirmation = await ask(`Type the username again to confirm: `);
if (confirmation !== username) {
  console.error("That didn't match. Nothing changed.");
  process.exit(1);
}

const backupDir = path.join(path.dirname(DB_PATH), "backups");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(DB_PATH, path.join(backupDir, `household-pre-admin-promotion-${stamp}.db`));

db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(user.id);

console.log(`\n"${username}" is now admin. Current accounts:`);
const rows = db.prepare(`SELECT username, role FROM users ORDER BY role, username`).all() as {
  username: string;
  role: string;
}[];
for (const row of rows) console.log(`  ${row.username.padEnd(20)} ${row.role}`);
