// Calorie-diary tools -- `sensitivity: "health"`. See ./README.md for the contract every domain module follows.
//
// WHAT IS HEALTH DATA HERE (the line, drawn once):
//   health     anything about a PERSON: what they ate (the food diary), their calorie budget, calories left,
//              exercise, weight and trend, steps, goals, logging streak, and the per-person calorie targets the
//              weekly planner uses. These tools are never in a cloud provider's payload unless the admin switched
//              that provider on (assistant.allowCloudHealth.<provider>), and a turn that looks health-related
//              runs on the local model (assistant/providers/index.ts). Spoken (Wear OS) health questions are
//              refused by default like money ones (assistant.noHealthVoiceData).
//   household  a recipe's calories ("the lasagna is 520 kcal a serving": list_recipes, save_recipe), the
//              household meal plan and who each meal is for (the mealplan module), and the food catalogue
//              (search_food_calories, ./foodCatalogue.ts). None of that says what anyone ate.
//   Edge cases, decided conservatively and logged in NUTRITION_ASSUMPTIONS.md (phase 6):
//   - set_meal_status names who now has a meal in their food diary: household (it is the meal's audience).
//   - a recipe's calories next to a person's name ("Bea's portion of the lasagna") is health.
//
// NAMING: this app also has a MONEY budget (assistant/tools/budget.ts, "financial"). Every tool, description and
// parameter here says "calorie" explicitly; nothing here is ever called just "budget".
//
// WHO SEES WHAT:
//   - A normal login (admin or parent) gets tools for THEIR OWN diary. Another login's data comes back only as
//     far as that login's visibility setting allows (nothing / totals / everything, nutrition/data/visibility.ts),
//     through routes/nutrition/share.ts's viewerAccess -- the same function the screen's routes use, so the chat
//     can never be more generous than the screen. Progress photos are unreachable from here at any level.
//   - If the person turned on "Require the PIN for my food diary" and the session hasn't unlocked (or is a device
//     token), every tool here is withheld and refuses -- the same state in which /api/nutrition answers 423.
//   - The one deliberate exception is plan_meals_within_calorie_budgets: it returns every diary login's daily
//     calorie budget NUMBER (minus their snack allowance) whatever they share, and never a diary, weight or photo
//     (the user's phase 6 decision for calorie-aware planning).
//   - Writes: the assistant only ever ADDS PLANNED entries to the speaker's own diary, which the person confirms
//     by tapping Log in the Food diary. It never logs, edits or deletes anything.
//   - The kiosk login gets plan-level tools only (portions of the household plan's meals, and -- only if the
//     admin set the kiosk to "plan + quick logging" -- marking a planned meal-plan entry eaten). No diaries.

import type { DomainTool, ToolContext, ToolModule } from "../registry.ts";
import crypto from "node:crypto";
import { db as appDb, getConfig, getScopedItems } from "../../db.ts";
import { canTrack, type Tracker } from "../../nutrition/data/access.ts";
import { daySummary, liveEntries } from "../../nutrition/data/days.ts";
import { addEntries } from "../../nutrition/data/diary.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { canSee, getFood, searchFoods, servingsOf, type FoodRow } from "../../nutrition/data/foods.ts";
import { parseJson } from "../../nutrition/data/input.ts";
import { kioskBoardData, logPlanEntries } from "../../nutrition/data/kioskBoard.ts";
import { streakFor } from "../../nutrition/data/loggingStreaks.ts";
import { planDayDate, PLAN_DAYS } from "../../nutrition/data/planDocs.ts";
import { weekCalories } from "../../nutrition/data/planCalories.ts";
import { getRecipeRecord } from "../../nutrition/data/recipes.ts";
import { sharedDay, sharedProgress } from "../../nutrition/data/sharedView.ts";
import { allSlotsFor, slotTargetKcal, slotsFor } from "../../nutrition/data/slots.ts";
import { all, get } from "../../nutrition/data/sql.ts";
import { listSteps } from "../../nutrition/data/steps.ts";
import { getTracker, listTrackers, todayFor } from "../../nutrition/data/tracker.ts";
import { weightTrendFor } from "../../nutrition/data/weightProgress.ts";
import { listWeights } from "../../nutrition/data/weights.ts";
import { addDays, isValidLocalDate, mondayOf } from "../../nutrition/dates.ts";
import { round2, type Nutrients } from "../../nutrition/nutrients.ts";
import { kcalPerServing } from "../../nutrition/recipeModel.ts";
import { KG_PER_LB } from "../../nutrition/weightTrend.ts";
import { KIOSK_ACCESS_KEY } from "../../routes/nutrition.ts";
import type { KioskAccess } from "../../routes/nutrition/common.ts";
import { readKioskAccess } from "../../routes/nutrition/kiosk.ts";
import { pinRequiredFor } from "../../routes/nutrition/pin.ts";
import { viewerAccess, sharedForSession, type ViewerSession } from "../../routes/nutrition/share.ts";
import { listMembers } from "../../routes/members.ts";
import { mealTargets } from "../../routes/mealplanDiary.ts";
import type { MealPlan } from "../../routes/mealplan.ts";

/** The most planned entries one call may add: a meal, not a week. */
export const MAX_PLANNED_ITEMS = 20;

const LOCKED = { error: "Your food diary is locked behind the PIN. Enter the PIN in the app first, then ask again." };
const lb = (kg: number): number => round2(kg / KG_PER_LB);

/** A NutritionError becomes text the model can read and retry from; anything else is a bug and propagates. */
function toolError(err: unknown): { error: string; [k: string]: unknown } {
  if (err instanceof NutritionError) return { error: err.message };
  throw err;
}

/**
 * "today" / "yesterday" / "tomorrow" / YYYY-MM-DD, relative to THE PERSON'S OWN today. Anything else is an
 * error rather than a guess: "Friday" could be this one or last, and a wrong day is a wrong diary.
 */
function resolveDay(raw: unknown, today: string): string | { error: string } {
  if (raw === undefined || raw === null || raw === "") return today;
  const text = String(raw).trim().toLowerCase();
  if (text === "today") return today;
  if (text === "yesterday") return addDays(today, -1);
  if (text === "tomorrow") return addDays(today, 1);
  if (isValidLocalDate(text)) return text;
  return { error: `date must be "today", "yesterday", "tomorrow" or YYYY-MM-DD (today is ${today}); work other days out from today's date.` };
}

/** A diary login by name (display name, case-insensitive; a unique prefix or fragment also works). */
function findTracker(trackers: Tracker[], wanted: string): Tracker | undefined {
  const needle = wanted.trim().toLowerCase();
  const exact = trackers.filter((t) => t.displayName.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = trackers.filter((t) => t.displayName.toLowerCase().startsWith(needle) || t.displayName.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0] : undefined;
}

const SELF_WORDS = new Set(["me", "myself", "my", "mine", "i", "self"]);

interface Env {
  now: () => Date;
}

// ---- the tracker's own tools --------------------------------------------------------------------------------------

function trackerTools(userId: string, unlocked: boolean, ctx: ToolContext, env: Env): DomainTool[] {
  const db = appDb;
  const session = (): ViewerSession => ({ unlocked, device: ctx.device === true });
  /** True while the person's own food-diary PIN lock is engaged for this session (checked live, at call time). */
  const locked = (): boolean => ctx.foodDiaryLocked === true || (pinRequiredFor(userId) && (!unlocked || ctx.device === true));
  const guarded = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => (locked() ? LOCKED : fn(args));
  const me = (): Tracker => getTracker(db, userId);

  /** Resolves the `person` argument: undefined = the signed-in person, else another diary login or an error. */
  function whose(person: unknown): { self: true } | { self: false; target: Tracker } | { error: string; validValues?: string[] } {
    const text = typeof person === "string" ? person.trim() : "";
    if (!text || SELF_WORDS.has(text.toLowerCase())) return { self: true };
    const trackers = listTrackers(db);
    const target = findTracker(trackers, text);
    if (!target) {
      const names = trackers.map((t) => t.displayName);
      return { error: `${text} doesn't keep a food diary here. Food diaries belong to logins: ${names.join(", ")}.`, validValues: names };
    }
    return target.id === userId ? { self: true } : { self: false, target };
  }

  const dayMeals = (user: Tracker, date: string, calorieBudget: number | null) => {
    const entries = liveEntries(db, user.id, date);
    const used = new Set(entries.map((e) => e.slot_key));
    const slots = allSlotsFor(db, user.id).filter((s) => s.enabled === 1 || used.has(s.key));
    return slots
      .map((slot) => {
        const list = entries.filter((e) => e.slot_key === slot.key);
        const eaten = list.filter((e) => e.status === "logged");
        return {
          meal: slot.label,
          mealKey: slot.key,
          caloriesEaten: round2(eaten.reduce((a, e) => a + parseJson<Nutrients>(e.nutrients_total).kcal, 0)),
          calorieTarget: slotTargetKcal(slot, calorieBudget),
          entries: list.map((e) => ({
            name: e.name_snapshot,
            quantity: e.quantity,
            unit: e.unit_snapshot,
            calories: round2(parseJson<Nutrients>(e.nutrients_total).kcal),
            status: e.status === "planned" ? "planned (not eaten yet, not counted)" : "logged",
          })),
        };
      })
      .filter((m) => m.entries.length > 0 || m.calorieTarget !== null);
  };

  return [
    {
      name: "get_calorie_day_summary",
      description:
        "A person's CALORIE day from their food diary: their calorie budget for the day (the kcal they may eat, " +
        "NOT money), calories eaten, exercise calories added back, calories left, what each meal has, and what is " +
        "planned but not eaten yet. Use this for \"how many calories do I have left\", \"what did I eat\", \"am I " +
        "over my calories\". Defaults to the signed-in person's own diary today. Pass person to ask about " +
        "another login: you get only what that person shares (a refusal is final -- do not try other tools). " +
        "For MONEY budgets use get_budget_summary, never this.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: '"today" (default), "yesterday", "tomorrow" or YYYY-MM-DD, in that person\'s own timezone.' },
          person: { type: "string", description: "Whose diary, by name. Omit for the signed-in person." },
        },
      },
      run: guarded(async ({ date, person }: { date?: unknown; person?: unknown }) => {
        try {
          const user = me();
          const who = whose(person);
          if ("error" in who) return who;
          const owner = who.self ? user : who.target;
          const today = todayFor(owner, env.now());
          const day = resolveDay(date, todayFor(user, env.now()));
          if (typeof day !== "string") return day;

          if (who.self) {
            const s = daySummary(db, user, day, today, { persist: false });
            return {
              person: user.displayName,
              date: day,
              isToday: day === today,
              calorieBudget: s.calorieBudget,
              caloriesEaten: s.eaten,
              exerciseCaloriesAddedBack: s.exercise,
              caloriesLeft: s.remaining,
              caloriesPlannedNotYetEaten: s.plannedKcal,
              plannedEntryCount: s.plannedCount,
              meals: dayMeals(user, day, s.calorieBudget),
              macrosEatenGrams: { protein: s.macros.protein.eaten, carbs: s.macros.carbs.eaten, fat: s.macros.fat.eaten },
              loggingStreakDays: streakFor(db, user.id, today).current,
              calorieBudgetUnavailable: s.calorieBudget === null
                ? `No calorie budget yet: still needed ${s.missing.join(", ")}. Set it up in Food settings.`
                : undefined,
            };
          }

          const access = viewerAccess(db, user.id, who.target.id, "totals", session());
          if (!access.ok) return { error: access.message };
          const shared = sharedDay(db, access.person, access.level, day, env.now());
          const summary = shared.summary;
          return {
            person: access.person.displayName,
            sharedAtLevel: access.level,
            date: day,
            isToday: day === shared.today,
            calorieBudget: summary.calorieBudget,
            caloriesEaten: summary.eaten,
            exerciseCaloriesAddedBack: summary.exercise,
            caloriesLeft: summary.remaining,
            loggingStreakDays: shared.streak.current,
            ...("slots" in shared
              ? {
                  meals: shared.slots.map((sl) => ({
                    meal: sl.label,
                    caloriesEaten: sl.kcal,
                    entries: sl.entries.map((e) => ({
                      name: e.name,
                      quantity: e.quantity,
                      unit: e.unit,
                      calories: round2(e.nutrients.kcal),
                      status: e.status === "planned" ? "planned (not eaten yet, not counted)" : "logged",
                    })),
                  })),
                  exercise: shared.exercise.map((x) => ({ name: x.name, calories: x.kcal, minutes: x.minutes })),
                }
              : {}),
          };
        } catch (err) {
          return toolError(err);
        }
      }),
    },

    {
      name: "get_calorie_week_summary",
      description:
        "The CALORIE week (Monday to Sunday), day by day: the calorie budget, calories eaten and calories planned " +
        "but not eaten yet, for the signed-in person and for each other login that shares at least their daily " +
        "totals with them. About food-diary calories, NOT money. For money budgets (groceries, spending) use " +
        "get_budget_summary instead.",
      parameters: {
        type: "object",
        properties: {
          weekStart: { type: "string", description: "Any date in the week, YYYY-MM-DD. Default: this week." },
        },
      },
      run: guarded(async ({ weekStart }: { weekStart?: unknown }) => {
        try {
          const user = me();
          const today = todayFor(user, env.now());
          const day = resolveDay(weekStart, today);
          if (typeof day !== "string") return day;
          const week = weekCalories(db, user.id, day, env.now(), { shared: sharedForSession(db, user.id, session(), "totals") });
          return {
            weekStart: week.weekStart,
            people: week.people.map((p) => ({
              person: p.name,
              isMe: p.isMe,
              days: p.days.map((d, i) => ({
                day: PLAN_DAYS[i],
                date: d.date,
                calorieBudget: d.calorieBudget,
                caloriesEaten: d.loggedKcal,
                caloriesPlannedNotYetEaten: d.plannedKcal,
                // The planning target and the room under it are the person's own business; others see totals only.
                planningTargetCalories: p.isMe ? d.planningTargetKcal : undefined,
                roomUnderPlanningTargetCalories: p.isMe ? d.roomKcal : undefined,
              })),
            })),
          };
        } catch (err) {
          return toolError(err);
        }
      }),
    },

    {
      name: "get_weight_progress",
      description:
        "A person's body-weight progress: latest weigh-in, the smoothed trend, how it changed over the period, " +
        "their goal weight and when the plan reaches it, and recent step counts. Defaults to the signed-in " +
        "person. Pass person for another login: you get weigh-ins and steps only if they share everything, " +
        "and never their goal or photos. A refusal is final -- do not try other tools.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string", description: "Whose progress, by name. Omit for the signed-in person." },
          days: { type: "number", description: "How many days back to look, 7 to 365. Default 90." },
        },
      },
      run: guarded(async ({ person, days }: { person?: unknown; days?: unknown }) => {
        try {
          const user = me();
          const who = whose(person);
          if ("error" in who) return who;
          const owner = who.self ? user : who.target;
          const span = typeof days === "number" && Number.isFinite(days) ? Math.min(365, Math.max(7, Math.round(days))) : 90;
          const today = todayFor(owner, env.now());
          const from = addDays(today, -span);

          if (who.self) {
            const trend = weightTrendFor(db, user, today, from);
            const weighIns = listWeights(db, user, { from });
            const steps = listSteps(db, user.id, { from: addDays(today, -13) });
            const first = trend.points[0];
            const latest = weighIns[weighIns.length - 1];
            return {
              person: user.displayName,
              today,
              preferredUnits: user.profile?.unit_system ?? "imperial",
              latestWeighIn: latest ? { date: latest.measured_on, weightKg: latest.weight_kg, weightLb: lb(latest.weight_kg) } : null,
              trendWeightKg: trend.trendKg,
              trendWeightLb: trend.trendKg === null ? null : lb(trend.trendKg),
              trendChangeOverPeriodKg: first && trend.trendKg !== null ? round2(trend.trendKg - first.trendKg) : null,
              trendChangeOverPeriodLb: first && trend.trendKg !== null ? lb(trend.trendKg - first.trendKg) : null,
              periodStart: first?.date ?? null,
              weighInCount: weighIns.length,
              recentWeighIns: weighIns.slice(-8).map((w) => ({ date: w.measured_on, weightKg: w.weight_kg, weightLb: lb(w.weight_kg) })),
              goalWeightKg: trend.goalKg,
              goalWeightLb: trend.goalKg === null ? null : lb(trend.goalKg),
              planPoundsPerWeek: trend.planLbPerWeek,
              projectedGoalDate: trend.projection?.date ?? null,
              projectionNote: trend.projection && trend.projection.date === null ? trend.projection.reason : undefined,
              stepsLast14Days: steps.map((s) => ({ date: s.local_date, steps: s.steps })),
              loggingStreakDays: streakFor(db, user.id, today).current,
              note: weighIns.length === 0 ? "No weigh-ins recorded in this period." : undefined,
            };
          }

          const access = viewerAccess(db, user.id, who.target.id, "everything", session());
          if (!access.ok) return { error: access.message };
          const progress = sharedProgress(db, access.person, env.now(), from);
          const latest = progress.weights[progress.weights.length - 1];
          const firstPoint = progress.trend.points[0];
          return {
            person: access.person.displayName,
            sharedAtLevel: access.level,
            today: progress.today,
            latestWeighIn: latest ? { date: latest.date, weightKg: latest.weightKg, weightLb: lb(latest.weightKg) } : null,
            trendWeightKg: progress.trend.trendKg,
            trendWeightLb: progress.trend.trendKg === null ? null : lb(progress.trend.trendKg),
            trendChangeOverPeriodKg: firstPoint && progress.trend.trendKg !== null ? round2(progress.trend.trendKg - firstPoint.trendKg) : null,
            trendChangeOverPeriodLb: firstPoint && progress.trend.trendKg !== null ? lb(progress.trend.trendKg - firstPoint.trendKg) : null,
            recentWeighIns: progress.weights.slice(-8).map((w) => ({ date: w.date, weightKg: w.weightKg, weightLb: lb(w.weightKg) })),
            stepsLast14Days: progress.steps.slice(-14),
          };
        } catch (err) {
          return toolError(err);
        }
      }),
    },

    {
      name: "add_planned_calorie_diary_entries",
      mutates: true,
      description:
        "Add foods to the signed-in person's OWN food diary as PLANNED entries -- never as eaten. Use it when " +
        'they say what they ate or will eat ("I had two eggs and toast for breakfast"). Each entry stays ' +
        "greyed out and uncounted until the person taps Log in the Food diary, so tell them to confirm it there. " +
        "It cannot log, edit or delete anything, and it only ever writes to the speaker's own diary. Find each " +
        "food with search_food_calories first and pass its foodId. State every amount explicitly: quantity of a " +
        "serving (with the serving name), or grams. If they did not say how much or which meal, ask them -- do " +
        "not guess. All foods are added together or none are.",
      parameters: {
        type: "object",
        properties: {
          meal: { type: "string", description: 'Which meal of the day, by name: "breakfast", "lunch", "dinner", "snacks", or one of their own.' },
          date: { type: "string", description: '"today" (default), "yesterday", "tomorrow" or YYYY-MM-DD. Planning a future day is fine.' },
          items: {
            type: "array",
            description: `The foods, at most ${MAX_PLANNED_ITEMS}.`,
            items: {
              type: "object",
              properties: {
                foodId: { type: "string", description: "The foodId from search_food_calories. Preferred." },
                food: { type: "string", description: "The food's name, only if you have no foodId. Refused when it matches more than one food." },
                quantity: { type: "number", description: 'How many of the serving, e.g. 2 for "two large eggs".' },
                serving: { type: "string", description: 'The serving\'s name from search_food_calories, e.g. "1 large". Needed for foods measured per 100 g unless you give grams.' },
                grams: { type: "number", description: "Instead of quantity + serving: the weight in grams." },
              },
            },
          },
        },
        required: ["meal", "items"],
      },
      run: guarded(async ({ meal, date, items }: { meal?: unknown; date?: unknown; items?: unknown }) => {
        try {
          const user = me();
          const today = todayFor(user, env.now());
          const day = resolveDay(date, today);
          if (typeof day !== "string") return day;

          // The meal, by key or by label: the person's own meals, never guessed.
          const slots = slotsFor(db, user.id);
          const wantedMeal = String(meal ?? "").trim().toLowerCase();
          const slot = slots.find((s) => s.key === wantedMeal) ?? slots.find((s) => s.label.toLowerCase() === wantedMeal);
          if (!wantedMeal || !slot) {
            return { error: `Which meal? ${wantedMeal ? `"${String(meal).trim()}" isn't one of this person's meals. ` : ""}Choose one of: ${slots.map((s) => s.label).join(", ")}.`, validValues: slots.map((s) => s.label) };
          }

          const list = Array.isArray(items) ? items : [];
          if (list.length === 0) return { error: "Say which foods to add." };
          if (list.length > MAX_PLANNED_ITEMS) return { error: `At most ${MAX_PLANNED_ITEMS} foods at a time.` };

          // Resolve and check EVERY item before writing any, so a problem on the third food adds nothing.
          const prepared: Array<{ id: string; foodId: string; quantity?: number; servingId?: string; grams?: number; label: string }> = [];
          for (const [i, raw] of list.entries()) {
            const item = (raw ?? {}) as Record<string, unknown>;
            const label = String(item.food ?? item.foodId ?? `item ${i + 1}`);
            let food: FoodRow | undefined;
            if (typeof item.foodId === "string" && item.foodId) {
              const f = getFood(db, item.foodId);
              food = f && canSee(f, userId) ? f : undefined;
              if (!food) return { error: `No food with that foodId (${item.foodId}). Use search_food_calories to find the food.` };
            } else if (typeof item.food === "string" && item.food.trim()) {
              const matches = searchFoods(db, userId, item.food.trim(), 5);
              if (matches.length === 0) return { error: `No food matching "${item.food}". Try search_food_calories with other words.` };
              if (matches.length > 1) {
                return {
                  error: `"${item.food}" matches more than one food, so nothing was added. Choose one and call again with its foodId.`,
                  candidates: matches.map((m) => ({ foodId: m.id, name: m.name, brand: m.brand ?? undefined })),
                };
              }
              food = matches[0];
            } else {
              return { error: `Item ${i + 1} needs a foodId (from search_food_calories) or a food name.` };
            }

            const grams = typeof item.grams === "number" && Number.isFinite(item.grams) && item.grams > 0 ? item.grams : undefined;
            const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : undefined;
            const servings = servingsOf(db, food.id);
            const named = typeof item.serving === "string" && item.serving.trim()
              ? servings.find((s) => s.label.toLowerCase() === (item.serving as string).trim().toLowerCase())
                ?? servings.filter((s) => s.label.toLowerCase().includes((item.serving as string).trim().toLowerCase()))[0]
              : undefined;
            if (typeof item.serving === "string" && item.serving.trim() && !named) {
              return { error: `${food.name} has no serving called "${item.serving}". Its servings: ${servings.map((s) => s.label).join(", ") || "none"}.`, validValues: servings.map((s) => s.label) };
            }

            if (food.basis === "per_serving") {
              if (grams !== undefined) return { error: `${food.name} is counted per serving, so give a quantity (number of servings), not grams.` };
              if (quantity === undefined) return { error: `How many servings of ${food.name}? Give a quantity.` };
              prepared.push({ id: `llm-${crypto.randomUUID()}`, foodId: food.id, quantity, servingId: named?.id, label: food.name });
            } else if (grams !== undefined) {
              prepared.push({ id: `llm-${crypto.randomUUID()}`, foodId: food.id, grams, label: food.name });
            } else {
              // Per 100 g: a count of a NAMED serving, or a weight. "2 eggs" with no serving named would silently mean 2 x 100 g.
              if (quantity === undefined || !named) {
                const options = servings.filter((s) => s.grams !== null).map((s) => s.label);
                return { error: `${food.name} is measured per 100 g. Give grams, or a quantity with the serving name (${options.join(", ") || "none listed"}).`, validValues: options };
              }
              prepared.push({ id: `llm-${crypto.randomUUID()}`, foodId: food.id, quantity, servingId: named.id, label: food.name });
            }
          }

          // Always status "planned", source "llm": a person confirms by logging. (The data layer's own default
          // would make a PAST day's entries "logged" -- the status is set explicitly so that can never happen here.)
          const groupId = `llm-${crypto.randomUUID()}`;
          const written = addEntries(db, user, day, today, {
            slot: slot.key,
            status: "planned",
            source: "llm",
            groupId,
            items: prepared.map((p) => ({ id: p.id, foodId: p.foodId, quantity: p.quantity, servingId: p.servingId, grams: p.grams })),
          });
          const kcal = (e: { nutrients_total: string }) => round2(parseJson<Nutrients>(e.nutrients_total).kcal);
          const total = round2(written.entries.reduce((a, e) => a + kcal(e), 0));
          return {
            addedAsPlanned: written.entries.map((e) => ({ name: e.name_snapshot, quantity: e.quantity, unit: e.unit_snapshot, calories: kcal(e) })),
            meal: slot.label,
            date: day,
            totalPlannedCalories: total,
            status: "PLANNED, not eaten",
            toConfirm: "Nothing is logged yet. Open the Food diary and tap Log on these (or Log all) once they have been eaten; until then they are not counted.",
            futureDayNote: day > today ? "That day hasn't happened yet; planned entries can be logged on the day." : undefined,
          };
        } catch (err) {
          return toolError(err);
        }
      }),
    },

    {
      name: "plan_meals_within_calorie_budgets",
      description:
        "Calorie targets for planning a week of meals. For each login that keeps a food diary and each day of the " +
        "week it returns their daily CALORIE budget (kcal, with their calorie schedule applied), the part kept free " +
        "for snacks, and the PLANNING TARGET = what that day's planned meals should add up to for them. If a meal " +
        "plan is already saved for that week it also checks it: per person per day, the calories of the planned " +
        "meals against the target. Call it BEFORE create_meal_plan to get the targets, and again AFTER to see " +
        "which days are over. It saves nothing itself. It is about calories, not money -- the grocery money budget is a " +
        "different thing. The numbers are for planning only; never repeat one person's numbers to another.",
      parameters: {
        type: "object",
        properties: {
          weekStart: { type: "string", description: "The Monday of the week to plan (or any date in it), YYYY-MM-DD." },
        },
        required: ["weekStart"],
      },
      run: guarded(async ({ weekStart }: { weekStart?: unknown }) => {
        try {
          const user = me();
          const today = todayFor(user, env.now());
          const day = resolveDay(weekStart, today);
          if (typeof day !== "string") return day;
          const monday = mondayOf(day);

          // EVERY diary login's calorie budget numbers, whatever they share (the user's phase 6 decision), and
          // nothing else: the planned/logged diary figures weekCalories also computes are dropped here.
          const week = weekCalories(db, user.id, monday, env.now(), { everyone: true });
          const targetOf = new Map<string, Map<string, number | null>>();
          for (const p of week.people) targetOf.set(p.userId, new Map(p.days.map((d) => [d.date, d.planningTargetKcal])));

          // The saved plan for that week, if any: what each person's planned meals add up to (1 serving each,
          // as the diaries would receive them), from the plan and its recipes only -- no diary is read.
          const plan = (getScopedItems("meal_plans", userId) as MealPlan[]).find((p) => p.weekStart === monday);
          const members = listMembers(userId);
          const planned = new Map<string, Map<string, number>>(); // userId -> date -> kcal
          const unknown: Array<{ date: string; day: string; meal: string; dish: string; reason: string }> = [];
          for (const meal of plan?.meals ?? []) {
            if (meal.status === "denied") continue;
            const date = planDayDate(monday, meal.day);
            if (!date) continue;
            const rec = meal.recipeId ? getRecipeRecord(db, meal.recipeId) : undefined;
            const kcal = rec ? kcalPerServing(rec.doc) : null;
            if (kcal === null) {
              unknown.push({ date, day: meal.day, meal: meal.slot, dish: meal.name, reason: rec ? "its recipe has no calories yet" : "it has no recipe" });
              continue;
            }
            for (const uid of mealTargets(meal, members).userIds) {
              const byDate = planned.get(uid) ?? new Map<string, number>();
              byDate.set(date, round2((byDate.get(date) ?? 0) + kcal));
              planned.set(uid, byDate);
            }
          }

          return {
            weekStart: monday,
            people: week.people.map((p) => ({
              person: p.name,
              days: p.days.map((d, i) => {
                const plannedKcal = plan ? round2(planned.get(p.userId)?.get(d.date) ?? 0) : undefined;
                return {
                  day: PLAN_DAYS[i],
                  date: d.date,
                  calorieBudget: d.calorieBudget,
                  snackAllowanceCalories: d.snackAllowanceKcal,
                  planningTargetCalories: d.planningTargetKcal,
                  plannedMealCalories: plannedKcal,
                  roomUnderTargetCalories: plannedKcal !== undefined && d.planningTargetKcal !== null ? round2(d.planningTargetKcal - plannedKcal) : undefined,
                  // Just that there is none: why (no profile, goal or weigh-in) is that person's own business.
                  noCalorieBudgetSetUp: d.missing.length ? true : undefined,
                };
              }),
            })),
            savedPlanForThisWeek: plan ? true : false,
            plannedMealsWithUnknownCalories: unknown.length ? unknown : undefined,
            howToUse:
              "A family meal is eaten by every person listed, so a family dinner must fit the smallest planning target of the day. " +
              "Calories of planned meals count 1 serving per person. Do not state one person's numbers to another.",
          };
        } catch (err) {
          return toolError(err);
        }
      }),
    },
  ];
}

// ---- the kiosk's plan-level tools ---------------------------------------------------------------------------------

function kioskTools(env: Env): DomainTool[] {
  const db = appDb;
  const access = (): KioskAccess => readKioskAccess(getConfig(KIOSK_ACCESS_KEY, "hidden"));
  const tools: DomainTool[] = [];

  if (access() === "hidden") return tools; // the admin's setting: nothing about food on the kiosk

  tools.push({
    name: "get_planned_meal_portions",
    description:
      "For the shared kitchen screen: the meals approved in the household meal plan for a day, and for each person " +
      "who keeps a food diary the planned portions of those meals with their CALORIES (name and calories of each " +
      "planned meal-plan entry, and the entry's id). That is all it shows: no totals, no calorie budgets, no " +
      "weights, nothing anyone logged or planned privately.",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD. Default: today." } },
    },
    run: async ({ date }) => {
      try {
        if (access() === "hidden") return { error: "Food isn't shown on the kiosk." };
        const day = date === undefined || date === null || date === "" ? undefined : String(date).trim();
        if (day !== undefined && !isValidLocalDate(day)) return { error: "date must be YYYY-MM-DD." };
        const board = kioskBoardData(db, env.now(), day);
        return {
          date: board.date,
          approvedMeals: board.meals.map((m) => ({ mealId: m.id, dish: m.name, meal: m.slotLabel, for: m.who, leftover: m.leftover || undefined })),
          people: board.people.map((p) => ({
            person: p.name,
            plannedPortions: p.planned.map((e) => ({ entryId: e.id, dish: e.name, meal: e.slotLabel, portionCalories: round2(e.kcal) })),
          })),
          canMarkEaten: access() === "plan_and_quick_log",
        };
      } catch (err) {
        return toolError(err);
      }
    },
  });

  if (access() === "plan_and_quick_log") {
    tools.push({
      name: "log_planned_meal",
      mutates: true,
      description:
        "Mark a person's planned meal from the household meal plan as eaten (\"we ate it\"). Only entries that came " +
        "from the meal plan can be marked, only on today or an earlier day (never a future one), and it cannot add, " +
        "edit or remove anything else. All of the entries are marked or none are. Get the entry ids from " +
        "get_planned_meal_portions, or give the dish name when the person has just one such planned meal that day.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string", description: "Whose meal, by name." },
          entryIds: { type: "array", items: { type: "string" }, description: "The entryId values from get_planned_meal_portions." },
          dish: { type: "string", description: "Instead of entryIds: the dish name. Refused if it could mean more than one planned meal." },
          date: { type: "string", description: "YYYY-MM-DD. Default: that person's today." },
        },
        required: ["person"],
      },
      run: async ({ person, entryIds, dish, date }) => {
        try {
          if (access() !== "plan_and_quick_log") return { error: "Quick logging isn't turned on for the kiosk." };
          const trackers = listTrackers(db);
          const target = typeof person === "string" ? findTracker(trackers, person) : undefined;
          if (!target) {
            const names = trackers.map((t) => t.displayName);
            return { error: `No food diary login named "${String(person ?? "")}". Choose one of: ${names.join(", ")}.`, validValues: names };
          }
          const day = date === undefined || date === null || date === "" ? todayFor(target, env.now()) : String(date).trim();
          if (!isValidLocalDate(day)) return { error: "date must be YYYY-MM-DD." };

          let ids: string[];
          if (Array.isArray(entryIds) && entryIds.length > 0) {
            ids = entryIds.map(String);
          } else if (typeof dish === "string" && dish.trim()) {
            const needle = dish.trim().toLowerCase();
            const rows = all<{ id: string; name_snapshot: string }>(db,
              `SELECT id, name_snapshot FROM nutrition_diary_entries
                WHERE user_id = ? AND local_date = ? AND status = 'planned' AND source = 'plan' AND deleted_at IS NULL`,
              target.id, day).filter((r) => r.name_snapshot.toLowerCase().includes(needle));
            if (rows.length === 0) return { error: `${target.displayName} has no planned meal-plan entry matching "${dish}" on ${day}.` };
            if (rows.length > 1) {
              return { error: `"${dish}" could mean more than one of ${target.displayName}'s planned meals on ${day}, so nothing was marked. Use the entryIds from get_planned_meal_portions.`, candidates: rows.map((r) => ({ entryId: r.id, dish: r.name_snapshot })) };
            }
            ids = [rows[0].id];
          } else {
            return { error: "Say which planned meal: entryIds from get_planned_meal_portions, or the dish name." };
          }

          const logged = logPlanEntries(db, target, ids, env.now());
          return { person: target.displayName, markedEaten: logged.length, entryIds: logged };
        } catch (err) {
          return toolError(err);
        }
      },
    });
  }
  return tools;
}

// ---- the module ---------------------------------------------------------------------------------------------------

function roleOf(userId: string): string | undefined {
  return get<{ role: string }>(appDb, "SELECT role FROM users WHERE id = ?", userId)?.role;
}

function calorieTools(userId: string, unlocked = true, ctx: ToolContext = {}): DomainTool[] {
  const env: Env = { now: ctx.now ?? (() => new Date()) };
  const role = ctx.role ?? roleOf(userId);
  if (role === "kiosk") return kioskTools(env);
  if (!role || !canTrack(role)) return [];
  return trackerTools(userId, unlocked, ctx, env);
}

export const calorieModule: ToolModule = {
  domain: "calories",
  sensitivity: "health",
  label: "calorie diaries (food eaten, calorie budgets, weight)",
  promptRules: [
    // The ambiguity the user flagged: the assistant also has MONEY budget tools.
    'The word "budget" means two different things here. A MONEY budget (dollars: Groceries, Eating Out, bills, ' +
      '"spent", "left this month") is answered ONLY with the money tools (get_budget_summary and the other budget ' +
      'tools). A CALORIE budget (the kcal a person may eat in a day: "calories left", "how much can I still eat", ' +
      '"am I over my calories") is answered ONLY with get_calorie_day_summary or get_calorie_week_summary. Never ' +
      'report dollars as calories or calories as dollars, and never call a calorie tool for a money question. If ' +
      'someone says "budget" or "how much is left" and nothing says calories or money, ask one short question: "Calories or money?"',
    "When someone says what they ate or will eat (\"I had two eggs and toast for breakfast\"), find each food with " +
      "search_food_calories, then call add_planned_calorie_diary_entries. Those become PLANNED entries in the " +
      "speaker's own diary that the person confirms by tapping Log in the Food diary -- never say anything was " +
      "logged or eaten, say it was added as planned. You cannot log, edit or delete diary entries, and you " +
      "cannot mark a planned meal as eaten: if asked to log one (\"log tonight's dinner\"), say it is planned and " +
      "that they should tap Log in the Food diary themselves. If they did " +
      "not say how much, or which meal, ask one short question instead of guessing. Only the speaker's own diary " +
      "can be written to.",
    "To tell a user how many calories are in a food, call search_food_calories; for a saved recipe use list_recipes. " +
      "Report the calories the tool gives; never work them out or guess.",
    "To answer about ANOTHER person's food diary or weight, pass their name as person. If the tool says they don't " +
      "share it, tell the user that plainly and stop: don't try other tools to get around it.",
    "When planning a week of meals, FIRST call plan_meals_within_calorie_budgets for that week and aim each day's " +
      "meals at each person's planningTargetCalories (it already leaves room for snacks; a family meal must fit the " +
      "smallest target that day). Give every dish ingredient amounts so its calories can be worked out. After " +
      "create_meal_plan, call plan_meals_within_calorie_budgets again and fix days that are over; say honestly which " +
      "days are still over, or which meals have no calories yet. Those calorie targets are for planning only: do not " +
      "tell one person another person's numbers (get_calorie_day_summary with person follows what they share).",
  ],
  build: calorieTools,
};
