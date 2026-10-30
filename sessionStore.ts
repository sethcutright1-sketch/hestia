// A server-side session store on the app's own SQLite handle (Stage:
// always-on). Replaces express-session's built-in MemoryStore, whose own
// typings warn it "will leak memory ... and is only meant for debugging."
// More importantly for this app: an in-memory store forgets every session the
// instant the process restarts, which is exactly what an always-on supervisor
// (scripts/launch-household.ps1) does periodically. Without this, every
// device -- fridge included -- would need to sign back in after every crash
// or scheduled rebuild.
//
// Deliberately reuses the `db` handle already opened in db.ts rather than a
// second DatabaseSync -- db.ts's PRAGMA choices (no WAL) assume exactly one
// writer, and a second handle on the same file would violate that.
import session from "express-session";
import { db, pruneSessions as pruneSessionsQuery } from "./db.ts";

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function expiresAtFor(sess: session.SessionData): number {
  // A rolling cookie (see auth.ts) refreshes `cookie.expires` on save, so this
  // naturally slides forward on activity -- no separate "last seen" column needed.
  const cookieExpires = (sess.cookie as any)?.expires;
  if (cookieExpires) {
    const t = new Date(cookieExpires).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const maxAge = (sess.cookie as any)?.maxAge;
  return Date.now() + (typeof maxAge === "number" ? maxAge : DEFAULT_MAX_AGE_MS);
}

export class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    // Best-effort cleanup of anything that already expired since the last
    // server run -- keeps the table from growing forever between the 6h
    // interval sweeps server.ts schedules alongside backupIfNeeded.
    try {
      pruneSessionsQuery();
    } catch (err) {
      console.error("Initial session prune failed:", err);
    }
  }

  get(sid: string, callback: (err: any, session?: session.SessionData | null) => void): void {
    process.nextTick(() => {
      try {
        const row = db
          .prepare(`SELECT data FROM sessions WHERE sid = ? AND expires_at > ?`)
          .get(sid, Date.now()) as { data: string } | undefined;
        if (!row) return callback(null, null);
        try {
          callback(null, JSON.parse(row.data));
        } catch (parseErr) {
          // A corrupt single row shouldn't wedge every future request for that
          // session id -- drop it and treat it as if it never existed.
          db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
          callback(null, null);
        }
      } catch (err) {
        callback(err);
      }
    });
  }

  set(sid: string, sess: session.SessionData, callback?: (err?: any) => void): void {
    process.nextTick(() => {
      try {
        db.prepare(
          `INSERT INTO sessions (sid, data, expires_at, user_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, user_id = excluded.user_id`
        ).run(sid, JSON.stringify(sess), expiresAtFor(sess), typeof sess.userId === "string" ? sess.userId : null);
        callback?.();
      } catch (err) {
        callback?.(err);
      }
    });
  }

  destroy(sid: string, callback?: (err?: any) => void): void {
    process.nextTick(() => {
      try {
        db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
        callback?.();
      } catch (err) {
        callback?.(err);
      }
    });
  }

  // Not optional in practice: with `resave: false`, express-session calls
  // touch() (not set()) on every request that didn't otherwise mutate the
  // session. Without this, a session's expiry is fixed at login time no
  // matter how often it's used -- a fridge left signed in would still get
  // logged out mid-month even while actively polling every 30s.
  touch(sid: string, sess: session.SessionData, callback?: () => void): void {
    process.nextTick(() => {
      try {
        db.prepare(`UPDATE sessions SET expires_at = ? WHERE sid = ?`).run(expiresAtFor(sess), sid);
      } catch (err) {
        console.error("Session touch failed:", err);
      }
      callback?.();
    });
  }
}
