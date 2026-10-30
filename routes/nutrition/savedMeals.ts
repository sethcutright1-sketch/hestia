// Saved meals: named templates of foods ("my usual breakfast"), joint or personal.
//
//   GET    /saved-meals           every one you can see, each with its items and total calories
//   POST   /saved-meals           { name, scope?, defaultSlotKey?, items: [...] }  or  { name, fromDate, fromSlot }
//   GET    /saved-meals/:id       PUT /saved-meals/:id (partial; `items` replaces the list)   DELETE (soft)
//   POST   /saved-meals/:id/log   { date?, slot?, groupId?, status? } log it into a meal of a day
//
// Logging is the same bulk write the diary uses (POST /diary/:date/bulk), built here from the
// meal's own items so a caller doesn't have to. Entry ids are derived from (you, groupId, position),
// so sending the same `groupId` again (an offline replay) creates nothing twice, and DELETE
// /diary/group/:groupId undoes the lot. Items whose food is gone, or is someone else's personal
// food, are skipped and reported in `skipped`.

import express from "express";
import crypto from "node:crypto";
import { addEntries } from "../../nutrition/data/diary.ts";
import { daySummary, entryJson } from "../../nutrition/data/days.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { bodyObject, localDateField, optString } from "../../nutrition/data/input.ts";
import {
  createSavedMeal, deleteSavedMeal, listSavedMeals, requireSavedMeal, savedMealJson, updateSavedMeal,
} from "../../nutrition/data/savedMeals.ts";
import { derivedEntryId, h, type Ctx } from "./common.ts";

export function savedMealRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  router.get("/saved-meals", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(listSavedMeals(db, user).map((m) => savedMealJson(db, user, m)));
  }));

  router.post("/saved-meals", h((req, res) => {
    const { user } = ctx.who(req);
    const out = createSavedMeal(db, user, req.body);
    res.status(201).json(savedMealJson(db, user, out.meal, out.skipped));
  }));

  router.get("/saved-meals/:id", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(savedMealJson(db, user, requireSavedMeal(db, user, String(req.params.id))));
  }));

  router.put("/saved-meals/:id", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(savedMealJson(db, user, updateSavedMeal(db, user, String(req.params.id), req.body)));
  }));

  router.delete("/saved-meals/:id", h((req, res) => {
    const { user } = ctx.who(req);
    deleteSavedMeal(db, user, String(req.params.id));
    res.json({ ok: true });
  }));

  router.post("/saved-meals/:id/log", h((req, res) => {
    const { user, today } = ctx.who(req);
    const meal = requireSavedMeal(db, user, String(req.params.id));
    const b = bodyObject(req.body ?? {});
    const date = b.date === undefined ? today : localDateField(b.date, "date");
    const slot = optString(b, "slot", 40) ?? meal.default_slot_key;
    if (!slot) throw new NutritionError(400, "slot is required: this saved meal has no default meal.");
    const groupId = optString(b, "groupId", 64) ?? crypto.randomUUID();

    const json = savedMealJson(db, user, meal);
    const usable = json.items.filter((i) => i.available && i.foodId);
    const skipped = json.items.filter((i) => !i.available)
      .map((i) => ({ name: i.name, reason: "That food was deleted or is no longer shared with you." }));
    if (usable.length === 0) throw new NutritionError(400, "None of the foods in this saved meal can be logged.", { skipped });

    const out = addEntries(db, user, date, today, {
      slot,
      ...(b.status === undefined ? {} : { status: b.status }),
      source: "copy",
      groupId,
      items: usable.map((i, n) => ({
        id: derivedEntryId(user.id, groupId, n), foodId: i.foodId, quantity: i.quantity, servingId: i.servingId, grams: i.grams,
      })),
    });
    res.status(out.created > 0 ? 201 : 200).json({
      entries: out.entries.map(entryJson),
      created: out.created,
      groupId,
      skipped,
      summary: daySummary(db, user, date, today),
    });
  }));

  return router;
}
