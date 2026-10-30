// The real /api/nutrition router, run against a private in-memory household (nutritionWorld.ts)
// instead of the app's database, with a pinned clock, a fake barcode lookup and in-memory storage for
// the kiosk setting. Requests go through routes/nutrition.ts's own kiosk gate and error mapping
// exactly as in the app; only the socket and requireAuth (which has its own tests) are missing.
//
// routes/nutrition.ts reaches db.ts (through auth.ts), so it is imported dynamically AFTER
// testdb.ts has pointed DB_PATH at the throwaway file -- the same ordering rule as every route test.

import type { TestContext } from "node:test";
import { callRoute } from "./router.ts";
import { NOW, newWorld, type World } from "./nutritionWorld.ts";
import { loadDb } from "./testdb.ts";
import type { LookupResult } from "../../nutrition/lookup.ts";
import type { RecipeModel } from "../../nutrition/recipeAi.ts";

export type Person = "ann" | "ben" | "kiosk";

export interface Reply {
  status: number;
  body: any;
}

export interface Api {
  w: World;
  /** `call("ann", "POST", "/diary/2026-03-10", { slot: "lunch", ... })` -> { status, body }. A "?a=b" query in the url is parsed. */
  call(who: Person, method: string, url: string, body?: unknown): Promise<Reply>;
  /** The same request as a Wear OS device token (no session): `req.deviceUserId` is the person. */
  callDevice(who: Person, method: string, url: string, body?: unknown): Promise<Reply>;
  /** Each person's session object, kept between calls (set `unlockedUntil` here to unlock, like POST /api/lock/unlock does). */
  sessions: Record<Person, { userId: string; unlockedUntil?: number; lockTrusted?: boolean }>;
  setNow(d: Date): void;
  /** The kiosk setting as the router sees it (stored in memory here). */
  kioskSetting: { value: unknown };
  /** Every code the fake lookup was asked about. */
  lookupCalls: string[];
  /** What the fake lookup answers, by code; anything else is "nobody knows it". */
  answers: Record<string, Partial<LookupResult>>;
}

const nothing = (code: string): LookupResult => ({
  gtin14: code.padStart(14, "0"), raw: code, source: null, name: null, brand: null, servingText: null, servingGrams: null,
  servingUnit: "g", per100g: null, perServing: null, nameOnly: false, cached: false, lookupMs: 1, sourcesErrored: [], randomWeight: false,
});

export async function newApi(t: TestContext, opts: { profiles?: boolean; lookup?: (code: string, format?: string) => Promise<LookupResult>; recipeModel?: () => RecipeModel | null } = {}): Promise<Api> {
  const w = await newWorld(t, { profiles: opts.profiles });
  await loadDb();
  const { createNutritionRoutes } = await import("../../routes/nutrition.ts");

  let now = NOW;
  const kioskSetting = { value: undefined as unknown };
  const lookupCalls: string[] = [];
  const answers: Api["answers"] = {};
  const router = createNutritionRoutes({
    db: w.db,
    now: () => now,
    recipeModel: opts.recipeModel ?? (() => null),
    lookup: opts.lookup ?? (async (code) => {
      lookupCalls.push(code);
      return { ...nothing(code), ...answers[code] };
    }),
    kioskSetting: { get: () => kioskSetting.value, set: (v) => { kioskSetting.value = v; } },
  });

  const sessions: Api["sessions"] = { ann: { userId: w.ids.ann }, ben: { userId: w.ids.ben }, kiosk: { userId: w.ids.kiosk } };
  const send = (opts: { session?: Api["sessions"][Person]; deviceUserId?: string }, method: string, url: string, body?: unknown) => {
    const [path, qs] = url.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs ?? ""));
    return callRoute(router, method, path, { session: opts.session ?? {}, deviceUserId: opts.deviceUserId, body, query }).then((r) => {
      if (r.fellThrough) throw new Error(`${method} ${url} fell through the router: ${r.error ?? "no handler"}`);
      return { status: r.status, body: r.body };
    });
  };
  const call: Api["call"] = (who, method, url, body) => send({ session: sessions[who] }, method, url, body);
  const callDevice: Api["callDevice"] = (who, method, url, body) => send({ deviceUserId: w.ids[who] }, method, url, body);
  return { w, call, callDevice, sessions, setNow: (d) => { now = d; }, kioskSetting, lookupCalls, answers };
}
