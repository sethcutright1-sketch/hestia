// Progress photos. PRIVATE: every function takes the owner and only ever touches that login's rows, and
// nothing outside routes/nutrition/photos.ts reads this table -- the sharing code (visibility.ts,
// sharedView.ts) never joins it, so no visibility level can reach a photo.
//
// The image bytes are stored in the database as a BLOB (migration 12): the household's only backup is the
// daily copy of the database file, so a photo kept anywhere else would not be backed up. The browser
// shrinks a new photo to about 1600 px before upload; the server does not resize (imported Lose It! photos
// are kept exactly as they were). The server's part is to refuse anything that is not a JPEG, PNG or WebP
// of a sane size, and to read the real type and size from the file, not from the request.

import crypto from "node:crypto";
import { imageInfo } from "../imageSize.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, localDateField, optClientId } from "./input.ts";
import { all, get, run, type Db } from "./sql.ts";

/** The largest photo accepted, in bytes. A shrunk photo is 300-500 KB; this leaves room for a phone that does not shrink well. */
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
/** Bigger than this on either side is not a photo of a person (a typo guard against a pixel-bomb). */
export const MAX_PHOTO_SIDE = 12_000;

interface PhotoMetaRow {
  id: string;
  taken_on: string;
  mime: string;
  width: number;
  height: number;
  source: string;
  created_at: string;
  size: number;
}

export const photoJson = (r: PhotoMetaRow) => ({
  id: r.id, takenOn: r.taken_on, mime: r.mime, width: r.width, height: r.height, source: r.source, size: r.size, createdAt: r.created_at,
});

/** Decode the base64 of a request, refusing anything that is not clean base64 (a data: URL prefix included). */
export function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) throw new NutritionError(400, "data must be the photo as base64 text.");
  if (value.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8) {
    throw new NutritionError(413, `That photo is too big. The limit is ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new NutritionError(400, "data must be plain base64 (no data: prefix).");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_PHOTO_BYTES) throw new NutritionError(413, `That photo is too big. The limit is ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`);
  return bytes;
}

/**
 * Store a new photo: { data: base64, takenOn?, id? } (`id` makes a replay a no-op). The type and size come from the
 * file itself; a `mime` the client sends must agree with it. A day that hasn't happened yet is refused.
 */
export function addPhoto(db: Db, user: Tracker, today: string, input: unknown) {
  assertCanTrack(user);
  const b = bodyObject(input);
  const bytes = decodeBase64(b.data);
  const info = imageInfo(bytes);
  if (!info) throw new NutritionError(400, "That isn't a JPEG, PNG or WebP picture.");
  if (b.mime !== undefined && b.mime !== info.mime) throw new NutritionError(400, `That file is ${info.mime}, not ${String(b.mime)}.`);
  if (info.width > MAX_PHOTO_SIDE || info.height > MAX_PHOTO_SIDE) throw new NutritionError(400, "That picture is far too large in pixels.");
  const takenOn = b.takenOn === undefined ? today : localDateField(b.takenOn, "takenOn");
  if (takenOn > today) throw new NutritionError(400, "A photo can't be from a day that hasn't happened yet.");
  const id = optClientId(b) ?? crypto.randomUUID();
  const prior = get<{ user_id: string }>(db, "SELECT user_id FROM nutrition_photos WHERE id = ?", id);
  if (prior) {
    if (prior.user_id !== user.id) throw new NutritionError(409, "That id belongs to someone else.");
    return { created: false, photo: photoMeta(db, user.id, id)! };
  }
  run(db,
    `INSERT INTO nutrition_photos (id, user_id, taken_on, mime, bytes, width, height, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    id, user.id, takenOn, info.mime, bytes, info.width, info.height, new Date().toISOString());
  return { created: true, photo: photoMeta(db, user.id, id)! };
}

const META = "id, taken_on, mime, width, height, source, created_at, length(bytes) AS size";

function photoMeta(db: Db, userId: string, id: string) {
  const row = get<PhotoMetaRow>(db, `SELECT ${META} FROM nutrition_photos WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, id, userId);
  return row ? photoJson(row) : undefined;
}

/** The person's own photos, newest day first: metadata only, never the bytes. */
export function listPhotos(db: Db, user: Tracker, range: { from?: unknown; to?: unknown } = {}) {
  const from = range.from === undefined ? "0000-01-01" : localDateField(range.from, "from");
  const to = range.to === undefined ? "9999-12-31" : localDateField(range.to, "to");
  return all<PhotoMetaRow>(db,
    `SELECT ${META} FROM nutrition_photos WHERE user_id = ? AND deleted_at IS NULL AND taken_on BETWEEN ? AND ?
      ORDER BY taken_on DESC, created_at DESC, rowid DESC`,
    user.id, from, to).map(photoJson);
}

/** One of the person's own photos with its bytes. Someone else's id, or a deleted one, is a 404 -- the same answer as an id that never existed. */
export function getPhoto(db: Db, user: Tracker, id: string): { mime: string; bytes: Buffer } {
  const row = get<{ mime: string; bytes: Uint8Array }>(db,
    "SELECT mime, bytes FROM nutrition_photos WHERE id = ? AND user_id = ? AND deleted_at IS NULL", id, user.id);
  if (!row) throw new NutritionError(404, "Photo not found.");
  return { mime: row.mime, bytes: Buffer.from(row.bytes) };
}

/** Delete one of the person's own photos: marks it deleted AND empties the bytes, so it no longer takes room. A second delete is a 404. */
export function deletePhoto(db: Db, user: Tracker, id: string): void {
  const r = run(db, "UPDATE nutrition_photos SET deleted_at = ?, bytes = x'' WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    new Date().toISOString(), id, user.id);
  if (!r.changes) throw new NutritionError(404, "Photo not found.");
}
