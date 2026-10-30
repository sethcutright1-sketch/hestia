// The food diary and the day around it.
//
//   GET    /diary/:date               the day page: meals with entries, each meal's calorie target, the summary
//   POST   /diary/:date               add one entry (food + amount, or a quick add); `id` makes it idempotent
//   POST   /diary/:date/bulk          many entries into one meal in one transaction; every item has a client id
//   PATCH  /diary/entry/:id           move it, plan -> logged ("I ate it"), change the quantity, or re-measure it (servingId / grams)
//   DELETE /diary/entry/:id           soft delete (idempotent)
//   DELETE /diary/group/:groupId      undo a bulk write
//   GET    /days/:date                the day summary, with the calorie budget  (also /days/:date/summary)
//   POST   /days/:date/done           "Done logging"
//   GET    /meals/previous?limit=     meals you ate lately, ready to log again
//
// Every row is the signed-in person's own: an entry id belonging to someone else is a 404 (or a
// 409 when it is offered as a new client id).

import express from "express";
import { daySummary, entryJson, markDayDone } from "../../nutrition/data/days.ts";
import { addEntries, addEntry, deleteEntry, deleteGroup, getDay, updateEntry } from "../../nutrition/data/diary.ts";
import { previousMeals } from "../../nutrition/data/mealItems.ts";
import { clampInt, dateParam, h, type Ctx } from "./common.ts";

export function diaryRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  router.get("/diary/:date", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(getDay(db, user, dateParam(req), today));
  }));

  router.post("/diary/:date", h((req, res) => {
    const { user, today } = ctx.who(req);
    const date = dateParam(req);
    const { row, created } = addEntry(db, user, date, today, req.body);
    res.status(created ? 201 : 200).json({ entry: entryJson(row), summary: daySummary(db, user, date, today) });
  }));

  router.post("/diary/:date/bulk", h((req, res) => {
    const { user, today } = ctx.who(req);
    const date = dateParam(req);
    const out = addEntries(db, user, date, today, req.body);
    res.status(out.created > 0 ? 201 : 200).json({
      entries: out.entries.map(entryJson),
      created: out.created,
      summary: daySummary(db, user, date, today),
    });
  }));

  router.patch("/diary/entry/:id", h((req, res) => {
    const { user, today } = ctx.who(req);
    const row = updateEntry(db, user, today, String(req.params.id), req.body);
    res.json({ entry: entryJson(row), summary: daySummary(db, user, row.local_date, today) });
  }));

  router.delete("/diary/entry/:id", h((req, res) => {
    const { user, today } = ctx.who(req);
    const cur = deleteEntry(db, user, String(req.params.id));
    res.json({ ok: true, summary: daySummary(db, user, cur.local_date, today) });
  }));

  router.delete("/diary/group/:groupId", h((req, res) => {
    const { user, today } = ctx.who(req);
    const out = deleteGroup(db, user, String(req.params.groupId));
    res.json({ ok: true, deleted: out.deleted, summaries: out.dates.map((d) => daySummary(db, user, d, today)) });
  }));

  const summary = h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(daySummary(db, user, dateParam(req), today));
  });
  router.get("/days/:date", summary);
  router.get("/days/:date/summary", summary);

  router.post("/days/:date/done", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(markDayDone(db, user, dateParam(req), today));
  }));

  router.get("/meals/previous", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(previousMeals(db, user, today, clampInt(req.query.limit, 20, 1, 50)));
  }));

  return router;
}
