// One photo per recipe, stored in the database (nutrition migration 14, table nutrition_recipe_photos).
//
// Who may see it is whoever may see the recipe: every function starts with requireRecipe, so a personal recipe's photo
// is a 404 to anyone else, exactly like the recipe itself. The browser shrinks a new photo to about 800 px before it is
// sent (src/sections/food/imageResize.ts); the server's part is to refuse anything over MAX_RECIPE_PHOTO_BYTES and
// anything that is not a JPEG, PNG or WebP, reading the real type and size from the file rather than the request.
//
// The bytes never go into the recipe document: the plan screen loads every recipe on every refresh. The document carries
// only `photoAt` (when it was set), which the screen uses as a cache-buster on the image address.

import { imageInfo } from "../imageSize.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject } from "./input.ts";
import { decodeBase64 } from "./photos.ts";
import { requireRecipe, saveRecipe } from "./recipes.ts";
import { get, run, tx, type Db } from "./sql.ts";

/** The largest recipe photo accepted. A shrunk one is 80-150 KB; this leaves room for a phone that does not shrink well. */
export const MAX_RECIPE_PHOTO_BYTES = 1024 * 1024;
/** Bigger than this on either side is not a recipe photo (a typo guard against a pixel-bomb). */
export const MAX_RECIPE_PHOTO_SIDE = 4000;

/** Store (or replace) the recipe's photo: { data: base64, mime? }. Returns the recipe document with its new `photoAt`. */
export function setRecipePhoto(db: Db, userId: string, recipeId: string, input: unknown) {
  const rec = requireRecipe(db, userId, recipeId);
  const b = bodyObject(input);
  const bytes = decodeBase64(b.data);
  if (bytes.length > MAX_RECIPE_PHOTO_BYTES) {
    throw new NutritionError(413, `That photo is too big. The limit is ${Math.round(MAX_RECIPE_PHOTO_BYTES / 1024)} KB for a recipe.`);
  }
  const info = imageInfo(bytes);
  if (!info) throw new NutritionError(400, "That isn't a JPEG, PNG or WebP picture.");
  if (b.mime !== undefined && b.mime !== info.mime) throw new NutritionError(400, `That file is ${info.mime}, not ${String(b.mime)}.`);
  if (info.width > MAX_RECIPE_PHOTO_SIDE || info.height > MAX_RECIPE_PHOTO_SIDE) throw new NutritionError(400, "That picture is far too large in pixels.");
  return tx(db, () => {
    const now = new Date().toISOString();
    run(db,
      `INSERT INTO nutrition_recipe_photos (recipe_id, mime, bytes, width, height, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(recipe_id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, width = excluded.width, height = excluded.height, updated_at = excluded.updated_at`,
      rec.doc.id, info.mime, bytes, info.width, info.height, now);
    return saveRecipe(db, userId, { ...rec.doc, photoAt: now });
  });
}

/** The recipe's photo bytes. No photo, or a recipe the caller can't see, is a 404 (the same answer for both). */
export function getRecipePhoto(db: Db, userId: string, recipeId: string): { mime: string; bytes: Buffer; updatedAt: string } {
  const rec = requireRecipe(db, userId, recipeId);
  const row = get<{ mime: string; bytes: Uint8Array; updated_at: string }>(db, "SELECT mime, bytes, updated_at FROM nutrition_recipe_photos WHERE recipe_id = ?", rec.doc.id);
  if (!row) throw new NutritionError(404, "This recipe has no photo.");
  return { mime: row.mime, bytes: Buffer.from(row.bytes), updatedAt: row.updated_at };
}

/** Remove the recipe's photo (a recipe with none is fine) and clear `photoAt`. Returns the recipe document. */
export function deleteRecipePhoto(db: Db, userId: string, recipeId: string) {
  const rec = requireRecipe(db, userId, recipeId);
  return tx(db, () => {
    run(db, "DELETE FROM nutrition_recipe_photos WHERE recipe_id = ?", rec.doc.id);
    const { photoAt: _gone, ...rest } = rec.doc;
    return saveRecipe(db, userId, rest);
  });
}

/** Give `toId` a copy of `fromId`'s photo, if it has one (a duplicated recipe starts with its original's picture). */
export function copyRecipePhoto(db: Db, fromId: string, toId: string): string | undefined {
  const row = get<{ mime: string; bytes: Uint8Array; width: number; height: number }>(db, "SELECT mime, bytes, width, height FROM nutrition_recipe_photos WHERE recipe_id = ?", fromId);
  if (!row) return undefined;
  const now = new Date().toISOString();
  run(db, "INSERT INTO nutrition_recipe_photos (recipe_id, mime, bytes, width, height, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(recipe_id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, width = excluded.width, height = excluded.height, updated_at = excluded.updated_at",
    toId, row.mime, Buffer.from(row.bytes), row.width, row.height, now);
  return now;
}
