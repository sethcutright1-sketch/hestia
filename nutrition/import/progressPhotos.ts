// progress-photos/progress-photos.csv + the pictures named <date>-<token>-photo.jpg -> nutrition_photos with
// source = 'import_loseit'.
//
// Rules (assumptions 5b.12-5b.17, and the user's decisions for the import):
//   - The pictures are stored EXACTLY as they are in the export: no resizing, no re-encoding.
//   - They land in the importing login's own photos, which are private: owner only, never shared at any
//     visibility level, never joint, never on the kiosk (routes/nutrition/photos.ts is the only reader).
//   - A picture over the size limit (photos.ts MAX_PHOTO_BYTES) is SKIPPED and counted, never shrunk.
//   - Rows marked Deleted are skipped. A photo imported earlier and deleted in Lose It! since is KEPT here (and
//     counted): deleting a photo here empties its bytes for good, so the import never does it on its own.
//   - A row is matched to its file by the token (the CSV says 2025-06-05 as 6/5/2025, the file says
//     2025-06-05-<token>-photo.jpg), not by the date.
//   - Re-running adds nothing: the photo's id is derived from the login and the token. A photo the person deleted
//     here stays deleted.
//   - Its date is the date in the CSV. Visibility in the CSV ("Private") is not read: everything lands private.

import { imageInfo } from "../imageSize.ts";
import { MAX_PHOTO_BYTES, MAX_PHOTO_SIDE } from "../data/photos.ts";
import { sha256, type Ctx } from "./context.ts";
import type { ImportReport } from "./types.ts";

/** The file for a token: its name carries the token, e.g. 2025-06-05-6e9d...-photo.jpg. */
function fileFor(photos: Map<string, Uint8Array>, token: string): Uint8Array | undefined {
  const t = token.toLowerCase();
  if (t.length < 8) return undefined; // too short to tell files apart
  for (const [name, bytes] of photos) if (name.includes(t)) return bytes;
  return undefined;
}

export const photoIdFor = (userId: string, token: string): string => `loseit-${sha256(`${userId}|${token.toLowerCase()}`).slice(0, 32)}`;

export function importProgressPhotos(ctx: Ctx): ImportReport["photos"] {
  const { db, user, o, warnings } = ctx;
  const rep: ImportReport["photos"] = {
    inFile: 0, created: 0, alreadyImported: 0, skippedDeleted: 0, deletedSinceKept: 0, tooBig: 0, unusable: 0, outsideRange: 0, future: 0,
    limitBytes: MAX_PHOTO_BYTES,
  };
  const rows = ctx.parsed.progressPhotos;
  if (!rows) return rep;

  const find = db.prepare("SELECT user_id, deleted_at FROM nutrition_photos WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO nutrition_photos (id, user_id, taken_on, mime, bytes, width, height, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'import_loseit', ?)`);
  const now = new Date().toISOString();
  const seen = new Set<string>();

  for (const r of rows) {
    rep.inFile++;
    const id = photoIdFor(user.id, r.token);
    const prior = find.get(id) as unknown as { user_id: string; deleted_at: string | null } | undefined;
    if (r.deleted) {
      rep.skippedDeleted++;
      if (prior && !prior.deleted_at) rep.deletedSinceKept++;
      continue;
    }
    if (!ctx.inWindow(r.date)) { rep.outsideRange++; continue; }
    if (r.date > o.today) { rep.future++; continue; }
    if (prior || seen.has(id)) { rep.alreadyImported++; continue; }
    seen.add(id);

    const bytes = fileFor(ctx.photos, r.token);
    if (!bytes) {
      rep.unusable++;
      warnings.add(`Progress photo of ${r.date}: its picture file isn't in the ZIP, skipped`);
      continue;
    }
    if (bytes.length > MAX_PHOTO_BYTES) {
      rep.tooBig++;
      warnings.add(`Progress photo of ${r.date}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB is over the ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB limit, skipped (photos are never shrunk on import)`);
      continue;
    }
    const info = imageInfo(bytes);
    if (!info || info.width > MAX_PHOTO_SIDE || info.height > MAX_PHOTO_SIDE) {
      rep.unusable++;
      warnings.add(`Progress photo of ${r.date}: not a usable JPEG, PNG or WebP picture, skipped`);
      continue;
    }
    insert.run(id, user.id, r.date, info.mime, bytes, info.width, info.height, now);
    rep.created++;
  }
  return rep;
}
