// /api/nutrition as server.ts mounts it: behind the real requireAuth and deviceTokenAuth, in front of
// db.ts's real database handle (the throwaway test file), speaking real HTTP on an ephemeral port.
// The route behaviour is tested against private databases in nutritionRoutes / nutritionKiosk /
// nutritionBarcodeRoutes; this file is only the seams: auth, the app_config storage of the kiosk
// setting, and "an existing Wear OS device token already works".

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { jpegBytes } from "./helpers/images.ts";

const { createUser, getConfig, setConfig, createDeviceToken, hashDeviceToken, db } = await loadDb();
const { deviceTokenAuth, requireAuth } = await import("../auth.ts");
const { nutritionRoutes, KIOSK_ACCESS_KEY } = await import("../routes/nutrition.ts");

let server: ReturnType<express.Express["listen"]>;
let base = "";
let admin: string, parent: string, kiosk: string;

before(() => {
  admin = createUser("wire-admin", "not-a-real-hash", "Wire Admin", "admin");
  parent = createUser("wire-parent", "not-a-real-hash", "Wire Parent", "parent");
  kiosk = createUser("wire-kiosk", "not-a-real-hash", "Wire Kiosk", "kiosk");

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  // Stands in for sessionMiddleware(): a header names the signed-in user. Everything after is the real code.
  app.use((req, _res, next) => {
    const as = req.headers["x-test-user"];
    req.session = (typeof as === "string" ? { userId: as } : {}) as any;
    next();
  });
  app.use(deviceTokenAuth);
  app.use("/api/nutrition", requireAuth, nutritionRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  cleanupDb();
});

async function call(method: string, path: string, opts: { as?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(base + "/api/nutrition" + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.as ? { "x-test-user": opts.as } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("nobody signed in is a 401 on every nutrition route", async () => {
  for (const [m, p] of [["GET", "/me/profile"], ["GET", "/settings/kiosk"], ["GET", "/kiosk/today"], ["POST", "/barcodes/lookup"], ["GET", "/nope"]] as const) {
    assert.equal((await call(m, p)).status, 401, `${m} ${p}`);
  }
});

test("a session works, writes land in household-app's own database, and JSON bodies are read", async () => {
  const saved = await call("PUT", "/me/profile", { as: parent, body: { sex: "male", birthDate: "1988-01-01", heightCm: 180, timezone: "America/New_York" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const row = db.prepare("SELECT height_cm FROM nutrition_profiles WHERE user_id = ?").get(parent) as any;
  assert.equal(row.height_cm, 180);
  assert.equal((await call("GET", "/me/profile", { as: parent })).body.name, "Wire Parent");
  assert.equal((await call("GET", "/me/profile", { as: admin })).body.hasProfile, false, "per login");
});

test("an existing device token (the Wear OS app's) authenticates like a session", async () => {
  const raw = crypto.randomBytes(24).toString("hex");
  createDeviceToken(parent, "test watch", hashDeviceToken(raw));
  const r = await call("GET", "/me/profile", { token: raw });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, parent);
  assert.equal((await call("GET", "/me/profile", { token: "not-a-real-token" })).status, 401);
});

test("the kiosk setting is stored in app_config: default hidden, admin-only to change", async () => {
  assert.equal(getConfig(KIOSK_ACCESS_KEY, "unset"), "unset", "nothing stored until an admin chooses");
  assert.equal(KIOSK_ACCESS_KEY, "nutrition_kiosk_access");
  assert.equal((await call("GET", "/settings/kiosk", { as: parent })).body.kioskAccess, "hidden");

  assert.equal((await call("PUT", "/settings/kiosk", { as: parent, body: { kioskAccess: "plan_only" } })).status, 403);
  assert.equal(getConfig(KIOSK_ACCESS_KEY, "unset"), "unset");
  assert.equal((await call("PUT", "/settings/kiosk", { as: admin, body: { kioskAccess: "plan_only" } })).status, 200);
  assert.equal(getConfig(KIOSK_ACCESS_KEY, "unset"), "plan_only");
  assert.equal((await call("GET", "/settings/kiosk", { as: parent })).body.kioskAccess, "plan_only");

  // The kiosk login sees the board but no diary, and it follows the stored value.
  const board = await call("GET", "/kiosk/today", { as: kiosk });
  assert.equal(board.status, 200);
  assert.ok(board.body.people.some((p: any) => p.name === "Wire Parent"));
  assert.ok(!board.body.people.some((p: any) => p.name === "Wire Kiosk"), "the kiosk is not a person with a diary");
  assert.equal((await call("GET", "/me/profile", { as: kiosk })).status, 403);

  setConfig(KIOSK_ACCESS_KEY, "hidden");
  assert.equal((await call("GET", "/kiosk/today", { as: kiosk })).status, 403);
  setConfig(KIOSK_ACCESS_KEY, "garbage");
  assert.equal((await call("GET", "/settings/kiosk", { as: admin })).body.kioskAccess, "hidden");
});

test("the barcode lookup route uses the app's shared lookup and cache (no network in this test: a code it can't reach is a 503, never logged as a miss)", async () => {
  const realFetch = globalThis.fetch;
  // Fail only the upstream databases; keep the loopback test server reachable.
  globalThis.fetch = ((input: any, init?: any) =>
    String(input).startsWith("http://127.0.0.1") ? realFetch(input, init) : Promise.reject(new TypeError("offline"))) as typeof fetch;
  try {
    const r = await call("POST", "/barcodes/lookup", { as: parent, body: { code: "016000275287" } });
    assert.equal(r.status, 503);
    assert.equal(r.body.unavailable, true);
    assert.equal((await call("GET", "/barcodes/misses", { as: parent })).body.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("progress photos over real HTTP: a ~2 MB upload fits the body limit, the picture comes back byte for byte with private headers, and only its owner (not another login, the kiosk or a watch) can fetch it", async () => {
  const jpeg = jpegBytes(1600, 1200, 2_000_000);
  const up = await call("POST", "/photos", { as: parent, body: { data: jpeg.toString("base64"), takenOn: "2026-01-02" } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const id = up.body.photo.id as string;
  assert.equal(up.body.photo.size, jpeg.length);

  const raw = (path: string, opts: { as?: string; token?: string } = {}) =>
    fetch(base + "/api/nutrition" + path, { headers: { ...(opts.as ? { "x-test-user": opts.as } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });

  const mine = await raw(`/photos/${id}/image`, { as: parent });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get("content-type"), "image/jpeg");
  assert.match(mine.headers.get("cache-control") ?? "", /^private/);
  assert.equal(mine.headers.get("x-content-type-options"), "nosniff");
  assert.ok(Buffer.from(await mine.arrayBuffer()).equals(jpeg));

  assert.equal((await raw(`/photos/${id}/image`)).status, 401, "not signed in");
  assert.equal((await raw(`/photos/${id}/image`, { as: admin })).status, 404, "another diary login, even an admin");
  assert.equal((await raw(`/photos/${id}/image`, { as: kiosk })).status, 404, "the kiosk login");
  const watch = crypto.randomBytes(24).toString("hex");
  createDeviceToken(parent, "photo watch", hashDeviceToken(watch));
  assert.equal((await raw(`/photos/${id}/image`, { token: watch })).status, 404, "even the owner's own watch");

  // A picture bigger than 6 MB is refused by the server's own cap, not by the 10 MB parser.
  const tooBig = await call("POST", "/photos", { as: parent, body: { data: jpegBytes(10, 10, 6_500_000).toString("base64") } });
  assert.equal(tooBig.status, 413);
  assert.equal((await call("DELETE", `/photos/${id}`, { as: admin })).status, 404);
  assert.equal((await call("DELETE", `/photos/${id}`, { as: parent })).status, 200);
});

test("who sees what over real HTTP: the choice is stored per login, and another login's day is refused until they share it", async () => {
  await call("PUT", "/me/profile", { as: admin, body: { sex: "female", birthDate: "1990-01-01", heightCm: 165, timezone: "America/New_York" } });
  assert.equal((await call("GET", "/me/visibility", { as: parent })).body.visibility, "nothing");
  const url = `/people/${parent}/day/2026-03-10`;
  assert.equal((await call("GET", url, { as: admin })).status, 403);
  assert.equal((await call("PUT", "/me/visibility", { as: parent, body: { visibility: "totals" } })).status, 200);
  const r = await call("GET", url, { as: admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.level, "totals");
  assert.equal((await call("GET", url, { as: kiosk })).status, 403);
  assert.deepEqual((await call("GET", "/sharing", { as: admin })).body.map((p: any) => p.name), ["Wire Parent"]);
  assert.equal(db.prepare("SELECT visibility FROM nutrition_user_settings WHERE user_id = ?").get(parent)!.visibility, "totals");
});
