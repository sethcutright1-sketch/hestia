// Who sees what -- the routes. Each diary login decides what the OTHER diary logins can see of THEIR food
// data (nutrition/data/visibility.ts: nothing / totals / everything). The server enforces it here; the
// screens only reflect it.
//
//   GET  /me/visibility                    { visibility, defaultVisibility, levels }   the signed-in login's own level
//   PUT  /me/visibility                    { visibility }                              for the signed-in login only
//   GET  /sharing                          [{ userId, name, level }]   the other diary logins sharing "totals" or
//                                          "everything" with the signed-in login (drives the Food section's person switcher)
//   GET  /people/:userId/day/:date         ANOTHER login's day (:date may be "today" = THEIR today), read-only, at THEIR level:
//                                            totals      { person, date, today, streak, summary: top-card numbers only }
//                                            everything  the same plus macros eaten, meals with entries, and exercise
//   GET  /people/:userId/progress?from=|range=   ANOTHER login's weigh-ins + trend + steps; "everything" only. `range` is the chart's
//                                          1m|3m|6m|1y|all; never their goal weight, plan, goal date or start date
//
// Rules, in the order they are checked:
//   1. A watch (device token) never views another person's data (403).
//   2. The person must be another diary login (400 for yourself; 404 for an unknown id or the kiosk login).
//   3. The owner's level must allow the request (403 "<name> doesn't share that with you.").
//   4. The owner's "Require the PIN for my food diary" (pin.ts) also locks their data for the VIEWER: an owner who
//      turned it on is readable only from a session that has entered the household PIN (423 "locked" otherwise,
//      the same answer and the same sliding unlock window as Budget). The household PIN is one shared PIN, so
//      this is not a secret between the two; it keeps a phone left open from showing a locked diary.
//
// The kiosk login never gets here (routes/nutrition.ts refuses it first), and nothing here writes: no route
// in this file, and no write route anywhere, acts on another login's rows. Progress photos are not reachable
// from this file at all.

import express from "express";
import { requireUnlocked, isUnlocked } from "../../auth.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { bodyObject } from "../../nutrition/data/input.ts";
import { sharedDay, sharedProgress } from "../../nutrition/data/sharedView.ts";
import type { Tracker } from "../../nutrition/data/access.ts";
import type { Db } from "../../nutrition/data/sql.ts";
import { peekTracker, todayFor } from "../../nutrition/data/tracker.ts";
import {
  levelAllows, setVisibility, sharersFor, visibilityJson, visibilityOf, type VisibilityNeed,
} from "../../nutrition/data/visibility.ts";
import { dateParam, h, queryString, type Ctx } from "./common.ts";
import { pinRequiredFor } from "./pin.ts";

/** What the session asking is: whether the household PIN has been entered, and whether it is a Wear OS device token. */
export interface ViewerSession {
  unlocked: boolean;
  device: boolean;
}

/**
 * The ids of the OTHER diary logins whose numbers a viewer may include in an aggregate answer
 * (the household streaks, the week's calorie view): those that share at least `need`, minus those who
 * lock their diary behind the household PIN while this session is locked. A watch gets none.
 * The plain-data form of sharedWithViewer, so the assistant's tools apply the SAME rule as the routes.
 */
export function sharedForSession(db: Db, viewerId: string, session: ViewerSession, need: VisibilityNeed = "totals"): Set<string> {
  const out = new Set<string>();
  if (session.device) return out;
  for (const s of sharersFor(db, viewerId, need)) {
    if (session.unlocked || !pinRequiredFor(s.tracker.id)) out.add(s.tracker.id);
  }
  return out;
}

/** The request form of sharedForSession. */
export function sharedWithViewer(ctx: Ctx, req: express.Request, need: VisibilityNeed = "totals"): Set<string> {
  return sharedForSession(ctx.db, ctx.who(req).user.id, { unlocked: isUnlocked(req), device: !!req.deviceUserId }, need);
}

export type ViewerAccess =
  | { ok: true; person: Tracker; level: VisibilityNeed; pinProtected: boolean }
  | { ok: false; reason: "device" | "self" | "unknown" | "not_shared" | "locked"; status: number; message: string };

/**
 * Rules 1 to 4 of the header comment, as one function of plain data: may this viewer read `personId`'s food data
 * at level `need`? Used by the /people/:userId routes below AND by the assistant's tools, so a chat answer about
 * another login can never be more generous than the screen. It checks in the order the comment lists them. A
 * `locked` answer is the 423 case: the owner locks their diary behind the household PIN and this session hasn't
 * entered it. `pinProtected` on success says the owner has that option on (the route then refreshes the unlock window).
 */
export function viewerAccess(db: Db, viewerId: string, personId: string, need: VisibilityNeed, session: ViewerSession): ViewerAccess {
  if (session.device) return { ok: false, reason: "device", status: 403, message: "A watch can't view another person's food data." };
  if (personId === viewerId) return { ok: false, reason: "self", status: 400, message: "That's you. Your own diary is the Me view." };
  let person: Tracker;
  try {
    person = peekTracker(db, personId);
  } catch {
    return { ok: false, reason: "unknown", status: 404, message: "Person not found." };
  }
  const level = visibilityOf(db, person.id);
  if (!levelAllows(level, need)) {
    return { ok: false, reason: "not_shared", status: 403, message: `${person.displayName} doesn't share that with you.` };
  }
  const pinProtected = pinRequiredFor(person.id);
  if (pinProtected && !session.unlocked) {
    return { ok: false, reason: "locked", status: 423, message: `${person.displayName} keeps their food diary behind the PIN, and it hasn't been entered.` };
  }
  return { ok: true, person, level: level as VisibilityNeed, pinProtected };
}

export function shareRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  router.get("/me/visibility", h((req, res) => {
    res.json(visibilityJson(visibilityOf(db, ctx.who(req).user.id)));
  }));

  router.put("/me/visibility", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(visibilityJson(setVisibility(db, user, bodyObject(req.body))));
  }));

  router.get("/sharing", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(req.deviceUserId ? [] : sharersFor(db, user.id).map((s) => ({ userId: s.tracker.id, name: s.tracker.displayName, level: s.level })));
  }));

  /** Checks rules 1 to 4 above. Returns the owner, or null when it has already answered 423. */
  function owner(req: express.Request, res: express.Response, need: VisibilityNeed) {
    const { user: viewer } = ctx.who(req);
    const access = viewerAccess(db, viewer.id, String(req.params.userId), need, { unlocked: isUnlocked(req), device: !!req.deviceUserId });
    if (!access.ok) {
      if (access.reason === "locked") {
        requireUnlocked(req, res, () => {}); // answers 423 { error: "locked" } like Budget
        return null;
      }
      throw new NutritionError(access.status, access.message);
    }
    if (access.pinProtected) {
      let passed = false;
      requireUnlocked(req, res, () => { passed = true; }); // passes (we are unlocked) and slides the unlock window
      if (!passed) return null;
    }
    return { person: access.person, level: access.level };
  }

  router.get("/people/:userId/day/:date", h((req, res) => {
    const found = owner(req, res, "totals");
    if (!found) return;
    // "today" means THEIR today (their timezone), so a screen can open on the right day without knowing it.
    const date = req.params.date === "today" ? todayFor(found.person, ctx.now()) : dateParam(req);
    res.json(sharedDay(db, found.person, found.level, date, ctx.now()));
  }));

  router.get("/people/:userId/progress", h((req, res) => {
    const found = owner(req, res, "everything");
    if (!found) return;
    const from = queryString(req, "from");
    const range = queryString(req, "range");
    res.json(sharedProgress(db, found.person, ctx.now(), from || undefined, range || undefined));
  }));

  return router;
}
