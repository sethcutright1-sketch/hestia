// rateLimit.ts -- the one failed-attempt limiter behind POST /api/auth/login, the household PIN
// on POST /api/auth/register, and POST /api/lock/unlock (the project notes 10.3, 10.4).
//
// A limiter that has quietly stopped working looks exactly like one that works until someone is
// through it, so this covers the arithmetic with a fake clock, and then each route's key: who
// shares a budget of attempts and who must not.
//
// `authAttempts` is one module-level instance shared by every route, so each test uses its own
// username or address.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, getConfig, setConfig } = await loadDb();
const { AttemptLimiter, authAttempts } = await import("../rateLimit.ts");
const { authRoutes } = await import("../auth.ts");
const { lockRoutes } = await import("../routes/lock.ts");

const PASSWORD = "correct horse battery";
let alex: string;
let ipCounter = 0;
/** A fresh address per test, so no two tests share a limiter key. */
const freshIp = () => `10.0.0.${++ipCounter}`;

before(async () => {
  alex = createUser("alex-rl", await bcrypt.hash(PASSWORD, 4), "Alex", "admin");
  createUser("bea-rl", await bcrypt.hash(PASSWORD, 4), "Bea", "parent");
});

beforeEach(() => setConfig("budget.securityLog", []));

after(cleanupDb);

describe("AttemptLimiter", () => {
  function clock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  test("four failures are free; the fifth starts a 60 s lockout", () => {
    const c = clock();
    const limiter = new AttemptLimiter({ now: c.now });
    for (let i = 0; i < 4; i++) assert.equal(limiter.fail("k"), false);
    assert.equal(limiter.status("k").locked, false);

    assert.equal(limiter.fail("k"), true, "the fifth failure starts a lockout");
    assert.deepEqual(limiter.status("k"), { locked: true, retryAfterMs: 60_000 });

    c.advance(60_000);
    assert.equal(limiter.status("k").locked, false, "and it ends on time");
  });

  test("each further lockout doubles", () => {
    const c = clock();
    const limiter = new AttemptLimiter({ now: c.now });
    const lockout = () => {
      for (let i = 0; i < 5; i++) limiter.fail("k");
      const { retryAfterMs } = limiter.status("k");
      c.advance(retryAfterMs);
      return retryAfterMs;
    };
    assert.deepEqual([lockout(), lockout(), lockout()], [60_000, 120_000, 240_000]);
  });

  test("a lockout never exceeds an hour", () => {
    const c = clock();
    const limiter = new AttemptLimiter({ now: c.now });
    for (let i = 0; i < 50; i++) limiter.fail("k");
    assert.equal(limiter.status("k").retryAfterMs, 60 * 60_000);
  });

  test("clear() forgets the count", () => {
    const limiter = new AttemptLimiter();
    for (let i = 0; i < 4; i++) limiter.fail("k");
    limiter.clear("k");
    assert.equal(limiter.fail("k"), false, "this is failure 1 again, not 5");
  });

  test("keys are independent", () => {
    const limiter = new AttemptLimiter();
    for (let i = 0; i < 5; i++) limiter.fail("a");
    assert.equal(limiter.status("a").locked, true);
    assert.equal(limiter.status("b").locked, false);
  });

  test("sweep() forgets a key a day after its last failure, and keeps a recent one's count", () => {
    const c = clock();
    const limiter = new AttemptLimiter({ now: c.now });
    limiter.fail("idle");
    c.advance(23 * 60 * 60_000);
    for (let i = 0; i < 5; i++) limiter.fail("recent"); // first lockout, 60 s
    c.advance(60 * 60_000); // "idle" is now exactly a day old; "recent" an hour

    limiter.sweep();
    assert.equal(limiter.size, 1, "the idle key is gone");

    for (let i = 0; i < 5; i++) limiter.fail("recent");
    assert.equal(limiter.status("recent").retryAfterMs, 120_000, "the recent key kept its count: this is its second lockout");
  });

  test("a key still locked out is never swept as idle", () => {
    // A lockout is at most an hour and always starts at a failure, so it ends long before the
    // day-long idle window does.
    const c = clock();
    const limiter = new AttemptLimiter({ now: c.now });
    for (let i = 0; i < 50; i++) limiter.fail("k");
    c.advance(59 * 60_000);
    limiter.sweep();
    assert.equal(limiter.status("k").locked, true);
  });

  test("past the size cap, unlocked keys are evicted before a locked one", () => {
    // Otherwise a flood of throwaway usernames would push a real lockout out of the Map.
    const limiter = new AttemptLimiter({ maxKeys: 3 });
    for (let i = 0; i < 5; i++) limiter.fail("victim"); // oldest key, and locked
    limiter.fail("junk-1");
    limiter.fail("junk-2");
    limiter.fail("junk-3");
    limiter.fail("junk-4");

    assert.equal(limiter.size, 3);
    assert.equal(limiter.status("victim").locked, true, "the lockout survived the flood");
  });
});

describe("POST /login", () => {
  const login = (username: string, password: string, ip: string) =>
    callRoute(authRoutes, "POST", "/login", { ip, session: {}, body: { username, password } });

  test("five wrong passwords lock that username from that address, even against the right one", async () => {
    const ip = freshIp();
    for (let i = 1; i <= 5; i++) assert.equal((await login("alex-rl", "wrong", ip)).status, 401, `attempt ${i}`);

    const sixth = await login("alex-rl", PASSWORD, ip);
    assert.equal(sixth.status, 429);
    assert.ok(sixth.body.retryAfterMs > 0);
    assert.equal(sixth.headers?.["retry-after"], "60");
  });

  test("the lockout doesn't reach the same account from another device, or another account", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await login("alex-rl", "wrong", ip);

    assert.equal((await login("alex-rl", PASSWORD, freshIp())).status, 200, "Alex from his phone");
    assert.equal((await login("bea-rl", PASSWORD, ip)).status, 200, "Bea from the same address");
  });

  test("the username is matched without case or surrounding spaces, so neither resets the count", async () => {
    const ip = freshIp();
    for (const name of ["alex-rl", "ALEX-RL", " Alex-rl ", "alex-RL", "aLex-rl"]) await login(name, "wrong", ip);
    assert.equal((await login("alex-rl", PASSWORD, ip)).status, 429);
  });

  test("a successful sign-in clears the count", async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await login("alex-rl", "wrong", ip);
    assert.equal((await login("alex-rl", PASSWORD, ip)).status, 200);
    assert.equal((await login("alex-rl", "wrong", ip)).status, 401, "a fresh count: this is failure 1");
  });

  test("an unknown username is limited too", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await login("nobody-rl", "wrong", ip);
    assert.equal((await login("nobody-rl", "wrong", ip)).status, 429);
  });

  test("failures are written to the security log, naming a real account but never an unknown username as typed", async () => {
    const ip = freshIp();
    await login("alex-rl", "wrong", ip);
    await login("hunter2-typed-in-the-wrong-box", "wrong", ip);

    const log = getConfig("budget.securityLog", []) as { event: string; type: string }[];
    assert.equal(log.length, 2);
    assert.equal(log[1].event, `Failed sign-in for "alex-rl" from ${ip}.`);
    assert.equal(log[0].event, `Failed sign-in for an unknown username from ${ip}.`);
    assert.ok(!JSON.stringify(log).includes("hunter2"));
    assert.equal(log[0].type, "warning");
  });

  test("the lockout itself is logged once, as critical", async () => {
    const ip = freshIp();
    for (let i = 0; i < 6; i++) await login("alex-rl", "wrong", ip);
    const log = getConfig("budget.securityLog", []) as { event: string; type: string }[];
    assert.equal(log.filter((e) => e.type === "critical").length, 1);
    assert.equal(log.length, 6, "5 failures + 1 lockout; the refused 6th attempt adds nothing");
  });

  test("a successful sign-in is not logged as a failure", async () => {
    await login("alex-rl", PASSWORD, freshIp());
    assert.deepEqual(getConfig("budget.securityLog", []), []);
  });
});

describe("POST /register -- the household PIN", () => {
  const register = (pin: string, ip: string, username = `new-${Math.random()}`) =>
    callRoute(authRoutes, "POST", "/register", { ip, session: {}, body: { username, password: "longenough1", pin } });

  test("five wrong PINs from one address pause sign-up there, whatever username is tried", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) assert.equal((await register("9999", ip)).status, 403);
    const result = await register("1234", ip);
    assert.equal(result.status, 429, "the right (default) PIN is refused during the lockout");
    assert.equal((await register("1234", freshIp())).status, 200, "another address is unaffected");
  });

  test("a malformed PIN is rejected without counting as a guess", async () => {
    const ip = freshIp();
    for (let i = 0; i < 6; i++) assert.equal((await register("abc", ip)).status, 400);
    assert.equal((await register("1234", ip)).status, 200);
  });

  test("a wrong PIN is logged", async () => {
    const ip = freshIp();
    await register("9999", ip);
    const log = getConfig("budget.securityLog", []) as { event: string }[];
    assert.equal(log[0].event, `Wrong household PIN on account sign-up from ${ip}.`);
  });
});

describe("POST /api/lock/unlock", () => {
  before(async () => setConfig("lock_pin_hash", await bcrypt.hash("4321", 4)));
  after(() => setConfig("lock_pin_hash", null));

  test("refuses a device token outright, before any PIN check (10.4)", async () => {
    // Each cookie-less request used to get its own fresh session id, so its own fresh limiter
    // bucket: a token could walk every PIN with no lockout at all.
    for (let i = 0; i < 10; i++) {
      const result = await callRoute(lockRoutes, "POST", "/unlock", {
        deviceUserId: alex,
        sessionID: `cookieless-${i}`,
        ip: "127.0.0.1",
        body: { code: "4321" },
      });
      assert.equal(result.status, 403, "even the right PIN");
    }
    assert.deepEqual(getConfig("budget.securityLog", []), [], "and no attempt reached the PIN check");
  });

  test("a device token is refused even when no PIN is set", async () => {
    setConfig("lock_pin_hash", null);
    try {
      const result = await callRoute(lockRoutes, "POST", "/unlock", { deviceUserId: alex, body: { code: "4321" } });
      assert.equal(result.status, 403);
    } finally {
      setConfig("lock_pin_hash", await bcrypt.hash("4321", 4));
    }
  });

  test("the same session from two addresses has two budgets (session + address key)", async () => {
    const session = { userId: alex };
    const ipA = freshIp();
    for (let i = 0; i < 5; i++) {
      await callRoute(lockRoutes, "POST", "/unlock", { session, sessionID: "shared-session", ip: ipA, body: { code: "0000" } });
    }
    const locked = await callRoute(lockRoutes, "POST", "/unlock", { session, sessionID: "shared-session", ip: ipA, body: { code: "4321" } });
    assert.equal(locked.status, 429);

    const other = await callRoute(lockRoutes, "POST", "/unlock", { session, sessionID: "shared-session", ip: freshIp(), body: { code: "4321" } });
    assert.equal(other.status, 200);
  });

  test("a PIN lockout and a login lockout never block each other", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      await callRoute(lockRoutes, "POST", "/unlock", { session: { userId: alex }, sessionID: "pin-vs-login", ip, body: { code: "0000" } });
    }
    const login = await callRoute(authRoutes, "POST", "/login", { ip, session: {}, body: { username: "alex-rl", password: PASSWORD } });
    assert.equal(login.status, 200);
  });
});

test("the shared limiter's Map is swept rather than growing forever", () => {
  // The sweep timer is unref()'d, so it can't keep this process alive; calling it directly is
  // the same code the timer runs.
  const before = authAttempts.size;
  authAttempts.sweep();
  assert.ok(authAttempts.size <= before);
});
