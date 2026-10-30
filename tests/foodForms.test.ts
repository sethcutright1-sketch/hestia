// What the Food section's forms send (src/sections/food/forms.ts): Quick add, Create food (including the
// "Only me" switch and how per-serving / per-100 g facts become servings) and the Exercise form. The
// create-food and quick-add bodies are also run through the real routes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { newApi } from "./helpers/nutritionApi.ts";
import { TODAY } from "./helpers/nutritionWorld.ts";
import {
  buildCreateFood, buildExercise, buildQuickAdd, emptyCreateFood, exerciseLine, optionalNumber, type CreateFoodForm,
} from "../src/sections/food/forms.ts";

describe("optionalNumber", () => {
  test("blank is nothing, a number is a value, junk or negative is bad", () => {
    assert.equal(optionalNumber(""), null);
    assert.equal(optionalNumber("  "), null);
    assert.equal(optionalNumber("12.5"), 12.5);
    assert.equal(optionalNumber("0"), 0);
    assert.equal(optionalNumber("-1"), "bad");
    assert.equal(optionalNumber("abc"), "bad");
  });
});

describe("buildQuickAdd", () => {
  test("only calories are required", () => {
    assert.deepEqual(buildQuickAdd({ kcal: "250", name: "", protein: "", carbs: "", fat: "" }, "snacks", "id-12345678"),
      { ok: true, body: { slot: "snacks", id: "id-12345678", source: "quick", kcal: 250 } });
    const bad = buildQuickAdd({ kcal: "", name: "x", protein: "", carbs: "", fat: "" }, "snacks", "id-12345678");
    assert.deepEqual(bad, { ok: false, error: "Enter the calories." });
  });
  test("name and macros ride along when given; a bad macro is named", () => {
    assert.deepEqual(buildQuickAdd({ kcal: "300", name: " Pizza slice ", protein: "12", carbs: "35", fat: "0" }, "dinner", "id-12345678"),
      { ok: true, body: { slot: "dinner", id: "id-12345678", source: "quick", kcal: 300, name: "Pizza slice", protein: 12, carbs: 35, fat: 0 } });
    const bad = buildQuickAdd({ kcal: "300", name: "", protein: "lots", carbs: "", fat: "" }, "dinner", "id-12345678");
    assert.deepEqual(bad, { ok: false, error: "Protein must be a number, or left empty." });
  });
  test("is accepted by the diary and is idempotent on its client id", async (t) => {
    const api = await newApi(t);
    const built = buildQuickAdd({ kcal: "250", name: "Cake", protein: "3", carbs: "", fat: "" }, "snacks", "quick-0000-0001");
    assert.ok(built.ok);
    const first = await api.call("ann", "POST", `/diary/${TODAY}`, built.body);
    assert.deepEqual([first.status, first.body.entry.name, first.body.entry.nutrients.kcal, first.body.entry.source], [201, "Cake", 250, "quick"]);
    const replay = await api.call("ann", "POST", `/diary/${TODAY}`, built.body);
    assert.deepEqual([replay.status, replay.body.summary.eaten], [200, 250]);
  });
});

const form = (over: Partial<CreateFoodForm> = {}): CreateFoodForm => ({ ...emptyCreateFood(), name: "Granola", nutrients: { kcal: "450" }, ...over });

describe("buildCreateFood", () => {
  test("a new food is shared with the household by default; the 'Only me' switch makes it personal", () => {
    const shared = buildCreateFood(form());
    assert.ok(shared.ok);
    assert.equal(shared.body.scope, "joint");
    const mine = buildCreateFood(form({ onlyMe: true }));
    assert.ok(mine.ok);
    assert.equal(mine.body.scope, "personal");
  });

  test("name and calories are required", () => {
    assert.deepEqual(buildCreateFood(form({ name: "  " })), { ok: false, error: "Give the food a name." });
    assert.deepEqual(buildCreateFood(form({ nutrients: {} })), { ok: false, error: "Enter the calories from the label." });
    assert.deepEqual(buildCreateFood(form({ nutrients: { kcal: "450", protein: "x" } })), { ok: false, error: "Protein must be a number, or left empty." });
  });

  test("per serving: one serving, named or '1 serving', with its weight if known", () => {
    const plain = buildCreateFood(form());
    assert.ok(plain.ok);
    assert.deepEqual(plain.body.servings, [{ label: "1 serving", grams: null }]);
    const named = buildCreateFood(form({ servingLabel: "1 bar", servingGrams: "50" }));
    assert.ok(named.ok);
    assert.deepEqual(named.body.servings, [{ label: "1 bar", grams: 50 }]);
    assert.deepEqual(buildCreateFood(form({ servingGrams: "0" })), { ok: false, error: "The serving weight must be a number above 0, or left empty." });
  });

  test("per 100 g: the 100 g row is the default unless a named serving with a weight is added", () => {
    const only = buildCreateFood(form({ basis: "per100g" }));
    assert.ok(only.ok);
    assert.deepEqual(only.body.servings, [{ label: "100 g", grams: 100, isDefault: true }]);
    const extra = buildCreateFood(form({ basis: "per100g", servingLabel: "1 cup", servingGrams: "80" }));
    assert.ok(extra.ok);
    assert.deepEqual(extra.body.servings, [{ label: "100 g", grams: 100, isDefault: false }, { label: "1 cup", grams: 80, isDefault: true }]);
    const nameOnly = buildCreateFood(form({ basis: "per100g", servingLabel: "1 cup" }));
    assert.ok(nameOnly.ok);
    assert.equal(nameOnly.body.servings.length, 1, "a serving name with no weight can't be used");
  });

  test("the barcode is checked and stored in its 14-digit form; brand and unset nutrients default sensibly", () => {
    const ok = buildCreateFood(form({ barcode: "016000275287", brand: " Acme " }));
    assert.ok(ok.ok);
    assert.equal(ok.body.gtin14, "00016000275287");
    assert.equal(ok.body.brand, "Acme");
    assert.equal(ok.body.nutrients.protein, 0);
    assert.equal(ok.body.nutrients.kcal, 450);
    assert.match((buildCreateFood(form({ barcode: "123" })) as { error: string }).error, /isn't valid/);
    const none = buildCreateFood(form());
    assert.ok(none.ok);
    assert.equal("gtin14" in none.body, false);
    assert.equal("brand" in none.body, false);
  });

  test("the server accepts every shape, and the scope lands as asked", async (t) => {
    const api = await newApi(t);
    const shapes = [
      form(), form({ onlyMe: true, name: "Mine" }), form({ basis: "per100g", name: "Per100" }),
      form({ basis: "per100g", servingLabel: "1 cup", servingGrams: "80", name: "Cup" }), form({ barcode: "016000275287", name: "Coded" }),
    ];
    for (const f of shapes) {
      const built = buildCreateFood(f);
      assert.ok(built.ok, f.name);
      const res = await api.call("ann", "POST", "/foods", built.body);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.scope, f.onlyMe ? "personal" : "joint", f.name);
    }
    // the other login sees the shared ones, not the personal one
    const names = (await api.call("ben", "GET", "/foods/search?q=granola")).body.map((x: any) => x.name);
    assert.deepEqual(names, ["Granola"]);
    assert.deepEqual((await api.call("ben", "GET", "/foods/search?q=mine")).body, []);
  });
});

describe("buildExercise", () => {
  test("name and calories burned are required, minutes are optional", () => {
    assert.deepEqual(buildExercise({ name: " Run ", minutes: "30", kcal: "300" }), { ok: true, body: { name: "Run", minutes: 30, kcal: 300 } });
    assert.deepEqual(buildExercise({ name: "Yoga", minutes: "", kcal: "120" }), { ok: true, body: { name: "Yoga", minutes: null, kcal: 120 } });
    assert.deepEqual(buildExercise({ name: "", minutes: "", kcal: "120" }), { ok: false, error: "Give the exercise a name." });
    assert.deepEqual(buildExercise({ name: "Run", minutes: "", kcal: "" }), { ok: false, error: "Enter the calories burned." });
    assert.deepEqual(buildExercise({ name: "Run", minutes: "x", kcal: "100" }), { ok: false, error: "Minutes must be a number, or left empty." });
  });
  test("limits match the server's", () => {
    assert.equal(buildExercise({ name: "Run", minutes: "", kcal: "20001" }).ok, false);
    assert.equal(buildExercise({ name: "Run", minutes: "1441", kcal: "10" }).ok, false);
    assert.equal(buildExercise({ name: "Run", minutes: "1440", kcal: "20000" }).ok, true);
  });
  test("exerciseLine", () => {
    assert.equal(exerciseLine({ name: "Run", minutes: 30, kcal: 300 }), "Run - 30 min - 300 kcal burned");
    assert.equal(exerciseLine({ name: "Yoga", minutes: null, kcal: 1200 }), "Yoga - 1,200 kcal burned");
  });
});
