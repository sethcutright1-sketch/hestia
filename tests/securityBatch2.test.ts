// Second security batch (audit 2026-10-16): M4 sign-out on password change, the secure cookie
// behind a proxy without trusting a forged X-Forwarded-For, and L4 (/api/health signed out).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import express from "express";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { db, createUser, createDeviceToken, hashDeviceToken, deleteSessionsForUser, getDeviceTokenByHash } = await loadDb();
const { authRoutes, sessionMiddleware, deviceTokenAuth } = await import("../auth.ts");
const { clientIp, loginKey } = await import("../rateLimit.ts");
const { healthRoutes } = await import("../routes/health.ts");
const { SqliteSessionStore } = await import("../sessionStore.ts");

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new password";
let alice: string;
let bob: string;
let store: InstanceType<typeof SqliteSessionStore>;

const setSession = (sid: string, userId?: string) =>
  new Promise<void>((resolve, reject) =>
    store.set(sid, { cookie: { originalMaxAge: 1e9, expires: new Date(Date.now() + 1e9) } as any, userId } as any, (e) => (e ? reject(e) : resolve()))
  );
const sidsOf = (userId: string) =>
  (db.prepare(`SELECT sid FROM sessions WHERE user_id = ? ORDER BY sid`).all(userId) as { sid: string }[]).map((r) => r.sid);
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

before(async () => {
  store = new SqliteSessionStore();
  alice = createUser("alice-b2", await bcrypt.hash(PASSWORD, 4), "Alice", "admin");
  bob = createUser("bob-b2", await bcrypt.hash(PASSWORD, 4), "Bob", "parent");
});
after(cleanupDb);

describe("M4: sessions carry their user", () => {
  test("the store writes user_id from the session data", async () => {
    await setSession("a-1", alice);
    await setSession("anon-1", undefined);
    assert.deepEqual(sidsOf(alice), ["a-1"]);
    const anon = db.prepare(`SELECT user_id FROM sessions WHERE sid = 'anon-1'`).get() as any;
    assert.equal(anon.user_id, null);
  });

  test("deleteSessionsForUser keeps the named session and other users' sessions", async () => {
    await setSession("a-2", alice);
    await setSession("a-3", alice);
    await setSession("b-1", bob);
    assert.equal(deleteSessionsForUser(alice, "a-2"), 2);
    assert.deepEqual(sidsOf(alice), ["a-2"]);
    assert.deepEqual(sidsOf(bob), ["b-1"]);
  });
});

describe("M4: POST /change-password", () => {
  test("signs out the user's other sessions and revokes their device tokens, not anyone else's", async () => {
    await setSession("a-4", alice);
    await setSession("a-5", alice);
    await setSession("b-2", bob);
    createDeviceToken(alice, "watch", hashDeviceToken("alice-watch-token"));
    createDeviceToken(bob, "watch", hashDeviceToken("bob-watch-token"));

    const result = await callRoute(authRoutes, "POST", "/change-password", {
      session: { userId: alice },
      sessionID: "a-4",
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(sidsOf(alice), ["a-4"], "only the requesting session stays signed in");
    assert.ok(sidsOf(bob).includes("b-2"));
    assert.equal(getDeviceTokenByHash(hashDeviceToken("alice-watch-token")), undefined);
    assert.ok(getDeviceTokenByHash(hashDeviceToken("bob-watch-token")));
  });

  test("a wrong current password changes nothing", async () => {
    await setSession("b-3", bob);
    const result = await callRoute(authRoutes, "POST", "/change-password", {
      session: { userId: bob },
      sessionID: "b-2",
      body: { currentPassword: "wrong wrong wrong", newPassword: "another new password" },
    });
    assert.equal(result.status, 401);
    assert.ok(sidsOf(bob).includes("b-3"));
  });
});

describe("admin sign out everywhere", () => {
  test("needs the admin password, then clears every session and device token", async () => {
    const denied = await callRoute(authRoutes, "POST", "/sign-out-everywhere", { session: { userId: alice }, body: { password: "nope nope nope" } });
    assert.equal(denied.status, 401);
    assert.ok(count("sessions") > 0);

    const notAdmin = await callRoute(authRoutes, "POST", "/sign-out-everywhere", { session: { userId: bob }, body: { password: PASSWORD } });
    assert.ok(notAdmin.status === 403 || notAdmin.status === 401);
    assert.ok(count("sessions") > 0);

    const ok = await callRoute(authRoutes, "POST", "/sign-out-everywhere", { session: { userId: alice }, body: { password: NEW_PASSWORD } });
    assert.equal(ok.status, 200);
    assert.equal(count("sessions"), 0);
    assert.equal(count("device_tokens"), 0);
  });
});

describe("secure cookie and the rate limiter behind a loopback proxy", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    const app = express();
    app.set("trust proxy", "loopback"); // same setting as server.ts
    app.use(sessionMiddleware());
    app.use(deviceTokenAuth);
    app.get("/touch", (req, res) => {
      req.session.userId = alice;
      res.json({ ip: req.ip, limiterIp: clientIp(req), key: loginKey(req, "Alice") });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test("a request that arrived over HTTPS (X-Forwarded-Proto from loopback) gets a Secure cookie", async () => {
    const res = await fetch(`${base}/touch`, { headers: { "x-forwarded-proto": "https" } });
    assert.match(res.headers.get("set-cookie") ?? "", /;\s*secure/i);
  });

  test("a plain-HTTP request (the LAN address) gets a cookie without Secure", async () => {
    const res = await fetch(`${base}/touch`);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /household\.sid=/);
    assert.doesNotMatch(cookie, /;\s*secure/i);
  });

  test("a forged X-Forwarded-For changes req.ip but not the address the limiter keys on", async () => {
    const plain: any = await (await fetch(`${base}/touch`)).json();
    const forged: any = await (await fetch(`${base}/touch`, { headers: { "x-forwarded-for": "203.0.113.77" } })).json();
    assert.equal(forged.ip, "203.0.113.77", "Express itself trusts the header from a loopback peer");
    assert.equal(forged.limiterIp, plain.limiterIp);
    assert.equal(forged.key, plain.key);
    assert.doesNotMatch(forged.key, /203\.0\.113\.77/);
  });
});

describe("L4: GET /api/health", () => {
  test("signed out it answers only {ok:true}", async () => {
    const result = await callRoute(healthRoutes, "GET", "/", { session: {} });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
  });

  test("a stale session for a deleted user is treated as signed out", async () => {
    const result = await callRoute(healthRoutes, "GET", "/", { session: { userId: "user-gone" } });
    assert.deepEqual(result.body, { ok: true });
  });

  test("signed in it adds the model and the dependency checks", async () => {
    const result = await callRoute(healthRoutes, "GET", "/", { session: { userId: alice } });
    assert.equal(result.body.ok, true);
    assert.equal(result.body.checks.db, "ok");
    assert.ok("model" in result.body);
  });
});
