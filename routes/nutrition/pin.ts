// "Require the PIN for my food diary": an option each login sets for itself in Account settings.
//
//   GET /settings/pin   -> { requirePin, householdPinSet, unlocked }   always readable, even while locked
//   PUT /settings/pin   { requirePin: boolean } -> the same shape      for the signed-in login only
//
// Default OFF. While it is ON for a login, every /api/nutrition/* request of that login (except the
// GET above) goes through requireUnlocked from auth.ts, exactly as Budget does: 423 { error: "locked" }
// until the household PIN is entered (the React app's PinPrompt already reacts to that), and the same
// sliding unlock window, refreshed by each request.
//
// Rules worth knowing:
//   - Turning it ON needs nothing (the option is switched on from a normal session).
//   - Turning it OFF needs the session to be unlocked: the PUT itself is gated like everything else,
//     so someone holding a signed-in phone can't simply switch the lock off.
//   - No household PIN configured (lock_pin_hash unset): requireUnlocked lets sessions through, so the
//     option does nothing yet; the GET says householdPinSet: false so the screen can say so.
//   - A Wear OS device token is refused (423) for a login that has this on, with or without a household
//     PIN, because requireUnlocked refuses device tokens outright (a watch can't enter the PIN, and
//     money is the same). A login that leaves it off is unaffected.
//   - The kiosk login has no diary and no setting; it never reaches this file (the kiosk gate answers
//     first), and its two kiosk routes are never PIN-gated.
//
// Stored per login in app_config as `nutrition_require_pin:<userId>` (via getConfig/setConfig) rather
// than on nutrition_profiles: that row needs sex, birth date and height before it can exist, and this
// is a lock on the login, not a body fact, so it must work before (and without) a profile.

import express from "express";
import { currentUserId, isUnlocked } from "../../auth.ts";
import { getConfig, setConfig } from "../../db.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { bodyObject } from "../../nutrition/data/input.ts";
import { h, type Ctx } from "./common.ts";

export const pinKey = (userId: string): string => `nutrition_require_pin:${userId}`;

/** Does this login lock its food diary behind the household PIN? */
export const pinRequiredFor = (userId: string): boolean => getConfig(pinKey(userId), false) === true;

const setPinRequired = (userId: string, value: boolean): void => setConfig(pinKey(userId), value);

/** The setting as the screen needs it. */
export const pinSettingJson = (req: express.Request) => ({
  requirePin: pinRequiredFor(currentUserId(req)),
  householdPinSet: !!getConfig("lock_pin_hash", null),
  unlocked: isUnlocked(req),
});

export function pinRoutes(_ctx: Ctx): express.Router {
  const router = express.Router();

  router.get("/settings/pin", h((req, res) => {
    res.json(pinSettingJson(req));
  }));

  router.put("/settings/pin", h((req, res) => {
    const b = bodyObject(req.body);
    if (typeof b.requirePin !== "boolean") throw new NutritionError(400, "requirePin must be true or false.");
    // By the time this runs the gate has already required an unlocked session if the option was on,
    // so switching it off from a locked session never gets here.
    setPinRequired(currentUserId(req), b.requirePin);
    res.json(pinSettingJson(req));
  }));

  return router;
}
