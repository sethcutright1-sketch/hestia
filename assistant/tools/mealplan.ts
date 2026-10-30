// Meal-plan and recipe tools. See ./README.md for the contract every domain module follows.

import type { DomainTool, ToolModule } from "../registry.ts";
import { db as appDb, getScopedItems, putScopedItem, deleteScopedItem, newId } from "../../db.ts";
import { ensureJointRecipe, saveDishAsRecipe } from "../../nutrition/data/recipes.ts";
import { listMarks } from "../../nutrition/data/recipeMarks.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { cleanInstructions, cleanTags } from "../../nutrition/recipeModel.ts";
import { planSlotOptions } from "../../nutrition/data/planSlots.ts";
import { getRecipeModel } from "../../nutrition/recipeAi.ts";
import type { ShoppingList } from "../../routes/grocery.ts";
import { listMembers } from "../../routes/members.ts";
import {
  DAYS,
  pantryNames,
  buildMealPlan,
  listMealRequests,
  addMissingToList,
  normalizeDay,
  normalizeSlot,
  mondayOf,
  replaceDeniedMeal,
  type MealPlan,
  type PlannedMeal,
  type Recipe,
  type MealRequest,
} from "../../routes/mealplan.ts";
import { commitPlanChange } from "../../routes/mealplanDiary.ts";
import { serverToday, isValidLocalDate, dayOfWeek, addDays } from "../../nutrition/dates.ts";
import { computeMissing, findDislikeConflicts } from "../../ingredients.ts";
import { cleanNames, findByName, closestNames, suggestNames, notFound } from "./shared.ts";

// Asked to "keep it random", a model will cheerfully save seven meals all called
// "Random Meal" -- it names the instruction instead of the dish, and the plan is
// then useless to cook or shop from even though the ingredients came out fine.
// The prompt and the tool schemas both say not to; this is the backstop that
// makes it impossible rather than unlikely, since the error comes back as text
// the model can read and retry from.
//
// Deliberately a short, anchored list rather than anything clever: it only has
// to catch a name that describes the choosing or the slot, and a real dish is
// never called any of these. A human typing a name in the UI is not run through
// this -- what they choose to call their own dinner is their business.
const PLACEHOLDER_NAMES = [
  "random", "random meal", "randommeal", "surprise", "surprise me", "anything",
  "meal", "a meal", "dish", "food", "dinner", "lunch", "breakfast", "tbd", "n/a",
];

function placeholderNameError(name: unknown): string | null {
  const trimmed = String(name ?? "").trim().toLowerCase();
  const bare = trimmed.replace(/^(a|an|the)\s+/, "").replace(/\s*\d+$/, "");
  if (PLACEHOLDER_NAMES.includes(trimmed) || PLACEHOLDER_NAMES.includes(bare)) {
    return `"${String(name).trim()}" is not a dish. Pick an actual meal and name it, ` +
      `e.g. "Chicken fajitas" -- being asked to choose at random tells you how to ` +
      `choose, not what to call it.`;
  }
  return null;
}

// What a model types into list_recipes's query when it means "everything" (compared trimmed and lowercased).
const ALL_RECIPES_WORDS = new Set(["*", "all", "any", "everything", "recipes", "saved", "all recipes", "saved recipes"]);

// Words set_meal_status accepts for `day` besides a weekday name or a date: days from today.
const RELATIVE_DAYS: Record<string, number> = { today: 0, tonight: 0, tomorrow: 1, yesterday: -1 };

function mealPlanTools(userId: string): DomainTool[] {
  // The assistant works for the shared plan, so it only ever sees JOINT recipes: a personal recipe's
  // name must not end up on a meal plan everyone reads.
  const recipes = () => (getScopedItems("recipes", userId) as Recipe[]).filter((r) => r.scope !== "personal");
  // The household's meals: the four standard ones plus any custom meal a diary login has ("brunch").
  const slotKeys = planSlotOptions(appDb).map((o) => o.key);
  const slotHelp = `One of: ${slotKeys.join(", ")}. Dinner is assumed when it is anything else.`;

  // Never the model's word for it: what's missing and what clashes with someone's
  // dislikes are worked out here from stored rows, then handed back for the model
  // to report. It supplies the ideas; the facts come from the database.
  const summarize = (plan: MealPlan) => ({
    weekStart: plan.weekStart,
    mealCount: plan.meals.length,
    missingIngredients: computeMissing(plan.meals, pantryNames(userId)),
    dislikeConflicts: findDislikeConflicts(plan.meals, listMembers(userId)),
  });

  // Which plan a plan tool means. The Meal Plan screen pages between weeks, so "the most recently edited plan" (what
  // currentPlan returns) is as likely to be NEXT week as this one, and "deny tonight's dinner" then changed next week's
  // Tuesday. The assistant now works on the week containing today unless told otherwise: `dateInWeek` (a date the
  // caller gave) wins, then `week`, then today. A week with no plan is an error that lists the weeks that do have one,
  // rather than silently falling back to another week.
  const planForWeek = (
    week: unknown,
    dateInWeek?: string
  ): { plan: MealPlan } | { error: string; weeksWithPlans?: string[]; hint?: string } => {
    const given = typeof week === "string" ? week.trim() : "";
    const monday = mondayOf(dateInWeek || given || serverToday());
    if (!monday) return { error: `week must be a date like 2026-10-19 (any day in the week you mean), not "${given}".` };
    const plans = getScopedItems("meal_plans", userId) as MealPlan[];
    const found = plans.find((p) => p.weekStart === monday);
    if (found) return { plan: found };
    if (plans.length === 0) return { error: "No meal plan saved yet." };
    return {
      error: `No meal plan is saved for the week of ${monday}${given || dateInWeek ? "" : " (this week)"}.`,
      // The latest ten, oldest first: enough to pick from without a year of history in the reply.
      weeksWithPlans: plans.map((p) => p.weekStart).sort().slice(-10),
      hint: "Ask which week they mean, or call again with week set to one of weeksWithPlans (any date in that week works).",
    };
  };
  const WEEK_PARAM = {
    type: "string",
    description:
      "Which week, as any date inside it (YYYY-MM-DD). Optional; defaults to this week, the one containing today. " +
      "Omit for this week (Monday-Sunday, the week containing today, even on a Sunday).",
  };

  return [
    {
      name: "list_recipes",
      description:
        "Meals the household has saved and can be planned again. Pass query to search by name, " +
        "ingredient or tag instead of listing everything. Leave query out to list every recipe. " +
        "A recipe's tags and whether the person you are talking to has marked it a favourite are shown when it has them.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Matches recipe name, an ingredient or a tag, e.g. "chicken" or "quick". Optional.' },
        },
      },
      run: async ({ query }) => {
        // This login's own favourites only (per person: the assistant works as the person it is talking to).
        const marks = listMarks(appDb, userId);
        const entry = (r: Recipe) => ({
          name: r.name,
          ingredients: r.ingredients,
          caloriesPerServing: r.nutrition ? Math.round(r.nutrition.perServing.kcal) : null,
          // Only when present (the keys are left out, not undefined), so a recipe with neither is exactly what it was
          // before and adds nothing to a small model's prompt.
          ...(r.tags && r.tags.length > 0 ? { tags: r.tags } : {}),
          ...(marks[r.id]?.favorite ? { favorite: true } : {}),
        });
        const all = recipes();
        const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
        // Models pass "*" or "all" meaning "everything", the substring filter then matched nothing, and they told the
        // user there were no recipes (which sank "plan the week"). These words are never a real search for a dish.
        if (!needle || ALL_RECIPES_WORDS.has(needle)) return all.map(entry);

        const matches = all.filter(
          (r) => r.name.toLowerCase().includes(needle) || r.ingredients.some((i) => i.toLowerCase().includes(needle)) || (r.tags ?? []).some((t) => t.includes(needle))
        );
        if (matches.length > 0 || all.length === 0) return matches.map(entry);
        // A real search that found nothing: say so, but hand over the whole book too, so "no match" cannot be mistaken
        // for "no recipes". The one case that is not a bare array; every match (and the no-query list) still is.
        return {
          matches: [],
          note: `No recipe matched "${String(query).trim()}". That does not mean there are no recipes. All saved recipes: ${all.map((r) => r.name).join(", ")}.`,
          recipes: all.map(entry),
        };
      },
    },

    {
      // The one place the method is handed over: list_recipes stays short on purpose (a whole book of steps
      // would swamp a small local model's prompt), so "how do I make the lasagna?" is a lookup by name.
      name: "get_recipe",
      description:
        "One saved recipe in full: its ingredients (with amounts where known), how many servings it makes, " +
        "calories per serving, prep and cook time, tags, notes, the asker's own rating and favourite, and the " +
        "step-by-step instructions if it has any. Use this when someone asks how " +
        "to make a meal or what goes in it. If it has no instructions saved, say so rather than inventing steps " +
        "as if they were the household's own; you may offer a method but label it as a suggestion.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The recipe's name, as in list_recipes or on the meal plan." },
        },
        required: ["name"],
      },
      run: async ({ name }) => {
        const list = recipes();
        const found = findByName(list, String(name ?? ""));
        if (!found) return notFound("recipe", String(name ?? ""), closestNames(list, String(name ?? "")));
        const lines = (found.lines ?? []).map((l) => l.text).filter(Boolean);
        const n = found.nutrition;
        const mark = listMarks(appDb, userId)[found.id];
        return {
          name: found.name,
          ingredients: lines.length > 0 ? lines : found.ingredients,
          servings: found.yieldServings ?? null,
          caloriesPerServing: n ? Math.round(n.perServing.kcal) : null,
          caloriesPartlyEstimated: n ? !n.complete : undefined,
          instructions: found.instructions && found.instructions.length > 0 ? found.instructions : null,
          source: found.sourceUrl,
          // Each only when it has a value (left out, not undefined); the rating and favourite are the asker's own,
          // never another login's.
          ...(found.prepMinutes ? { prepMinutes: found.prepMinutes } : {}),
          ...(found.cookMinutes ? { cookMinutes: found.cookMinutes } : {}),
          ...(found.tags && found.tags.length > 0 ? { tags: found.tags } : {}),
          ...(found.notes ? { notes: found.notes } : {}),
          ...(mark?.rating ? { yourRating: mark.rating } : {}),
          ...(mark?.favorite ? { yourFavorite: true } : {}),
        };
      },
    },

    {
      name: "list_meal_requests",
      description:
        "Meals someone has asked for that haven't been worked into a plan yet. Check this " +
        "before calling create_meal_plan and try to include them.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const members = listMembers(userId);
        return listMealRequests(userId).map((r) => ({
          id: r.id,
          name: r.name,
          notes: r.notes,
          requestedBy: r.memberId ? members.find((m) => m.id === r.memberId)?.name : undefined,
        }));
      },
    },

    {
      name: "add_meal_request",
      mutates: true,
      // Told "add these to the meal plan", the model called this four times
      // instead of create_meal_plan, so five proposed dinners landed on the
      // wish-list and the plan stayed empty -- and it then described the plan
      // back to the user as though it had been saved. The names are genuinely
      // close, so the description has to draw the line rather than rely on it
      // being obvious.
      description:
        "Add a dish to the wish-list of meals to consider in some LATER plan. This does " +
        "NOT put anything on the meal plan. If the user wants meals on the plan -- " +
        '"add these to the meal plan", "plan my week" -- use create_meal_plan instead.',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: 'The dish, e.g. "Tacos".' },
          notes: { type: "string", description: "Anything else about the request. Optional." },
          member: { type: "string", description: "Who's asking, by name. Optional." },
        },
        required: ["name"],
      },
      run: async ({ name, notes, member }) => {
        const dish = String(name || "").trim();
        if (!dish) return { error: "A meal request needs a name." };

        const members = listMembers(userId);
        const matchedMember = member ? findByName(members, member) : undefined;
        if (member && !matchedMember) return notFound("family member", member, closestNames(members, member));

        const now = new Date().toISOString();
        const request: MealRequest = {
          id: newId("mealreq"),
          name: dish,
          notes: typeof notes === "string" ? notes.trim() : "",
          memberId: matchedMember?.id,
          scope: "joint",
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        };
        putScopedItem("meal_requests", userId, request);
        return { requested: request.name, for: matchedMember?.name };
      },
    },

    {
      name: "remove_meal_request",
      mutates: true,
      description: "Clear a meal request, e.g. once it's been added to a plan or is no longer wanted.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The requested meal to clear." } },
        required: ["name"],
      },
      run: async ({ name }) => {
        const requests = listMealRequests(userId);
        // Deleting: exact name only, so "Tacos" cannot clear "Tacos al pastor".
        const found = findByName(requests, name, { exact: true });
        if (!found) return notFound("meal request", name, suggestNames(requests, name));

        deleteScopedItem("meal_requests", userId, found.id);
        return { cleared: found.name };
      },
    },

    {
      name: "save_recipe",
      mutates: true,
      description:
        "Save a meal so it can be reused in later plans. Updates it if the name exists. Its calories are " +
        "worked out automatically from the ingredient amounts, so give amounts whenever you can " +
        "(\"200 g chicken breast\", \"2 cups cooked rice\") and say how many servings it makes.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'The dish, e.g. "Chicken fajitas". Must name the actual food -- never a ' +
              'placeholder like "Random Meal", "Dinner" or "Meal 1", even if the user ' +
              "asked you to pick at random.",
          },
          ingredients: {
            type: "array",
            items: { type: "string" },
            description:
              'Ingredients, with the amount where you know it, e.g. ["400 g chicken breast", ' +
              '"2 cups cooked rice", "2 peppers", "olive oil"]. A bare name is fine when there is no amount.',
          },
          servings: {
            type: "number",
            description: "How many servings the dish makes, e.g. 4. Optional; 4 is assumed (and flagged) if left out.",
          },
          instructions: {
            type: "array",
            items: { type: "string" },
            description: "How to make it, one step per entry, in order. Optional; leave it out to keep any steps the recipe already has.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: 'Short labels, e.g. ["quick", "crockpot"]. Optional; added to any tags the recipe already has.',
          },
        },
        required: ["name", "ingredients"],
      },
      run: async ({ name, ingredients, servings, instructions, tags }) => {
        const badName = placeholderNameError(name);
        if (badName) return { error: badName };

        const cleaned = cleanNames(ingredients);
        if (cleaned.length === 0) return { error: "A recipe needs at least one ingredient." };

        const steps = cleanInstructions(instructions);
        const yieldServings = typeof servings === "number" && Number.isFinite(servings) && servings >= 1 && servings <= 100 ? Math.round(servings) : undefined;

        // One recipe book: the dish is saved as lines (what was written + the pantry name matching uses),
        // then its calories are worked out -- foods linked where the match is clearly right, the local
        // model's estimate for the rest, flagged as an estimate. Joint only: it is for the shared plan.
        // (create_meal_plan saves each of its dishes through this same function.)
        const { recipe, note } = await saveDishAsRecipe(appDb, userId, { name: String(name), ingredients: cleaned, yieldServings, instructions: steps.length > 0 ? steps : undefined, tags: cleanTags(tags) }, getRecipeModel());
        const n = recipe.nutrition;
        return {
          saved: recipe.name,
          ingredients: recipe.ingredients,
          servings: recipe.yieldServings ?? null,
          steps: recipe.instructions?.length ?? 0,
          servingsAssumed: recipe.yieldAssumed === true || undefined,
          caloriesPerServing: n ? Math.round(n.perServing.kcal) : null,
          caloriesPartlyEstimated: n ? !n.complete : undefined,
          note,
        };
      },
    },

    {
      name: "create_meal_plan",
      mutates: true,
      description:
        "Save a week of meals. Plan freely -- do not limit dishes to what is in the pantry, " +
        "and do not try to work out what needs buying: this reports back which ingredients " +
        "are missing after checking the pantry itself. Replaces any existing plan for the same week. " +
        "Every dish is also saved as a joint recipe (the same way save_recipe does, with its calories worked " +
        "out from the ingredients, so give amounts like \"200 g chicken breast\" when you can). " +
        "Meals start as proposed; once a person approves one it goes into the food diaries of the people it is for.",
      parameters: {
        type: "object",
        properties: {
          weekStart: { type: "string", description: "The Monday this plan covers, as YYYY-MM-DD." },
          meals: {
            type: "array",
            description: "One entry per meal. A full week is 21: breakfast, lunch and dinner for each day.",
            items: {
              type: "object",
              properties: {
                day: { type: "string", description: 'e.g. "Monday".' },
                slot: { type: "string", description: slotHelp },
                name: {
                  type: "string",
                  description:
                    'The dish, e.g. "Chicken fajitas". Must name the actual food -- never a ' +
                    'placeholder like "Random Meal", "Dinner" or "Meal 1", even if the user ' +
                    "asked you to pick at random, and vary it across the week.",
                },
                ingredients: {
                  type: "array",
                  items: { type: "string" },
                  description: 'Ingredients, with the amount where you know it, e.g. ["400 g chicken breast", "2 cups cooked rice", "olive oil"].',
                },
                servings: {
                  type: "number",
                  description: "How many servings the dish makes (4 is assumed, and flagged, when left out). Leftovers are worked out from this.",
                },
                audience: {
                  type: "string",
                  description:
                    '"family" (default) or "individual". Use "individual" only for a day/slot where ' +
                    "list_calendar_events shows one member eating separately -- everyone else still gets " +
                    "a normal family meal for that same day/slot.",
                },
                member: {
                  type: "string",
                  description: 'Whose meal this is, by name. Required when audience is "individual".',
                },
              },
              required: ["day", "slot", "name", "ingredients"],
            },
          },
          keepOtherDays: {
            type: "boolean",
            description:
              "When true, only the days present in meals are replaced; every other day of that week's existing plan " +
              "is kept exactly as it is (if no plan exists for the week yet, one is created). Use it to save a week " +
              "one day at a time. Omit it (or false) to replace the whole week with meals.",
          },
        },
        required: ["weekStart", "meals"],
      },
      run: async ({ weekStart, meals, keepOtherDays }) => {
        // Unlike the malformed rows skipped below, a placeholder name fails the
        // whole call. It isn't one bad entry -- it means the dishes were never
        // chosen, so dropping those rows would save an emptier plan than the user
        // asked for and say nothing about why. Erroring hands the model something
        // it can act on while the week is still intact.
        const placeholders = (Array.isArray(meals) ? meals : [])
          .map((m: any) => placeholderNameError(m?.name))
          .filter((e): e is string => e !== null);
        if (placeholders.length > 0) return { error: placeholders[0] };

        const members = listMembers(userId);
        // Skip malformed entries rather than failing the whole week: a local model
        // dropping one of twenty-one meals shouldn't cost the user the other twenty.
        // A day that isn't one of the seven weekdays is dropped, not defaulted --
        // unlike slot below, there's no sensible fallback day, and guessing one
        // would put a meal on the wrong night.
        const usable = (Array.isArray(meals) ? meals : [])
          .filter((m: any) => m && m.name && normalizeDay(m.day))
          .slice(0, 30);

        // Every planned meal points at a joint recipe (merge plan decision 2). The same dish on several days is
        // saved once. A recipe the household already has under that name is used as it is -- the plan must not
        // rewrite a real recipe from the model's guess at its ingredients -- otherwise the dish is saved the way
        // save_recipe saves it (lines, foods linked where clearly right, a flagged estimate for the rest).
        const model = getRecipeModel();
        const dishes = new Map<string, { recipe: Recipe; usedIngredients: string[] }>();
        for (const m of usable) {
          const key = String(m.name).trim().toLowerCase();
          if (dishes.has(key)) continue;
          const given = cleanNames(m.ingredients);
          const servings = typeof m.servings === "number" && Number.isFinite(m.servings) && m.servings >= 1 && m.servings <= 100 ? Math.round(m.servings) : undefined;
          try {
            const made = await ensureJointRecipe(appDb, userId, { name: String(m.name).trim(), ingredients: given, yieldServings: servings }, model);
            dishes.set(key, { recipe: made.recipe, usedIngredients: made.recipe.ingredients.length > 0 ? made.recipe.ingredients : given });
          } catch (err) {
            if (!(err instanceof NutritionError)) throw err;
            return { error: `Couldn't save "${String(m.name).trim()}" as a recipe: ${err.message}` };
          }
        }

        const cleaned: PlannedMeal[] = usable.map((m: any) => {
          const wantsIndividual = String(m.audience || "").trim().toLowerCase() === "individual";
          const matchedMember = wantsIndividual ? findByName(members, m.member || "") : undefined;
          const dish = dishes.get(String(m.name).trim().toLowerCase())!;
          return {
            id: newId("meal"),
            day: normalizeDay(m.day) as string,
            slot: normalizeSlot(m.slot) ?? "dinner",
            name: dish.recipe.name,
            ingredients: dish.usedIngredients,
            recipeId: dish.recipe.id,
            status: "proposed" as const,
            // Falls back to family if "individual" was requested but the named
            // member doesn't exist -- an unassignable meal shouldn't silently
            // vanish from the plan.
            audience: matchedMember ? ("individual" as const) : ("family" as const),
            memberId: matchedMember?.id,
          };
        });

        if (cleaned.length === 0) {
          // The model called this with meals:[] three times in a row and then
          // asked the user which meals to plan, rather than choosing any. The
          // old wording ("No usable meals -- each needs a day, a slot and a
          // name") described the shape without saying whose job it is to fill
          // it, so say that outright: an error the model can act on beats an
          // error that is merely accurate.
          return {
            error:
              "No meals were supplied. Choosing the dishes is your job, not the user's -- " +
              "do not ask them which meals to cook. Call this again with meals filled in: " +
              'one entry per meal, each with day, slot, name and ingredients, e.g. ' +
              '{"day":"Monday","slot":"dinner","name":"Chicken fajitas","ingredients":["chicken","peppers"]}.',
          };
        }

        const monday = mondayOf(weekStart);
        if (!monday) {
          return { error: "weekStart must be a date like 2026-08-24." };
        }

        const existing = (getScopedItems("meal_plans", userId) as MealPlan[]).find(
          (p) => p.weekStart === monday
        );
        // keepOtherDays: only the days named in this call are replaced. Used by "Plan the week", which saves one day per
        // call -- the local model's tool-call parser (Ollama's gemma4) drops a call as long as a whole week's 21 meals but
        // reads a day's three every time. A kept day is not touched at all (same meal objects: ids, statuses, approvals,
        // and so the diary entries an approval created stay). A replaced day goes exactly as a full replace sends it: its
        // old meals leave the plan and their still-planned diary entries go with them (logged entries stay). A leftover
        // meal on a kept day whose original was on a replaced day goes too -- as it does when its original is deleted by
        // hand -- rather than being left pointing at a meal that no longer exists.
        const merging = keepOtherDays === true && !!existing;
        let planMeals = cleaned;
        let removedMeals = existing?.meals;
        if (merging) {
          const replacedDays = new Set(cleaned.map((m) => m.day));
          const replacedIds = new Set(existing!.meals.filter((m) => replacedDays.has(m.day)).map((m) => m.id));
          removedMeals = existing!.meals.filter((m) => replacedIds.has(m.id) || (m.leftoverOf !== undefined && replacedIds.has(m.leftoverOf)));
          const gone = new Set(removedMeals.map((m) => m.id));
          const kept = existing!.meals.filter((m) => !gone.has(m.id));
          // Week order, so the plan reads Monday to Sunday however the days were saved; the sort is stable, so meals
          // within a day keep their order.
          planMeals = [...kept, ...cleaned].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
        }
        const plan = buildMealPlan(userId, monday, planMeals, existing);
        // The new meals are all proposed, so the only diary work is removing what the replaced meals had put there
        // that is still only planned (logged entries stay).
        commitPlanChange(userId, plan, [], members, { removedMeals });
        const daysSaved = DAYS.filter((d) => cleaned.some((m) => m.day === d));
        return {
          ...summarize(plan),
          // Which days this call put meals on, and (so a day-by-day save can see what is left) which days now have any.
          daysSaved,
          daysWithMeals: DAYS.filter((d) => plan.meals.some((m) => m.day === d)),
        };
      },
    },

    {
      name: "get_meal_plan",
      description:
        "The household's current meal plan, with which meals were denied and what's missing. " +
        "It is this week's plan unless week says otherwise.",
      parameters: { type: "object", properties: { week: WEEK_PARAM } },
      run: async ({ week }) => {
        const resolved = planForWeek(week);
        if ("error" in resolved) return resolved;
        const plan = resolved.plan;
        const members = listMembers(userId);
        return {
          ...summarize(plan),
          meals: plan.meals.map((m) => ({
            // The id is what set_meal_status takes to point at exactly one meal when a slot holds several.
            id: m.id,
            day: m.day,
            slot: m.slot,
            name: m.name,
            status: m.status,
            audience: m.audience || "family",
            member: m.memberId ? members.find((mem) => mem.id === m.memberId)?.name : undefined,
            hasRecipe: !!m.recipeId,
            leftover: m.leftoverOf ? true : undefined,
          })),
        };
      },
    },

    {
      name: "set_meal_status",
      mutates: true,
      description:
        "Approve or deny one meal in the plan. Denied meals stop counting toward the shopping list. " +
        "Approving a meal puts it in the food diary of everyone it is for (as a planned entry they confirm " +
        "by logging it); denying or un-approving it takes those planned entries out again. A meal needs a recipe to be approved. " +
        "A day and slot can hold more than one meal (a family meal plus one person's own, or leftovers): then say which " +
        "with meal (the dish name), member, or id from get_meal_plan. If it still can't tell which, it changes nothing and lists them. " +
        "It works on this week's plan unless week (any date in the week) says otherwise.",
      parameters: {
        type: "object",
        properties: {
          day: { type: "string", description: "e.g. \"Tuesday\". A date (YYYY-MM-DD) also works and picks that date's week." },
          slot: { type: "string", description: slotHelp },
          status: { type: "string", description: "approved, denied, or proposed to undo." },
          week: WEEK_PARAM,
          meal: { type: "string", description: "The dish name, to pick one meal when the slot holds several. Optional." },
          member: { type: "string", description: "Whose meal: \"family\" for the shared one, or a family member's name for their own. Optional." },
          id: { type: "string", description: "The meal's id from get_meal_plan. Optional; points at exactly one meal." },
        },
        required: ["day", "slot", "status"],
      },
      run: async ({ day: dayArg, slot, status, meal: dish, member, id, week }) => {
        // A date for `day` is the most specific thing the caller can say, so its week wins over `week` and today.
        // "today", "tonight", "tomorrow" and "yesterday" are turned into that date first (eval #53: gemma sent
        // day:"today"), so they behave exactly like a date: tomorrow on a Sunday lands in next week's plan, and today
        // is never "already past".
        const dayText = String(dayArg ?? "").trim();
        const aliasOffset = RELATIVE_DAYS[dayText.toLowerCase()];
        const dayDate = aliasOffset !== undefined ? addDays(serverToday(), aliasOffset) : isValidLocalDate(dayText) ? dayText : undefined;
        const day = aliasOffset !== undefined ? `${dayText} (${dayDate})` : dayArg;
        if (!dayDate && !normalizeDay(dayText)) {
          return {
            error: `day must be a weekday name like "Tuesday", a date like 2026-10-19, or today, tonight, tomorrow or yesterday -- not "${dayText}". Nothing was changed.`,
          };
        }
        // `week` that contradicts a resolved word/date is ignored (the date wins); say so rather than do it silently.
        const givenWeek = typeof week === "string" ? week.trim() : "";
        const weekNote =
          dayDate && givenWeek && mondayOf(givenWeek) && mondayOf(givenWeek) !== mondayOf(dayDate)
            ? `week ${givenWeek} was ignored: ${dayText} is ${dayDate}, in the week of ${mondayOf(dayDate)}.`
            : undefined;
        // An id from get_meal_plan points at one meal in one plan: find that plan, so a model that read next week's
        // plan and forgot to repeat `week` does not get "no such id" from this week's.
        const idText = typeof id === "string" ? id.trim() : "";
        const plansWithId =
          idText && !dayDate && !(typeof week === "string" && week.trim())
            ? (getScopedItems("meal_plans", userId) as MealPlan[]).find((p) => p.meals.some((m) => m.id === idText))
            : undefined;
        // A day NAME with no week means that day of the week containing today. If that day is already past, the person
        // almost certainly means the coming one (gemma4:12b denied last Monday's dinner for "deny tomorrow's" on a
        // Sunday, when tomorrow is in next week). Change nothing and say which date to retry with. Skipped when the
        // caller was deliberate: a week, a date or an id.
        const weekGiven = typeof week === "string" && week.trim() !== "";
        const dayName = normalizeDay(dayText);
        if (!weekGiven && !dayDate && !plansWithId && dayName) {
          const today = serverToday();
          const thisMonday = mondayOf(today);
          const targetDate = thisMonday ? addDays(thisMonday, DAYS.indexOf(dayName)) : undefined;
          if (thisMonday && targetDate && targetDate < today) {
            const nextMonday = addDays(thisMonday, 7);
            return {
              error: `${dayName} ${targetDate} is already past, so nothing was changed. If you meant the coming ${dayName} (${addDays(nextMonday, DAYS.indexOf(dayName))}), call again with week ${nextMonday}.`,
              hint: `For the past ${dayName}, pass week ${thisMonday}.`,
            };
          }
        }
        const resolved = plansWithId ? { plan: plansWithId } : planForWeek(week, dayDate);
        if ("error" in resolved) return resolved;
        const plan = resolved.plan;

        const wanted = String(status).trim().toLowerCase();
        if (wanted !== "approved" && wanted !== "denied" && wanted !== "proposed") {
          return { error: "status must be approved, denied or proposed." };
        }

        const targetDay = (dayDate ? DAYS[(dayOfWeek(dayDate) + 6) % 7] : dayText).toLowerCase();
        const targetSlot = String(slot).trim().toLowerCase();
        const members = listMembers(userId);
        const describe = (m: PlannedMeal) => ({
          id: m.id,
          name: m.name,
          for: (m.audience ?? "family") === "individual" ? members.find((x) => x.id === m.memberId)?.name ?? "one person" : "family",
          status: m.status,
          leftover: m.leftoverOf ? true : undefined,
        });

        // Exactly one meal, never "whichever is first" (the project notes 10.15): a slot can hold a family meal, a
        // person's own meal and leftovers. An id is unambiguous; otherwise day + slot, narrowed by dish name and/or
        // whose it is, and anything still ambiguous (or matching nothing) changes NOTHING and lists the candidates.
        let meal: PlannedMeal | undefined;
        if (typeof id === "string" && id.trim()) {
          meal = plan.meals.find((m) => m.id === id.trim());
          if (!meal) return { error: `No meal in the plan has the id "${id.trim()}". Use get_meal_plan to see the ids.` };
          if (meal.day.toLowerCase() !== targetDay || meal.slot !== targetSlot) {
            return { error: `That id is the ${meal.slot} on ${meal.day}, not the ${slot} on ${day}. Nothing was changed.`, meal: describe(meal) };
          }
        } else {
          let candidates = plan.meals.filter((m) => m.day.toLowerCase() === targetDay && m.slot === targetSlot);
          if (candidates.length === 0) return { error: `No ${slot} planned for ${day}.` };

          if (typeof dish === "string" && dish.trim()) {
            const needle = dish.trim().toLowerCase();
            const exact = candidates.filter((m) => m.name.trim().toLowerCase() === needle);
            const narrowed = exact.length > 0 ? exact : candidates.filter((m) => m.name.toLowerCase().includes(needle));
            if (narrowed.length === 0) {
              return { error: `No meal called "${dish}" is planned for ${day} ${slot}. Nothing was changed.`, candidates: candidates.map(describe) };
            }
            candidates = narrowed;
          }
          if (typeof member === "string" && member.trim()) {
            const who = member.trim().toLowerCase();
            let narrowed: PlannedMeal[];
            if (["family", "everyone", "everybody", "all", "the family", "whole family"].includes(who)) {
              narrowed = candidates.filter((m) => (m.audience ?? "family") === "family");
            } else {
              const person = findByName(members, member);
              if (!person) return notFound("family member", member, closestNames(members, member));
              narrowed = candidates.filter((m) => (m.audience ?? "family") === "individual" && m.memberId === person.id);
            }
            if (narrowed.length === 0) {
              return { error: `No ${member} meal is planned for ${day} ${slot}. Nothing was changed.`, candidates: candidates.map(describe) };
            }
            candidates = narrowed;
          }
          if (candidates.length > 1) {
            return {
              error: `More than one meal is planned for ${day} ${slot}, so nothing was changed. Say which one: give its dish name (meal), who it is for (member), or its id.`,
              candidates: candidates.map(describe),
            };
          }
          meal = candidates[0];
        }

        if (wanted === "approved" && meal.status !== "approved" && !meal.recipeId) {
          return { error: `"${meal.name}" has no recipe yet, so it can't be approved. It needs one picked or created in the Meal Plan screen first.` };
        }

        const prev: PlannedMeal = { ...meal };
        meal.status = wanted as PlannedMeal["status"];
        plan.updatedAt = new Date().toISOString();
        let sync;
        try {
          sync = commitPlanChange(userId, plan, [{ prev, next: meal }], listMembers(userId));
        } catch (err) {
          if (err instanceof NutritionError) return { error: err.message };
          throw err;
        }

        return {
          day: meal.day, slot: meal.slot, name: meal.name, status: meal.status,
          note: weekNote,
          // Who now has it planned in their food diary (names only), and anything worth telling the user.
          inFoodDiariesOf: sync.created.length ? sync.created.map((c) => c.name) : undefined,
          diaryNote: sync.note ?? sync.skipped[0]?.reason,
          ...summarize(plan),
        };
      },
    },

    {
      name: "replace_denied_meal",
      mutates: true,
      description:
        "Fill the slot of a DENIED meal with a different saved recipe. The recipe is chosen here, not by you: it skips " +
        "recipes already on the plan or already refused and any with an ingredient someone it is for dislikes, and prefers " +
        "one the pantry covers that fits the day's calories. The new meal is proposed (not approved), for the same day, slot " +
        "and person; the denied meal and its leftovers are removed. Only for a meal that is denied: use set_meal_status to " +
        "deny it first if the person has not. Pass the meal's id from get_meal_plan. If nothing fits it changes nothing and says so.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The denied meal's id from get_meal_plan." },
        },
        required: ["id"],
      },
      run: async ({ id }) => {
        const mealId = typeof id === "string" ? id.trim() : "";
        if (!mealId) return { error: "id is required: the denied meal's id from get_meal_plan." };
        const plan = (getScopedItems("meal_plans", userId) as MealPlan[]).find((p) => p.meals.some((m) => m.id === mealId));
        if (!plan) return { error: `No meal in any plan has the id "${mealId}". Use get_meal_plan to see the ids.` };
        const was = plan.meals.find((m) => m.id === mealId)!;

        let out;
        try {
          out = replaceDeniedMeal(userId, plan, mealId);
        } catch (err) {
          if (err instanceof NutritionError) return { error: err.message };
          throw err;
        }
        if (!out.ok) return { error: out.error, nothingChanged: true };

        return {
          replaced: was.name,
          day: out.meal.day,
          slot: out.meal.slot,
          now: out.meal.name,
          status: out.meal.status,
          ...summarize(plan),
        };
      },
    },

    {
      name: "add_missing_ingredients_to_list",
      mutates: true,
      description:
        "Put the meal plan's missing ingredients onto a shopping list. Only call this once the " +
        "user has clearly said to. The items are worked out here -- do not pass them in. " +
        "They come from this week's plan unless week says otherwise.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", description: "Which shopping list to add to." },
          week: WEEK_PARAM,
        },
        required: ["list"],
      },
      run: async ({ list, week }) => {
        const resolved = planForWeek(week);
        if ("error" in resolved) return resolved;
        const plan = resolved.plan;

        if (computeMissing(plan.meals, pantryNames(userId)).length === 0) {
          return { error: "Nothing is missing -- the pantry covers this plan." };
        }

        // Not archived, rather than === "active": a list saved before status
        // existed has none, and the Grocery tab treats it as a normal list.
        const lists = (getScopedItems("shopping_lists", userId) as ShoppingList[]).filter(
          (l) => l.status !== "archived"
        );
        // Exact list name, as in add_shopping_item: a partial one must not pick the first list containing it.
        const found = findByName(lists, list, { exact: true });
        if (!found) return notFound("shopping list", list, suggestNames(lists, list));

        const { added, alreadyOnList } = addMissingToList(userId, plan, found);
        return { added, alreadyOnList, to: found.name };
      },
    },
  ];
}

export const mealPlanModule: ToolModule = {
  domain: "mealplan",
  sensitivity: "household",
  label: "meal plans",
  promptRules: [
    // Weeks run Monday to Sunday, so on a Sunday the week containing today is the one ending tonight. gemma4:12b read
    // the prompt's "next week starts Mon ..." line on a Sunday and passed next week's date for "the meal plan" and
    // "plan dinner tonight", filling the wrong week. Leaving week out is always right for these: it is the tools' default.
    "Meal plan weeks run Monday to Sunday. \"The meal plan\", \"this week\", \"tonight\" and \"tomorrow\" (when " +
      "tomorrow is in the same week) mean the week containing today, even on a Sunday -- leave week out for them. " +
      "Pass week only when the person says \"next week\", names another week, or gives a date in one.",
    // gemma4:12b, asked "deny that" about tomorrow's dinner on a Sunday, left week out and hit last Monday's meal.
    "A day name (\"Monday\", \"tomorrow\", \"Friday\") means the next one from today unless the person says last or " +
      "past; if that day is in next week, pass week.",
    // A denied meal leaves its slot empty; replace_denied_meal chooses a saved recipe for it. The model must not pick one itself.
    "To swap a denied meal for something else, call replace_denied_meal with the meal's id from get_meal_plan (deny it " +
      "with set_meal_status first if it is not denied yet). It chooses the recipe and the new meal is only proposed, so " +
      "say what it picked and that it still needs approving. Do not invent a replacement dish yourself.",
    // Eval #90 (kiosk): "mark tonight's dinner eaten for Alice" -> set_meal_status approved, then "I've marked it as eaten".
    // log_planned_meal is deliberately not named: the kiosk prompt must not describe a logging tool it was not given
    // (assistantHealthBoundary.test.ts); systemPrompt.ts names it only when it is offered.
    "set_meal_status only approves or denies a planned meal; it never marks it eaten or logs it. To mark a meal eaten " +
      "use a tool made for that if you were given one; if not, say it can't be logged from here and point to the Log " +
      "button in the Food diary. Never say a meal was eaten or logged after approving it.",
    // This rule used to say the opposite -- "ask the user which week/days to
    // cover, any dietary restrictions or budget for the week" -- and the model
    // did exactly that, opening with a four-part questionnaire covering things
    // the app already knew and one thing (a budget) it has no field for. Tool
    // rules are appended last, so it beat everything above it.
    "Do not interrogate the user before planning. The days come from what they asked " +
      "for (\"Monday to Friday\", \"this week\"); the family's likes, dislikes and " +
      "outstanding meal requests are already stated near the top of this prompt. " +
      "Plan from those. Only ask if the days are genuinely unclear, and then ask only " +
      "about the days.",
    // It called create_meal_plan with meals:[] three times, got an error each
    // time, and asked the user which meals to cook instead of choosing any.
    "Choosing the dishes is your job. Never call create_meal_plan with an empty meals " +
      "list, and never ask the user which meals to cook -- decide yourself, then send " +
      "them with a day, slot, name and ingredients each. Plan every " +
      "day the user asked for; if you name dishes in your reply, save those same ones.",
    // Eval #54: all 21 meals of a week in ONE create_meal_plan call is dropped by Ollama's gemma4 tool-call parser (the
    // same bug the Plan the week button works around, src/sections/mealplan/planWeek.ts), so nothing is saved.
    "Save a plan of more than one day with one create_meal_plan call per day, each with keepOtherDays: true -- the " +
      "first call too, even for an empty week.",
    // It described a five-day plan back to the user having only called
    // add_meal_request, so the grid stayed empty while the chat said otherwise.
    "Never tell the user a meal plan is saved unless create_meal_plan actually returned " +
      "a plan. If it returned an error, say what failed and fix it -- do not describe " +
      "the week as though it worked.",
    "Before calling create_meal_plan, call list_calendar_events for that week. For " +
      "any day/slot where a family member has an \"individual\" calendar event, mark " +
      "that meal audience \"individual\" with their memberId instead of \"family\" -- " +
      "everyone else still gets a normal \"family\" meal for that same day/slot.",
    "The meals people have asked for are listed near the top of this prompt -- work " +
      "in as many as fit without asking first. Once a requested meal makes it into " +
      "the plan, call remove_meal_request for it so it isn't suggested again next time.",
    "Never plan a meal around a food someone in the family won't eat.",
    // Phase 4: every planned dish is saved as a recipe, and calories come from its ingredient lines.
    "Every dish you put on the plan is saved as a joint recipe, and its calories are worked out from its " +
      "ingredients. Write each ingredient with an amount where you can (\"200 g chicken breast\", \"2 cups cooked " +
      "rice\") and give the number of servings the dish makes.",
    // Approving is the household's decision: it puts the meal in their food diaries.
    "Meals you plan start as proposed. Do not approve them yourself unless the user asks you to: approving a " +
      "meal puts it in the food diary of everyone it is for.",
  ],
  build: mealPlanTools,
};
