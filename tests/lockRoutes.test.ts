// routes/lock.ts -- how a session actually becomes unlocked, and how the PIN
// itself is set, changed, or removed.
//
// The rate limiter is the part that most needs a test. A 4-6 digit PIN is a
// space of 10,000-1,000,000 codes; without a working lockout a script walks it
// in minutes, and "the lockout stopped working" is completely invisible from
// the outside until someone is already through it.
//
// Every test here uses its own sessionID, because the limiter's state is a
// module-level Map keyed by exactly that -- sharing one would let an earlier
// test's failures lock out a later one.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute, type FakeSession } from "./helpers/router.ts";

const { createUser, getConfig, setConfig } = await loadDb();
const { lockRoutes } = await import("../routes/lock.ts");

const PASSWORD = "correct horse battery";
const PIN = "1234";
let alice: string;
let sessionCounter = 0;

/** A signed-in session with an id unique to the calling test. */
function freshSession(overrides: FakeSession = {}): { session: FakeSession; sessionID: string } {
  return { session: { userId: alice, ...overrides }, sessionID: `lock-session-${sessionCounter++}` };
}

async function setPin(pin: string | null) {
  setConfig("lock_pin_hash", pin === null ? null : await bcrypt.hash(pin, 4));
}

before(async () => {
  // Admin, not the "parent" default: PUT /settings, PUT /pin and DELETE /pin
  // are requireAdmin-gated now (routes/lock.ts), and alice is the account
  // exercising their positive-path behavior throughout this file. See the
  // "parent role" describe block below for coverage of the new restriction
  // itself.
  alice = createUser("alice-lock", await bcrypt.hash(PASSWORD, 4), "Alice", "admin");
});

beforeEach(async () => {
  await setPin(PIN);
  setConfig("lock_timeout_kiosk_minutes", 5);
  setConfig("lock_timeout_trusted_minutes", 120);
  setConfig("budget.securityLog", []);
});

after(cleanupDb);

describe("GET /status", () => {
  test("is reachable while locked -- the client needs it to know what to show", async () => {
    const result = await callRoute(lockRoutes, "GET", "/status", freshSession());

    assert.equal(result.status, 200);
    assert.equal(result.body.pinSet, true);
    assert.equal(result.body.unlocked, false);
    assert.equal(result.body.kioskMinutes, 5);
    assert.equal(result.body.trustedMinutes, 120);
  });

  test("reports unlocked with a live window", async () => {
    const result = await callRoute(lockRoutes, "GET", "/status", freshSession({ unlockedUntil: Date.now() + 60_000 }));
    assert.equal(result.body.unlocked, true);
  });

  test("with no PIN set, reports unlocked and no expiry to track", async () => {
    await setPin(null);
    const result = await callRoute(lockRoutes, "GET", "/status", freshSession());

    assert.equal(result.body.pinSet, false);
    assert.equal(result.body.unlocked, true);
    assert.equal(result.body.unlockedUntil, null);
  });

  test("does not itself extend the unlock window", async () => {
    // The client polls this every 30s on the kiosk. If polling slid the window,
    // the lock would never engage on an idle screen -- which is the one place
    // it matters most.
    const ctx = freshSession({ unlockedUntil: Date.now() + 1_000 });
    const before = ctx.session.unlockedUntil;

    await callRoute(lockRoutes, "GET", "/status", ctx);

    assert.equal(ctx.session.unlockedUntil, before);
  });
});

describe("POST /unlock", () => {
  test("the right PIN opens a kiosk-length window", async () => {
    const ctx = freshSession();
    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: PIN } });

    assert.equal(result.status, 200);
    assert.equal(result.body.unlocked, true);
    assert.equal(ctx.session.lockTrusted, false);
    assert.ok(ctx.session.unlockedUntil! > Date.now() + 4 * 60_000);
    assert.ok(ctx.session.unlockedUntil! <= Date.now() + 5 * 60_000);
  });

  test("the trusted flag opens the longer window", async () => {
    const ctx = freshSession();
    await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: PIN, trusted: true } });

    assert.equal(ctx.session.lockTrusted, true);
    assert.ok(ctx.session.unlockedUntil! > Date.now() + 119 * 60_000);
  });

  test("only a literal `true` counts as trusted", async () => {
    // A truthy string from a form post must not silently buy 2 hours.
    const ctx = freshSession();
    await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: PIN, trusted: "yes" } });

    assert.equal(ctx.session.lockTrusted, false);
    assert.ok(ctx.session.unlockedUntil! <= Date.now() + 5 * 60_000);
  });

  test("a wrong PIN is refused and unlocks nothing", async () => {
    const ctx = freshSession();
    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: "9999" } });

    assert.equal(result.status, 401);
    assert.equal(ctx.session.unlockedUntil, undefined);
  });

  test("a malformed code is refused without reaching bcrypt", async () => {
    for (const code of ["abcd", "12", "1234567", "", "12 34"]) {
      const result = await callRoute(lockRoutes, "POST", "/unlock", { ...freshSession(), body: { code } });
      assert.equal(result.status, 401, `"${code}" should be refused`);
    }
  });

  test("a non-string code is refused rather than throwing", async () => {
    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...freshSession(), body: { code: 1234 } });
    assert.equal(result.status, 401);
  });

  test("with no PIN configured there is nothing to unlock", async () => {
    await setPin(null);
    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...freshSession(), body: {} });

    assert.equal(result.status, 200);
    assert.equal(result.body.unlocked, true);
  });

  test("a failed attempt is logged server-side", async () => {
    // Logged by the server, not the client: a locked-out session by definition
    // cannot be trusted to report its own lockout honestly.
    await callRoute(lockRoutes, "POST", "/unlock", { ...freshSession(), body: { code: "9999" } });

    const log = getConfig("budget.securityLog", []) as any[];
    assert.equal(log[0].event, "Incorrect PIN entered.");
    assert.equal(log[0].type, "warning");
  });

  test("the security log is capped rather than growing forever", async () => {
    setConfig("budget.securityLog", Array.from({ length: 60 }, (_, i) => ({ id: `old-${i}`, event: "x", type: "info" })));
    await callRoute(lockRoutes, "POST", "/unlock", { ...freshSession(), body: { code: "9999" } });

    assert.equal((getConfig("budget.securityLog", []) as any[]).length, 50);
  });
});

describe("POST /unlock -- the rate limiter", () => {
  test("locks the session out after five wrong PINs", async () => {
    const ctx = freshSession();

    for (let i = 1; i <= 5; i++) {
      const result = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: "9999" } });
      assert.equal(result.status, 401, `attempt ${i} should be a plain refusal`);
    }

    const sixth = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: "9999" } });
    assert.equal(sixth.status, 429, "the sixth attempt should be rate limited");
    assert.ok(sixth.body.retryAfterMs > 0, "and should say how long to wait");
  });

  test("the lockout applies even to the correct PIN", async () => {
    // Otherwise an attacker who guesses right on attempt 6 is let straight in,
    // and the limiter has done nothing.
    const ctx = freshSession();
    for (let i = 0; i < 5; i++) {
      await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: "9999" } });
    }

    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: PIN } });

    assert.equal(result.status, 429);
    assert.equal(ctx.session.unlockedUntil, undefined, "and must not unlock");
  });

  test("four wrong attempts do not lock anyone out", async () => {
    const ctx = freshSession();
    for (let i = 0; i < 4; i++) {
      await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: "9999" } });
    }

    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: PIN } });
    assert.equal(result.status, 200, "a mistyped PIN a few times must not lock out the household");
  });

  test("a correct PIN clears the failure count", async () => {
    const ctx = freshSession();
    for (let i = 0; i < 4; i++) {
      await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: "9999" } });
    }
    await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: PIN } });

    // If the counter had survived, this single failure would be the 5th strike.
    const after = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: "9999" } });
    assert.equal(after.status, 401);

    const next = await callRoute(lockRoutes, "POST", "/unlock", { ...ctx, body: { code: PIN } });
    assert.equal(next.status, 200);
  });

  test("the limiter is per-session, so one device cannot lock out another", async () => {
    // Keyed by session rather than IP on purpose: several devices behind one
    // home NAT would otherwise share a single budget.
    const attacker = freshSession();
    for (let i = 0; i < 6; i++) {
      await callRoute(lockRoutes, "POST", "/unlock", { ...attacker, body: { code: "9999" } });
    }

    const bystander = freshSession();
    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...bystander, body: { code: PIN } });
    assert.equal(result.status, 200, "a different device should be unaffected");
  });
});

describe("PUT /pin", () => {
  test("sets a PIN when the account password is right", async () => {
    await setPin(null);
    const result = await callRoute(lockRoutes, "PUT", "/pin", {
      ...freshSession(),
      body: { pin: "4321", password: PASSWORD },
    });

    assert.equal(result.status, 200);
    const unlock = await callRoute(lockRoutes, "POST", "/unlock", { ...freshSession(), body: { code: "4321" } });
    assert.equal(unlock.status, 200, "the new PIN should work");
  });

  test("works from a fully locked session -- this is the forgotten-PIN recovery path", async () => {
    // Deliberately NOT behind requireUnlocked: someone who knows the account
    // password can always set a new PIN, even having forgotten the old one.
    const result = await callRoute(lockRoutes, "PUT", "/pin", {
      ...freshSession(),
      body: { pin: "5555", password: PASSWORD },
    });
    assert.equal(result.status, 200);
  });

  test("refuses without the account password", async () => {
    const result = await callRoute(lockRoutes, "PUT", "/pin", {
      ...freshSession(),
      body: { pin: "5555", password: "wrong" },
    });

    assert.equal(result.status, 401);
    const unlock = await callRoute(lockRoutes, "POST", "/unlock", { ...freshSession(), body: { code: PIN } });
    assert.equal(unlock.status, 200, "the original PIN must still be in force");
  });

  test("enforces 4-6 digits", async () => {
    for (const pin of ["123", "1234567", "abcd", "12.34", ""]) {
      const result = await callRoute(lockRoutes, "PUT", "/pin", {
        ...freshSession(),
        body: { pin, password: PASSWORD },
      });
      assert.equal(result.status, 400, `"${pin}" should be rejected`);
    }
  });

  test("checks the PIN format before the password", async () => {
    // A bad PIN with a bad password should report the PIN problem -- otherwise
    // this endpoint doubles as a password oracle.
    const result = await callRoute(lockRoutes, "PUT", "/pin", {
      ...freshSession(),
      body: { pin: "abc", password: "also wrong" },
    });
    assert.equal(result.status, 400);
  });

  test("distinguishes setting a first PIN from changing one, in the log", async () => {
    await setPin(null);
    await callRoute(lockRoutes, "PUT", "/pin", { ...freshSession(), body: { pin: "1111", password: PASSWORD } });
    assert.equal((getConfig("budget.securityLog", []) as any[])[0].event, "PIN set.");

    await callRoute(lockRoutes, "PUT", "/pin", { ...freshSession(), body: { pin: "2222", password: PASSWORD } });
    assert.equal((getConfig("budget.securityLog", []) as any[])[0].event, "PIN changed.");
  });
});

describe("DELETE /pin", () => {
  test("requires an unlocked session", async () => {
    const result = await callRoute(lockRoutes, "DELETE", "/pin", {
      ...freshSession(),
      body: { password: PASSWORD },
    });

    assert.equal(result.status, 423, "removing the lock from a locked session should be refused");
    assert.ok(getConfig("lock_pin_hash", null), "the PIN must still be set");
  });

  test("requires the account password even when unlocked", async () => {
    const result = await callRoute(lockRoutes, "DELETE", "/pin", {
      ...freshSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { password: "wrong" },
    });

    assert.equal(result.status, 401);
    assert.ok(getConfig("lock_pin_hash", null));
  });

  test("removes the lock when unlocked and the password is right", async () => {
    const result = await callRoute(lockRoutes, "DELETE", "/pin", {
      ...freshSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { password: PASSWORD },
    });

    assert.equal(result.status, 200);
    assert.equal(getConfig("lock_pin_hash", null), null);
    assert.equal((getConfig("budget.securityLog", []) as any[])[0].event, "PIN lock removed.");
  });
});

describe("POST /lock", () => {
  test("relocks immediately", async () => {
    const ctx = freshSession({ unlockedUntil: Date.now() + 60_000 });
    const result = await callRoute(lockRoutes, "POST", "/lock", ctx);

    assert.equal(result.status, 200);
    assert.equal(ctx.session.unlockedUntil, 0);
  });
});

describe("PUT /settings", () => {
  test("requires an unlocked session", async () => {
    const result = await callRoute(lockRoutes, "PUT", "/settings", {
      ...freshSession(),
      body: { kioskMinutes: 60 },
    });
    assert.equal(result.status, 423);
  });

  test("stores new timeouts", async () => {
    const result = await callRoute(lockRoutes, "PUT", "/settings", {
      ...freshSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { kioskMinutes: 10, trustedMinutes: 240 },
    });

    assert.equal(result.body.kioskMinutes, 10);
    assert.equal(result.body.trustedMinutes, 240);
  });

  test("clamps values into a sane range rather than trusting the client", async () => {
    // 0 would mean "relock instantly", which reads as the lock being broken;
    // a year would quietly mean "never lock".
    const result = await callRoute(lockRoutes, "PUT", "/settings", {
      ...freshSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { kioskMinutes: 0, trustedMinutes: 999_999 },
    });

    assert.equal(result.body.kioskMinutes, 1, "clamped up to the 1-minute floor");
    assert.equal(result.body.trustedMinutes, 1440, "clamped down to the 24-hour ceiling");
  });

  test("rounds fractional minutes and ignores non-numbers", async () => {
    const ctx = freshSession({ unlockedUntil: Date.now() + 60_000 });
    const rounded = await callRoute(lockRoutes, "PUT", "/settings", { ...ctx, body: { kioskMinutes: 7.6 } });
    assert.equal(rounded.body.kioskMinutes, 8);

    const ignored = await callRoute(lockRoutes, "PUT", "/settings", {
      ...ctx,
      body: { kioskMinutes: "sixty", trustedMinutes: NaN },
    });
    assert.equal(ignored.body.kioskMinutes, 8, "a non-number should leave the existing value alone");
    assert.equal(ignored.body.trustedMinutes, 120);
  });
});

// The kiosk login (auth.ts) is still meant to unlock/lock Budget like anyone
// else -- that's the whole point of it -- but shouldn't be trusted to
// reconfigure the lock or set/remove the PIN itself. See requireAdmin on
// these three routes in routes/lock.ts.
describe("kiosk role", () => {
  let kioskId: string;
  let kioskSessionCounter = 0;

  before(() => {
    kioskId = createUser("fridge-lock-test", "not-a-real-hash", "Kiosk", "kiosk");
  });

  function kioskSession(overrides: FakeSession = {}) {
    return { session: { userId: kioskId, ...overrides }, sessionID: `lock-kiosk-session-${kioskSessionCounter++}` };
  }

  test("can still read lock status", async () => {
    const result = await callRoute(lockRoutes, "GET", "/status", kioskSession());
    assert.equal(result.status, 200);
  });

  test("can still unlock with the right PIN", async () => {
    const result = await callRoute(lockRoutes, "POST", "/unlock", { ...kioskSession(), body: { code: PIN } });
    assert.equal(result.status, 200);
    assert.equal(result.body.unlocked, true);
  });

  test("can still lock", async () => {
    const result = await callRoute(lockRoutes, "POST", "/lock", kioskSession({ unlockedUntil: Date.now() + 60_000 }));
    assert.equal(result.status, 200);
  });

  test("cannot change the lock timeouts", async () => {
    const result = await callRoute(lockRoutes, "PUT", "/settings", {
      ...kioskSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { kioskMinutes: 1 },
    });
    assert.equal(result.status, 403);
  });

  test("cannot set or change the PIN", async () => {
    const result = await callRoute(lockRoutes, "PUT", "/pin", {
      ...kioskSession(),
      body: { pin: "9999", password: "whatever" },
    });
    assert.equal(result.status, 403);
  });

  test("cannot remove the PIN", async () => {
    const result = await callRoute(lockRoutes, "DELETE", "/pin", {
      ...kioskSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { password: "whatever" },
    });
    assert.equal(result.status, 403);
  });
});

// A parent (today's full "member" access, just renamed) can unlock/lock
// Budget like anyone else, but PUT /settings, PUT /pin and DELETE /pin are
// now admin-only, not just non-kiosk -- see requireAdmin's comment (auth.ts).
describe("parent role", () => {
  let parentId: string;
  let parentSessionCounter = 0;

  before(async () => {
    parentId = createUser("parent-lock-test", await bcrypt.hash(PASSWORD, 4), "Parent");
  });

  function parentSession(overrides: FakeSession = {}) {
    return { session: { userId: parentId, ...overrides }, sessionID: `lock-parent-session-${parentSessionCounter++}` };
  }

  test("can still read lock status and unlock/lock", async () => {
    const status = await callRoute(lockRoutes, "GET", "/status", parentSession());
    assert.equal(status.status, 200);

    const unlock = await callRoute(lockRoutes, "POST", "/unlock", { ...parentSession(), body: { code: PIN } });
    assert.equal(unlock.status, 200);

    const lock = await callRoute(lockRoutes, "POST", "/lock", parentSession({ unlockedUntil: Date.now() + 60_000 }));
    assert.equal(lock.status, 200);
  });

  test("cannot change the lock timeouts", async () => {
    const result = await callRoute(lockRoutes, "PUT", "/settings", {
      ...parentSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { kioskMinutes: 1 },
    });
    assert.equal(result.status, 403);
  });

  test("cannot set or change the PIN, even with the right account password", async () => {
    const result = await callRoute(lockRoutes, "PUT", "/pin", {
      ...parentSession(),
      body: { pin: "9999", password: PASSWORD },
    });
    assert.equal(result.status, 403);
  });

  test("cannot remove the PIN, even unlocked with the right account password", async () => {
    const result = await callRoute(lockRoutes, "DELETE", "/pin", {
      ...parentSession({ unlockedUntil: Date.now() + 60_000 }),
      body: { password: PASSWORD },
    });
    assert.equal(result.status, 403);
  });
});
