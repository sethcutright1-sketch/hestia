// Progress photos -- PRIVATE to the login that took them. They are never shared at any visibility level,
// and no route outside this file reads them.
//
//   GET    /photos?from=&to=     the signed-in login's own photos, newest day first: METADATA ONLY
//                                [{ id, takenOn, mime, width, height, source, size, createdAt }]
//   POST   /photos               { data: <base64>, takenOn?, id?, mime? } -> 201 { created, photo }
//                                JPEG, PNG or WebP only (read from the file itself), at most 6 MB. The browser
//                                shrinks a new photo to about 1600 px first; the server stores what it is given.
//   GET    /photos/:id/image     the picture's bytes, `Cache-Control: private`
//   DELETE /photos/:id           removes it (and empties its bytes)
//
// Owner only: someone else's photo id, a deleted one and one that never existed all answer 404, and so do
// a watch (device token) and -- instead of the kiosk gate's usual 403 -- the kiosk login (routes/nutrition.ts).
// The images live in the database file as BLOBs, so the household's daily database copy backs them up.

import express from "express";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { addPhoto, deletePhoto, getPhoto, listPhotos } from "../../nutrition/data/photos.ts";
import { h, sendError, type Ctx } from "./common.ts";

export function photoRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  // A watch's token acts as its owner everywhere else, but a photo is the most private thing here: 404, as if it did not exist.
  router.use("/photos", (req, res, next) => {
    if (req.deviceUserId) sendError(res, new NutritionError(404, "Not found."));
    else next();
  });

  router.get("/photos", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(listPhotos(db, user, { from: req.query.from, to: req.query.to }));
  }));

  router.post("/photos", h((req, res) => {
    const { user, today } = ctx.who(req);
    const out = addPhoto(db, user, today, req.body);
    res.status(out.created ? 201 : 200).json(out);
  }));

  router.get("/photos/:id/image", h((req, res) => {
    const { user } = ctx.who(req);
    const photo = getPhoto(db, user, String(req.params.id));
    res.setHeader("Content-Type", photo.mime);
    // no-cache, not max-age: the browser must ask again every time, so a deleted photo (or one viewed in a
    // browser someone else signs into later) is never shown from cache. Express's ETag makes the repeat a
    // cheap 304 while the photo is unchanged.
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(photo.bytes);
  }));

  router.delete("/photos/:id", h((req, res) => {
    const { user } = ctx.who(req);
    deletePhoto(db, user, String(req.params.id));
    res.json({ ok: true });
  }));

  return router;
}
