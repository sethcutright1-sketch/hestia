// custom-foods.csv (Name|UniqueId|Brand|Image|Quantity|Measure|Calories|<nutrients>) -> foods.
//
// A custom food is read the way a food-log row is: its nutrients are TOTALS for `Quantity` x `Measure` (so "29
// Grams" becomes a per-100 g food, and "1 Serving" a per-serving food whose serving is called Serving). Its
// identity is the same `loseit:<name>|<measure>` the food log uses, so a custom food and the history rows that
// mention it are ONE food. Custom foods are imported before the diary so the history finds them.
//
// Who can see it is the import's food-sharing choice (shared with the household by default, "Only me" for
// personal), exactly like the foods made from the food log.

import { define, FoodLibrary, groupKeyOf, sourceRefOf, type FoodGroup } from "./foods.ts";
import type { Ctx } from "./context.ts";
import type { ImportReport } from "./types.ts";

export function importCustomFoods(ctx: Ctx, library: FoodLibrary): ImportReport["customFoods"] {
  const rows = ctx.parsed.customFoods;
  if (!rows) return { rows: 0, created: 0, reused: 0, withoutNutrition: 0 };

  // One food per (name, measure); if the file lists one twice, the later row wins.
  const groups = new Map<string, FoodGroup>();
  for (const r of rows) {
    const usable = r.quantity !== null && r.quantity > 0 && r.calories !== null;
    groups.set(groupKeyOf(r.name, r.measure), {
      key: groupKeyOf(r.name, r.measure),
      name: r.name.trim(),
      units: r.measure.trim(),
      brand: r.brand.trim() || null,
      sourceRef: sourceRefOf(r.name, r.measure),
      def: usable ? define({ quantity: r.quantity, units: r.measure, calories: r.calories, nutrients: r.nutrients }) : null,
    });
  }
  for (const g of groups.values()) library.idFor(g);
  return { rows: rows.length, created: library.created, reused: library.reused, withoutNutrition: library.withoutNutrition };
}
