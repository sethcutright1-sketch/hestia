// The meal plan's side of the food diary.
//
//   GET  /plan/calories?weekStart=   each person's calorie budget, snack allowance, planned and logged kcal
//                                    for every day of a week (default: this week), so a screen can show
//                                    "planned + logged vs calorie budget". Health data: diary logins only. The
//                                    signed-in person's own numbers, plus those of each other login that shares
//                                    "totals" or "everything" with them (share.ts).
//   POST /diary/:date/log-all        { slot }  the signed-in person's planned entries in one meal on that day
//                                    become logged, together (a day that hasn't happened yet is refused)
//   GET  /diary/entry/:id/pantry-use "Use from pantry?": the recipe behind a logged entry, matched to the pantry
//   POST /diary/entry/:id/pantry-use { items: [{ pantryItemId, amount }] }  takes them out of the pantry
//
// Approving a meal in the plan (PUT /api/mealplan/meals/:id) is what creates the planned entries; that lives
// with the plan in routes/mealplan.ts. "Budget" here is always the calorie budget.

import express from "express";
import { daySummary } from "../../nutrition/data/days.ts";
import { localDateField } from "../../nutrition/data/input.ts";
import { logPlannedSlot } from "../../nutrition/data/mealPlanSync.ts";
import { pantryUseSuggestions, usePantry } from "../../nutrition/data/pantryUse.ts";
import { weekCalories } from "../../nutrition/data/planCalories.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { bodyObject } from "../../nutrition/data/input.ts";
import { dateParam, h, queryString, type Ctx } from "./common.ts";
import { sharedWithViewer } from "./share.ts";

export function planRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  router.get("/plan/calories", h((req, res) => {
    const { user, today } = ctx.who(req);
    const raw = queryString(req, "weekStart");
    const day = raw ? localDateField(raw, "weekStart") : today;
    res.json(weekCalories(db, user.id, day, ctx.now(), { shared: sharedWithViewer(ctx, req) }));
  }));

  router.post("/diary/:date/log-all", h((req, res) => {
    const { user, today } = ctx.who(req);
    const date = dateParam(req);
    const slot = bodyObject(req.body).slot;
    if (typeof slot !== "string" || !slot) throw new NutritionError(400, "slot is required: which meal to log.");
    const out = logPlannedSlot(db, user, date, today, slot);
    res.json({ ...out, summary: daySummary(db, user, date, today) });
  }));

  router.get("/diary/entry/:id/pantry-use", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(pantryUseSuggestions(db, user, String(req.params.id)));
  }));

  router.post("/diary/entry/:id/pantry-use", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(usePantry(db, user, String(req.params.id), req.body));
  }));

  return router;
}
