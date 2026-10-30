// Thin typed wrappers over node:sqlite, shared by every nutrition data module.
//
// Every function in nutrition/data takes the database handle as its first argument
// instead of importing db.ts's singleton. Production passes db.ts's one handle; tests
// pass a throwaway in-memory database. It also keeps this folder out of db.ts's import
// cycle: db.ts imports schema.ts (to run the migrations at boot), so nothing under here
// can import db.ts back.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type Db = DatabaseSync;
export type Param = SQLInputValue;

// node:sqlite returns rows as Record<string, SQLOutputValue>; the caller says what the
// SELECT actually produces.
export function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function get<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(db: Db, sql: string, ...params: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return db.prepare(sql).run(...params);
}

let savepointCounter = 0;

/**
 * Run fn in a transaction: committed if it returns, rolled back if it throws.
 *
 * BEGIN IMMEDIATE takes the write lock up front, so a check-then-insert (is this client id
 * already used? then insert) can't interleave with another writer. When the caller is already
 * inside a transaction the work becomes a SAVEPOINT instead, because SQLite refuses a nested
 * BEGIN -- and household-app's own code may one day wrap a nutrition call in its own
 * transaction. A throw still undoes exactly this call's writes.
 */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const name = `nutrition_sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
