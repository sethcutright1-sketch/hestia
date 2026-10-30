// "Require the PIN for my food diary": the per-login option (routes/nutrition/pin.ts) and the gate in
// routes/nutrition.ts that applies requireUnlocked (auth.ts) to that login's nutrition requests.
//
// The household PIN itself (lock_pin_hash) and the option live in the app's own app_config, which
// the throwaway database from testdb.ts stands in for; the people and their diaries are the
// private in-memory household from nutritionWorld.ts.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { cleanupDb, loadDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { newApi, type Api } from "./helpers/nutritionApi.ts";
import { TODAY, customFood } from "./helpers/nutritionWorld.ts";

const { getConfig, setConfig } = await loadDb();
const { lockRoutes } = await import("../routes/lock.ts");

after(cleanupDb);
beforeEach(() => setConfig("lock_pin_hash", null));

const PIN = "4826";
const setHouseholdPin = async () => setConfig("lock_pin_hash", await bcrypt.hash(PIN, 4));
const key = (userId: string) => `nutrition_require_pin:${userId}`;
const pinGet = (api: Api, who: "ann" | "ben" | "kiosk" = "ann") => api.call(who, "GET", "/settings/pin");
const pinPut = (api: Api, value: unknown, who: "ann" | "ben" | "kiosk" = "ann") => api.call(who, "PUT", "/settings/pin", { requirePin: value });
const locked = (r: { status: number; body: any }) => r.status === 423 && r.body.error === "locked";

/** The real unlock route, so "unlocking works" tests the actual path rather than poking the session. */
async function unlock(api: Api, who: "ann" | "ben", code = PIN) {
  return callRoute(lockRoutes, "POST", "/unlock", { session: api.sessions[who], body: { code, trusted: false } });
}

test("the option defaults to off and changes nothing: the diary is open with or without a household PIN", async (t) => {
  const api = await newApi(t);
  assert.deepEqual((await pinGet(api)).body, { requirePin: false, householdPinSet: false, unlocked: true });
  await setHouseholdPin();
  assert.deepEqual((await pinGet(api)).body, { requirePin: false, householdPinSet: true, unlocked: false });
  assert.equal((await api.call("ann", "GET", `/diary/${TODAY}`)).status, 200, "a locked session still reaches the diary");
  assert.equal((await api.call("ann", "POST", "/foods", customFood("Snack", 100))).status, 201);
  assert.equal(getConfig(key(api.w.ids.ann), "unset"), "unset", "nothing is stored until someone asks");
});

test("turned on with a household PIN: a locked session gets 423 { error: 'locked' } everywhere except the setting's GET", async (t) => {
  const api = await newApi(t);
  await setHouseholdPin();
  const on = await pinPut(api, true);
  assert.deepEqual([on.status, on.body.requirePin], [200, true], "switching it on needs no unlock");
  assert.equal(getConfig(key(api.w.ids.ann), false), true, "stored per login in app_config");

  for (const [method, url, body] of [
    ["GET", `/diary/${TODAY}`], ["POST", `/diary/${TODAY}`, { slot: "lunch", kcal: 5 }], ["GET", "/foods/search?q=a"], ["POST", "/foods", customFood("x", 1)],
    ["GET", "/weights"], ["GET", "/me/profile"], ["GET", "/saved-meals"], ["GET", "/recipes"], ["GET", "/settings/kiosk"], ["POST", "/barcodes/lookup", { code: "016000275287" }],
  ] as Array<[string, string, unknown?]>) {
    const r = await api.call("ann", method, url, body);
    assert.ok(locked(r), `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  const state = await pinGet(api);
  assert.deepEqual([state.status, state.body], [200, { requirePin: true, householdPinSet: true, unlocked: false }], "the GET stays readable so the screen can show it");
  assert.equal(api.w.db.prepare("SELECT COUNT(*) AS n FROM nutrition_foods").get()!.n, 0, "nothing the locked requests asked for was written");
});

test("unlocking with the household PIN opens the diary; the window slides with use and closes when it lapses", async (t) => {
  const api = await newApi(t);
  await setHouseholdPin();
  await pinPut(api, true);
  assert.ok(locked(await api.call("ann", "GET", `/diary/${TODAY}`)));

  assert.equal((await unlock(api, "ann", "0000")).status, 401, "a wrong PIN opens nothing");
  assert.ok(locked(await api.call("ann", "GET", `/diary/${TODAY}`)));

  const ok = await unlock(api, "ann");
  assert.equal(ok.status, 200);
  assert.equal((await api.call("ann", "GET", `/diary/${TODAY}`)).status, 200);
  assert.equal((await api.call("ann", "POST", "/foods", customFood("Snack", 100))).status, 201);
  assert.equal((await pinGet(api)).body.unlocked, true);

  // Sliding window: a gated request pushes the expiry forward, like Budget.
  api.sessions.ann.unlockedUntil = Date.now() + 1_000;
  await api.call("ann", "GET", `/diary/${TODAY}`);
  assert.ok(api.sessions.ann.unlockedUntil! > Date.now() + 60_000, "refreshed to the full window");

  // Lapsed.
  api.sessions.ann.unlockedUntil = Date.now() - 1;
  assert.ok(locked(await api.call("ann", "GET", `/diary/${TODAY}`)));
  // And the lock button (POST /api/lock/lock) closes it at once.
  await unlock(api, "ann");
  await callRoute(lockRoutes, "POST", "/lock", { session: api.sessions.ann });
  assert.ok(locked(await api.call("ann", "GET", `/diary/${TODAY}`)));
});

test("turning it off needs an unlocked session; a locked one can't switch the lock off", async (t) => {
  const api = await newApi(t);
  await setHouseholdPin();
  await pinPut(api, true);

  const refused = await pinPut(api, false);
  assert.ok(locked(refused));
  assert.equal(getConfig(key(api.w.ids.ann), false), true, "still on");
  assert.equal((await pinGet(api)).body.requirePin, true);

  await unlock(api, "ann");
  const off = await pinPut(api, false);
  assert.deepEqual([off.status, off.body.requirePin], [200, false]);
  // Off means off: even after locking again the diary is open.
  await callRoute(lockRoutes, "POST", "/lock", { session: api.sessions.ann });
  assert.equal((await api.call("ann", "GET", `/diary/${TODAY}`)).status, 200);
  assert.equal((await pinPut(api, true)).status, 200, "and it can be switched on again from a locked session");
});

test("the setting is validated and is the signed-in login's own: a body can't name someone else", async (t) => {
  const api = await newApi(t);
  for (const bad of ["yes", 1, null, undefined, "true"]) assert.equal((await pinPut(api, bad)).status, 400, String(bad));
  const sneaky = await api.call("ann", "PUT", "/settings/pin", { requirePin: true, userId: api.w.ids.ben });
  assert.equal(sneaky.status, 200);
  assert.equal(getConfig(key(api.w.ids.ben), false), false);
  assert.equal(getConfig(key(api.w.ids.ann), false), true);
});

test("one login's lock does not touch the other's diary", async (t) => {
  const api = await newApi(t);
  await setHouseholdPin();
  await pinPut(api, true, "ann");
  assert.ok(locked(await api.call("ann", "GET", `/diary/${TODAY}`)));
  assert.equal((await api.call("ben", "GET", `/diary/${TODAY}`)).status, 200);
  assert.equal((await pinGet(api, "ben")).body.requirePin, false);
  // Ben unlocking (or not) says nothing about Ann: sessions are separate.
  await unlock(api, "ben");
  assert.ok(locked(await api.call("ann", "GET", `/diary/${TODAY}`)));
  // And Ben can turn his own on without Ann's state mattering.
  assert.equal((await pinPut(api, true, "ben")).status, 200);
  assert.equal((await api.call("ben", "GET", `/diary/${TODAY}`)).status, 200, "he is still unlocked from a moment ago");
  await callRoute(lockRoutes, "POST", "/lock", { session: api.sessions.ben });
  assert.ok(locked(await api.call("ben", "GET", `/diary/${TODAY}`)));
});

test("with no household PIN set the option has no effect on sessions, and the screen is told so", async (t) => {
  const api = await newApi(t);
  const on = await pinPut(api, true);
  assert.deepEqual(on.body, { requirePin: true, householdPinSet: false, unlocked: true });
  assert.equal((await api.call("ann", "GET", `/diary/${TODAY}`)).status, 200);
  assert.equal((await api.call("ann", "POST", "/foods", customFood("Snack", 100))).status, 201);
  // Setting a PIN later makes it bite at once.
  await setHouseholdPin();
  assert.ok(locked(await api.call("ann", "GET", `/diary/${TODAY}`)));
  // Removing it (admin, from an unlocked session) lifts it again.
  setConfig("lock_pin_hash", null);
  assert.equal((await api.call("ann", "GET", `/diary/${TODAY}`)).status, 200);
});

test("a Wear OS device token is refused for a login that has the option on (like money), and fine for one that doesn't", async (t) => {
  const api = await newApi(t);
  const status = (who: "ann" | "ben") => api.callDevice(who, "GET", `/diary/${TODAY}`);
  assert.equal((await status("ann")).status, 200, "off: a watch works as before");

  await pinPut(api, true, "ann");
  const withoutHouseholdPin = await status("ann");
  assert.ok(locked(withoutHouseholdPin), "refused even when no household PIN is set, because requireUnlocked refuses tokens outright");
  await setHouseholdPin();
  await unlock(api, "ann");
  assert.ok(locked(await status("ann")), "and unlocking the person's browser session doesn't unlock the watch");
  assert.equal((await api.call("ann", "GET", `/diary/${TODAY}`)).status, 200, "the browser session is fine");

  assert.equal((await status("ben")).status, 200, "another login's watch is unaffected");
  assert.equal((await api.callDevice("ann", "GET", "/settings/pin")).status, 200, "the setting's GET is readable by the token");
  assert.ok(locked(await api.callDevice("ann", "PUT", "/settings/pin", { requirePin: false })), "a watch can't switch the lock off");
  assert.equal(getConfig(key(api.w.ids.ann), false), true);
});

test("the kiosk is never PIN-gated, can't use the setting, and a stray flag on the kiosk login changes nothing", async (t) => {
  const api = await newApi(t);
  await setHouseholdPin();
  api.kioskSetting.value = "plan_and_quick_log";
  await pinPut(api, true, "ann");

  assert.equal((await api.call("kiosk", "GET", "/kiosk/today")).status, 200, "Ann's lock doesn't lock the fridge");
  assert.equal((await api.call("kiosk", "GET", `/kiosk/day/${TODAY}`)).status, 200);
  assert.equal((await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds: ["nope"] })).status, 409, "reaches the real handler, not a 423");

  // The kiosk can't read or set the option (the kiosk gate answers 403 first).
  assert.equal((await pinGet(api, "kiosk")).status, 403);
  assert.equal((await pinPut(api, true, "kiosk")).status, 403);
  setConfig(key(api.w.ids.kiosk), true); // someone edited the database by hand
  assert.equal((await api.call("kiosk", "GET", "/kiosk/today")).status, 200);
  assert.equal((await api.call("kiosk", "GET", "/me/profile")).status, 403, "still the kiosk gate's 403, not a 423");
});

test("the lock covers the recipe calorie routes too, so the PIN prompt appears when a locked login calculates a recipe", async (t) => {
  const api = await newApi(t);
  await setHouseholdPin();
  await pinPut(api, true);
  assert.ok(locked(await api.call("ann", "POST", "/recipes/anything/calculate", {})));
  await unlock(api, "ann");
  assert.equal((await api.call("ann", "POST", "/recipes/anything/calculate", {})).status, 404, "unlocked: the real handler answers");
});
