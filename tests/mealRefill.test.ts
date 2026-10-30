// pickReplacement: which saved recipe takes a denied meal's place. The rules are in mealRefill.ts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pickReplacement, type RefillMeal, type RefillRecipe } from "../mealRefill.ts";

const recipe = (id: string, ingredients: string[], kcalPerServing: number | null = null): RefillRecipe =>
  ({ id, name: id, ingredients, kcalPerServing });
const meal = (id: string, status: string, recipeId?: string, extra: Partial<RefillMeal> = {}): RefillMeal =>
  ({ id, name: recipeId ?? id, recipeId, status, ...extra });

const denied = meal("m1", "denied", "chili");
const base = { denied, planMeals: [denied], members: [], pantry: [] as string[], roomKcal: null as number | null };

describe("pickReplacement", () => {
  test("never picks the denied meal's own recipe", () => {
    const got = pickReplacement({ ...base, recipes: [recipe("chili", [])] });
    assert.equal(got, null);
  });

  test("skips recipes already on the plan, leftovers included, and ones another meal was refused", () => {
    const planMeals = [denied, meal("m2", "proposed", "soup"), { ...meal("m3", "proposed", "pie"), name: "Leftover pie" }, meal("m4", "denied", "stew")];
    const got = pickReplacement({ ...base, planMeals, recipes: [recipe("soup", []), recipe("pie", []), recipe("stew", []), recipe("tacos", [])] });
    assert.equal(got?.id, "tacos");
  });

  test("matches an already-planned recipe by name when the meal has no recipe link", () => {
    const planMeals = [denied, { id: "m2", name: "Soup", status: "proposed" }];
    const got = pickReplacement({ ...base, planMeals, recipes: [recipe("soup", []), recipe("tacos", [])].map((r) => ({ ...r, name: r.id === "soup" ? "soup" : r.name })) });
    assert.equal(got?.id, "tacos");
  });

  test("skips a recipe with an ingredient someone it is for dislikes", () => {
    const members = [{ id: "a", name: "Alice", dislikes: ["mushroom"] }];
    const got = pickReplacement({ ...base, members, recipes: [recipe("stroganoff", ["beef", "mushrooms"]), recipe("tacos", ["beef"])] });
    assert.equal(got?.id, "tacos");
  });

  test("a meal for one person only checks that person's dislikes", () => {
    const members = [{ id: "a", name: "Alice", dislikes: ["mushroom"] }, { id: "b", name: "Bo", dislikes: [] }];
    const forBo = meal("m1", "denied", "chili", { audience: "individual", memberId: "b" });
    const got = pickReplacement({ ...base, denied: forBo, planMeals: [forBo], members, recipes: [recipe("stroganoff", ["mushrooms"])] });
    assert.equal(got?.id, "stroganoff");
  });

  test("prefers the recipe the pantry covers best", () => {
    const got = pickReplacement({ ...base, pantry: ["rice", "beans"], recipes: [recipe("a", ["rice", "kale", "tofu"]), recipe("b", ["rice", "beans"])] });
    assert.equal(got?.id, "b");
  });

  test("stays under the calorie room before it counts pantry coverage", () => {
    const got = pickReplacement({
      ...base, pantry: ["rice"], roomKcal: 500,
      recipes: [recipe("big", ["rice"], 900), recipe("fits", ["kale"], 450)],
    });
    assert.equal(got?.id, "fits");
  });

  test("among equal recipes, takes the calories closest to the room left", () => {
    const got = pickReplacement({ ...base, roomKcal: 500, recipes: [recipe("a", [], 200), recipe("b", [], 480)] });
    assert.equal(got?.id, "b");
  });

  test("a recipe with no calories is not treated as over; no room means calories are ignored", () => {
    assert.equal(pickReplacement({ ...base, roomKcal: 100, recipes: [recipe("a", [], null)] })?.id, "a");
    assert.equal(pickReplacement({ ...base, roomKcal: null, recipes: [recipe("a", [], 9000)] })?.id, "a");
  });

  test("returns null when nothing qualifies", () => {
    assert.equal(pickReplacement({ ...base, recipes: [] }), null);
  });
});
