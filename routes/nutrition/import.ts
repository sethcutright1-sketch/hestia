// The Lose It! import -- into the SIGNED-IN login's own diary, never anyone else's.
//
//   POST /import/loseit/dry-run   the whole import, rolled back: the report is exactly what a real run would do
//   POST /import/loseit           the import for real (one transaction: all or nothing)
//   POST /import/loseit/match-calorie-budget   { palOverride }  the separate, explicit "Match my Lose It! calorie budget" action
//
// The first two take the export's ZIP as the REQUEST BODY (Content-Type: application/zip, read with express.raw on
// these routes only, up to 100 MB; the app-wide 10 MB JSON parser in server.ts steps aside for them), and the options
// as query parameters:
//
//   conflict=skip|merge|replace   a day you already logged here: leave it (default), import beside it, or replace it
//   onlyMe=1                      foods the import creates are personal instead of shared with the household
//   weightUnit=lb|kg              the unit of weights.csv (default: the login's own unit setting)
//   from=YYYY-MM-DD&to=YYYY-MM-DD only this inclusive window
//
// The answer is the report (nutrition/import/types.ts ImportReport). The calorie-budget comparison in it is a
// comparison only: nothing in these two routes changes a goal. Only match-calorie-budget does, and only when asked.
//
// Who may use it: an admin or parent login for their own diary. The kiosk login is refused by the gate in
// routes/nutrition.ts (403, like every nutrition route), a login with the food-diary PIN on needs an unlocked session
// (the same gate answers 423 before the ZIP is read), and a watch (device token) is refused here.

import express from "express";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { goalJson } from "../../nutrition/data/goals.ts";
import { applyCalibration } from "../../nutrition/import/calibration.ts";
import { importLoseIt } from "../../nutrition/import/loseitImport.ts";
import type { ConflictMode, WeightUnit } from "../../nutrition/import/types.ts";
import { readZip } from "../../nutrition/import/zip.ts";
import { h, queryString, sendError, type Ctx } from "./common.ts";

/** The largest ZIP accepted. A full export with progress photos was about 17 MB. */
export const IMPORT_BODY_LIMIT = "100mb";

/** The two routes that take a ZIP body. server.ts's global JSON parser skips them. */
export const isZipImportPath = (path: string): boolean => /^\/api\/nutrition\/import\/loseit(\/dry-run)?\/?$/i.test(path.split("?")[0]);

const ZIP_TYPES = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];

function onlyMe(req: express.Request): boolean {
  const v = queryString(req, "onlyMe").toLowerCase();
  if (v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new NutritionError(400, "onlyMe must be 1 or 0.");
}

export function importRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  const zipBody = express.raw({ type: ZIP_TYPES, limit: IMPORT_BODY_LIMIT });

  const run = (dryRun: boolean): express.RequestHandler => h((req, res) => {
    // A watch's token acts as its owner for the diary, but importing a whole history is a person at a screen.
    if (req.deviceUserId) throw new NutritionError(403, "Importing from Lose It! isn't available from a watch.");
    const { user, today } = ctx.who(req);
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new NutritionError(415, "Send the Lose It! ZIP file itself as the request body, with Content-Type: application/zip.");
    }
    const exp = readZip(body);
    const report = importLoseIt(db, user, exp, {
      dryRun,
      today,
      conflict: (queryString(req, "conflict") || undefined) as ConflictMode | undefined,
      weightUnit: (queryString(req, "weightUnit") || undefined) as WeightUnit | undefined,
      from: queryString(req, "from") || undefined,
      to: queryString(req, "to") || undefined,
      foodScope: onlyMe(req) ? "personal" : "joint",
      // applyCalibration is deliberately NOT read from the request: matching the calorie budget is its own action.
    });
    res.json(report);
  });

  router.post("/import/loseit/dry-run", zipBody, run(true));
  router.post("/import/loseit", zipBody, run(false));

  router.post("/import/loseit/match-calorie-budget", h((req, res) => {
    if (req.deviceUserId) throw new NutritionError(403, "Changing your calorie goal isn't available from a watch.");
    const { user, today } = ctx.who(req);
    const pal = (req.body as { palOverride?: unknown } | undefined)?.palOverride;
    const goal = applyCalibration(db, user, today, pal);
    res.status(201).json({ applied: true, goal: goalJson(goal) });
  }));

  // body-parser's own failures (a ZIP over the limit, a body that stops short) arrive here as errors, not as responses.
  router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      sendError(res, new NutritionError(413, `That file is too big. The limit is ${IMPORT_BODY_LIMIT.replace("mb", " MB")}.`));
    } else if (err?.type === "request.aborted" || err?.type === "request.size.invalid") {
      sendError(res, new NutritionError(400, "The upload was cut short. Try again."));
    } else {
      next(err);
    }
  });

  return router;
}
