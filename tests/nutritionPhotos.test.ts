// Progress photos (migration 12 + /photos): stored as BLOBs in the database file, JPEG/PNG/WebP only with a size cap,
// metadata-only listing, and PRIVATE -- only the owner reaches a photo, at every visibility level; every other login,
// the kiosk and a watch get 404. Clock 2026-03-10 15:00Z: ann's today is 2026-03-10, ben's (Auckland) is 2026-03-11.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi } from "./helpers/nutritionApi.ts";
import { TODAY, YESTERDAY } from "./helpers/nutritionWorld.ts";
import { PNG_1X1_BASE64, jpegBytes, pngBytes, webpBytes } from "./helpers/images.ts";
import { imageInfo } from "../nutrition/imageSize.ts";
import { MAX_PHOTO_BYTES } from "../nutrition/data/photos.ts";
import { NUTRITION_MIGRATIONS, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

after(cleanupDb);

const b64 = (b: Buffer) => b.toString("base64");

// ---- reading a picture's header ---------------------------------------------------------------------

test("imageInfo reads the real type and size of a JPEG, PNG or WebP, and nothing else", () => {
  assert.deepEqual(imageInfo(Buffer.from(PNG_1X1_BASE64, "base64")), { mime: "image/png", width: 1, height: 1 });
  assert.deepEqual(imageInfo(pngBytes(1600, 1200, 50)), { mime: "image/png", width: 1600, height: 1200 });
  assert.deepEqual(imageInfo(jpegBytes(1200, 1600, 100)), { mime: "image/jpeg", width: 1200, height: 1600 });
  assert.deepEqual(imageInfo(webpBytes("lossy", 640, 480, 20)), { mime: "image/webp", width: 640, height: 480 });
  assert.deepEqual(imageInfo(webpBytes("lossless", 1024, 768, 20)), { mime: "image/webp", width: 1024, height: 768 });
  assert.deepEqual(imageInfo(webpBytes("extended", 4000, 3000, 20)), { mime: "image/webp", width: 4000, height: 3000 });

  const notImages: Array<[string, Buffer]> = [
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')],
    ["html", Buffer.from("<html><script>alert(1)</script></html>")],
    ["pdf", Buffer.from("%PDF-1.4\n1 0 obj")],
    ["gif", Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00", "latin1")],
    ["empty", Buffer.alloc(0)],
    ["two bytes", Buffer.from([0xff, 0xd8])],
    ["a JPEG cut off before its frame header", jpegBytes(10, 10).subarray(0, 24)],
    ["a PNG cut off", pngBytes(10, 10).subarray(0, 18)],
    ["a zero-sized PNG", pngBytes(0, 0)],
    ["a JPEG with no frame before the scan", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 2, 0, 0])],
  ];
  for (const [name, bytes] of notImages) assert.equal(imageInfo(bytes), null, name);
});

// ---- the migration ---------------------------------------------------------------------------------------

test("migration 12 adds nutrition_photos: a BLOB, the three types, manual or imported, diary logins only", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  run(db, "INSERT INTO users (id, role) VALUES ('u1', 'admin'), ('k', 'kiosk')");
  runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 11));
  assert.deepEqual(runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 12)), [12]);
  const cols = all<{ name: string; type: string }>(db, "SELECT name, type FROM pragma_table_info('nutrition_photos')");
  assert.deepEqual(cols.map((c) => c.name), ["id", "user_id", "taken_on", "mime", "bytes", "width", "height", "source", "created_at", "deleted_at"]);
  assert.equal(cols.find((c) => c.name === "bytes")!.type, "BLOB");
  const insert = (id: string, user: string, mime: string, source = "manual") => run(db,
    "INSERT INTO nutrition_photos (id, user_id, taken_on, mime, bytes, width, height, source, created_at) VALUES (?, ?, '2026-03-01', ?, x'ffd8ff', 1, 1, ?, 'x')", id, user, mime, source);
  insert("p1", "u1", "image/jpeg");
  insert("p2", "u1", "image/png", "import_loseit");
  assert.throws(() => insert("p3", "u1", "image/gif"), /CHECK/);
  assert.throws(() => insert("p4", "u1", "image/webp", "scraped"), /CHECK/);
  assert.throws(() => insert("p5", "k", "image/jpeg"), /only admin and parent/);
  assert.deepEqual(Array.from(get<{ bytes: Uint8Array }>(db, "SELECT bytes FROM nutrition_photos WHERE id = 'p1'")!.bytes), [0xff, 0xd8, 0xff], "the bytes come back exactly");
});

// ---- the routes -------------------------------------------------------------------------------------------

test("upload, list (metadata only), get the bytes, delete -- with the type and size read from the file", async (t) => {
  const api = await newApi(t);
  const jpeg = jpegBytes(1200, 1600, 400);
  const up = await api.call("ann", "POST", "/photos", { data: b64(jpeg), takenOn: YESTERDAY });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.deepEqual(
    [up.body.created, up.body.photo.takenOn, up.body.photo.mime, up.body.photo.width, up.body.photo.height, up.body.photo.source, up.body.photo.size],
    [true, YESTERDAY, "image/jpeg", 1200, 1600, "manual", jpeg.length],
  );
  const id = up.body.photo.id;

  // The date defaults to the person's own today.
  const second = (await api.call("ann", "POST", "/photos", { data: PNG_1X1_BASE64, mime: "image/png" })).body.photo;
  assert.deepEqual([second.takenOn, second.mime], [TODAY, "image/png"]);

  const list = await api.call("ann", "GET", "/photos");
  assert.deepEqual(list.body.map((p: any) => p.id), [second.id, id], "newest day first");
  assert.deepEqual(Object.keys(list.body[0]).sort(), ["createdAt", "height", "id", "mime", "size", "source", "takenOn", "width"], "metadata only");
  assert.equal(JSON.stringify(list.body).includes(b64(jpeg).slice(0, 40)), false);
  assert.deepEqual((await api.call("ann", "GET", `/photos?from=${TODAY}`)).body.map((p: any) => p.id), [second.id]);
  assert.equal((await api.call("ann", "GET", "/photos?to=nope")).status, 400);

  const image = await api.call("ann", "GET", `/photos/${id}/image`);
  assert.equal(image.status, 200);
  assert.ok(Buffer.isBuffer(image.body));
  assert.ok(image.body.equals(jpeg), "the exact bytes come back");

  assert.equal((await api.call("ann", "DELETE", `/photos/${id}`)).status, 200);
  assert.equal((await api.call("ann", "GET", `/photos/${id}/image`)).status, 404);
  assert.equal((await api.call("ann", "DELETE", `/photos/${id}`)).status, 404, "a second delete");
  assert.deepEqual((await api.call("ann", "GET", "/photos")).body.map((p: any) => p.id), [second.id]);
  // Deleting really frees the picture: the row keeps a deleted_at but no bytes.
  const row = get<{ n: number; deleted_at: string }>(api.w.db, "SELECT length(bytes) AS n, deleted_at FROM nutrition_photos WHERE id = ?", id)!;
  assert.deepEqual([row.n, typeof row.deleted_at], [0, "string"]);
});

test("upload is checked: only real JPEG, PNG or WebP, a size cap, clean base64, a believable date, a matching type", async (t) => {
  const api = await newApi(t);
  const post = (body: unknown) => api.call("ann", "POST", "/photos", body);
  const count = () => all(api.w.db, "SELECT 1 FROM nutrition_photos").length;

  assert.equal((await post({ data: b64(Buffer.from("<svg onload=alert(1)/>")) })).status, 400, "an SVG");
  assert.equal((await post({ data: b64(Buffer.from("%PDF-1.4 hello")) })).status, 400, "a PDF");
  assert.equal((await post({ data: b64(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")) })).status, 400, "a GIF");
  assert.equal((await post({ data: b64(pngBytes(100, 100)), mime: "image/jpeg" })).status, 400, "the client's word about the type is checked against the file");
  assert.equal((await post({ data: `data:image/png;base64,${PNG_1X1_BASE64}` })).status, 400, "no data: prefix");
  assert.equal((await post({ data: "not base64!!" })).status, 400);
  assert.equal((await post({ data: PNG_1X1_BASE64.slice(1) })).status, 400, "base64 that is not a whole number of groups");
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ data: "" })).status, 400);
  assert.equal((await post({ data: 5 })).status, 400);
  assert.equal((await post({ data: PNG_1X1_BASE64, takenOn: "2026-03-12" })).status, 400, "a photo can't be from a day that hasn't happened");
  assert.equal((await post({ data: PNG_1X1_BASE64, takenOn: "yesterday" })).status, 400);
  assert.equal((await post({ data: b64(pngBytes(50_000, 10)) })).status, 400, "absurd pixel size");
  assert.equal((await post([])).status, 400);

  const justUnder = jpegBytes(1600, 1200, MAX_PHOTO_BYTES - 1000);
  assert.ok(justUnder.length <= MAX_PHOTO_BYTES);
  assert.equal((await post({ data: b64(justUnder) })).status, 201, "a photo within the cap is kept");
  const tooBig = jpegBytes(1600, 1200, MAX_PHOTO_BYTES + 10);
  const big = await post({ data: b64(tooBig) });
  assert.deepEqual([big.status, /too big/.test(big.body.error)], [413, true]);
  assert.equal(count(), 1, "nothing refused was stored");

  // A client id makes a replay a no-op; another login's id is a 409.
  const first = await api.call("ann", "POST", "/photos", { data: PNG_1X1_BASE64, id: "photo-client-id-1" });
  assert.deepEqual([first.status, first.body.created], [201, true]);
  const replay = await api.call("ann", "POST", "/photos", { data: PNG_1X1_BASE64, id: "photo-client-id-1" });
  assert.deepEqual([replay.status, replay.body.created, replay.body.photo.id], [200, false, "photo-client-id-1"]);
  assert.equal((await api.call("ben", "POST", "/photos", { data: PNG_1X1_BASE64, id: "photo-client-id-1" })).status, 409);
  assert.equal((await api.call("ann", "POST", "/photos", { data: PNG_1X1_BASE64, id: "x" })).status, 400, "ids are 8-64 safe characters");
});

test("PRIVATE: whatever anyone shares, only the owner gets a photo -- every other login, the kiosk and a watch get 404", async (t) => {
  const api = await newApi(t);
  const made = (await api.call("ann", "POST", "/photos", { data: PNG_1X1_BASE64 })).body.photo;
  for (const level of ["nothing", "totals", "everything"]) {
    await api.call("ann", "PUT", "/me/visibility", { visibility: level });
    // Ben reaches nothing of it.
    assert.equal((await api.call("ben", "GET", `/photos/${made.id}/image`)).status, 404, level);
    assert.equal((await api.call("ben", "DELETE", `/photos/${made.id}`)).status, 404, level);
    assert.deepEqual((await api.call("ben", "GET", "/photos")).body, [], `${level}: Ben's own list is empty`);
    // No shared view mentions a photo or its id.
    for (const url of [`/people/${api.w.ids.ann}/day/${TODAY}`, `/people/${api.w.ids.ann}/progress`, "/sharing", "/household/streaks", "/plan/calories"]) {
      const r = await api.call("ben", "GET", url);
      const flat = JSON.stringify(r.body);
      assert.equal(flat.includes(made.id), false, `${level} ${url}`);
      assert.equal(/photo/i.test(flat), false, `${level} ${url} mentions photos`);
    }
    // The kiosk and a watch: 404, not even 403.
    assert.equal((await api.call("kiosk", "GET", `/photos/${made.id}/image`)).status, 404, level);
    assert.equal((await api.call("kiosk", "GET", "/photos")).status, 404, level);
    assert.equal((await api.call("kiosk", "POST", "/photos", { data: PNG_1X1_BASE64 })).status, 404, level);
    assert.equal((await api.call("kiosk", "DELETE", `/photos/${made.id}`)).status, 404, level);
    assert.equal((await api.callDevice("ann", "GET", `/photos/${made.id}/image`)).status, 404, level);
    assert.equal((await api.callDevice("ann", "GET", "/photos")).status, 404, level);
    assert.equal((await api.callDevice("ann", "POST", "/photos", { data: PNG_1X1_BASE64 })).status, 404, level);
    assert.equal((await api.callDevice("ann", "DELETE", `/photos/${made.id}`)).status, 404, level);
  }
  assert.equal((await api.call("ann", "GET", `/photos/${made.id}/image`)).status, 200, "and the owner still has it");
  assert.equal(all(api.w.db, "SELECT 1 FROM nutrition_photos WHERE deleted_at IS NULL").length, 1, "none of those changed anything");
  assert.equal((await api.call("ann", "GET", "/photos/no-such-photo/image")).status, 404);
});
