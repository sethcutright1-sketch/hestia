// The recipe line editor's pure pieces (src/sections/mealplan/recipeLines.ts), and the real recipe routes driven with
// exactly the requests the editor builds: match, link, change the amount, unlink, and the yield form.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi } from "./helpers/nutritionApi.ts";
import { addGeneric, customFood } from "./helpers/nutritionWorld.ts";
import { saveRecipe } from "../nutrition/data/recipes.ts";
import type { Line, RecipeDoc } from "../nutrition/recipeModel.ts";
import { computeAmount, startAmount } from "../src/sections/food/amount.ts";
import {
  caloriesHeadline, lineAmountText, lineStatus, linkBody, parsedText, startFor, statusText, summarize, summaryText, unlinkBody, usableFoods,
  yieldBody, yieldChanged, yieldFormOf, type MatchLine, type RecipeDetail, type RecipeLineDetail,
} from "../src/sections/mealplan/recipeLines.ts";
import type { Food } from "../src/sections/food/types.ts";

after(cleanupDb);

const line = (over: Partial<RecipeLineDetail> = {}): RecipeLineDetail => ({
  index: 0, text: "2 cups flour", pantryName: "flour", foodName: null, kcal: null, negligible: false, ...over,
});

describe("how a line is worded", () => {
  test("the amount the reader found", () => {
    const p = { quantity: 2, unit: "cup", name: "flour", negligible: false, via: "regex" as const };
    assert.equal(parsedText(p), "2 cup flour");
    assert.equal(parsedText({ ...p, quantity: 1.25, unit: null, name: "onions" }), "1.3 onions");
    assert.equal(parsedText({ ...p, quantity: null, unit: null }), "no amount found (flour)");
    assert.equal(parsedText({ ...p, negligible: true }), "a pinch or a splash: counts as nothing");
    assert.equal(parsedText(undefined), "");
  });

  test("status: linked, broken link, AI estimate, a pinch, or not linked", () => {
    assert.equal(lineStatus(line({ foodId: "f", kcal: 200 })), "linked");
    assert.equal(lineStatus(line({ foodId: "f", kcal: null })), "broken", "the food is gone or the amount no longer fits");
    assert.equal(lineStatus(line({ estimated: true, estimatedKcal: 120, kcal: 120 })), "estimate");
    assert.equal(lineStatus(line({ negligible: true })), "negligible");
    assert.equal(lineStatus(line()), "none");
    assert.equal(statusText(line({ foodId: "f", foodName: "Flour", grams: 250, kcal: 910 })), "Flour · 250 g · 910 kcal");
    assert.equal(statusText(line({ foodId: "f", foodName: "Bar", quantity: 2, kcal: 400 })), "Bar · 2 servings · 400 kcal");
    assert.equal(statusText(line({ estimated: true, estimatedKcal: 120 })), "AI estimate · about 120 kcal");
    assert.equal(statusText(line()), "not linked");
    assert.match(statusText(line({ foodId: "f", foodName: "Flour", kcal: null })), /can't be used any more/);
    assert.equal(lineAmountText(line({ quantity: 1 })), "1 serving");
  });

  test("the summary counts each kind once and says so", () => {
    const lines = [
      line({ foodId: "a", kcal: 1 }), line({ foodId: "b", kcal: 2 }), line({ estimated: true, estimatedKcal: 5 }),
      line({}), line({ foodId: "c", kcal: null }), line({ negligible: true }),
    ];
    const s = summarize(lines);
    assert.deepEqual(s, { total: 6, linked: 2, estimated: 1, unlinked: 2, negligible: 1 });
    assert.equal(summaryText(s), "2 linked · 1 AI estimate · 2 not linked · 1 not counted");
    assert.equal(summaryText(summarize([line({ foodId: "a", kcal: 1 })])), "1 linked");
  });

  test("calories: partly estimated until nothing is estimated or unlinked; the website's figure sits beside the calculated one", () => {
    const perServing = { kcal: 489.6 } as any;
    assert.deepEqual(caloriesHeadline({ nutrition: undefined, kcalPerServing: null }), { main: "no calories yet", partly: null, site: null, origin: null });
    assert.deepEqual(caloriesHeadline({ nutrition: { perServing, origin: "mixed", complete: false, siteKcalPerServing: 520 }, kcalPerServing: 489.6 }), {
      main: "490 kcal per serving", partly: "calories partly estimated", site: "website says 520", origin: "added up from the linked foods and AI estimates",
    });
    const done = caloriesHeadline({ nutrition: { perServing, origin: "calculated", complete: true }, kcalPerServing: 489.6 });
    assert.deepEqual([done.partly, done.site, done.origin], [null, null, "added up from the linked foods"]);
    const site = caloriesHeadline({ nutrition: { perServing, origin: "site", complete: false, siteKcalPerServing: 490 }, kcalPerServing: 490 });
    assert.deepEqual([site.partly, site.site, site.origin], [null, null, "from the website"], "a site figure is the page's own number, not an estimate");
  });
});

describe("requests", () => {
  test("link bodies carry the food and one kind of amount; unlink clears", () => {
    assert.deepEqual(linkBody(2, "f1", { grams: 150 }), { links: [{ index: 2, foodId: "f1", grams: 150 }] });
    assert.deepEqual(linkBody(0, "f1", { quantity: 2, servingId: "s1" }), { links: [{ index: 0, foodId: "f1", quantity: 2, servingId: "s1" }] });
    assert.deepEqual(linkBody(0, "f1", { quantity: 2 }), { links: [{ index: 0, foodId: "f1", quantity: 2 }] });
    assert.deepEqual(unlinkBody(3), { links: [{ index: 3, clear: true }] });
  });

  test("search results leave out recipes, and personal foods for a joint recipe", () => {
    const f = (id: string, over: Partial<Food>) => ({ id, source: "custom", scope: "joint", ...over }) as Food;
    const foods = [f("a", {}), f("b", { scope: "personal" }), f("c", { source: "recipe" }), f("d", { scope: "generic" })];
    assert.deepEqual(usableFoods(foods, "joint").map((x) => x.id), ["a", "d"]);
    assert.deepEqual(usableFoods(foods, "personal").map((x) => x.id), ["a", "b", "d"], "a personal recipe may use the person's own foods; a recipe is never an ingredient");
  });

  test("the yield form: numbers within the server's limits, an empty cooked weight clears it", () => {
    const form = (y: string, l = "", g = "") => ({ yieldServings: y, servingLabel: l, totalCookedG: g });
    assert.deepEqual(yieldBody(form("4", " bowl ", "1200")), { body: { yieldServings: 4, servingLabel: "bowl", totalCookedG: 1200 } });
    assert.deepEqual(yieldBody(form("2.5")), { body: { yieldServings: 2.5, servingLabel: "", totalCookedG: null } });
    for (const bad of [form(""), form("0"), form("1001"), form("x"), form("4", "x".repeat(41)), form("4", "", "0"), form("4", "", "abc"), form("4", "", "100001")]) {
      assert.ok("error" in yieldBody(bad), JSON.stringify(bad));
    }
    const recipe = { yieldServings: 4, servingLabel: "bowl", totalCookedG: undefined };
    assert.deepEqual(yieldFormOf(recipe), form("4", "bowl", ""));
    assert.equal(yieldChanged(form("4", "bowl", ""), recipe), false);
    assert.equal(yieldChanged(form(" 4 ", " bowl ", ""), recipe), false);
    assert.equal(yieldChanged(form("5", "bowl", ""), recipe), true);
    assert.equal(yieldFormOf({ yieldServings: null, servingLabel: undefined, totalCookedG: 900 }).yieldServings, "");
  });
});

describe("the editor against the real recipe routes", () => {
  const L = (text: string, pantryName: string, over: Partial<Line> = {}): Line => ({ text, pantryName, ...over });

  test("match, link at the amount the sheet worked out, change it, unlink: the calories follow and the pantry names never change", async (t) => {
    const api = await newApi(t);
    const flour = addGeneric(api.w.db, "Flour", 364);
    const oil = (await api.call("ann", "POST", "/foods", customFood("Olive oil", 120))).body;
    const t0 = "2026-03-01T00:00:00.000Z";
    const doc: RecipeDoc = saveRecipe(api.w.db, api.w.ids.ann, {
      id: "r-lines", name: "Flatbread", ingredients: [], scope: "joint", createdBy: api.w.ids.ann, createdAt: t0, updatedAt: t0,
      yieldServings: 4, lines: [L("250 g flour", "flour"), L("1 olive oil", "olive oil"), L("a pinch of salt", "salt")],
    });

    // The reader and the matches.
    const m = (await api.call("ann", "POST", `/recipes/${doc.id}/match`, {})).body.lines as MatchLine[];
    assert.deepEqual(m.map((l) => parsedText(l.parsed)), ["250 g flour", "1 olive oil", "a pinch or a splash: counts as nothing"]);
    assert.equal(m[0].candidates[0].foodId, flour);
    assert.equal(m[0].candidates[0].amount?.grams, 250);

    // Nothing linked yet: "no calories yet".
    let d: RecipeDetail = (await api.call("ann", "GET", `/recipes/${doc.id}`)).body;
    assert.equal(caloriesHeadline(d).main, "no calories yet");
    assert.deepEqual(d.lines.map((l) => lineStatus(l)), ["none", "none", "negligible"]);

    // Link the flour at the proposed amount, as the sheet does: startAmount from the candidate, computeAmount, linkBody.
    const flourFood = (await api.call("ann", "GET", `/foods/${flour}`)).body as Food;
    const start = startFor(flourFood, m[0].candidates[0].amount);
    const computed = computeAmount(flourFood, start)!;
    d = (await api.call("ann", "POST", `/recipes/${doc.id}/links`, linkBody(0, flour, computed.body))).body;
    assert.deepEqual([d.lines[0].foodName, d.lines[0].kcal, lineAmountText(d.lines[0])], ["Flour", 910, "250 g"]);
    assert.equal(caloriesHeadline(d).main, "228 kcal per serving", "910 kcal over 4 servings");
    assert.equal(caloriesHeadline(d).partly, "calories partly estimated", "the olive oil line is still unlinked");

    // The oil, by one serving; now every counted line is linked.
    const oilFood = (await api.call("ann", "GET", `/foods/${oil.id}`)).body as Food;
    d = (await api.call("ann", "POST", `/recipes/${doc.id}/links`, linkBody(1, oil.id, computeAmount(oilFood, startAmount(oilFood, null))!.body))).body;
    assert.deepEqual(summarize(d.lines), { total: 3, linked: 2, estimated: 0, unlinked: 0, negligible: 1 });
    assert.equal(caloriesHeadline(d).partly, null, "no estimated or unlinked line remains");
    assert.equal(caloriesHeadline(d).main, "258 kcal per serving");

    // Change the amount of the flour to 500 g.
    d = (await api.call("ann", "POST", `/recipes/${doc.id}/links`, linkBody(0, flour, { grams: 500 }))).body;
    assert.equal(d.lines[0].kcal, 1820);
    assert.equal(caloriesHeadline(d).main, "485 kcal per serving");

    // Unlink the oil: back to partly.
    d = (await api.call("ann", "POST", `/recipes/${doc.id}/links`, unlinkBody(1))).body;
    assert.deepEqual([lineStatus(d.lines[1]), d.lines[1].text], ["none", "1 olive oil"]);
    assert.equal(caloriesHeadline(d).partly, "calories partly estimated");

    // Pantry matching reads `ingredients`, and linking never touches it.
    assert.deepEqual(d.ingredients, ["flour", "olive oil", "salt"]);
    assert.deepEqual(d.lines.map((l) => l.pantryName), ["flour", "olive oil", "salt"]);

    // The yield form's body is accepted as it is, and the calories follow the servings.
    const out = yieldBody({ yieldServings: "2", servingLabel: "flatbread", totalCookedG: "600" });
    assert.ok("body" in out);
    const put = await api.call("ann", "PUT", `/recipes/${doc.id}`, (out as any).body);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual([put.body.yieldServings, put.body.servingLabel, put.body.totalCookedG, put.body.kcalPerServing], [2, "flatbread", 600, 910]);
    const cleared = await api.call("ann", "PUT", `/recipes/${doc.id}`, (yieldBody({ yieldServings: "2", servingLabel: "", totalCookedG: "" }) as any).body);
    assert.deepEqual([cleared.status, cleared.body.totalCookedG, cleared.body.servingLabel], [200, undefined, "serving"], "an empty cooked weight clears it; an empty name puts the default back");
  });

  test("the other login can edit a joint recipe's lines, but a personal food is refused in a joint recipe", async (t) => {
    const api = await newApi(t);
    const mine = (await api.call("ann", "POST", "/foods", customFood("Secret shake", 300, { scope: "personal" }))).body;
    const t0 = "2026-03-01T00:00:00.000Z";
    const doc = saveRecipe(api.w.db, api.w.ids.ann, {
      id: "r-share", name: "Shared dish", ingredients: [], scope: "joint", createdBy: api.w.ids.ann, createdAt: t0, updatedAt: t0, yieldServings: 2, lines: [L("1 shake", "shake")],
    });
    const refused = await api.call("ann", "POST", `/recipes/${doc.id}/links`, linkBody(0, mine.id, { quantity: 1 }));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /personal food/);
    const shared = (await api.call("ben", "POST", "/foods", customFood("Oats", 150))).body;
    const ok = await api.call("ben", "POST", `/recipes/${doc.id}/links`, linkBody(0, shared.id, { quantity: 1 }));
    assert.deepEqual([ok.status, ok.body.kcalPerServing], [200, 75]);
  });
});
