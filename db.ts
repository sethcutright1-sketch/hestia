// The entire data layer. Nothing outside this file ever writes SQL directly --
// routes/*.ts and assistant/tools/*.ts only ever call the functions exported
// below, mostly getScopedItems/getScopedItem/putScopedItem/deleteScopedItem.
// New to this codebase? Start with the ScopedTable comment further down --
// it's the one idea that explains most of the schema at once.
//
// `node:sqlite` is Node's own built-in SQLite (stable since Node 22), not a
// third-party package -- no ORM, no query builder, just tagged SQL strings via
// `db.prepare(...).run/get/all(...)`. `DatabaseSync` means every call blocks
// until it completes; that's fine here because SQLite itself is local disk
// I/O, not a network call, so there's nothing to gain from async.
// Must be the first import -- see env.ts. Without this, the bare
// backupIfNeeded() call below (and DB_PATH's process.env.DB_PATH read) run
// before dotenv has loaded .env.local, because ES module imports are fully
// evaluated before this file's own top-level statements, regardless of
// where server.ts's dotenv setup sits relative to *its* import of this file.
import "./env.ts";

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "path";
import fs from "fs";
import { runNutritionMigrations } from "./nutrition/data/schema.ts";
import { ENCRYPTION_PREFIX as SECRET_PREFIX, encryptWithKey, decryptWithKey, parseKey } from "./secretBox.ts";
import { freshLinkToken } from "./plaidFreshLinks.ts";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Overridable (Stage 0.5.1) so dev/test work can run against a
// throwaway database (see scripts/seed-dev-db.ts) instead of the one real
// household.db -- without this there was no way to run the app against
// anything but live data. Falls back to the original fixed path unchanged.
export const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "household.db");
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const BACKUP_DIR = path.join(dbDir, "backups");
const BACKUP_RETENTION_DAYS = 14;

function pruneOldBackups(dir: string): void {
  const files = fs.readdirSync(dir)
    .filter((f) => /^household-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  while (files.length > BACKUP_RETENTION_DAYS) {
    const oldest = files.shift()!;
    fs.unlinkSync(path.join(dir, oldest));
  }
}

// At-most-once-per-calendar-day snapshot. This single SQLite file is the only
// copy of the household's data, so this runs on every server start and is
// re-checked periodically while the server stays up. Lifted from Budget Sync,
// which has the same single-point-of-failure shape.
export function backupIfNeeded(): void {
  if (!fs.existsSync(DB_PATH)) return;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const filename = `household-${today}.db`;
  const todaysBackup = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(todaysBackup)) {
    fs.copyFileSync(DB_PATH, todaysBackup);
  }

  pruneOldBackups(BACKUP_DIR);

  // Optional second copy off this disk entirely (Stage: always-on).
  // household.db, its 14 daily snapshots, and the app itself all otherwise live
  // on one disk -- this is what turns "lost drive" into "lost one day" instead
  // of "lost everything."
  // Copies the already-quiescent local snapshot (not DB_PATH) so there's no
  // question of catching a write in progress, and the whole thing is wrapped so
  // a full/missing offsite destination can never stop the app from booting.
  const offsite = process.env.OFFSITE_BACKUP_DIR;
  if (offsite) {
    try {
      if (!fs.existsSync(offsite)) fs.mkdirSync(offsite, { recursive: true });
      const offsiteCopy = path.join(offsite, filename);
      if (!fs.existsSync(offsiteCopy)) fs.copyFileSync(todaysBackup, offsiteCopy);
      pruneOldBackups(offsite);
    } catch (err) {
      console.error("Offsite backup failed (continuing without it):", err);
    }
  }
}

backupIfNeeded();

export const db = new DatabaseSync(DB_PATH);

// Explicit, not just relying on SQLite's own defaults, because this file lives on
// removable FAT32 media served to several devices continuously (Stage: always-on).
// Deliberately NOT WAL: backupIfNeeded() above is a bare fs.copyFileSync of DB_PATH,
// and WAL would leave committed-but-uncheckpointed data in a sidecar `-wal` file that
// copy never touches -- every daily snapshot would silently miss recent writes. WAL
// also needs a `-shm` mmap sidecar, a worse story on a drive that can be unplugged.
// There's no concurrency to gain from it either: one process, one DatabaseSync handle.
db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;`);

// Every domain table has the same shape: an id, an optional owner, and the object
// itself as JSON. `owner_user_id IS NULL` means the row is joint (both household
// members see it); a set owner means it's personal to that user. This is Budget
// Sync's model, extended to groceries and the calendar -- a shopping list or a
// dinner can be "ours" or "mine" for exactly the same reasons a transaction can.
//
// Budget's own tables (transactions, budgets, credit_cards, ...) get created here
// when that app is folded in; they already use this identical shape, so the
// migration is a data copy rather than a schema change.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Long-lived credentials for non-browser clients (the Wear OS app, and any
  -- future one) that can't reasonably hold a username+password or a rolling
  -- session cookie. Only a SHA-256 hash of the token is stored -- see
  -- hashDeviceToken -- so a leaked .db file doesn't also leak live device
  -- credentials, the same reasoning as plaid_cursors' item_key.
  CREATE TABLE IF NOT EXISTS device_tokens (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  -- Server-side session storage (Stage: always-on). Replaces express-session's
  -- default in-memory store, which loses every session -- logging out every
  -- device -- on each server restart. See sessionStore.ts for the Store
  -- implementation that reads/writes this table.
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

  -- Grocery. Items live inside the list's JSON rather than in their own table:
  -- a list is always read and written whole, so a join would buy nothing.
  CREATE TABLE IF NOT EXISTS shopping_lists (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- What's in the kitchen right now. Always joint: a household shares one set of
  -- cupboards, so unlike shopping lists there's no personal/joint split here.
  CREATE TABLE IF NOT EXISTS pantry_items (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Meals worth keeping. The assistant invents dishes freely and saves one here
  -- when asked, so the recipe book builds itself instead of needing data entry.
  CREATE TABLE IF NOT EXISTS recipes (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- The people who eat here, and what they won't eat. Deliberately not the same
  -- as the users table: logins are capped at two, but a family can be any size,
  -- and a child who never signs in still shouldn't be served mushrooms.
  CREATE TABLE IF NOT EXISTS household_members (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Calendar.
  CREATE TABLE IF NOT EXISTS events (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Chores. Rendered alongside calendar events (Stage 10.3), not a separate
  -- screen -- see routes/chores.ts.
  CREATE TABLE IF NOT EXISTS chores (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Stage 10.4: the points-only rewards catalog chores earn toward -- no
  -- money involved (see routes/chores.ts's FAMILY_POINTS_BUCKET comment and
  -- routes/rewards.ts), so this stays outside the financial privacy boundary
  -- on purpose. Same item_id/owner/data shape as chores.
  CREATE TABLE IF NOT EXISTS rewards (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- One row per time a member redeemed a reward. Snapshots the reward's
  -- title/cost at redemption time (routes/rewards.ts) so later editing or
  -- deleting the reward doesn't rewrite this history.
  CREATE TABLE IF NOT EXISTS redemptions (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Stage 6.5/10.4 (PLAN.md): manual ± point adjustments a parent makes
  -- outside of chores ("+5 for helping with the garage sale"), same
  -- item_id/owner/data shape as rewards/redemptions above. routes/rewards.ts's
  -- balancesByMember folds these into a member's balance alongside approved
  -- chore earnings and redemptions.
  CREATE TABLE IF NOT EXISTS point_adjustments (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Bug fix (owner: "if it's a one-off chore and gets removed the kid loses
  -- the stars for it"): approved chore completions must survive the chore
  -- row being deleted. routes/chores.ts's deleteChoreRow archives each
  -- approved completion here (snapshotting its points, same idea as
  -- redemptions above snapshotting a reward's title/cost) before the chore
  -- row itself is deleted, and pointsByMember folds these into its totals
  -- alongside the live chore rows. Same item_id/owner/data shape as
  -- everything else here.
  CREATE TABLE IF NOT EXISTS earned_points (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- A week of meals. Each meal carries its own approve/deny status; denied ones
  -- stop counting toward the shopping list.
  CREATE TABLE IF NOT EXISTS meal_plans (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Meals someone wants on a future plan, ahead of the assistant (or a person)
  -- actually building the week -- a wishlist the planner checks, separate from
  -- meal_plans because a request has no day/slot yet and may never be used.
  CREATE TABLE IF NOT EXISTS meal_requests (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- The same wishlist for snacks, kept apart so a snack never shows up among dinner ideas the planner works from.
  CREATE TABLE IF NOT EXISTS snack_requests (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- A half-finished "Send to Kroger" screen, one per shopping list (item_id = the list id), so closing the
  -- sheet or leaving and coming back picks up where it stopped. Goes away with a send or a deleted list.
  CREATE TABLE IF NOT EXISTS kroger_drafts (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Budget, folded in from the standalone Budget Sync app. Same item_id/owner/data
  -- shape as everything else here -- this table set was the reason that shape was
  -- chosen in the first place (see the comment above).
  CREATE TABLE IF NOT EXISTS transactions (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Keyed by category rather than a generated id -- see putScopedItemAs.
  CREATE TABLE IF NOT EXISTS budgets (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bank_connections (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_cards (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS goals (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Phase 6: recurring bills with due dates and amounts, replacing the old
  -- category-based "N of M bills paid" tracker (see budgetMath's billStatus/
  -- billDueDate for the due-date and payment-matching logic).
  CREATE TABLE IF NOT EXISTS bills (
    item_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    data TEXT NOT NULL
  );

  -- Per-user merchant -> category memory: what "Children's Hospital" means can
  -- differ between household members (one person's lunch spot is another's actual
  -- medical visit), so rules are scoped to the user who created them, not shared.
  -- merchant_key is the normalized (lowercased, trimmed) merchant name.
  CREATE TABLE IF NOT EXISTS merchant_rules (
    owner_user_id TEXT NOT NULL,
    merchant_key TEXT NOT NULL,
    merchant_display TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, merchant_key)
  );

  -- Plaid /transactions/sync is a cursor-based feed: each response returns a
  -- next_cursor that must be sent on the following call to get anything newer.
  -- Without a stored cursor every sync restarts at the beginning of the item's
  -- history and can never reach recent transactions. item_key is a SHA-256 of
  -- the access token, so the cursor is tied to its item without the credential
  -- itself ever being used as a database key.
  CREATE TABLE IF NOT EXISTS plaid_cursors (
    owner_user_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    cursor TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, item_key)
  );

  -- Stage 4: the assistant's conversation history, server-side instead of
  -- living only in the browser tab's React state. One row per chat thread;
  -- title is derived from the first message, no extra model call needed just
  -- to name it.
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(owner_user_id, updated_at);

  -- tool_calls/tool_results are index-aligned JSON arrays (tool_calls[i] pairs
  -- with tool_results[i]) rather than one merged column, matching the shape
  -- PLAN.md's Stage 4 write-up specified -- kept separate from the content
  -- column so a new chat request can replay them as real role:"tool" wire
  -- messages (see server.ts), not just re-read the prose that resulted from them.
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_results TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
`);

// `role` distinguishes the normal household-member accounts from a kiosk
// login (see forbidKiosk in auth.ts) that can reach only Budget. Added after
// the table above already shipped, so CREATE TABLE IF NOT EXISTS won't add
// it to an existing install -- ALTER TABLE is the only way to backfill a
// column onto a live users table without losing the rows already in it.
// SQLite has no "ADD COLUMN IF NOT EXISTS", hence the table_info check.
if (!(db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).some((c) => c.name === "role")) {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`);
}

// M4: sessions remember whose they are, so a password change can sign that user's other devices out.
// The id also lives inside the JSON `data`; the column makes "all sessions of user X" one indexed
// DELETE. Rows from before this column get it backfilled from their JSON once.
if (!(db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).some((c) => c.name === "user_id")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT`);
  db.exec(`UPDATE sessions SET user_id = json_extract(data, '$.userId') WHERE json_valid(data)`);
}
db.exec(`CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id)`);

// UserRole gained an "admin" tier above the flat member/kiosk split -- admin =
// account/security settings (Plaid keys, household PIN, budget/lock PIN, kiosk
// login, backup download, the cloud-finance toggle, the full budget reset);
// parent = today's full member access minus those. Pure rename, zero behavior
// change until the requireAdmin-gated routes exist: every existing account
// keeps exactly the access it already had. Safe to run on every boot -- after
// the first run this matches zero rows, so it's a no-op forever after.
// Deliberately does NOT promote anyone to "admin" -- that's a separate,
// explicit, one-time decision (see scripts/promote-to-admin.ts), not
// something a blanket migration should guess.
db.exec(`UPDATE users SET role = 'parent' WHERE role = 'member'`);

// The calorie tracker's tables (`nutrition_*`, see nutrition/data/schema.ts). Run here, after
// everything above, because they reference `users` and the role values just normalised. They
// have their own append-only migration list and version table, so none of the idempotent
// block above knows about them. Same handle, same `journal_mode = DELETE` as everything else
// -- the nutrition code never opens its own connection and never changes the journal mode.
runNutritionMigrations(db);

// Encrypts the Plaid access token inside a bank_connections row, and the Plaid client secret in
// app_config `budget.plaid`, so a leaked .db file (backup, copied disk, cloud sync) isn't also a
// set of live banking credentials. AES-256-GCM with a key held in .env.local, never in the
// database itself; the format lives in secretBox.ts. The `enc:v1:` prefix distinguishes
// already-encrypted values from plaintext, both for the migrations and so decryptSecret can
// pass a not-yet-migrated value through unchanged instead of failing on it. Changing the key
// needs scripts/rotate-encryption-key.ts, which re-encrypts every value -- a new key alone
// would make every stored token unreadable.
const ENCRYPTION_PREFIX = SECRET_PREFIX;

function getEncryptionKey(): Buffer {
  return parseKey(process.env.DB_ENCRYPTION_KEY, "DB_ENCRYPTION_KEY");
}

export function encryptSecret(plaintext: string): string {
  return encryptWithKey(plaintext, getEncryptionKey());
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(ENCRYPTION_PREFIX)) return value;
  return decryptWithKey(value, getEncryptionKey());
}

function encryptBankConnection(item: any): any {
  if (item && typeof item.accessToken === "string" && !item.accessToken.startsWith(ENCRYPTION_PREFIX)) {
    return { ...item, accessToken: encryptSecret(item.accessToken) };
  }
  return item;
}

// A bank_connections row as it may leave the server (the project notes 10.7): never the
// access token, encrypted or not -- just `hasAccessToken`, so a screen can tell a linked account
// from a manual one. getScopedItems/getScopedItem return this shape, so the /store response, the
// assistant's budget tools and any later reader can't hand a token to a browser or a model by
// accident. The one way to the token itself is getBankConnectionAccessToken below.
function publicBankConnection(item: any): any {
  if (!item || typeof item !== "object") return item;
  const { accessToken, ...rest } = item;
  return { ...rest, hasAccessToken: typeof accessToken === "string" && accessToken.length > 0 };
}

/** The stored (encrypted or legacy-plaintext) token of a bank_connections row this user may see, by row id. */
function storedBankToken(userId: string, id: string): string | null {
  const row = db
    .prepare(`SELECT data FROM bank_connections WHERE item_id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)`)
    .get(id, userId) as { data: string } | undefined;
  const token = row ? JSON.parse(row.data).accessToken : undefined;
  return typeof token === "string" && token ? token : null;
}

/** The stored token of any bank_connections row this user may see that belongs to Plaid item `itemId`. */
function storedItemToken(userId: string, itemId: unknown): string | null {
  if (typeof itemId !== "string" || !itemId) return null;
  const rows = db
    .prepare(`SELECT data FROM bank_connections WHERE owner_user_id IS NULL OR owner_user_id = ?`)
    .all(userId) as { data: string }[];
  for (const r of rows) {
    const d = JSON.parse(r.data);
    if (d.itemId === itemId && typeof d.accessToken === "string" && d.accessToken) return d.accessToken;
  }
  return null;
}

/** The decrypted Plaid access token of bank connection `id`, if this user may see that row. Server use only. */
export function getBankConnectionAccessToken(userId: string, id: string): string | null {
  const token = storedBankToken(userId, id);
  return token ? decryptSecret(token) : null;
}

/**
 * A bank_connections row from a client, made ready to store. A token in the request is ignored,
 * always: the row gets the token of the Plaid item THIS user linked in the last 30 minutes
 * (plaidFreshLinks.ts), else the one this row already has, else the one another row of the same
 * item has (all limited to rows the user may see). So a save from the browser -- which never has a
 * token -- can't blank one, and can't plant one either. `hasAccessToken` is derived, never stored.
 */
function bankConnectionForWrite(userId: string, id: string, item: any, trustedToken?: string): any {
  const { accessToken: _fromClient, hasAccessToken: _derived, ...rest } = item ?? {};
  const token = trustedToken || freshLinkToken(userId, rest.itemId) || storedBankToken(userId, id) || storedItemToken(userId, rest.itemId);
  return token ? encryptBankConnection({ ...rest, accessToken: token }) : rest;
}

/** Stores a bank_connections row WITH a token the server itself obtained (from Plaid, a migration, a test
 *  fixture). Never wire this to a request body: putScopedItem is the path for anything a client sends. */
export function putBankConnectionWithToken(userId: string, item: any, accessToken: string): boolean {
  return putScopedItemAs("bank_connections", userId, String(item.id), item, accessToken);
}

// The Plaid client id/secret, saved from Budget settings (routes/budget-plaid.ts). `secret` is
// stored encrypted; the project notes 10.6.
export const PLAID_CONFIG_KEY = "budget.plaid";

/** One-time boot migration for a Plaid secret saved before it was encrypted. Idempotent: an
 *  `enc:v1:` value, an empty one, or no config at all is left alone, so every later boot is a
 *  no-op. Without DB_ENCRYPTION_KEY it leaves the value as it is (the app still works; the
 *  secret just stays readable) rather than stopping the server from starting. */
export function encryptStoredPlaidSecret(): "encrypted" | "unchanged" | "no-key" {
  const stored = getConfig(PLAID_CONFIG_KEY, null);
  if (!stored || typeof stored.secret !== "string" || !stored.secret || stored.secret.startsWith(ENCRYPTION_PREFIX)) {
    return "unchanged";
  }
  if (!process.env.DB_ENCRYPTION_KEY) {
    console.warn("The Plaid secret is stored unencrypted, and DB_ENCRYPTION_KEY is not set, so it can't be encrypted yet.");
    return "no-key";
  }
  setConfig(PLAID_CONFIG_KEY, { ...stored, secret: encryptSecret(stored.secret) });
  // SQLite leaves an UPDATE's old bytes in freed pages; VACUUM rewrites the file from live rows
  // only, so the plaintext really leaves this file (same reason as encrypt-plaid-tokens.ts).
  try {
    db.exec("VACUUM");
  } catch (err) {
    console.error("VACUUM after encrypting the Plaid secret failed (the secret is encrypted either way):", err);
  }
  console.log("Encrypted the stored Plaid secret.");
  return "encrypted";
}

encryptStoredPlaidSecret();

// Every table listed here has exactly the shape created above: item_id,
// owner_user_id, data. That's what lets one set of four functions
// (getScopedItems/getScopedItem/putScopedItem/deleteScopedItem) serve all of
// them instead of every route hand-rolling its own SELECT/INSERT/UPDATE --
// "table" here is a runtime parameter, not a different code path.
export type ScopedTable =
  | "shopping_lists"
  | "events"
  | "chores"
  | "rewards"
  | "redemptions"
  | "point_adjustments"
  | "earned_points"
  | "meal_plans"
  | "meal_requests"
  | "snack_requests"
  | "kroger_drafts"
  | "pantry_items"
  | "recipes"
  | "household_members"
  | "transactions"
  | "budgets"
  | "bank_connections"
  | "credit_cards"
  | "alerts"
  | "goals"
  | "bills";

export function getScopedItems(table: ScopedTable, userId: string): any[] {
  const rows = db
    .prepare(`SELECT data FROM ${table} WHERE owner_user_id IS NULL OR owner_user_id = ?`)
    .all(userId) as { data: string }[];
  const items = rows.map((r) => JSON.parse(r.data));
  return table === "bank_connections" ? items.map(publicBankConnection) : items;
}

export function getScopedItem(table: ScopedTable, userId: string, id: string): any | undefined {
  const row = db
    .prepare(`SELECT data FROM ${table} WHERE item_id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)`)
    .get(id, userId) as { data: string } | undefined;
  if (!row) return undefined;
  const item = JSON.parse(row.data);
  return table === "bank_connections" ? publicBankConnection(item) : item;
}

// Single-item upsert. Budget Sync replaces whole tables on every save because its
// client holds the entire dataset in memory; here the client edits one list or one
// event at a time, so writes are targeted and two people editing different lists
// can't clobber each other.
// Returns false if the write was refused because the row belongs to another
// member -- see putScopedItemAs, which does the actual work.
export function putScopedItem(table: ScopedTable, userId: string, item: any): boolean {
  return putScopedItemAs(table, userId, String(item.id), item);
}

// Scoped so one member can't delete the other's personal rows by guessing an id.
export function deleteScopedItem(table: ScopedTable, userId: string, id: string): boolean {
  const result = db
    .prepare(`DELETE FROM ${table} WHERE item_id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)`)
    .run(id, userId);
  return result.changes > 0;
}

export function getConfig(key: string, fallback: any): any {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : fallback;
}

export function setConfig(key: string, value: any): void {
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value));
}

// Deletes rows that have already passed their cookie expiry. Called once from
// SqliteSessionStore's constructor and again every 6h from the same interval
// that re-checks backupIfNeeded (see server.ts) -- an always-on server never
// naturally restarts to clear this out on its own.
export function pruneSessions(): void {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
}

/** Signs a user out everywhere: deletes their session rows, except `exceptSid` (the one making the
 *  request, when it should stay). Returns how many were removed. */
export function deleteSessionsForUser(userId: string, exceptSid?: string): number {
  const r = exceptSid
    ? db.prepare(`DELETE FROM sessions WHERE user_id = ? AND sid != ?`).run(userId, exceptSid)
    : db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
  return Number(r.changes);
}

/** Revokes every device token (watch pairing) a user owns. Returns how many were removed. */
export function deleteDeviceTokensForUser(userId: string): number {
  return Number(db.prepare(`DELETE FROM device_tokens WHERE owner_user_id = ?`).run(userId).changes);
}

/** Signs everyone out: every session row and every device token. */
export function deleteAllSessionsAndDeviceTokens(): { sessions: number; deviceTokens: number } {
  return {
    sessions: Number(db.prepare(`DELETE FROM sessions`).run().changes),
    deviceTokens: Number(db.prepare(`DELETE FROM device_tokens`).run().changes),
  };
}

// "kid" (a real per-child login with no financial tools, PLAN.md Stage 6.5) is
// reserved for a later stage -- not a live value yet, so it's left out of the
// type rather than forcing every role === "..." check to pretend to handle it.
export type UserRole = "admin" | "parent" | "kiosk";

export interface UserRecord {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
}

// For a specific role only -- still used directly by a couple of tests and by
// getKioskUser's sibling checks. For "how many real people are in this
// household" (the MAX_HOUSEHOLD_USERS cap and /api/auth/status's count), use
// getHouseholdMemberCount below instead: defaulting this to one role or the
// other would silently undercount now that there are two non-kiosk tiers.
export function getUserCount(role: UserRole): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = ?`).get(role) as { c: number };
  return row.c;
}

// Counts every real household login (admin + parent) against
// MAX_HOUSEHOLD_USERS -- the kiosk login is a credential for a shared device,
// not a person, and has never counted against the cap.
export function getHouseholdMemberCount(): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role != 'kiosk'`).get() as { c: number };
  return row.c;
}

export function getUserByUsername(username: string): UserRecord | undefined {
  return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as unknown as UserRecord | undefined;
}

export function getUserById(id: string): UserRecord | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as unknown as UserRecord | undefined;
}

// At most one kiosk account exists at a time -- see PUT/DELETE /api/auth/kiosk
// in auth.ts, which replace it wholesale rather than editing it in place.
export function getKioskUser(): UserRecord | undefined {
  return db.prepare(`SELECT * FROM users WHERE role = 'kiosk'`).get() as UserRecord | undefined;
}

export function deleteKioskUser(): void {
  db.prepare(`DELETE FROM users WHERE role = 'kiosk'`).run();
}

export function createUser(username: string, passwordHash: string, displayName: string, role: UserRole = "parent"): string {
  const id = `user-${crypto.randomBytes(8).toString("hex")}`;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, created_at, role) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, username, passwordHash, displayName, new Date().toISOString(), role);
  return id;
}

export function listUsers(): Pick<UserRecord, "id" | "username" | "display_name" | "role">[] {
  return db.prepare(`SELECT id, username, display_name, role FROM users`).all() as any[];
}

export function updateUserPasswordHash(id: string, passwordHash: string): void {
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

export interface DeviceTokenRecord {
  id: string;
  owner_user_id: string;
  token_hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

// A fast, unkeyed SHA-256 is the right primitive here (unlike bcrypt for the
// PIN/password) -- the token itself already has 256 bits of entropy, so the
// threat model is "don't store the raw credential," not "slow down guessing."
export function hashDeviceToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function createDeviceToken(ownerUserId: string, label: string, tokenHash: string): DeviceTokenRecord {
  const id = newId("device");
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO device_tokens (id, owner_user_id, token_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(id, ownerUserId, tokenHash, label, createdAt);
  return { id, owner_user_id: ownerUserId, token_hash: tokenHash, label, created_at: createdAt, last_used_at: null };
}

export function getDeviceTokenByHash(tokenHash: string): DeviceTokenRecord | undefined {
  return db.prepare(`SELECT * FROM device_tokens WHERE token_hash = ?`).get(tokenHash) as unknown as DeviceTokenRecord | undefined;
}

export function touchDeviceToken(id: string): void {
  db.prepare(`UPDATE device_tokens SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function listDeviceTokens(ownerUserId: string): DeviceTokenRecord[] {
  return db
    .prepare(`SELECT * FROM device_tokens WHERE owner_user_id = ? ORDER BY created_at DESC`)
    .all(ownerUserId) as unknown as DeviceTokenRecord[];
}

export function deleteDeviceToken(ownerUserId: string, id: string): boolean {
  const result = db.prepare(`DELETE FROM device_tokens WHERE id = ? AND owner_user_id = ?`).run(id, ownerUserId);
  return result.changes > 0;
}

// Like putScopedItem, but for tables whose row key isn't item.id -- budgets are
// keyed by category, so the caller supplies the key explicitly.
// The WHERE on the DO UPDATE branch is the ownership guard, and it is the reason
// this can return false: without it, any signed-in member could overwrite another
// member's personal row by writing to its item_id, and flip it to joint in the
// same statement. deleteScopedItem has always been guarded this way; this write
// path was not, which is the asymmetry that made it a bug. Predictable keys make
// it reachable in practice -- budgets are keyed by category name, not a random id.
//
// Returns true if the row was written, false if an existing row belongs to someone
// else. A refusal is a silent no-op at the SQL level, so callers that care about
// telling the user must check the return value.
export function putScopedItemAs(table: ScopedTable, userId: string, id: string, item: any, trustedBankToken?: string): boolean {
  const scope = item.scope || "joint";
  const ownerUserId = scope === "personal" ? userId : null;
  const toStore = table === "bank_connections" ? bankConnectionForWrite(userId, id, item, trustedBankToken) : item;
  const result = db.prepare(
    `INSERT INTO ${table} (item_id, owner_user_id, data) VALUES (?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, data = excluded.data
     WHERE ${table}.owner_user_id IS NULL OR ${table}.owner_user_id = ?`
  ).run(id, ownerUserId, JSON.stringify(toStore), userId);
  return result.changes > 0;
}

export interface MerchantRule {
  merchantKey: string;
  merchantDisplay: string;
  category: string;
}

function normalizeMerchantKey(merchantName: string): string {
  return merchantName.trim().toLowerCase();
}

export function getMerchantRules(userId: string): MerchantRule[] {
  const rows = db.prepare(`SELECT merchant_key, merchant_display, category FROM merchant_rules WHERE owner_user_id = ?`).all(userId) as any[];
  return rows.map((r) => ({ merchantKey: r.merchant_key, merchantDisplay: r.merchant_display, category: r.category }));
}

// Raw bank descriptions carry extra noise ("CHILDRENS HOSPITAL CAFETERIA #4",
// "AMZN MKTPLC US*1A2B3") that won't exact-match a saved merchant name, so rules
// are matched as substrings of the transaction text. Picks the longest (most
// specific) matching rule if more than one applies. Only ever matches against
// the requesting user's OWN rules -- one household member's "this is my lunch
// spot" correction must never silently re-categorize the other member's data.
export function matchMerchantRule(userId: string, text: string): MerchantRule | undefined {
  const haystack = text.toLowerCase();
  const rules = getMerchantRules(userId);
  let best: MerchantRule | undefined;
  for (const rule of rules) {
    if (rule.merchantKey && haystack.includes(rule.merchantKey)) {
      if (!best || rule.merchantKey.length > best.merchantKey.length) best = rule;
    }
  }
  return best;
}

export function upsertMerchantRule(userId: string, merchantName: string, category: string): void {
  const key = normalizeMerchantKey(merchantName);
  db.prepare(
    `INSERT INTO merchant_rules (owner_user_id, merchant_key, merchant_display, category, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_user_id, merchant_key) DO UPDATE SET category = excluded.category, merchant_display = excluded.merchant_display`
  ).run(userId, key, merchantName, category, new Date().toISOString());
}

export function deleteMerchantRule(userId: string, merchantName: string): void {
  db.prepare(`DELETE FROM merchant_rules WHERE owner_user_id = ? AND merchant_key = ?`).run(userId, normalizeMerchantKey(merchantName));
}

// Derives the stable per-item key used for cursor storage. Hashed so a Plaid
// access token is never written into a primary key or surfaced in a query log.
export function plaidItemKey(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("hex");
}

export function getPlaidCursor(userId: string, itemKey: string): string | undefined {
  const row = db
    .prepare(`SELECT cursor FROM plaid_cursors WHERE owner_user_id = ? AND item_key = ?`)
    .get(userId, itemKey) as { cursor: string } | undefined;
  return row?.cursor;
}

export function setPlaidCursor(userId: string, itemKey: string, cursor: string): void {
  db.prepare(
    `INSERT INTO plaid_cursors (owner_user_id, item_key, cursor, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_user_id, item_key) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
  ).run(userId, itemKey, cursor, new Date().toISOString());
}

// Clearing the cursor makes the next sync replay the item's full history from
// the beginning -- used to backfill after a sync that was previously truncated.
export function clearPlaidCursor(userId: string, itemKey: string): void {
  db.prepare(`DELETE FROM plaid_cursors WHERE owner_user_id = ? AND item_key = ?`).run(userId, itemKey);
}

// Stage 4: the assistant's persisted conversation history (see PLAN.md).
// Deliberately not the generic item_id/owner_user_id/data scoped-item shape --
// these need real relational queries (a conversation's messages in time order,
// a user's conversations in recency order) the generic helpers don't support.

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredToolCall {
  tool: string;
  args: Record<string, any>;
}

export interface StoredToolResult {
  tool: string;
  result?: unknown;
  error?: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: StoredToolCall[] | null;
  toolResults: StoredToolResult[] | null;
  createdAt: string;
}

export function listConversations(userId: string): Conversation[] {
  const rows = db
    .prepare(`SELECT id, title, created_at, updated_at FROM conversations WHERE owner_user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as any[];
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}

// Scoped to the owner the same way getScopedItem is -- returns undefined
// rather than another user's conversation if the id doesn't belong to them.
export function getConversation(userId: string, id: string): Conversation | undefined {
  const row = db
    .prepare(`SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND owner_user_id = ?`)
    .get(id, userId) as any;
  return row ? { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
}

export function createConversation(userId: string, title: string): Conversation {
  const id = newId("conv");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, title, now, now);
  return { id, title, createdAt: now, updatedAt: now };
}

// Scoped update -- affects nothing if `id` doesn't belong to `userId`, same
// "can't touch what isn't yours" guarantee deleteScopedItem gives every other table.
export function renameConversation(userId: string, id: string, title: string): boolean {
  const result = db
    .prepare(`UPDATE conversations SET title = ? WHERE id = ? AND owner_user_id = ?`)
    .run(title, id, userId);
  return result.changes > 0;
}

export function deleteConversation(userId: string, id: string): boolean {
  const result = db.prepare(`DELETE FROM conversations WHERE id = ? AND owner_user_id = ?`).run(id, userId);
  if (result.changes > 0) db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(id);
  return result.changes > 0;
}

// Bumped whenever a message is added, so listConversations' recency order
// reflects actual activity, not just creation time.
export function touchConversation(id: string): void {
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function listMessages(conversationId: string): StoredMessage[] {
  const rows = db
    .prepare(`SELECT id, conversation_id, role, content, tool_calls, tool_results, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId) as any[];
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : null,
    toolResults: r.tool_results ? JSON.parse(r.tool_results) : null,
    createdAt: r.created_at,
  }));
}

export function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  toolCalls?: StoredToolCall[],
  toolResults?: StoredToolResult[]
): StoredMessage {
  const id = newId("msg");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_results, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, toolResults ? JSON.stringify(toolResults) : null, now);
  return { id, conversationId, role, content, toolCalls: toolCalls ?? null, toolResults: toolResults ?? null, createdAt: now };
}
