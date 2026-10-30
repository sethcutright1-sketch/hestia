// Interactive password reset for a household login -- for when someone forgets
// theirs. Unlike reset-test-passwords.ts, nothing is hardcoded: the username is
// an argument and the new password is typed at a hidden prompt, so no real
// password ever lands in the repo, shell history, or a chat log.
//
// Usage -- the database path is a required argument, on purpose:
//   node node_modules\tsx\dist\cli.mjs scripts\reset-my-password.ts admin "C:path	ohousehold-app\data\household.db"
//
// Deliberately does NOT import ../db.ts: that pulls in env.ts, whose
// .env.local load (override: true) replaces a shell-set DB_PATH -- so in a
// dev checkout it silently targeted data/dev.db instead of the live DB. Opening
// the file directly means the path you pass is the path that gets changed.
//
// Backs up the DB first, same as the other one-shot scripts here.
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        } else if (c === "\u0003") {
          process.stdout.write("\nCancelled.\n");
          process.exit(1);
        } else if (c === "\u0008" || c === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

const username = process.argv[2];
const dbArg = process.argv[3];
if (!username || !dbArg) {
  console.error("Usage: reset-my-password.ts <username> <path-to-household.db>");
  process.exit(1);
}
const DB_PATH = path.resolve(dbArg);
if (!fs.existsSync(DB_PATH)) {
  console.error(`No database file at ${DB_PATH}. Nothing changed.`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);

const user = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username) as { id: string } | undefined;
if (!user) {
  const names = (db.prepare(`SELECT username FROM users`).all() as { username: string }[]).map((u) => u.username);
  console.error(`No user "${username}" in ${DB_PATH}. Usernames here: ${names.join(", ")}`);
  process.exit(1);
}

console.log(`Resetting "${username}" in ${DB_PATH}`);
const first = await askHidden("New password (hidden): ");
if (first.length < 8) {
  console.error("Password must be at least 8 characters. Nothing changed.");
  process.exit(1);
}
const second = await askHidden("Type it again: ");
if (first !== second) {
  console.error("Passwords didn't match. Nothing changed.");
  process.exit(1);
}

const backupDir = path.join(path.dirname(DB_PATH), "backups");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(DB_PATH, path.join(backupDir, `household-pre-password-reset-${stamp}.db`));

const hash = await bcrypt.hash(first, 12);
db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, user.id);
console.log(`Password for "${username}" reset. Sign in with it now.`);
