// Device tokens (auth.ts's deviceTokenAuth, routes/devices.ts) and the
// voice/finance chat gate (assistant/providers/index.ts's blocksVoiceFinance).
//
// requireAuth/requireUnlocked's session-cookie behavior is exercised
// indirectly by every other route test; what's new and worth covering
// directly here is: a device token authenticates like a session for normal
// routes, a device token can NEVER pass requireUnlocked, and a device token
// can't be used to manage device tokens themselves.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callMiddleware, callRoute } from "./helpers/router.ts";

const { createUser } = await loadDb();
const { deviceTokenAuth, requireAuth, requireUnlocked } = await import("../auth.ts");
const { deviceRoutes } = await import("../routes/devices.ts");
const { assistantRoutes } = await import("../routes/assistant.ts");
const { blocksVoiceFinance } = await import("../assistant/providers/index.ts");

let alice: string;
let admin: string;
let bob: string;

before(() => {
  alice = createUser("alice-devices", "not-a-real-hash", "Alice");
  bob = createUser("bob-devices", "not-a-real-hash", "Bob");
  admin = createUser("admin-devices", "not-a-real-hash", "Admin", "admin");
});

after(cleanupDb);

async function issueToken(ownerSession: string, label = "test device"): Promise<string> {
  const result = await callRoute(deviceRoutes, "POST", "/", {
    session: { userId: ownerSession },
    body: { label },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.token as string;
}

describe("issuing and revoking device tokens", () => {
  test("requires a real session, not a device token, to issue one", async () => {
    const result = await callRoute(deviceRoutes, "POST", "/", {
      session: {}, // no userId -- as if only a device token were presented
      body: { label: "should fail" },
    });
    assert.equal(result.status, 403);
  });

  test("requires a label", async () => {
    for (const body of [{}, { label: "" }, { label: "   " }]) {
      const result = await callRoute(deviceRoutes, "POST", "/", { session: { userId: alice }, body });
      assert.equal(result.status, 400, `${JSON.stringify(body)} should be refused`);
    }
  });

  test("issues a raw token once, then lists the device without it", async () => {
    const token = await issueToken(alice, "Alice's watch");
    assert.ok(token.length >= 32, "token should be high-entropy, not a short code");

    const listed = await callRoute(deviceRoutes, "GET", "/", { session: { userId: alice } });
    assert.equal(listed.status, 200);
    const device = listed.body.tokens.find((t: any) => t.label === "Alice's watch");
    assert.ok(device, "the new device should be listed");
    assert.equal(device.token, undefined, "the raw token is never listed again");
    assert.equal(device.lastUsedAt, null);
  });

  test("one member cannot see or revoke another member's devices", async () => {
    await issueToken(bob, "Bob's watch");
    const asAliceList = await callRoute(deviceRoutes, "GET", "/", { session: { userId: alice } });
    assert.ok(!asAliceList.body.tokens.some((t: any) => t.label === "Bob's watch"));

    const bobsDevice = (await callRoute(deviceRoutes, "GET", "/", { session: { userId: bob } })).body.tokens.find(
      (t: any) => t.label === "Bob's watch"
    );
    const revokeAttempt = await callRoute(deviceRoutes, "DELETE", `/${bobsDevice.id}`, { session: { userId: alice } });
    assert.equal(revokeAttempt.status, 404, "should not leak whether the id exists at all");
  });

  test("revoking removes it from the list", async () => {
    await issueToken(alice, "Temporary device");
    const before = await callRoute(deviceRoutes, "GET", "/", { session: { userId: alice } });
    const device = before.body.tokens.find((t: any) => t.label === "Temporary device");

    const revoked = await callRoute(deviceRoutes, "DELETE", `/${device.id}`, { session: { userId: alice } });
    assert.equal(revoked.status, 200);

    const after = await callRoute(deviceRoutes, "GET", "/", { session: { userId: alice } });
    assert.ok(!after.body.tokens.some((t: any) => t.id === device.id));
  });
});

describe("authenticating with a device token", () => {
  test("a valid bearer token authenticates like a session for a normal route", async () => {
    const token = await issueToken(alice, "Auth test device");

    const deviceAuthResult = await callMiddleware(deviceTokenAuth, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(deviceAuthResult.passed, true, "deviceTokenAuth always calls next()");

    // deviceTokenAuth and requireAuth run as two separate middlewares in
    // server.ts, sharing one req -- reproduce that here rather than through
    // callMiddleware, which only hands back the session, not the full req.
    const req: any = { headers: { authorization: `Bearer ${token}` }, session: {} };
    let passed = false;
    deviceTokenAuth(req, {} as any, () => {
      requireAuth(req, { status: () => ({ json: () => {} }) } as any, () => {
        passed = true;
      });
    });
    assert.equal(passed, true);
    assert.equal(req.deviceUserId, alice);
  });

  test("an unknown or missing token never authenticates, but never errors either", async () => {
    const cases: Record<string, string>[] = [{}, { authorization: "Bearer not-a-real-token" }, { authorization: "not-even-bearer" }];
    for (const headers of cases) {
      const result = await callMiddleware(deviceTokenAuth, { headers });
      assert.equal(result.passed, true, "deviceTokenAuth always calls next()");
    }

    const req: any = { headers: { authorization: "Bearer not-a-real-token" }, session: {} };
    let statusSeen = 0;
    deviceTokenAuth(req, {} as any, () => {
      requireAuth(req, { status: (code: number) => ({ json: () => (statusSeen = code) }) } as any, () => {
        assert.fail("requireAuth should not have passed with no real session and no valid token");
      });
    });
    assert.equal(statusSeen, 401);
  });

  test("a device token can never satisfy requireUnlocked, regardless of PIN state", async () => {
    const token = await issueToken(alice, "Financial test device");
    const req: any = { deviceUserId: alice, session: {} };
    let status = 0;
    requireUnlocked(req, { status: (code: number) => ({ json: () => (status = code) }) } as any, () => {
      assert.fail("requireUnlocked must never pass for a device token");
    });
    assert.equal(status, 423);
    void token; // issued only to prove a real token exists; the check above is on deviceUserId directly
  });

  test("a device token cannot issue or revoke device tokens through the router itself", async () => {
    // routes/devices.ts checks req.session.userId directly, not currentUserId,
    // specifically so a device-token-authenticated request (which only ever
    // sets req.deviceUserId, never req.session.userId) is refused here.
    const result = await callRoute(deviceRoutes, "POST", "/", {
      session: {}, // deviceTokenAuth would only ever populate deviceUserId, not this
      body: { label: "minted by a watch" },
    });
    assert.equal(result.status, 403);
  });
});

describe("assistant.noFinanceVoiceData setting", () => {
  test("defaults to true (blocked) before anything has been saved", async () => {
    const result = await callRoute(assistantRoutes, "GET", "/settings", { session: { userId: alice } });
    assert.equal(result.status, 200);
    assert.equal(result.body.noFinanceVoiceData, true);
  });

  test("round-trips through PUT", async () => {
    const off = await callRoute(assistantRoutes, "PUT", "/settings", {
      session: { userId: admin },
      body: { noFinanceVoiceData: false },
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.noFinanceVoiceData, false);

    const read = await callRoute(assistantRoutes, "GET", "/settings", { session: { userId: alice } });
    assert.equal(read.body.noFinanceVoiceData, false);

    // Restore, since app_config is process-wide state for the rest of this file.
    await callRoute(assistantRoutes, "PUT", "/settings", { session: { userId: admin }, body: { noFinanceVoiceData: true } });
  });

  test("refuses a non-boolean value", async () => {
    const result = await callRoute(assistantRoutes, "PUT", "/settings", {
      session: { userId: admin },
      body: { noFinanceVoiceData: "yes" },
    });
    assert.equal(result.status, 400);
  });

  // the project notes 10.5: the watch is the one client that sends voice, and this is the
  // setting that keeps its spoken money questions away from a model.
  test("a device token can't change it, even an admin's own", async () => {
    const result = await callRoute(assistantRoutes, "PUT", "/settings", {
      deviceUserId: admin,
      body: { noFinanceVoiceData: false },
    });
    assert.equal(result.status, 403);
    const read = await callRoute(assistantRoutes, "GET", "/settings", { session: { userId: alice } });
    assert.equal(read.body.noFinanceVoiceData, true, "nothing was written");
  });

  test("a device token is refused even alongside a session cookie", async () => {
    const result = await callRoute(assistantRoutes, "PUT", "/settings", {
      session: { userId: admin },
      deviceUserId: admin,
      body: { noFinanceVoiceData: false },
    });
    assert.equal(result.status, 403);
  });

  test("a parent can read it but not change it", async () => {
    const result = await callRoute(assistantRoutes, "PUT", "/settings", {
      session: { userId: alice },
      body: { noFinanceVoiceData: false },
    });
    assert.equal(result.status, 403);
  });
});

describe("blocksVoiceFinance", () => {
  test("blocks only when all three conditions hold", () => {
    assert.equal(blocksVoiceFinance("voice", true, true), true);
    assert.equal(blocksVoiceFinance("voice", false, true), false, "not financial");
    assert.equal(blocksVoiceFinance("text", true, true), false, "not voice");
    assert.equal(blocksVoiceFinance("voice", true, false), false, "setting turned off");
  });

  test("a missing or unrecognized inputMode is treated as text, never blocked", () => {
    assert.equal(blocksVoiceFinance(undefined, true, true), false);
    assert.equal(blocksVoiceFinance("something-else", true, true), false);
  });
});
