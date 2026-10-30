// The kiosk (fridge) login and nutrition: an admin setting (merge plan decision 10) says how much of
// it the shared screen may show.
//
//   nutrition_kiosk_access   "hidden" (default) | "plan_only" | "plan_and_quick_log"
//
//   GET /settings/kiosk      any signed-in login except the kiosk may read it   -> { kioskAccess, options }
//   PUT /settings/kiosk      admin only   { kioskAccess }                       -> same shape
//
// The kiosk login never has a diary (the data layer refuses it, and SQL triggers back that up),
// and on /api/nutrition/* it gets 403 for EVERYTHING except these three, which exist only for it:
//
//   GET  /kiosk/today        unless "hidden". For each person who keeps a diary: their display name
//                            and their own today's PLANNED entries THAT CAME FROM THE HOUSEHOLD MEAL PLAN
//                            (source = 'plan') -- name, calories, meal. Nothing else: no weights, goals,
//                            calorie budget, totals or logged food, and nothing a person planned privately in
//                            their own diary (e.g. "Copy to..." onto a future day). That is diary data, which
//                            the who-sees-what setting governs and the kiosk never reaches (phase 5b review fix).
//                            Each planned entry also carries `mealId`, the household-plan meal it came from.
//   GET  /kiosk/day/:date    the same board for any other day (YYYY-MM-DD): "today" is per person (each
//                            in their own timezone), a named date is the same calendar date for everyone.
//   POST /kiosk/log          only for "plan_and_quick_log". { userId, entryIds, date? } marks those planned
//                            meal-plan entries of that person, on any day up to their today, as logged ("we ate it"). It never
//                            creates or edits any other entry; a logged, deleted or other-person's id
//                            refuses the whole request (409) and writes nothing. The answer is the board
//                            for `date` if one was sent, else today's.
//
// Logging uses the phone's own path (updateEntry): the entry keeps its food, amount and date, the day's
// totals and frozen calorie budget follow.
//
// THE PLAN SIDE (phase 4). Whenever the board is shown at all ("plan only" or "plan + quick logging"), it also
// carries `meals`: the meals APPROVED in the household plan for that day -- name, meal (slot) and who they're
// for ("Everyone" or a roster member's name). That is the plan, which the whole household can already read;
// it adds no calories and nothing from anyone's diary. "Hidden" shows nothing at all (403). "Today" for the
// plan is the date in the first diary login's timezone (the household's), a named date is that calendar date.

import express from "express";
import { currentUserId } from "../../auth.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { bodyObject, localDateField } from "../../nutrition/data/input.ts";
import { MAX_KIOSK_LOG_IDS, kioskBoardData, logPlanEntries } from "../../nutrition/data/kioskBoard.ts";
import { get } from "../../nutrition/data/sql.ts";
import { listTrackers } from "../../nutrition/data/tracker.ts";
import { KIOSK_ACCESS_VALUES, dateParam, h, type Ctx, type KioskAccess } from "./common.ts";

export { MAX_KIOSK_LOG_IDS };

export const isKioskAccess = (v: unknown): v is KioskAccess => (KIOSK_ACCESS_VALUES as readonly unknown[]).includes(v);

/** What a stored value means: anything unrecognised (a hand-edited config) is the safe default, hidden. */
export const readKioskAccess = (stored: unknown): KioskAccess => (isKioskAccess(stored) ? stored : "hidden");

const settingJson = (value: KioskAccess) => ({ kioskAccess: value, options: KIOSK_ACCESS_VALUES });

/**
 * The one place the kiosk's reach is decided: the kiosk may only ever hit these routes. `path` is
 * already lower-cased with any trailing slash removed (routes/nutrition.ts), the way Express matches.
 */
export function isKioskRoute(method: string, path: string): boolean {
  return (method === "GET" && (path === "/kiosk/today" || /^\/kiosk\/day\/[^/]+$/.test(path))) || (method === "POST" && path === "/kiosk/log");
}

export function kioskRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  const roleOf = (req: express.Request): string | undefined =>
    get<{ role: string }>(db, "SELECT role FROM users WHERE id = ?", currentUserId(req))?.role;

  router.get("/settings/kiosk", h((req, res) => {
    res.json(settingJson(ctx.kioskAccess()));
  }));

  // Same rule as auth.ts's requireAdmin, but read from this router's own database handle so a test
  // can run it against a private database. (In the app they are the same handle.)
  router.put("/settings/kiosk", h((req, res) => {
    if (roleOf(req) !== "admin") throw new NutritionError(403, "Admins only.");
    const b = bodyObject(req.body);
    if (!isKioskAccess(b.kioskAccess)) {
      throw new NutritionError(400, `kioskAccess must be one of ${KIOSK_ACCESS_VALUES.join(", ")}.`);
    }
    ctx.setKioskAccess(b.kioskAccess);
    res.json(settingJson(b.kioskAccess));
  }));

  const board = (date?: string) => ({
    kioskAccess: ctx.kioskAccess(),
    canQuickLog: ctx.kioskAccess() === "plan_and_quick_log",
    ...kioskBoardData(db, ctx.now(), date),
  });

  router.get("/kiosk/today", h((_req, res) => {
    if (ctx.kioskAccess() === "hidden") throw new NutritionError(403, "Nutrition isn't shown on the kiosk.");
    res.json(board());
  }));

  router.get("/kiosk/day/:date", h((req, res) => {
    if (ctx.kioskAccess() === "hidden") throw new NutritionError(403, "Nutrition isn't shown on the kiosk.");
    res.json(board(dateParam(req)));
  }));

  router.post("/kiosk/log", h((req, res) => {
    if (ctx.kioskAccess() !== "plan_and_quick_log") throw new NutritionError(403, "Quick logging isn't turned on for the kiosk.");
    const b = bodyObject(req.body);
    const person = typeof b.userId === "string" ? listTrackers(db).find((p) => p.id === b.userId) : undefined;
    if (!person) throw new NutritionError(404, "Person not found.");
    const ids = b.entryIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_KIOSK_LOG_IDS || ids.some((id) => typeof id !== "string")) {
      throw new NutritionError(400, `entryIds must be a list of 1 to ${MAX_KIOSK_LOG_IDS} entry ids.`);
    }
    const date = b.date === undefined ? undefined : localDateField(b.date, "date");

    // The rules (planned meal-plan entries only, any day up to the person's today, all or nothing) live in
    // nutrition/data/kioskBoard.ts, shared with the assistant's kiosk tool.
    const unique = logPlanEntries(db, person, ids as string[], ctx.now());
    // Only the refreshed board comes back: no totals, no calorie budget -- the kiosk is a shared screen.
    res.json({ logged: unique, ...board(date) });
  }));

  return router;
}

