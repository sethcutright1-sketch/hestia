// sessionStore.ts -- the SQLite-backed express-session store.
//
// What breaks when this is wrong is subtle and remote: every device signed
// out after a supervisor restart, or the fridge -- a permanently signed-in
// browser polling every 30s -- getting logged out mid-month anyway because
// touch() never moved its expiry. Neither shows up on the machine you're
// developing on.
//
// express-session's Store API is callback-based, so each test awaits a small
// promise wrapper rather than calling the methods directly.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { SessionData } from "express-session";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { db, pruneSessions } = await loadDb();
const { SqliteSessionStore } = await import("../sessionStore.ts");

let store: InstanceType<typeof SqliteSessionStore>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session shaped the way express-session hands one to a store. */
function sessionWith(overrides: Partial<SessionData> = {}, expiresInMs = 30 * DAY_MS): SessionData {
  return {
    cookie: { originalMaxAge: expiresInMs, expires: new Date(Date.now() + expiresInMs), maxAge: expiresInMs } as any,
    ...overrides,
  } as SessionData;
}

const get = (sid: string) =>
  new Promise<SessionData | null | undefined>((resolve, reject) =>
    store.get(sid, (err, sess) => (err ? reject(err) : resolve(sess)))
  );
const set = (sid: string, sess: SessionData) =>
  new Promise<void>((resolve, reject) => store.set(sid, sess, (err) => (err ? reject(err) : resolve())));
const destroy = (sid: string) =>
  new Promise<void>((resolve, reject) => store.destroy(sid, (err) => (err ? reject(err) : resolve())));
const touch = (sid: string, sess: SessionData) =>
  new Promise<void>((resolve) => store.touch(sid, sess, resolve));

function expiryOf(sid: string): number | undefined {
  const row = db.prepare(`SELECT expires_at FROM sessions WHERE sid = ?`).get(sid) as { expires_at: number } | undefined;
  return row?.expires_at;
}

before(() => {
  store = new SqliteSessionStore();
});

after(cleanupDb);

describe("set and get", () => {
  test("a stored session comes back with its data intact", async () => {
    await set("sid-basic", sessionWith({ userId: "user-123", lockTrusted: true }));
    const got = await get("sid-basic");
    assert.equal(got?.userId, "user-123");
    assert.equal(got?.lockTrusted, true);
  });

  test("an unknown session id is null, not an error", async () => {
    assert.equal(await get("sid-never-existed"), null);
  });

  test("set on an existing id updates rather than duplicating", async () => {
    await set("sid-update", sessionWith({ userId: "user-a" }));
    await set("sid-update", sessionWith({ userId: "user-b" }));

    assert.equal((await get("sid-update"))?.userId, "user-b");
    const count = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE sid = ?`).get("sid-update") as { n: number };
    assert.equal(count.n, 1);
  });

  test("the PIN unlock window survives a round trip", async () => {
    // unlockedUntil lives in the session, so a store that dropped unknown keys
    // would silently relock every device on every server restart.
    const until = Date.now() + 5 * 60_000;
    await set("sid-unlock", sessionWith({ userId: "u", unlockedUntil: until }));
    assert.equal((await get("sid-unlock"))?.unlockedUntil, until);
  });
});

describe("expiry", () => {
  test("an expired session reads as absent even though the row is still there", async () => {
    await set("sid-expired", sessionWith({ userId: "u" }, -1000));

    assert.equal(await get("sid-expired"), null, "a past expiry must not authenticate anyone");
    assert.ok(expiryOf("sid-expired") !== undefined, "the row itself is still present until pruned");
  });

  test("expiry comes from the cookie's own expires date", async () => {
    const expires = new Date(Date.now() + 7 * DAY_MS);
    await set("sid-cookie-expiry", { cookie: { expires } } as any);
    assert.equal(expiryOf("sid-cookie-expiry"), expires.getTime());
  });

  test("falls back to maxAge when there is no expires date", async () => {
    const before = Date.now();
    await set("sid-maxage", { cookie: { maxAge: 60_000 } } as any);
    const stored = expiryOf("sid-maxage")!;
    assert.ok(stored >= before + 60_000 && stored <= Date.now() + 60_000);
  });

  test("falls back to 30 days when the cookie says nothing useful", async () => {
    await set("sid-default", { cookie: {} } as any);
    const stored = expiryOf("sid-default")!;
    // Generous window -- the point is that it is ~30 days, not ~0.
    assert.ok(stored > Date.now() + 29 * DAY_MS, "a session with no cookie hints should not expire immediately");
  });

  test("an unparseable expires date does not store NaN", async () => {
    // NaN in expires_at would compare false against everything, silently
    // logging that device out on its very next request.
    await set("sid-bad-date", { cookie: { expires: "not a date", maxAge: 60_000 } } as any);
    assert.equal(Number.isNaN(expiryOf("sid-bad-date")), false);
  });
});

describe("touch -- the reason an always-on device stays signed in", () => {
  test("moves the expiry forward without rewriting the session data", async () => {
    await set("sid-touch", sessionWith({ userId: "fridge" }, 60_000));
    const original = expiryOf("sid-touch")!;

    await touch("sid-touch", sessionWith({ userId: "fridge" }, 30 * DAY_MS));

    assert.ok(expiryOf("sid-touch")! > original, "touch must extend the window");
    assert.equal((await get("sid-touch"))?.userId, "fridge", "and must not clobber the session");
  });

  test("touching an id that isn't stored is a no-op, not a crash", async () => {
    await assert.doesNotReject(() => touch("sid-not-there", sessionWith()));
    assert.equal(await get("sid-not-there"), null);
  });
});

describe("destroy", () => {
  test("removes the session outright", async () => {
    await set("sid-destroy", sessionWith({ userId: "u" }));
    await destroy("sid-destroy");

    assert.equal(await get("sid-destroy"), null);
    assert.equal(expiryOf("sid-destroy"), undefined, "logout should not leave the row behind");
  });

  test("destroying something already gone is not an error", async () => {
    await assert.doesNotReject(() => destroy("sid-already-gone"));
  });
});

describe("corrupt rows", () => {
  test("a row with unparseable JSON is dropped and treated as absent", async () => {
    // Otherwise one bad row wedges every future request carrying that cookie,
    // with no way for the user to recover but clearing their cookies.
    db.prepare(`INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)`).run(
      "sid-corrupt",
      "{not valid json",
      Date.now() + DAY_MS
    );

    assert.equal(await get("sid-corrupt"), null);
    assert.equal(expiryOf("sid-corrupt"), undefined, "the corrupt row should have been deleted");
  });
});

describe("pruneSessions", () => {
  test("removes expired rows and leaves live ones alone", async () => {
    await set("sid-live", sessionWith({ userId: "u" }, 30 * DAY_MS));
    await set("sid-dead", sessionWith({ userId: "u" }, -1000));

    pruneSessions();

    assert.ok(expiryOf("sid-live") !== undefined, "a live session must survive the sweep");
    assert.equal(expiryOf("sid-dead"), undefined, "an expired session should be swept");
  });
});
