// /api/nutrition/* -- the food diary, calorie budgets, weight and barcodes. Mounted in
// server.ts as `app.use("/api/nutrition", requireAuth, nutritionRoutes)`.
//
// The routes are thin HTTP wrappers over nutrition/data (read nutrition/data/schema.ts first for
// the model). Who is asking always comes from the session (currentUserId -> getTracker), never from a
// request body: the calorie app's profile picker and device-token login are gone, and household-app's
// own sessions -- and its Wear OS device tokens, which already pass requireAuth -- replace them.
// Only admin and parent logins keep a diary; the kiosk login is refused by the gate below.
//
// The PIN lock: by default nothing here uses requireUnlocked (it covers money; logging a snack should
// be quick), but each login can opt in with "Require the PIN for my food diary" in the Food section's
// settings (pin.ts). While a login has that on, the gate below runs requireUnlocked for its requests, and
// share.ts applies the same lock to anyone viewing that login's shared data.
//
// One file per area under routes/nutrition/:
//   me.ts          profile, calorie goals (+ schedule and preview), meals/targets, snack allowance, the weight loss start day, streaks
//   share.ts       who sees what: each login's visibility level, who shares with me, and read-only views of their data
//   photos.ts      progress photos (private to their owner, never shared)
//   foods.ts       search, recent, create / read / edit / delete
//   barcodes.ts    the scan (one lookup service shared with Pantry), attach / detach, offline list, miss log
//   diary.ts       the day page, entries, bulk add, undo, day summary and "Done logging", previous meals
//   body.ts        weights (+ trend), steps and exercise
//   savedMeals.ts  saved meals, and logging one
//   kiosk.ts       the admin setting for the fridge screen, and the routes the kiosk may use
//   recipes.ts     calories for the household's recipes: lines, matching foods, calculate
//   plan.ts        the meal plan's side of the diary: the week's calorie view, log all, "Use from pantry?"
//   pin.ts         the per-login "require the PIN for my food diary" option
//   import.ts      the Lose It! import (dry run, import, match my calorie budget) into the signed-in login's own diary
//
// The factory takes its database, clock, lookup and the kiosk setting's storage so tests can run
// the real routes against a private in-memory database; `nutritionRoutes` at the bottom is the one
// the app mounts, wired to db.ts.

import express from "express";
import { currentUserId, requireUnlocked } from "../auth.ts";
import { db as appDb, getConfig, setConfig } from "../db.ts";
import { makeLookup } from "../nutrition/lookup.ts";
import { getRecipeModel, type RecipeModel } from "../nutrition/recipeAi.ts";
import { get, type Db } from "../nutrition/data/sql.ts";
import { barcodeRoutes } from "./nutrition/barcodes.ts";
import { bodyRoutes } from "./nutrition/body.ts";
import { makeWho, sendError, type Ctx, type KioskAccess, type LookupFn } from "./nutrition/common.ts";
import { diaryRoutes } from "./nutrition/diary.ts";
import { foodRoutes } from "./nutrition/foods.ts";
import { importRoutes } from "./nutrition/import.ts";
import { isKioskRoute, kioskRoutes, readKioskAccess } from "./nutrition/kiosk.ts";
import { meRoutes } from "./nutrition/me.ts";
import { pinRequiredFor, pinRoutes } from "./nutrition/pin.ts";
import { photoRoutes } from "./nutrition/photos.ts";
import { planRoutes } from "./nutrition/plan.ts";
import { recipeRoutes } from "./nutrition/recipes.ts";
import { savedMealRoutes } from "./nutrition/savedMeals.ts";
import { shareRoutes } from "./nutrition/share.ts";

export { sendError } from "./nutrition/common.ts";
export type { KioskAccess } from "./nutrition/common.ts";

/** app_config key for the admin's kiosk setting: "hidden" | "plan_only" | "plan_and_quick_log". */
export const KIOSK_ACCESS_KEY = "nutrition_kiosk_access";

export interface NutritionDeps {
  db: Db;
  now?: () => Date;
  lookup?: LookupFn;
  /** The local model for recipe parsing and estimates; null = none. Default: the Ollama-backed one (nutrition/recipeAi.ts). */
  recipeModel?: () => RecipeModel | null;
  /** Where the kiosk setting lives. Default: db.ts's getConfig/setConfig. */
  kioskSetting?: { get(): unknown; set(value: KioskAccess): void };
}

export function createNutritionRoutes(deps: NutritionDeps): express.Router {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const setting = deps.kioskSetting ?? { get: () => getConfig(KIOSK_ACCESS_KEY, "hidden"), set: (v: KioskAccess) => setConfig(KIOSK_ACCESS_KEY, v) };
  const ctx: Ctx = {
    db,
    now,
    lookup: deps.lookup ?? makeLookup(db),
    kioskAccess: () => readKioskAccess(setting.get()),
    setKioskAccess: (v) => setting.set(v),
    who: makeWho(db, now),
    recipeModel: deps.recipeModel ?? getRecipeModel,
  };

  const router = express.Router();

  // The kiosk gate. Runs before everything: the kiosk login gets 403 on every nutrition route
  // except its two (kiosk.ts decides, from the setting, whether those answer), and no other login
  // may use those two.
  router.use((req, res, next) => {
    try {
      const role = get<{ role: string }>(db, "SELECT role FROM users WHERE id = ?", currentUserId(req))?.role;
      if (!role) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      // Express matches routes case-insensitively and ignores a trailing slash, so compare the
      // same way: "/Kiosk/log/" must be treated as "/kiosk/log" by both checks below.
      const path = (req.url ?? "").split("?")[0].toLowerCase().replace(/(.)\/+$/, "$1");
      const kioskOnly = path === "/kiosk" || path.startsWith("/kiosk/");
      if (role === "kiosk" && !isKioskRoute(req.method, path)) {
        // Progress photos answer 404 to everyone but their owner, the kiosk included (photos.ts); every other route is a plain 403.
        if (path === "/photos" || path.startsWith("/photos/")) {
          res.status(404).json({ error: "Not found." });
          return;
        }
        res.status(403).json({ error: "Food diaries are for admin and parent logins; the kiosk login doesn't keep one." });
        return;
      }
      if (role !== "kiosk" && kioskOnly) {
        res.status(403).json({ error: "Those are for the kiosk login." });
        return;
      }
      // The PIN option (pin.ts): a login that turned it on is locked like Budget. The kiosk has no
      // diary and no setting, and the setting's own GET stays readable so the screen can show the state.
      if (role !== "kiosk" && !(req.method === "GET" && path === "/settings/pin") && pinRequiredFor(currentUserId(req))) {
        requireUnlocked(req, res, next);
        return;
      }
      next();
    } catch (err) {
      sendError(res, err);
    }
  });

  router.use(meRoutes(ctx));
  router.use(barcodeRoutes(ctx)); // before foodRoutes: "/foods/barcodes" must not be read as "/foods/:id"
  router.use(foodRoutes(ctx));
  router.use(diaryRoutes(ctx));
  router.use(bodyRoutes(ctx));
  router.use(savedMealRoutes(ctx));
  router.use(kioskRoutes(ctx));
  router.use(recipeRoutes(ctx));
  router.use(pinRoutes(ctx));
  router.use(planRoutes(ctx));
  router.use(shareRoutes(ctx));
  router.use(photoRoutes(ctx));
  router.use(importRoutes(ctx));

  // Unknown /api/nutrition paths answer JSON, not an HTML page.
  router.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  return router;
}

export const nutritionRoutes = createNutritionRoutes({ db: appDb });
