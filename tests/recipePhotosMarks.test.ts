// Recipe photos and per-person marks (routes/mealplan.ts, nutrition/data/recipePhotos.ts and recipeMarks.ts; nutrition
// migration 14): photos live in the database and follow the recipe's visibility; a favourite star and a 1-5 rating
// belong to one login and are never seen by another.
//   alice, bob  parents   kiosk  the shared kitchen screen

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { PNG_1X1_BASE64, jpegBytes, pngBytes } from "./helpers/images.ts";
import { nutritionSchemaVersion } from "../nutrition/data/schema.ts";

const loaded = await loadDb();
const { createUser, getScopedItems, setConfig, db } = loaded as any;
const { mealPlanRoutes } = await import("../routes/mealplan.ts");

let alice: string, bob: string, kiosk: string;
const as = (userId: string, extra: Record<string, unknown> = {}) => ({ session: { userId, ...extra } });
const call = (method: string, url: string, who: object, body?: unknown) => callRoute(mealPlanRoutes, method, url, { ...who, body });
const b64 = (buf: Buffer) => buf.toString("base64");

function addRecipe(over: Record<string, unknown> = {}) {
  const id = `recipe-${Math.random().toString(16).slice(2, 10)}`;
  const doc = {
    id, name: `Dish ${id}`, ingredients: ["beef"], scope: "joint", createdBy: alice,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lines: [{ text: "2 cups beef", pantryName: "beef" }], ...over,
  };
  db.prepare("INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, ?, ?)").run(id, doc.scope === "personal" ? alice : null, JSON.stringify(doc));
  return doc as any;
}
const recipeRow = (id: string) => (getScopedItems("recipes", alice) as any[]).find((r) => r.id === id);
const photoRows = (id: string) => db.prepare("SELECT * FROM nutrition_recipe_photos WHERE recipe_id = ?").all(id) as any[];

before(() => {
  alice = createUser("alice-rp", "not-a-real-hash", "Alice", "parent");
  bob = createUser("bob-rp", "not-a-real-hash", "Bob", "parent");
  kiosk = createUser("kiosk-rp", "not-a-real-hash", "Kitchen", "kiosk");
});
after(cleanupDb);
beforeEach(() => {
  db.exec("DELETE FROM recipes; DELETE FROM nutrition_recipe_photos; DELETE FROM nutrition_recipe_marks");
  setConfig("lock_pin_hash", null);
});

test("migration 14 is applied", () => {
  assert.ok(nutritionSchemaVersion(db) >= 14);
});

describe("recipe photos", () => {
  test("a photo is stored in the database, read back with its type, and the recipe records when", async () => {
    const r = addRecipe();
    const put = await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: PNG_1X1_BASE64 });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.ok(put.body.recipe.photoAt);
    assert.equal(recipeRow(r.id).photoAt, put.body.recipe.photoAt);
    assert.equal(photoRows(r.id).length, 1);
    const got = await call("GET", `/recipes/${r.id}/photo`, as(bob));
    assert.equal(got.status, 200);
    assert.equal(got.headers?.["content-type"], "image/png");
    assert.equal(got.headers?.["cache-control"], "private, no-cache");
    assert.equal(Buffer.from(got.body).toString("base64"), PNG_1X1_BASE64);
  });

  test("the bytes never go into the recipe document", async () => {
    const r = addRecipe();
    await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: PNG_1X1_BASE64 });
    assert.ok(!JSON.stringify(recipeRow(r.id)).includes(PNG_1X1_BASE64.slice(0, 20)));
    const plan = await call("GET", "/", as(alice));
    assert.ok(!JSON.stringify(plan.body).includes(PNG_1X1_BASE64.slice(0, 20)));
  });

  test("a second photo replaces the first; delete removes it and clears photoAt", async () => {
    const r = addRecipe();
    await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: PNG_1X1_BASE64 });
    const jpg = b64(jpegBytes(640, 480, 200));
    const second = await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: jpg, mime: "image/jpeg" });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(photoRows(r.id).length, 1);
    assert.equal(photoRows(r.id)[0].mime, "image/jpeg");
    const gone = await call("DELETE", `/recipes/${r.id}/photo`, as(alice));
    assert.equal(gone.status, 200);
    assert.equal(gone.body.recipe.photoAt, undefined);
    assert.equal(photoRows(r.id).length, 0);
    assert.equal((await call("GET", `/recipes/${r.id}/photo`, as(alice))).status, 404);
  });

  test("refuses what is not a small picture: wrong type 400, too big 413, wrong mime 400, huge in pixels 400, not base64 400", async () => {
    const r = addRecipe();
    assert.equal((await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: b64(Buffer.from("<svg></svg>")) })).status, 400);
    assert.equal((await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: b64(pngBytes(100, 100, 1.2 * 1024 * 1024)) })).status, 413);
    assert.equal((await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: PNG_1X1_BASE64, mime: "image/jpeg" })).status, 400);
    assert.equal((await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: b64(pngBytes(9000, 9000)) })).status, 400);
    assert.equal((await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: "data:image/png;base64,AAAA" })).status, 400);
    assert.equal(photoRows(r.id).length, 0);
  });

  test("a personal recipe's photo is a 404 to anyone else, for reading and writing", async () => {
    const mine = addRecipe({ scope: "personal" });
    await call("PUT", `/recipes/${mine.id}/photo`, as(alice), { data: PNG_1X1_BASE64 });
    assert.equal((await call("GET", `/recipes/${mine.id}/photo`, as(alice))).status, 200);
    assert.equal((await call("GET", `/recipes/${mine.id}/photo`, as(bob))).status, 404);
    assert.equal((await call("PUT", `/recipes/${mine.id}/photo`, as(bob), { data: PNG_1X1_BASE64 })).status, 404);
    assert.equal((await call("DELETE", `/recipes/${mine.id}/photo`, as(bob))).status, 404);
    assert.equal(photoRows(mine.id).length, 1);
  });

  test("the kiosk can see a joint recipe's photo but needs the PIN to change one", async () => {
    const r = addRecipe();
    await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: PNG_1X1_BASE64 });
    setConfig("lock_pin_hash", "set");
    assert.equal((await call("GET", `/recipes/${r.id}/photo`, as(kiosk))).status, 200);
    assert.equal((await call("PUT", `/recipes/${r.id}/photo`, as(kiosk), { data: PNG_1X1_BASE64 })).status, 423);
    assert.equal((await call("DELETE", `/recipes/${r.id}/photo`, as(kiosk))).status, 423);
    assert.equal(photoRows(r.id).length, 1);
  });

  test("a recipe with no photo is a 404; deleting the recipe deletes its photo", async () => {
    const r = addRecipe();
    assert.equal((await call("GET", `/recipes/${r.id}/photo`, as(alice))).status, 404);
    await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: PNG_1X1_BASE64 });
    assert.equal((await call("DELETE", `/recipes/${r.id}`, as(alice))).status, 200);
    assert.equal(photoRows(r.id).length, 0);
  });

  test("a duplicate starts with a copy of the photo", async () => {
    const r = addRecipe();
    await call("PUT", `/recipes/${r.id}/photo`, as(alice), { data: PNG_1X1_BASE64 });
    const copy = await call("POST", `/recipes/${r.id}/duplicate`, as(bob));
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    assert.ok(copy.body.recipe.photoAt);
    assert.equal(photoRows(copy.body.recipe.id).length, 1);
    assert.equal(photoRows(r.id).length, 1, "the original keeps its own");
  });
});

describe("per-person marks", () => {
  test("a favourite and a rating are saved for the caller and come back with the plan", async () => {
    const r = addRecipe();
    const res = await call("PUT", `/recipes/${r.id}/mark`, as(alice), { favorite: true, rating: 4 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.mark, { favorite: true, rating: 4 });
    const plan = await call("GET", "/", as(alice));
    assert.deepEqual(plan.body.marks[r.id], { favorite: true, rating: 4 });
  });

  test("they belong to one login: bob never sees alice's, and has his own", async () => {
    const r = addRecipe();
    await call("PUT", `/recipes/${r.id}/mark`, as(alice), { favorite: true, rating: 5 });
    assert.deepEqual((await call("GET", "/", as(bob))).body.marks, {});
    await call("PUT", `/recipes/${r.id}/mark`, as(bob), { rating: 2 });
    assert.deepEqual((await call("GET", "/", as(bob))).body.marks[r.id], { favorite: false, rating: 2 });
    assert.deepEqual((await call("GET", "/", as(alice))).body.marks[r.id], { favorite: true, rating: 5 });
  });

  test("what the request leaves out is kept; null clears a rating; nothing set removes the row", async () => {
    const r = addRecipe();
    await call("PUT", `/recipes/${r.id}/mark`, as(alice), { favorite: true, rating: 3 });
    assert.deepEqual((await call("PUT", `/recipes/${r.id}/mark`, as(alice), { rating: null })).body.mark, { favorite: true, rating: null });
    assert.deepEqual((await call("PUT", `/recipes/${r.id}/mark`, as(alice), { favorite: false })).body.mark, { favorite: false, rating: null });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nutrition_recipe_marks").get().n, 0);
  });

  test("bad values are 400s; a recipe you cannot see is a 404; the kiosk is refused (403)", async () => {
    const r = addRecipe();
    for (const body of [{ rating: 6 }, { rating: 2.5 }, { rating: "great" }, { favorite: "yes" }]) {
      assert.equal((await call("PUT", `/recipes/${r.id}/mark`, as(alice), body)).status, 400, JSON.stringify(body));
    }
    const secret = addRecipe({ scope: "personal" });
    assert.equal((await call("PUT", `/recipes/${secret.id}/mark`, as(bob), { favorite: true })).status, 404);
    assert.equal((await call("PUT", `/recipes/${r.id}/mark`, as(kiosk), { favorite: true })).status, 403);
    assert.deepEqual((await call("GET", "/", as(kiosk))).body.marks, {});
  });

  test("deleting the recipe deletes everyone's marks on it", async () => {
    const r = addRecipe();
    await call("PUT", `/recipes/${r.id}/mark`, as(alice), { favorite: true });
    await call("PUT", `/recipes/${r.id}/mark`, as(bob), { rating: 5 });
    await call("DELETE", `/recipes/${r.id}`, as(alice));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nutrition_recipe_marks").get().n, 0);
  });
});
