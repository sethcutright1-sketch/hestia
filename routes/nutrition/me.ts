// The signed-in person's own nutrition settings: profile, calorie goals (with the calorie
// schedule and its preview), meals (slots) and targets, and logging streaks.
//
//   GET  /me/profile          { id, name, role, hasProfile, sex, birthDate, heightCm, timezone, unitSystem, slots }
//   PUT  /me/profile          partial update; the first save needs sex, birthDate, heightCm
//   GET  /me/goals            { current, history }
//   POST /me/goals            a new calorie goal effective from a date (append-only)
//   POST /me/goals/preview    what goal fields WOULD give each weekday, saving nothing
//   GET  /me/slots            every meal, switched-off ones too
//   POST /me/slots            a custom meal      PUT /me/slots/:key   rename / switch / targets
//   POST /me/slots/reorder    { keys: [...] }
//   GET  /me/snack-allowance { snackAllowancePct, defaultPct, min, max }   PUT { snackAllowancePct } (0 to 50, default 10)
//   GET  /me/weight-start    { weightStartDate, today, earliest }   PUT { weightStartDate: "2026-01-03" | null } (null clears it):
//                            "I started my weight loss on ...", the day "lost so far" is measured from. Yours alone, never shared.
//   GET  /me/streak           { current, best, countedToday, today }
//   GET  /household/streaks   streak NUMBERS (nothing about what anyone ate): yours, plus each other login's only when
//                             they share "totals" or "everything" with you (share.ts; phase 5a review finding 5a.R2)
//
// "Calorie budget" is the only budget in this API; household-app's money Budget is /api/budget.

import express from "express";
import { addGoal, listGoals, previewCalorieBudgets, goalJson } from "../../nutrition/data/goals.ts";
import { bodyObject } from "../../nutrition/data/input.ts";
import { householdStreaks, streakFor } from "../../nutrition/data/loggingStreaks.ts";
import { setSnackAllowancePct, snackAllowanceJson, snackAllowancePct } from "../../nutrition/data/snackAllowance.ts";
import { profileJson, getTracker, saveProfile } from "../../nutrition/data/tracker.ts";
import { setWeightStartDate, weightStartDate, weightStartJson } from "../../nutrition/data/weightStart.ts";
import {
  allSlotsFor, createSlot, isBuiltInSlot, reorderSlots, slotJson, slotsFor, updateSlot,
} from "../../nutrition/data/slots.ts";
import { h, type Ctx } from "./common.ts";
import { sharedWithViewer } from "./share.ts";

export function meRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();
  const slotList = (userId: string) => allSlotsFor(db, userId).map((s) => ({ ...slotJson(s), custom: !isBuiltInSlot(s.key) }));

  router.get("/me/profile", h((req, res) => {
    const { user } = ctx.who(req);
    res.json({ ...profileJson(user), slots: slotsFor(db, user.id).map(slotJson) });
  }));

  router.put("/me/profile", h((req, res) => {
    const { user } = ctx.who(req);
    saveProfile(db, user, req.body);
    res.json(profileJson(getTracker(db, user.id)));
  }));

  router.get("/me/goals", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(listGoals(db, user, today));
  }));

  router.post("/me/goals", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.status(201).json(goalJson(addGoal(db, user, today, req.body)));
  }));

  router.post("/me/goals/preview", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(previewCalorieBudgets(db, user, today, req.body));
  }));

  router.get("/me/slots", h((req, res) => {
    res.json(slotList(ctx.who(req).user.id));
  }));

  router.post("/me/slots", h((req, res) => {
    const { user } = ctx.who(req);
    const slot = createSlot(db, user, bodyObject(req.body));
    res.status(201).json({ ...slotJson(slot), custom: true });
  }));

  // Registered before the :key route (a PUT): the two never overlap, but the order says so.
  router.post("/me/slots/reorder", h((req, res) => {
    const { user } = ctx.who(req);
    reorderSlots(db, user, bodyObject(req.body).keys);
    res.json(slotList(user.id));
  }));

  router.put("/me/slots/:key", h((req, res) => {
    const { user } = ctx.who(req);
    const slot = updateSlot(db, user, String(req.params.key), bodyObject(req.body));
    res.json({ ...slotJson(slot), custom: !isBuiltInSlot(slot.key) });
  }));

  router.get("/me/snack-allowance", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(snackAllowanceJson(snackAllowancePct(db, user.id)));
  }));

  router.put("/me/snack-allowance", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(snackAllowanceJson(setSnackAllowancePct(db, user, req.body)));
  }));

  router.get("/me/weight-start", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(weightStartJson(weightStartDate(db, user.id), today));
  }));

  router.put("/me/weight-start", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(weightStartJson(setWeightStartDate(db, user, today, req.body), today));
  }));

  router.get("/me/streak", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json({ ...streakFor(db, user.id, today), today });
  }));

  router.get("/household/streaks", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(householdStreaks(db, user.id, ctx.now(), { shared: sharedWithViewer(ctx, req) }));
  }));

  return router;
}
