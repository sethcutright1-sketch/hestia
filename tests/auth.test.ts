// auth.ts -- the gate every other route sits behind, and the PIN lock in front
// of financial data.
//
// Untested until now, and the hardest area to check by hand: the interesting
// cases are a session that has gone stale, a lock window that slid forward or
// didn't, and an account cap that has to hold. None of those are things you
// notice while clicking around signed in as yourself.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute, callMiddleware, type FakeSession } from "./helpers/router.ts";

const { createUser, setConfig, getUserByUsername, getHouseholdMemberCount, deleteKioskUser } = await loadDb();
const { requireAuth, requireUnlocked, forbidKiosk, requireAdmin, isUnlocked, currentUserId, verifyPassword, authRoutes } =
  await import("../auth.ts");

const PASSWORD = "correct horse battery";
let alice: string;

before(async () => {
  // Cost 4 rather than the app's 12: bcrypt.compare reads the cost from the
  // hash itself, so this verifies identically and keeps the suite quick.
  // Admin, not the "parent" default: most of this file uses alice as the
  // generic signed-in real household member, including the household-pin
  // tests below, which are requireAdmin-gated now. Nothing else in this file
  // cares about her specific tier -- requireAuth/requireUnlocked don't check
  // role at all, and login/register/change-password are role-agnostic too.
  alice = createUser("alice-auth", await bcrypt.hash(PASSWORD, 4), "Alice", "admin");
});

beforeEach(() => {
  // Most tests want no PIN configured; the lock suite sets its own.
  setConfig("lock_pin_hash", null);
});

after(cleanupDb);

describe("requireAuth", () => {
  test("passes a session with a real user", async () => {
    const result = await callMiddleware(requireAuth, { session: { userId: alice } });
    assert.equal(result.passed, true);
  });

  test("rejects a session with no user id", async () => {
    const result = await callMiddleware(requireAuth, { session: {} });
    assert.equal(result.passed, false);
    assert.equal(result.status, 401);
  });

  test("rejects a session pointing at a user who no longer exists", async () => {
    // A deleted account's cookie is still a validly-signed cookie. Checking the
    // id against the database is what stops it from still working.
    const result = await callMiddleware(requireAuth, { session: { userId: "user-deleted" } });
    assert.equal(result.passed, false);
    assert.equal(result.status, 401);
  });
});

describe("currentUserId", () => {
  test("reports the signed-in user", () => {
    assert.equal(currentUserId({ session: { userId: alice } } as any), alice);
  });
});

describe("verifyPassword", () => {
  test("accepts the right password", async () => {
    assert.equal(await verifyPassword(alice, PASSWORD), true);
  });

  test("rejects the wrong one", async () => {
    assert.equal(await verifyPassword(alice, "hunter2"), false);
  });

  test("rejects an empty or missing password without throwing", async () => {
    // This guards the database download and the PIN reset, so "" must never be
    // treated as "no password required".
    assert.equal(await verifyPassword(alice, ""), false);
    assert.equal(await verifyPassword(alice, undefined as any), false);
  });

  test("rejects an unknown user", async () => {
    assert.equal(await verifyPassword("user-nope", PASSWORD), false);
  });
});

describe("isUnlocked -- with no PIN configured", () => {
  test("everything is unlocked, since there is nothing to unlock", () => {
    assert.equal(isUnlocked({ session: {} } as any), true);
  });
});

describe("isUnlocked / requireUnlocked -- with a PIN configured", () => {
  before(async () => {
    setConfig("lock_timeout_kiosk_minutes", 5);
    setConfig("lock_timeout_trusted_minutes", 120);
  });

  beforeEach(async () => {
    setConfig("lock_pin_hash", await bcrypt.hash("1234", 4));
  });

  test("a session that has never unlocked is locked", () => {
    assert.equal(isUnlocked({ session: {} } as any), false);
  });

  test("an expired unlock window is locked again", () => {
    assert.equal(isUnlocked({ session: { unlockedUntil: Date.now() - 1 } } as any), false);
  });

  test("a live unlock window is unlocked", () => {
    assert.equal(isUnlocked({ session: { unlockedUntil: Date.now() + 60_000 } } as any), true);
  });

  test("requireUnlocked answers 423 Locked, not 403", async () => {
    // 423 is what lets the client show a keypad instead of a generic error --
    // 403 would read as "wrong account".
    const result = await callMiddleware(requireUnlocked, { session: { userId: alice } });
    assert.equal(result.passed, false);
    assert.equal(result.status, 423);
    assert.equal(result.body.error, "locked");
  });

  test("requireUnlocked lets an unlocked session through", async () => {
    const result = await callMiddleware(requireUnlocked, {
      session: { userId: alice, unlockedUntil: Date.now() + 60_000 },
    });
    assert.equal(result.passed, true);
  });

  test("the window slides forward on every gated request", async () => {
    // Active use must never interrupt itself. Without the slide, a session
    // unlocked 5 minutes ago relocks mid-task even while being used.
    const session: FakeSession = { userId: alice, unlockedUntil: Date.now() + 1_000 };
    const result = await callMiddleware(requireUnlocked, { session });

    assert.equal(result.passed, true);
    assert.ok(
      session.unlockedUntil! > Date.now() + 4 * 60_000,
      "a kiosk unlock should have slid out to ~5 minutes"
    );
  });

  test("a trusted device gets the longer timeout", async () => {
    const trusted: FakeSession = { userId: alice, unlockedUntil: Date.now() + 1_000, lockTrusted: true };
    await callMiddleware(requireUnlocked, { session: trusted });

    assert.ok(
      trusted.unlockedUntil! > Date.now() + 119 * 60_000,
      "a trusted unlock should have slid out to ~120 minutes"
    );
  });

  test("a locked session's window is not slid forward", async () => {
    // Otherwise hammering a gated route would hold the lock open from outside.
    const session: FakeSession = { userId: alice };
    await callMiddleware(requireUnlocked, { session });
    assert.equal(session.unlockedUntil, undefined);
  });

  test("with no PIN set, requireUnlocked passes and leaves the session alone", async () => {
    setConfig("lock_pin_hash", null);
    const session: FakeSession = { userId: alice };

    const result = await callMiddleware(requireUnlocked, { session });

    assert.equal(result.passed, true);
    assert.equal(session.unlockedUntil, undefined, "no PIN means no window to track");
  });
});

// The household PIN gates *who can create an account at all* -- unrelated to the
// budget PIN lock covered above, which gates what an already-signed-in person can
// reach. Placed before "POST /register" below so these run while household_pin_hash
// is still unset (a fresh throwaway database per test file), which is what lets the
// first test actually exercise the lazy-seeding path rather than an already-seeded one.
describe("Household PIN", () => {
  describe("POST /register", () => {
    test("succeeds with the default 1234 PIN on a fresh database (lazy seeding)", async () => {
      const result = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "pin-newcomer", password: "a-good-password", pin: "1234" },
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    });

    test("fails with a wrong PIN", async () => {
      const result = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "pin-wrong", password: "a-good-password", pin: "9999" },
      });
      assert.equal(result.status, 403);
      assert.match(result.body.error, /household PIN isn't right/i);
      assert.equal(getUserByUsername("pin-wrong"), undefined);
    });

    test("fails with a missing PIN", async () => {
      const result = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "pin-missing", password: "a-good-password" },
      });
      assert.equal(result.status, 400);
      assert.equal(getUserByUsername("pin-missing"), undefined);
    });

    test("fails with a malformed PIN", async () => {
      const letters = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "pin-letters", password: "a-good-password", pin: "abcd" },
      });
      assert.equal(letters.status, 400);

      const tooShort = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "pin-short", password: "a-good-password", pin: "12" },
      });
      assert.equal(tooShort.status, 400);
    });

    test("checks the PIN before the username-taken check", async () => {
      // A wrong PIN against an EXISTING username must answer 403 (wrong PIN), never
      // 409 (username taken) -- otherwise this route is an oracle for which
      // usernames exist to anyone willing to guess, PIN or no PIN.
      const result = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "alice-auth", password: "a-good-password", pin: "0000" },
      });
      assert.equal(result.status, 403);
    });
  });

  describe("GET /household-pin", () => {
    test("requires being signed in", async () => {
      const result = await callRoute(authRoutes, "GET", "/household-pin", { session: {} });
      assert.equal(result.status, 401);
    });

    test("reports isDefault true initially", async () => {
      const result = await callRoute(authRoutes, "GET", "/household-pin", { session: { userId: alice } });
      assert.equal(result.status, 200);
      assert.equal(result.body.isDefault, true);
    });
  });

  describe("GET /status", () => {
    test("never exposes anything about the household PIN", async () => {
      // The one auth route an unauthenticated visitor can always reach -- it must
      // stay silent about whether "1234" still works.
      const result = await callRoute(authRoutes, "GET", "/status", { session: {} });
      assert.equal("isDefault" in result.body, false);
      assert.equal("householdPinIsDefault" in result.body, false);
    });
  });

  describe("PUT /household-pin", () => {
    test("requires being signed in", async () => {
      const result = await callRoute(authRoutes, "PUT", "/household-pin", {
        session: {},
        body: { pin: "5678", password: PASSWORD },
      });
      assert.equal(result.status, 401);
    });

    test("rejects a malformed PIN", async () => {
      const result = await callRoute(authRoutes, "PUT", "/household-pin", {
        session: { userId: alice },
        body: { pin: "12", password: PASSWORD },
      });
      assert.equal(result.status, 400);
    });

    test("rejects the wrong account password", async () => {
      const result = await callRoute(authRoutes, "PUT", "/household-pin", {
        session: { userId: alice },
        body: { pin: "5678", password: "not-alices-password" },
      });
      assert.equal(result.status, 401);
    });

    test("changes the PIN when the password is right: the old PIN then fails and the new one works", async () => {
      const changed = await callRoute(authRoutes, "PUT", "/household-pin", {
        session: { userId: alice },
        body: { pin: "5678", password: PASSWORD },
      });
      assert.equal(changed.status, 200);

      const oldPinAttempt = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "after-pin-change-old", password: "a-good-password", pin: "1234" },
      });
      assert.equal(oldPinAttempt.status, 403, "the old household PIN must stop working");

      const newPinAttempt = await callRoute(authRoutes, "POST", "/register", {
        body: { username: "after-pin-change-new", password: "a-good-password", pin: "5678" },
      });
      assert.equal(newPinAttempt.status, 200, "the new household PIN must work");
    });

    test("isDefault flips false after changing away from 1234, and true again once set back", async () => {
      // Continues from the change made just above -- the household PIN is "5678"
      // right now, so isDefault should already read false.
      const afterChange = await callRoute(authRoutes, "GET", "/household-pin", { session: { userId: alice } });
      assert.equal(afterChange.body.isDefault, false);

      const revert = await callRoute(authRoutes, "PUT", "/household-pin", {
        session: { userId: alice },
        body: { pin: "1234", password: PASSWORD },
      });
      assert.equal(revert.status, 200);

      const afterRevert = await callRoute(authRoutes, "GET", "/household-pin", { session: { userId: alice } });
      assert.equal(afterRevert.body.isDefault, true, "setting it back to 1234 must re-flag it as default");
    });
  });
});

describe("POST /register", () => {
  test("rejects a missing username or password", async () => {
    const noUser = await callRoute(authRoutes, "POST", "/register", { body: { password: "longenough1" } });
    assert.equal(noUser.status, 400);

    const noPass = await callRoute(authRoutes, "POST", "/register", { body: { username: "someone" } });
    assert.equal(noPass.status, 400);
  });

  test("enforces a minimum password length", async () => {
    const result = await callRoute(authRoutes, "POST", "/register", {
      body: { username: "shorty", password: "abc" },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /at least 8 characters/);
    assert.equal(getUserByUsername("shorty"), undefined, "no account should have been created");
  });

  test("refuses a username that is already taken", async () => {
    const result = await callRoute(authRoutes, "POST", "/register", {
      body: { username: "alice-auth", password: "a-good-password", pin: "1234" },
    });
    assert.equal(result.status, 409);
  });

  test("creates an account, signs it in, and never echoes the password back", async () => {
    const session: FakeSession = {};
    const result = await callRoute(authRoutes, "POST", "/register", {
      session,
      body: { username: "newcomer", password: "a-good-password", displayName: "Newcomer", pin: "1234" },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.user.displayName, "Newcomer");
    assert.equal(session.userId, result.body.user.id, "registering should sign you in");
    assert.equal(JSON.stringify(result.body).includes("a-good-password"), false);
  });

  test("regenerates the session on registration, discarding whatever was there before", async () => {
    const session: FakeSession = { plantedByAttacker: "leftover-fixation-marker" };
    const result = await callRoute(authRoutes, "POST", "/register", {
      session,
      body: { username: "regen-check", password: "a-good-password", pin: "1234" },
    });

    assert.equal(result.status, 200);
    assert.equal(session.userId, result.body.user.id);
    assert.equal(session.plantedByAttacker, undefined, "pre-registration session state must not survive");
  });

  test("stores the password hashed, never in the clear", async () => {
    const stored = getUserByUsername("newcomer")!;
    assert.notEqual(stored.password_hash, "a-good-password");
    assert.ok(stored.password_hash.startsWith("$2"), "should be a bcrypt hash");
    assert.equal(await bcrypt.compare("a-good-password", stored.password_hash), true);
  });

  test("falls back to the username when no display name is given", async () => {
    const result = await callRoute(authRoutes, "POST", "/register", {
      body: { username: "nodisplay", password: "a-good-password", pin: "1234" },
    });
    assert.equal(result.body.user.displayName, "nodisplay");
  });

  test("stops at the household account cap", async () => {
    // MAX_HOUSEHOLD_USERS is 6. Fill the remaining slots, then check the next
    // one is refused rather than quietly allowed.
    while (getHouseholdMemberCount() < 6) {
      const n = getHouseholdMemberCount();
      const filled = await callRoute(authRoutes, "POST", "/register", {
        body: { username: `filler-${n}`, password: "a-good-password", pin: "1234" },
      });
      assert.equal(filled.status, 200, `filling slot ${n} should succeed`);
    }

    const overflow = await callRoute(authRoutes, "POST", "/register", {
      body: { username: "one-too-many", password: "a-good-password", pin: "1234" },
    });

    assert.equal(overflow.status, 403);
    assert.equal(getUserByUsername("one-too-many"), undefined);
    assert.equal(getHouseholdMemberCount(), 6, "the cap must actually hold");
  });

  test("GET /status reports the cap being full", async () => {
    const result = await callRoute(authRoutes, "GET", "/status", { session: {} });
    assert.equal(result.body.canRegister, false);
    assert.equal(result.body.authenticated, false);
    assert.equal(result.body.user, null);
  });
});

describe("POST /login", () => {
  test("signs in with the right password", async () => {
    const session: FakeSession = {};
    const result = await callRoute(authRoutes, "POST", "/login", {
      session,
      body: { username: "alice-auth", password: PASSWORD },
    });

    assert.equal(result.status, 200);
    assert.equal(session.userId, alice);
  });

  test("rejects a wrong password without signing anyone in", async () => {
    const session: FakeSession = {};
    const result = await callRoute(authRoutes, "POST", "/login", {
      session,
      body: { username: "alice-auth", password: "wrong" },
    });

    assert.equal(result.status, 401);
    assert.equal(session.userId, undefined);
  });

  test("gives the same message for a wrong username as for a wrong password", async () => {
    // Otherwise this endpoint answers "does this account exist?" for anyone
    // who asks.
    const badUser = await callRoute(authRoutes, "POST", "/login", {
      body: { username: "nobody-here", password: PASSWORD },
    });
    const badPass = await callRoute(authRoutes, "POST", "/login", {
      body: { username: "alice-auth", password: "wrong" },
    });

    assert.equal(badUser.status, badPass.status);
    assert.equal(badUser.body.error, badPass.body.error);
  });

  test("requires both fields", async () => {
    const result = await callRoute(authRoutes, "POST", "/login", { body: { username: "alice-auth" } });
    assert.equal(result.status, 400);
  });

  // the project notes 10.2: a pre-login session must not carry over into an
  // authenticated one -- otherwise whoever planted that session's cookie
  // (session fixation) inherits it the moment a real person logs in on that
  // browser. Anything left over from before login should be gone afterward.
  test("regenerates the session on login, discarding whatever was there before", async () => {
    const session: FakeSession = { plantedByAttacker: "leftover-fixation-marker" };
    const result = await callRoute(authRoutes, "POST", "/login", {
      session,
      body: { username: "alice-auth", password: PASSWORD },
    });

    assert.equal(result.status, 200);
    assert.equal(session.userId, alice);
    assert.equal(session.plantedByAttacker, undefined, "pre-login session state must not survive");
  });

  test("does not regenerate the session on a failed login", async () => {
    const session: FakeSession = { plantedByAttacker: "leftover-fixation-marker" };
    const result = await callRoute(authRoutes, "POST", "/login", {
      session,
      body: { username: "alice-auth", password: "wrong" },
    });

    assert.equal(result.status, 401);
    assert.equal(session.plantedByAttacker, "leftover-fixation-marker", "no reason to touch the session on failure");
  });
});

describe("POST /logout", () => {
  test("clears the session", async () => {
    const session: FakeSession = { userId: alice, unlockedUntil: Date.now() + 60_000 };
    const result = await callRoute(authRoutes, "POST", "/logout", { session });

    assert.equal(result.status, 200);
    assert.equal(session.userId, undefined);
    assert.equal(session.unlockedUntil, undefined, "logging out should drop the unlock window too");
  });
});

describe("POST /change-password", () => {
  const NEW_PASSWORD = "a-brand-new-password";

  test("requires being signed in", async () => {
    const result = await callRoute(authRoutes, "POST", "/change-password", {
      session: {},
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(result.status, 401);
  });

  test("requires both fields", async () => {
    const result = await callRoute(authRoutes, "POST", "/change-password", {
      session: { userId: alice },
      body: { newPassword: NEW_PASSWORD },
    });
    assert.equal(result.status, 400);
  });

  test("enforces the minimum length on the new password", async () => {
    const result = await callRoute(authRoutes, "POST", "/change-password", {
      session: { userId: alice },
      body: { currentPassword: PASSWORD, newPassword: "short" },
    });
    assert.equal(result.status, 400);
    assert.equal(await verifyPassword(alice, PASSWORD), true, "the old password must still work");
  });

  test("refuses without the current password, even with a live session", async () => {
    // A stolen or left-open session should not be enough on its own to take
    // over the account -- the same reasoning the backup download uses.
    const result = await callRoute(authRoutes, "POST", "/change-password", {
      session: { userId: alice },
      body: { currentPassword: "not-it", newPassword: NEW_PASSWORD },
    });

    assert.equal(result.status, 401);
    assert.equal(await verifyPassword(alice, PASSWORD), true, "the password must be unchanged");
  });

  test("changes the password when the current one is right", async () => {
    const result = await callRoute(authRoutes, "POST", "/change-password", {
      session: { userId: alice },
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });

    assert.equal(result.status, 200);
    assert.equal(await verifyPassword(alice, NEW_PASSWORD), true);
    assert.equal(await verifyPassword(alice, PASSWORD), false, "the old password must stop working");
  });
});

// The kiosk login is a second, deliberately weaker account class -- see
// forbidKiosk (auth.ts) for what it's blocked from, and PLAN.md's kiosk-login
// note for why (a shared always-on screen should reach less than a real
// household member, not just look like it does). A fresh user here rather
// than reusing `alice`, whose password the change-password suite above just
// rotated to NEW_PASSWORD.
describe("kiosk role", () => {
  let carol: string;
  let dana: string;
  const CAROL_PASSWORD = "correct horse battery staple";
  const DANA_PASSWORD = "correct horse battery staple too";

  before(async () => {
    // Admin, not the "parent" default: managing the kiosk login itself is
    // requireAdmin-gated now (see the "requireAdmin" describe block below),
    // and this fixture is used throughout this file as the account doing
    // that managing.
    carol = createUser("carol-auth", await bcrypt.hash(CAROL_PASSWORD, 4), "Carol", "admin");
    // A plain parent -- shared across every "admin only" refusal check below
    // (household-pin, kiosk management, requireAdmin itself) rather than one
    // fixture per test. This file's POST /register describe block already
    // fills MAX_HOUSEHOLD_USERS exactly, so every extra real account here has
    // to be deliberate, not one-off.
    dana = createUser("dana-auth", await bcrypt.hash(DANA_PASSWORD, 4), "Dana");
  });

  describe("forbidKiosk", () => {
    test("passes a real member account", async () => {
      const result = await callMiddleware(forbidKiosk, { session: { userId: carol } });
      assert.equal(result.passed, true);
    });

    test("blocks a kiosk-role account with 403, not 401 -- it IS signed in, just not allowed here", async () => {
      const kioskId = createUser("kiosk-forbid-check", "not-a-real-hash", "Kiosk", "kiosk");
      try {
        const result = await callMiddleware(forbidKiosk, { session: { userId: kioskId } });
        assert.equal(result.passed, false);
        assert.equal(result.status, 403);
      } finally {
        // getKioskUser/deleteKioskUser (db.ts) assume at most one kiosk row --
        // true for anything created through PUT /kiosk, but this test built
        // one directly, so it has to clean up after itself or the "no kiosk
        // login yet" test further down (same throwaway database) finds this
        // leftover row instead.
        deleteKioskUser();
      }
    });
  });

  describe("requireAdmin", () => {
    test("passes an admin account", async () => {
      const result = await callMiddleware(requireAdmin, { session: { userId: carol } });
      assert.equal(result.passed, true);
    });

    test("blocks a parent account with 403", async () => {
      const result = await callMiddleware(requireAdmin, { session: { userId: dana } });
      assert.equal(result.passed, false);
      assert.equal(result.status, 403);
    });

    test("blocks a kiosk account with 403 -- a kiosk is never admin", async () => {
      const kioskId = createUser("kiosk-require-admin-check", "not-a-real-hash", "Kiosk", "kiosk");
      try {
        const result = await callMiddleware(requireAdmin, { session: { userId: kioskId } });
        assert.equal(result.passed, false);
        assert.equal(result.status, 403);
      } finally {
        deleteKioskUser();
      }
    });

    test("a parent is refused on the household-pin routes too, even with the right password", async () => {
      const get = await callRoute(authRoutes, "GET", "/household-pin", { session: { userId: dana } });
      assert.equal(get.status, 403);

      const put = await callRoute(authRoutes, "PUT", "/household-pin", {
        session: { userId: dana },
        body: { pin: "5678", password: DANA_PASSWORD },
      });
      assert.equal(put.status, 403);
    });
  });

  describe("GET /status", () => {
    test("reports the signed-in user's role", async () => {
      const result = await callRoute(authRoutes, "GET", "/status", { session: { userId: carol } });
      assert.equal(result.body.user.role, "admin");
    });
  });

  describe("GET/PUT/DELETE /kiosk", () => {
    test("reports no kiosk login before one has ever been created", async () => {
      const result = await callRoute(authRoutes, "GET", "/kiosk", { session: { userId: carol } });
      assert.equal(result.status, 200);
      assert.equal(result.body.exists, false);
      assert.equal(result.body.username, null);
    });

    test("requires being signed in", async () => {
      const result = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: {},
        body: { username: "fridge", password: "a-good-password", currentPassword: CAROL_PASSWORD },
      });
      assert.equal(result.status, 401);
    });

    test("rejects a kiosk password under 8 characters", async () => {
      const result = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: { userId: carol },
        body: { username: "fridge", password: "short", currentPassword: CAROL_PASSWORD },
      });
      assert.equal(result.status, 400);
    });

    test("rejects the wrong caller password -- a live session alone isn't enough", async () => {
      const result = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: { userId: carol },
        body: { username: "fridge", password: "a-good-password", currentPassword: "not-carols-password" },
      });
      assert.equal(result.status, 401);
      assert.equal(getUserByUsername("fridge"), undefined);
    });

    test("creates the kiosk login once the caller's password checks out", async () => {
      const result = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: { userId: carol },
        body: { username: "fridge", password: "a-good-password", currentPassword: CAROL_PASSWORD },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.username, "fridge");

      const status = await callRoute(authRoutes, "GET", "/kiosk", { session: { userId: carol } });
      assert.equal(status.body.exists, true);
      assert.equal(status.body.username, "fridge");
    });

    test("the new login signs in as role kiosk, not member", async () => {
      const result = await callRoute(authRoutes, "POST", "/login", {
        session: {},
        body: { username: "fridge", password: "a-good-password" },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.user.role, "kiosk");
    });

    test("a kiosk session cannot reach GET/PUT/DELETE /kiosk itself", async () => {
      const kioskUser = getUserByUsername("fridge")!;
      const get = await callRoute(authRoutes, "GET", "/kiosk", { session: { userId: kioskUser.id } });
      assert.equal(get.status, 403);

      const put = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: { userId: kioskUser.id },
        body: { username: "fridge-take-2", password: "a-good-password", currentPassword: "a-good-password" },
      });
      assert.equal(put.status, 403);
    });

    test("a parent session cannot reach GET/PUT/DELETE /kiosk either -- admin only", async () => {
      const get = await callRoute(authRoutes, "GET", "/kiosk", { session: { userId: dana } });
      assert.equal(get.status, 403);

      const put = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: { userId: dana },
        body: { username: "fridge-take-3", password: "a-good-password", currentPassword: DANA_PASSWORD },
      });
      assert.equal(put.status, 403);
    });

    test("resetting replaces the previous kiosk login wholesale -- the old username stops working", async () => {
      const result = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: { userId: carol },
        body: { username: "wall-tablet", password: "a-second-password", currentPassword: CAROL_PASSWORD },
      });
      assert.equal(result.status, 200);

      const oldLogin = await callRoute(authRoutes, "POST", "/login", {
        body: { username: "fridge", password: "a-good-password" },
      });
      assert.equal(oldLogin.status, 401, "the replaced kiosk username should no longer exist");

      const newLogin = await callRoute(authRoutes, "POST", "/login", {
        body: { username: "wall-tablet", password: "a-second-password" },
      });
      assert.equal(newLogin.status, 200);
    });

    test("refuses a username already taken by a real household member", async () => {
      const result = await callRoute(authRoutes, "PUT", "/kiosk", {
        session: { userId: carol },
        body: { username: "carol-auth", password: "a-good-password", currentPassword: CAROL_PASSWORD },
      });
      assert.equal(result.status, 409);
    });

    test("DELETE requires the caller's password too", async () => {
      const result = await callRoute(authRoutes, "DELETE", "/kiosk", {
        session: { userId: carol },
        body: { currentPassword: "not-carols-password" },
      });
      assert.equal(result.status, 401);
      assert.equal(getUserByUsername("wall-tablet") !== undefined, true, "must still exist");
    });

    test("DELETE removes the kiosk login -- it can no longer sign in afterward", async () => {
      const result = await callRoute(authRoutes, "DELETE", "/kiosk", {
        session: { userId: carol },
        body: { currentPassword: CAROL_PASSWORD },
      });
      assert.equal(result.status, 200);

      const status = await callRoute(authRoutes, "GET", "/kiosk", { session: { userId: carol } });
      assert.equal(status.body.exists, false);

      const loginAttempt = await callRoute(authRoutes, "POST", "/login", {
        body: { username: "wall-tablet", password: "a-second-password" },
      });
      assert.equal(loginAttempt.status, 401);
    });
  });
});
