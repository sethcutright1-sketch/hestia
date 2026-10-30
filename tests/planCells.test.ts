// nutrition/planCells.ts: the pure rules for moving a planned meal to another day + meal. The server (PUT
// /api/mealplan/meals/:id) and the Meal Plan screen's Move control share them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { cellRank, checkMoveCell, dayIndex, moveChoices, slotKindOf, type CellMeal } from "../nutrition/planCells.ts";

const m = (id: string, day: string, slot: string, over: Partial<CellMeal> = {}): CellMeal => ({ id, day, slot, status: "approved", audience: "family", ...over });

test("slot kinds: standard keys are themselves, custom meals are read by what they sound like", () => {
  assert.deepEqual(["breakfast", "lunch", "dinner", "snacks"].map(slotKindOf), ["breakfast", "lunch", "dinner", "snacks"]);
  assert.deepEqual(["brunch", "midday-bite", "supper", "pre-workout"].map(slotKindOf), ["breakfast", "lunch", "dinner", "snacks"]);
});

test("cell ranks order the week by day, then breakfast, lunch, dinner, snacks; days match any casing", () => {
  assert.ok(cellRank("Monday", "snacks") < cellRank("Tuesday", "breakfast"));
  assert.ok(cellRank("Tuesday", "lunch") < cellRank("Tuesday", "dinner"));
  assert.equal(dayIndex("  sunday "), 6);
  assert.equal(dayIndex("Funday"), -1);
});

test("a move to where the meal already is is no move; an unknown day or missing meal is refused", () => {
  const meal = m("a", "Monday", "dinner");
  assert.equal(checkMoveCell([meal], meal, "Monday", "dinner"), null);
  assert.match(checkMoveCell([meal], meal, "Someday", "dinner")!, /day of the week/);
  assert.match(checkMoveCell([meal], meal, "Tuesday", "")!, /Pick a meal/);
  assert.equal(checkMoveCell([meal], meal, "Tuesday", "lunch"), null);
});

test("a cell with a meal for the same audience is taken (any status); a family meal and a person's own meal can share one", () => {
  const family = m("a", "Monday", "dinner");
  const other = m("b", "Tuesday", "dinner");
  const denied = m("c", "Wednesday", "dinner", { status: "denied" });
  const meals = [family, other, denied];
  assert.match(checkMoveCell(meals, family, "Tuesday", "dinner", (k) => k.toUpperCase())!, /Tuesday dinner already has a meal/);
  assert.match(checkMoveCell(meals, family, "Wednesday", "dinner")!, /already has a meal/, "a denied meal still fills the cell the grid draws");

  const sam = m("s", "Monday", "lunch", { audience: "individual", memberId: "sam" });
  const kid = m("k", "Tuesday", "dinner", { audience: "individual", memberId: "kid" });
  const sam2 = m("s2", "Friday", "dinner", { audience: "individual", memberId: "sam" });
  const all = [family, other, sam, kid, sam2];
  assert.equal(checkMoveCell(all, sam, "Monday", "dinner"), null, "Sam's own meal can sit beside the family dinner");
  assert.equal(checkMoveCell(all, sam, "Tuesday", "dinner"), null, "...and beside another person's meal");
  assert.match(checkMoveCell(all, sam, "Friday", "dinner")!, /already has a meal/, "but not on top of Sam's other meal");
});

test("a leftover stays a later lunch or dinner than its original", () => {
  const pot = m("pot", "Monday", "dinner");
  const left = m("left", "Wednesday", "lunch", { leftoverOf: "pot" });
  const meals = [pot, left];
  assert.equal(checkMoveCell(meals, left, "Thursday", "dinner"), null);
  assert.equal(checkMoveCell(meals, left, "Tuesday", "lunch"), null);
  assert.match(checkMoveCell(meals, left, "Monday", "lunch")!, /later meal than the one they come from \(Monday dinner\)/);
  assert.match(checkMoveCell(meals, left, "Monday", "dinner")!, /already has a meal|later meal/);
  assert.match(checkMoveCell(meals, left, "Thursday", "breakfast")!, /lunch or dinner/);
  assert.match(checkMoveCell(meals, left, "Thursday", "snacks")!, /lunch or dinner/);
});

test("a meal with leftovers can't move to or past its earliest live leftover; a denied leftover doesn't hold it", () => {
  const pot = m("pot", "Monday", "dinner");
  const l1 = m("l1", "Wednesday", "lunch", { leftoverOf: "pot" });
  const l2 = m("l2", "Friday", "dinner", { leftoverOf: "pot" });
  const meals = [pot, l1, l2];
  assert.equal(checkMoveCell(meals, pot, "Tuesday", "dinner"), null);
  assert.match(checkMoveCell(meals, pot, "Wednesday", "lunch")!, /already has a meal/, "the leftover's own cell is a taken cell");
  assert.match(checkMoveCell(meals, pot, "Wednesday", "dinner")!, /leftovers on Wednesday lunch/);
  assert.match(checkMoveCell(meals, pot, "Thursday", "dinner")!, /Move the leftovers first/);
  const freed = [pot, { ...l1, status: "denied" }, l2];
  assert.equal(checkMoveCell(freed, pot, "Thursday", "dinner"), null, "only the Friday leftover is live now");
});

test("moveChoices lists every cell the meal may go to, in week order, without its own cell", () => {
  const pot = m("pot", "Monday", "dinner");
  const left = m("left", "Wednesday", "lunch", { leftoverOf: "pot" });
  const other = m("o", "Tuesday", "lunch");
  const choices = moveChoices([pot, left, other], left, ["lunch", "dinner"]);
  assert.deepEqual(choices.map((c) => `${c.day} ${c.slot}`), ["Tuesday dinner", "Wednesday dinner", "Thursday lunch", "Thursday dinner", "Friday lunch", "Friday dinner", "Saturday lunch", "Saturday dinner", "Sunday lunch", "Sunday dinner"]);
  const free = moveChoices([pot, other], other, ["breakfast", "lunch"]);
  assert.equal(free.length, 7 * 2 - 1);
  assert.ok(!free.some((c) => c.day === "Tuesday" && c.slot === "lunch"));
});
