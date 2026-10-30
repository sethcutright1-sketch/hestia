// Weigh-ins, steps and exercise. Weight is stored in kilograms (the client converts for display); the
// latest weight on or before a day drives that day's calorie budget.
//
//   GET    /weights?from=&to=     weigh-ins, oldest first
//   GET    /weights/trend?from=|range=   the smoothed trend weight and, with a goal weight, when the plan reaches it.
//                                 `range` (1m|3m|6m|1y|all, the chart's buttons) returns the points of that range with the trend
//                                 worked out from the whole history, plus `weightStart` (the trend on the day the person said
//                                 they started). `from` is the older form (the trend starts at the first weigh-in since). Not both.
//   POST   /weights               { weightKg | weightLb, measuredOn?, id? }  `id` makes a replay a no-op
//   DELETE /weights/:id
//   GET    /steps?from=&to=       steps typed by hand, one row per date, oldest first: [{ date, steps, source }]
//   PUT    /steps/:date           { steps }  sets that date (a whole number, 0 to 200,000), replacing what was there
//   DELETE /steps/:date           removes that date. Steps never change the calorie budget.
//   GET    /exercise?date=        a day's exercise
//   GET    /exercise/recent?limit= your own distinct recent exercises, newest first (one-tap repeat)
//   POST   /exercise              { name, kcal, minutes?, localDate?, excludeFromBudget? }  adds to the day's calorie budget
//                                 unless flagged "exclude from budget" (still a CALORIE budget)
//   PATCH  /exercise/:id          { name?, kcal?, minutes? (null clears), excludeFromBudget? }
//   DELETE /exercise/:id

import express from "express";
import { addExercise, deleteExercise, listExercise, recentExercise, updateExercise } from "../../nutrition/data/exercise.ts";
import { deleteSteps, listSteps, putSteps, stepsJson } from "../../nutrition/data/steps.ts";
import { weightTrendFor, weightTrendForRange } from "../../nutrition/data/weightProgress.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { addWeight, deleteWeight, listWeights, weightJson } from "../../nutrition/data/weights.ts";
import { h, type Ctx } from "./common.ts";

export function bodyRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  router.get("/weights", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(listWeights(db, user, { from: req.query.from, to: req.query.to }).map(weightJson));
  }));

  router.get("/weights/trend", h((req, res) => {
    const { user, today } = ctx.who(req);
    const { from, range } = req.query;
    if (range === undefined) return void res.json(weightTrendFor(db, user, today, from));
    if (from !== undefined) throw new NutritionError(400, "Use either from or range, not both.");
    res.json(weightTrendForRange(db, user, today, range));
  }));

  router.post("/weights", h((req, res) => {
    const { user } = ctx.who(req);
    const out = addWeight(db, user, ctx.now(), req.body);
    res.status(out.created ? 201 : 200).json(out);
  }));

  router.delete("/weights/:id", h((req, res) => {
    const { user } = ctx.who(req);
    deleteWeight(db, user, String(req.params.id));
    res.json({ ok: true });
  }));

  router.get("/steps", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(listSteps(db, user.id, { from: req.query.from, to: req.query.to }).map(stepsJson));
  }));

  router.put("/steps/:date", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(putSteps(db, user, today, req.params.date, req.body));
  }));

  router.delete("/steps/:date", h((req, res) => {
    const { user } = ctx.who(req);
    deleteSteps(db, user, req.params.date);
    res.json({ ok: true });
  }));

  router.get("/exercise", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(listExercise(db, user, ctx.now(), req.query.date));
  }));

  router.get("/exercise/recent", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(recentExercise(db, user, req.query.limit));
  }));

  router.post("/exercise", h((req, res) => {
    const { user } = ctx.who(req);
    res.status(201).json(addExercise(db, user, ctx.now(), req.body));
  }));

  router.patch("/exercise/:id", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(updateExercise(db, user, String(req.params.id), req.body));
  }));

  router.delete("/exercise/:id", h((req, res) => {
    const { user } = ctx.who(req);
    deleteExercise(db, user, String(req.params.id));
    res.json({ ok: true });
  }));

  return router;
}
