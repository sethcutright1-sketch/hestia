// Logging streaks through the data layer: which days count, "Done logging" for recent past days,
// the household view (numbers only, each person's own midnight), and the weight trend.
// Ported from the calorie app's streaks.test.ts. (The Lose It! importer is phase 7, so an
// "imported" day is written by hand the way the importer will leave it.)

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { NOW, TODAY, YESTERDAY, newWorld } from "./helpers/nutritionWorld.ts";
import { addEntry } from "../nutrition/data/diary.ts";
import { markDayDone } from "../nutrition/data/days.ts";
import { addGoal } from "../nutrition/data/goals.ts";
import { householdStreaks, streakFor } from "../nutrition/data/loggingStreaks.ts";
import { run } from "../nutrition/data/sql.ts";
import { todayFor } from "../nutrition/data/tracker.ts";
import { weightTrendFor } from "../nutrition/data/weightProgress.ts";
import { addWeight } from "../nutrition/data/weights.ts";

after(cleanupDb);

const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function world(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  let now = NOW;
  const who = (name: "ann" | "ben") => w.tracker(w.ids[name]);
  const today = (name: "ann" | "ben") => todayFor(who(name), now);
  const done = (name: "ann" | "ben", date: string) => markDayDone(w.db, who(name), date, today(name));
  const streak = (name: "ann" | "ben") => ({ ...streakFor(w.db, w.ids[name], today(name)), today: today(name) });
  return { w, who, today, done, streak, setNow: (d: Date) => { now = d; }, now: () => now };
}

test("a streak counts days marked done: today ends it, an unfinished today doesn't break it", async (t) => {
  const { done, streak } = await world(t);
  assert.deepEqual(streak("ann"), { current: 0, best: 0, countedToday: false, today: TODAY });

  const first = done("ann", YESTERDAY);
  assert.deepEqual(first.streak, { current: 1, best: 1, countedToday: false });
  assert.ok(first.doneLoggingAt, "still the day summary");
  done("ann", daysAgo(2));
  done("ann", daysAgo(3));
  assert.deepEqual(streak("ann"), { current: 3, best: 3, countedToday: false, today: TODAY }, "yesterday and before: today is still open");

  assert.deepEqual(done("ann", TODAY).streak, { current: 4, best: 4, countedToday: true });
  // Marking it again changes nothing.
  assert.deepEqual(done("ann", TODAY).streak, { current: 4, best: 4, countedToday: true });

  // A gap splits the run: the best stays, the current one is what's connected to now.
  done("ann", daysAgo(6)); // 6 ago counted, 5 and 4 not
  done("ann", daysAgo(7));
  assert.deepEqual(streak("ann"), { current: 4, best: 4, countedToday: true, today: TODAY });
});

test("the streak resets only after a whole day passes without being finished", async (t) => {
  const { done, streak, setNow } = await world(t);
  done("ann", YESTERDAY);
  done("ann", TODAY);
  setNow(new Date("2026-03-11T15:00:00Z")); // tomorrow, not done yet
  assert.deepEqual(streak("ann"), { current: 2, best: 2, countedToday: false, today: "2026-03-11" });
  setNow(new Date("2026-03-12T15:00:00Z")); // and the day after: a whole day was missed
  assert.deepEqual(streak("ann"), { current: 0, best: 2, countedToday: false, today: "2026-03-12" });
});

test("Done logging can finish a day up to 7 days back, never ahead of time, and still needs the plans handled", async (t) => {
  const { w, who, done } = await world(t);
  assert.ok(done("ann", daysAgo(7)));
  assert.throws(() => done("ann", daysAgo(8)), (e: any) => e.status === 400 && /last 7 days/.test(e.message));
  assert.throws(() => done("ann", "2026-03-11"), (e: any) => e.status === 400 && /hasn't happened/.test(e.message));
  assert.throws(() => done("ann", "not-a-date"), (e: any) => e.status === 400);

  // A leftover plan on a recent day blocks it, exactly as for today.
  addEntry(w.db, who("ann"), YESTERDAY, TODAY, { slot: "dinner", kcal: 500, status: "planned" });
  assert.throws(() => done("ann", YESTERDAY), (e: any) => e.status === 409 && e.extra.plannedCount === 1);
});

test("days imported from Lose It! count (an assumption: its export has no done flag); deleted ones don't", async (t) => {
  const { w, who, done, streak } = await world(t);
  // The sample export logged food on 2026-03-05 only.
  run(w.db, `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
             VALUES ('imp-1', ?, '2026-03-05', 'breakfast', 'Oatmeal', 1, 'Cup', '{}', 'import_loseit', 'x', 'x')`, w.ids.ann);
  assert.deepEqual(streak("ann"), { current: 0, best: 1, countedToday: false, today: TODAY });
  // Finish the days since: the imported day is not adjacent, so it stays its own run...
  done("ann", YESTERDAY);
  assert.deepEqual(streak("ann"), { current: 1, best: 1, countedToday: false, today: TODAY });
  // ...until the days between are done as well (now a recent past day can be finished).
  for (const d of ["2026-03-06", "2026-03-07", "2026-03-08"]) done("ann", d);
  assert.deepEqual(streak("ann"), { current: 5, best: 5, countedToday: false, today: TODAY });

  // An imported day whose entries are gone doesn't count.
  run(w.db, "UPDATE nutrition_diary_entries SET deleted_at = '2026-03-10T00:00:00Z' WHERE source = 'import_loseit'");
  assert.deepEqual(streak("ann"), { current: 4, best: 4, countedToday: false, today: TODAY });
  // Entries logged by hand never count by themselves: only finishing the day does.
  addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "lunch", kcal: 400 });
  assert.equal(streak("ann").countedToday, false);
  // The other person is unaffected by Ann's history.
  assert.equal(streak("ben").best, 0);
});

test("the household view can show both people's streak numbers and nothing else, each by their own midnight", async (t) => {
  const { w, done, today, now } = await world(t);
  // Ben is in Pacific/Auckland: on the shared test clock it is already 2026-03-11 for him.
  done("ann", TODAY);
  done("ann", YESTERDAY);
  assert.equal(today("ben"), "2026-03-11");
  done("ben", today("ben"));

  // Server-side callers that are not answering one person ask for everyone; a route answering a person passes who shares with them.
  const view = householdStreaks(w.db, w.ids.ann, now(), { everyone: true });
  assert.deepEqual(view, [
    { userId: w.ids.ann, name: "Ann", mine: true, current: 2, best: 2, countedToday: true },
    { userId: w.ids.ben, name: "Ben", mine: false, current: 1, best: 1, countedToday: true },
  ]);
  // Same list for Ben, with himself marked.
  assert.deepEqual(householdStreaks(w.db, w.ids.ben, now(), { everyone: true }).map((s) => s.mine), [false, true]);
  // With no say-so, a viewer gets only their own streak -- forgetting the rule shows less, not more.
  assert.deepEqual(householdStreaks(w.db, w.ids.ann, now()).map((s) => s.name), ["Ann"]);
  assert.deepEqual(householdStreaks(w.db, w.ids.ann, now(), { shared: new Set([w.ids.ben]) }).map((s) => s.name), ["Ann", "Ben"]);
  // Numbers only: no dates, entries or calories leak.
  assert.deepEqual(Object.keys(view[1]).sort(), ["best", "countedToday", "current", "mine", "name", "userId"]);
});

test("the weight trend smooths the weigh-ins and projects when the plan reaches the goal weight", async (t) => {
  const { w, who } = await world(t);
  const ann = () => who("ann");
  assert.deepEqual(weightTrendFor(w.db, ann(), TODAY), { points: [], trendKg: null, goalKg: null, planLbPerWeek: 0, projection: null });

  addWeight(w.db, ann(), NOW, { weightKg: 80, measuredOn: "2026-03-01" });
  addWeight(w.db, ann(), NOW, { weightKg: 81, measuredOn: "2026-03-02" });
  addGoal(w.db, ann(), TODAY, { planLbPerWeek: 1, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, goalWeightKg: 70 });
  const trend = weightTrendFor(w.db, ann(), TODAY);
  assert.deepEqual(trend.points.map((p) => [p.date, p.weightKg]), [["2026-03-01", 80], ["2026-03-02", 81]]);
  assert.equal(trend.trendKg, 80.1, "80 + 0.1 x (81 - 80)");
  assert.deepEqual([trend.goalKg, trend.planLbPerWeek], [70, 1]);
  assert.equal(trend.projection?.reason, "ok");
  assert.ok(trend.projection!.date! > TODAY);
  // `from` narrows the window.
  assert.equal(weightTrendFor(w.db, ann(), TODAY, "2026-03-02").points.length, 1);
  assert.throws(() => weightTrendFor(w.db, ann(), TODAY, "yesterday"), (e: any) => e.status === 400);
});
