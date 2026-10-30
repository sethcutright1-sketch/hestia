import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Check, X, Trash2, AlertTriangle, Plus, ArrowLeftRight, ClipboardList, Sparkles, Wallet, Repeat, ChefHat, CalendarDays } from "lucide-react";
import {
  api,
  ApiError,
  type MealPlanResponse,
  type PlannedMeal,
  type ShoppingList,
  type HouseholdMember,
  type MealStatus,
  type MealSyncReport,
  type LeftoverOffer,
  type Recipe,
} from "../api.ts";
import { useLiveRefresh } from "../useLiveRefresh.ts";
import { KIOSK } from "../kiosk.ts";
import Preferences from "./mealplan/Preferences.tsx";
import Recipes from "./mealplan/Recipes.tsx";
import RecipePicker from "./mealplan/RecipePicker.tsx";
import RecipeView from "./mealplan/RecipeView.tsx";
import PlanWeek from "./mealplan/PlanWeek.tsx";
import PlanCalories from "./mealplan/PlanCalories.tsx";
import MoveMeal from "./mealplan/MoveMeal.tsx";
import LeftoverPicker from "./mealplan/LeftoverPicker.tsx";
import KioskLogFor from "./mealplan/KioskLogFor.tsx";
import { boardDates, loggedKey, logChips, type KioskBoard, type LogChip } from "./mealplan/kioskLog.ts";
import { CALORIES_LEGEND, hasCalorieRows, rowsForDate, type PlanCaloriesResponse } from "./mealplan/planCaloriesView.ts";
import { addDays } from "./food/dates.ts";
import { isoDate, mondayOf } from "./mealplan/planWeek.ts";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** One sentence about what the food diaries did when a meal changed (the server's `sync` report), or "". */
function describeSync(sync: MealSyncReport | undefined): string {
  if (!sync) return "";
  const bits: string[] = [];
  if (sync.created.length > 0) {
    const names = sync.created.map((c) => c.name);
    bits.push(`Planned in ${names.length === 1 ? `${names[0]}'s food diary` : `${names.join(" and ")}'s food diaries`}.`);
  }
  if (sync.note) bits.push(sync.note);
  for (const f of sync.slotFallbacks) bits.push(`${f.name} has no "${f.from}" meal, so it went under ${f.to}.`);
  if (sync.alreadyLogged.length > 0) bits.push(`${sync.alreadyLogged.map((a) => a.name).join(" and ")} already logged it, so that was left as it is.`);
  for (const k of sync.skipped) if (k.userId === null || /no longer exists|kiosk/i.test(k.reason)) bits.push(k.reason);
  return bits.join(" ");
}

const kcalOf = (r: Recipe | undefined): number | null => (r?.nutrition ? Math.round(r.nutrition.perServing.kcal) : null);

type View = "plan" | "prefs" | "recipes";

const VIEWS: { id: View; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "prefs", label: "Likes & Dislikes" },
  { id: "recipes", label: "Recipes" },
];

const NEW_LIST = "__new__";

export default function MealPlan({
  onRequestUnlock,
  canCalculateCalories = true,
  isKioskLogin = false,
}: {
  /** Opens the PIN prompt (App.tsx): a login that PIN-locks its food diary gets a 423 from the recipe calorie routes. */
  onRequestUnlock?: () => void;
  /** False for the kiosk login, which keeps no food diary and so can't work out recipe calories. */
  canCalculateCalories?: boolean;
  /** True for the kiosk login (role kiosk): no calories per person, and the "Log for" buttons when the admin allows quick logging. */
  isKioskLogin?: boolean;
} = {}) {
  const [data, setData] = useState<MealPlanResponse | null>(null);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [selectedListId, setSelectedListId] = useState("");
  // Set while "New list…" is chosen in the Missing ingredients box: the name the list will be created with.
  const [newListName, setNewListName] = useState<string | null>(null);
  const [newRequestName, setNewRequestName] = useState("");
  const [newRequestMemberId, setNewRequestMemberId] = useState("");
  const [newSnackName, setNewSnackName] = useState("");
  const [newSnackMemberId, setNewSnackMemberId] = useState("");
  const [error, setError] = useState("");
  const [listNotice, setListNotice] = useState("");
  // The "Plan the week" form is always shown when there's no plan; with one,
  // it opens on demand so it doesn't push the week itself down the page.
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [view, setView] = useState<View>("plan");
  // "family" or a HouseholdMember id -- each person gets their own tab, per the
  // "3 meals a day per person, each in its own tab" request. Distinct from
  // `view` above: this picks whose meals the Plan grid shows.
  // The week on screen (its Monday), or null until the first load picks the latest plan's week. Every plan call
  // carries it as ?weekStart= (wk below), so paging weeks never touches which plan is "latest".
  const [week, setWeek] = useState<string | null>(null);
  const weekRef = useRef<string | null>(null);
  weekRef.current = week;
  // The calendar cell open for editing: a day, a meal, and "family" or a member id.
  const [sel, setSel] = useState<{ day: string; slot: string; who: string } | null>(null);
  const [addFor, setAddFor] = useState("family");
  const wk = (url: string) => (weekRef.current ? `${url}${url.includes("?") ? "&" : "?"}weekStart=${weekRef.current}` : url);
  // What the food diaries did about the last meal change, shown under the heading.
  const [notice, setNotice] = useState("");
  // Leftover offers fetched on demand, by meal id.
  const [offers, setOffers] = useState<Record<string, LeftoverOffer>>({});
  // The "Add a meal" form: a day, a meal (slot), and a recipe or a typed name.
  const [addDay, setAddDay] = useState("Monday");
  const [addSlot, setAddSlot] = useState("dinner");
  const [addRecipeId, setAddRecipeId] = useState("");
  const [addName, setAddName] = useState("");
  // Calories per person for the week on screen (not for the kiosk login). `null` = nothing to show.
  const [calories, setCalories] = useState<PlanCaloriesResponse | null>(null);
  const [caloriesLocked, setCaloriesLocked] = useState(false);
  // The meal whose Move panel is open.
  // The recipe open in the viewer (by id, so it follows the list when a save reloads it).
  const [viewRecipeId, setViewRecipeId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  // The kiosk board by date (only for the kiosk login, only when quick logging is on), what this screen has logged
  // (loggedKey -> the person's name) and who is being logged right now.
  const [boards, setBoards] = useState<Record<string, KioskBoard>>({});
  const [loggedFor, setLoggedFor] = useState<Map<string, string>>(new Map());
  const [logBusy, setLogBusy] = useState<Set<string>>(new Set());

  async function refresh() {
    try {
      const [plan, groceryLists, memberList] = await Promise.all([
        api.get<MealPlanResponse>(wk("/api/mealplan")),
        api.get<{ lists: ShoppingList[] }>("/api/grocery/lists"),
        api.get<{ members: HouseholdMember[] }>("/api/members"),
      ]);
      // The default has to come from the same filtered set the dropdown shows.
      // It used to be the first list of ANY status, so with an archived list
      // first the button added to a list the dropdown didn't even offer.
      // "Not archived" rather than "active": lists made before status existed
      // have none, and the Grocery tab shows those as ordinary lists.
      const active = groceryLists.lists.filter((l) => l.status !== "archived");
      setData(plan);
      if (weekRef.current === null) {
        const w = plan.plan?.weekStart ?? isoDate(mondayOf(new Date()));
        weekRef.current = w;
        setWeek(w);
      }
      setLists(active);
      setMembers(memberList.members);
      setSelectedListId((prev) => (active.some((l) => l.id === prev) ? prev : active[0]?.id || ""));
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, []);
  // Paging to another week re-reads the plan for it (the first load sets `week` itself and has just read it).
  const loadedWeek = useRef<string | null>(null);
  useEffect(() => {
    if (week === null) return;
    if (loadedWeek.current !== null && loadedWeek.current !== week) { setSel(null); refresh(); }
    loadedWeek.current = week;
  }, [week]);

  // Picks up a plan change made elsewhere (another device, the assistant)
  // without App.tsx's dataVersion remount, which would reset activeTab.
  useLiveRefresh(() => refresh(), KIOSK ? 30_000 : 60_000);

  // Calories per person for the week on screen. The server decides who is in the answer (you, plus anyone who shares
  // their totals or everything with you); nothing is added here. The kiosk login has no diary and never asks. Any
  // failure hides the block; a PIN-locked food diary (423) says so, with the unlock prompt.
  const weekStart = week;
  useEffect(() => {
    if (isKioskLogin || !weekStart) {
      setCalories(null);
      setCaloriesLocked(false);
      return;
    }
    let cancelled = false;
    api.get<PlanCaloriesResponse>(`/api/nutrition/plan/calories?weekStart=${encodeURIComponent(weekStart)}`)
      .then((res) => { if (!cancelled) { setCalories(res); setCaloriesLocked(false); } })
      .catch((err) => {
        if (cancelled) return;
        setCalories(null);
        setCaloriesLocked(err instanceof ApiError && err.status === 423);
      });
    return () => { cancelled = true; };
  }, [data, isKioskLogin, weekStart]);

  // The kiosk's "Log for" buttons need the board for each day up to today that has an approved meal. "Plan only"
  // (canQuickLog false), "hidden" (403) and any other failure give no boards, so no buttons.
  const planForBoards = data?.plan ?? null;
  useEffect(() => {
    if (!isKioskLogin || !planForBoards) {
      setBoards({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const today = await api.get<KioskBoard>("/api/nutrition/kiosk/today");
        if (!today.canQuickLog) { if (!cancelled) setBoards({}); return; }
        const dates = boardDates(planForBoards.weekStart, planForBoards.meals, today.date);
        const got = await Promise.all(dates.map(async (d) => [d, await api.get<KioskBoard>(`/api/nutrition/kiosk/day/${d}`)] as const));
        if (!cancelled) setBoards(Object.fromEntries(got));
      } catch {
        if (!cancelled) setBoards({});
      }
    })();
    return () => { cancelled = true; };
  }, [data, isKioskLogin, planForBoards]);

  // Every meal change returns the whole plan plus `sync`: what the food diaries did about it.
  function applyMealResponse(res: MealPlanResponse) {
    setData(res);
    setError("");
    setNotice(describeSync(res.sync));
  }

  async function setMealStatus(mealId: string, status: MealStatus) {
    try {
      applyMealResponse(await api.put<MealPlanResponse>(wk(`/api/mealplan/meals/${mealId}`), { status }));
    } catch (err: any) { setError(err.message); }
  }

  // A denied meal's slot filled with a saved recipe the server picks (pantry, calories, dislikes, no repeats).
  async function replaceDenied(mealId: string) {
    try {
      const res = await api.post<MealPlanResponse & { meal: { name: string } }>(wk(`/api/mealplan/meals/${mealId}/replace-denied`), {});
      applyMealResponse(res);
      setNotice(`Replaced with ${res.meal.name}. It's proposed, so approve it or deny it too.`);
    } catch (err: any) { setError(err.message); }
  }

  // Attach a recipe to a meal: a chosen joint recipe, or one made from the meal's own name and ingredients.
  async function setMealRecipe(mealId: string, choice: string) {
    if (!choice) return;
    try {
      const body = choice === "__create__" ? { createRecipe: true } : { recipeId: choice };
      applyMealResponse(await api.put<MealPlanResponse>(wk(`/api/mealplan/meals/${mealId}`), body));
    } catch (err: any) { setError(err.message); }
  }

  async function showLeftoverOffer(mealId: string) {
    try {
      const res = await api.get<{ offer: LeftoverOffer }>(wk(`/api/mealplan/meals/${mealId}/leftover-offer`));
      setOffers((prev) => ({ ...prev, [mealId]: res.offer }));
    } catch (err: any) { setError(err.message); }
  }

  async function addLeftover(mealId: string, day: string, slot: string) {
    try {
      applyMealResponse(await api.post<MealPlanResponse>(wk(`/api/mealplan/meals/${mealId}/leftovers`), { day, slot }));
      setOffers((prev) => { const next = { ...prev }; delete next[mealId]; return next; });
    } catch (err: any) { setError(err.message); }
  }

  // Move a meal to another day and/or meal. The server re-checks the same rules and answers with the diaries' `sync`.
  async function moveMeal(mealId: string, day: string, slot: string) {
    setMoveBusy(true);
    try {
      applyMealResponse(await api.put<MealPlanResponse>(wk(`/api/mealplan/meals/${mealId}`), { day, slot }));
      setMovingId(null);
    } catch (err: any) { setError(err.message); }
    finally { setMoveBusy(false); }
  }

  // The kiosk's "Log for": one tap marks that person's planned portion of this meal as eaten.
  async function logForPerson(date: string, mealId: string, chip: LogChip) {
    const key = loggedKey(mealId, chip.userId);
    setLogBusy((prev) => new Set(prev).add(key));
    try {
      const board = await api.post<KioskBoard>("/api/nutrition/kiosk/log", { userId: chip.userId, entryIds: chip.entryIds, date });
      setBoards((prev) => ({ ...prev, [date]: board }));
      setLoggedFor((prev) => new Map(prev).set(key, chip.name));
      setError("");
    } catch (err: any) { setError(err.message); }
    finally {
      setLogBusy((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }

  async function addMeal(e: React.FormEvent) {
    e.preventDefault();
    if (!addRecipeId && !addName.trim()) return;
    try {
      const who = addFor === "family" ? {} : { audience: "individual", memberId: addFor };
      const body = addRecipeId
        ? { day: addDay, slot: addSlot, recipeId: addRecipeId, ...who }
        : { day: addDay, slot: addSlot, name: addName.trim(), ...who };
      applyMealResponse(await api.post<MealPlanResponse>(wk("/api/mealplan/meals"), body));
      setAddRecipeId("");
      setAddName("");
    } catch (err: any) { setError(err.message); }
  }

  // Merges an individual meal back into the family's. If a family meal already
  // exists for that day/slot, this one is redundant once merged -- deleted
  // rather than converted, so the slot doesn't end up with two "family" meals.
  async function mergeToFamily(meal: PlannedMeal) {
    try {
      const familyMealExists = data?.plan?.meals.some(
        (m) => m.day === meal.day && m.slot === meal.slot && m.id !== meal.id && (m.audience || "family") === "family"
      );
      const res = familyMealExists
        ? await api.del<MealPlanResponse>(wk(`/api/mealplan/meals/${meal.id}`))
        : await api.put<MealPlanResponse>(wk(`/api/mealplan/meals/${meal.id}`), { audience: "family" });
      applyMealResponse(res);
    } catch (err: any) { setError(err.message); }
  }

  // Adds a brand-new meal just for one person on a day/slot that currently only
  // has (or has no) family meal, without touching the family's own entry.
  async function addIndividualMeal(day: string, slot: string, from: PlannedMeal, memberId: string) {
    try {
      // Starts as the same dish (same recipe), so the person only changes it if they want a different one.
      const res = await api.post<MealPlanResponse>(wk("/api/mealplan/meals"), from.recipeId
        ? { day, slot, recipeId: from.recipeId, audience: "individual", memberId }
        : { day, slot, name: from.name, ingredients: from.ingredients, audience: "individual", memberId });
      applyMealResponse(res);
      // The new meal lives in that person's row, not the one being looked at, so without this the click seems to do
      // nothing: jump to their cell and say what happened.
      const who = members.find((m) => m.id === memberId);
      setSel({ day, slot, who: memberId });
      setNotice(`${who?.name ?? "They"} now have their own ${slotLabel(slot).toLowerCase()} on ${day}. Change it below, or merge it back to the family meal.`);
    } catch (err: any) { setError(err.message); }
  }

  async function addMissingToList() {
    const creating = newListName !== null;
    if (creating ? !newListName.trim() : !selectedListId) return;
    setListNotice("");
    try {
      // "New list…": make the list here so the person doesn't have to leave the plan and come back.
      let listId = selectedListId;
      let createdName = "";
      if (creating) {
        const made = await api.post<{ list: ShoppingList }>("/api/grocery/lists", { name: newListName.trim() });
        listId = made.list.id;
        createdName = made.list.name;
        setLists((prev) => [made.list, ...prev]);
        setSelectedListId(listId);
        setNewListName(null);
      }
      const res = await api.post<{ added: string[]; alreadyOnList: string[] }>(wk(`/api/mealplan/add-missing`), {
        listId,
      });
      const listName = createdName || lists.find((l) => l.id === listId)?.name || "the list";
      const already = res.alreadyOnList.length;
      setListNotice(
        res.added.length === 0
          ? `Everything missing is already on ${listName}.`
          : `Added ${res.added.length} item${res.added.length === 1 ? "" : "s"} to ${listName}` +
              (already ? ` (${already} already on it).` : ".")
      );
      await refresh();
    } catch (err: any) { setError(err.message); }
  }

  // Meal and snack requests are the same shape in two lists, so one pair of handlers serves both.
  async function addRequest(e: React.FormEvent, kind: "meal" | "snack" = "meal") {
    e.preventDefault();
    const snack = kind === "snack";
    const name = snack ? newSnackName : newRequestName;
    const memberId = snack ? newSnackMemberId : newRequestMemberId;
    if (!name.trim()) return;
    try {
      const res = await api.post<MealPlanResponse>(wk(snack ? "/api/mealplan/snack-requests" : "/api/mealplan/requests"), {
        name,
        memberId: memberId || undefined,
      });
      setData(res);
      if (snack) { setNewSnackName(""); setNewSnackMemberId(""); }
      else { setNewRequestName(""); setNewRequestMemberId(""); }
    } catch (err: any) { setError(err.message); }
  }

  async function removeRequest(id: string, kind: "meal" | "snack" = "meal") {
    try {
      const res = await api.del<MealPlanResponse>(wk(`/api/mealplan/${kind === "snack" ? "snack-requests" : "requests"}/${id}`));
      setData(res);
    } catch (err: any) { setError(err.message); }
  }

  function renderRequests(kind: "meal" | "snack") {
    const snack = kind === "snack";
    const list = snack ? snackRequests ?? [] : requests;
    return (
      <>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><ClipboardList size={15} /> {snack ? "Snack requests" : "Meal requests"}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
          {snack ? "Ask for a snack to be picked up or made." : "Ask for a meal to be worked into the next plan."}
        </p>
        <form onSubmit={(e) => addRequest(e, kind)} className="flex flex-wrap gap-2 mb-3">
          <input
            className="flex-1 min-w-[10rem] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder={snack ? "Request a snack…" : "Request a meal…"}
            value={snack ? newSnackName : newRequestName}
            onChange={(e) => (snack ? setNewSnackName : setNewRequestName)(e.target.value)}
          />
          <select
            className="px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            value={snack ? newSnackMemberId : newRequestMemberId}
            onChange={(e) => (snack ? setNewSnackMemberId : setNewRequestMemberId)(e.target.value)}
            aria-label="Requested by"
          >
            <option value="">Anyone</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white" aria-label={snack ? "Add snack request" : "Add meal request"}>
            <Plus size={16} />
          </button>
        </form>
        {list.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{snack ? "No snack requests yet." : "No meal requests yet."}</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {list.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <div className="flex-1">
                  <div className="text-sm">{r.name}</div>
                  {r.memberId && (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Requested by {members.find((m) => m.id === r.memberId)?.name || "a former member"}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => removeRequest(r.id, kind)}
                  className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                  aria-label={`Remove ${snack ? "snack " : ""}request for ${r.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  // This section owns the data but not the editing of all of it. The roster
  // belongs to the Family tab, likes and dislikes to the Preferences sub-view,
  // and saving or deleting a recipe to the Recipes sub-view -- which is handed
  // `refresh` so a change there re-reads the plan too, since a new recipe can
  // change what the week is missing.

  if (!data) return null;

  const { plan, missing, conflicts, recipes, requests, snackRequests, groceryBudget } = data;
  // Your own favourites and ratings (per person: the server sends only yours; the kitchen screen has none).
  const marks = data.marks ?? {};
  // The meals a planned meal can use (the standard four plus the household's own), and the recipes it may name:
  // joint ones only, because everyone reads the shared plan.
  const slots = data.slots?.length ? data.slots : [
    { key: "breakfast", label: "Breakfast", standard: true }, { key: "lunch", label: "Lunch", standard: true },
    { key: "dinner", label: "Dinner", standard: true }, { key: "snacks", label: "Snacks", standard: true },
  ];
  const slotLabel = (key: string) => slots.find((s) => s.key === key)?.label ?? key;
  const jointRecipes = recipes.filter((r) => r.scope !== "personal");
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  // A meal in a slot the household doesn't list any more (or a custom one) still gets a row, after the known ones.
  const slotKeys = [...slots.map((s) => s.key), ...(plan ? [...new Set(plan.meals.map((m) => m.slot))].filter((k) => !slots.some((s) => s.key === k)) : [])];
  const conflictsByMeal = new Map<string, string[]>();
  for (const c of conflicts) {
    conflictsByMeal.set(c.mealId, [...(conflictsByMeal.get(c.mealId) || []), `${c.member} won't eat ${c.ingredient}`]);
  }


  const MAIN_SLOTS = ["breakfast", "lunch", "dinner"];
  // Breakfast, lunch and dinner always show; snacks or a household's own meal only when this week uses it.
  const shownSlots = [...MAIN_SLOTS, ...slotKeys.filter((k) => !MAIN_SLOTS.includes(k) && plan?.meals.some((m) => m.slot === k))];
  const people: { id: string; name: string; member: HouseholdMember | null }[] = [
    { id: "family", name: "Family (shared)", member: null },
    ...members.map((m) => ({ id: m.id, name: m.name, member: m })),
  ];
  const thisMonday = isoDate(mondayOf(new Date()));
  const shiftWeek = (n: number) => setWeek(addDays(week!, 7 * n));
  const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const weekNav = (
    <div className="flex items-center gap-2 mb-3">
      <button onClick={() => shiftWeek(-1)} className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Previous week">
        <ChevronLeft size={16} />
      </button>
      <div className="text-sm font-medium min-w-[9rem] text-center">
        {week ? `${fmtDay(week)} – ${fmtDay(addDays(week, 6))}` : ""}
        {week === thisMonday && <span className="ml-1.5 text-xs text-blue-600 dark:text-blue-400">this week</span>}
      </div>
      <button onClick={() => shiftWeek(1)} className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Next week">
        <ChevronRight size={16} />
      </button>
      {week !== thisMonday && (
        <button onClick={() => setWeek(thisMonday)} className="px-2.5 py-1 rounded-lg text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40">
          Today
        </button>
      )}
    </div>
  );

  // The meal in one calendar cell: the person's own meal if they have one, else the family's (shown inherited).
  function cellMeal(day: string, slot: string, who: string): { meal: PlannedMeal | undefined; inherited: boolean } {
    const dayMeals = plan?.meals.filter((m) => m.day === day) ?? [];
    const family = dayMeals.find((m) => m.slot === slot && (m.audience || "family") === "family");
    if (who === "family") return { meal: family, inherited: false };
    const own = dayMeals.find((m) => m.slot === slot && m.audience === "individual" && m.memberId === who);
    return own ? { meal: own, inherited: false } : { meal: family, inherited: true };
  }

  function openCell(day: string, slot: string, who: string) {
    const { meal } = cellMeal(day, slot, who);
    setSel({ day, slot, who });
    if (!meal) { setAddDay(day); setAddSlot(slot); setAddFor(who); }
  }

  const tone = (m: PlannedMeal) =>
    m.status === "denied" ? "opacity-50 line-through border-slate-200 dark:border-slate-800"
      : m.status === "approved" ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30"
      : "border-slate-200 dark:border-slate-800";

  function renderCalendar() {
    return (
      <div className="space-y-5 overflow-x-auto pb-2">
        {people.map((person) => (
          <div key={person.id} className="min-w-[44rem]">
            <h3 className="text-sm font-semibold mb-1.5">{person.name}</h3>
            <div className="grid grid-cols-7 gap-1.5">
              {DAYS.map((day, i) => {
                const date = addDays(plan?.weekStart ?? week!, i);
                return (
                  <div key={day} className="space-y-1.5">
                    <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
                      {day.slice(0, 3)} <span className="text-slate-400">{fmtDay(date)}</span>
                    </div>
                    {person.id === "family" && <PlanCalories rows={rowsForDate(calories, date)} />}
                    {shownSlots.map((slot) => {
                      const { meal, inherited } = cellMeal(day, slot, person.id);
                      const selected = sel?.day === day && sel.slot === slot && sel.who === person.id;
                      return (
                        <button
                          key={slot}
                          onClick={() => (selected ? setSel(null) : openCell(day, slot, person.id))}
                          className={`w-full text-left rounded-lg border p-1.5 text-xs min-h-[3.25rem] ${
                            meal ? tone(meal) : "border-dashed border-slate-300 dark:border-slate-700 text-slate-400"
                          } ${inherited ? "border-dashed" : ""} ${selected ? "ring-2 ring-blue-500" : ""}`}
                          aria-label={`${person.name} ${slotLabel(slot)} ${day}${meal ? `: ${meal.name}` : ": empty"}`}
                        >
                          <div className="text-[10px] uppercase tracking-wide text-slate-400">{slotLabel(slot)}</div>
                          {meal ? (
                            <div className="leading-snug line-clamp-3">{meal.name}</div>
                          ) : (
                            <div className="flex items-center gap-0.5 mt-0.5"><Plus size={11} /> Add</div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderDetail() {
    if (!sel) return null;
    const person = people.find((p) => p.id === sel.who);
    const { meal, inherited } = cellMeal(sel.day, sel.slot, sel.who);
    const dayDate = addDays(plan?.weekStart ?? week!, DAYS.indexOf(sel.day));
    return (
      <div className="mt-3 max-w-md">
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
          {person?.name} · {sel.day} {fmtDay(dayDate)} · {slotLabel(sel.slot)}
        </p>
        {meal ? (
          renderCard(meal, inherited, person?.member ?? null, sel.day, sel.slot, dayDate)
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">Nothing planned. Use “Add a meal” below.</p>
        )}
      </div>
    );
  }

  function renderCard(meal: PlannedMeal, inherited: boolean, activeMember: HouseholdMember | null, day: string, slot: string, dayDate: string) {
    const mealConflicts = conflictsByMeal.get(meal.id);
    return (
                            <div
                              className={`rounded-lg border p-2.5 text-sm ${
                                meal.status === "denied"
                                  ? "border-slate-200 dark:border-slate-800 opacity-50"
                                  : meal.status === "approved"
                                    ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30"
                                    : "border-slate-200 dark:border-slate-800"
                              } ${inherited ? "border-dashed" : ""}`}
                            >
                              <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">
                                <span>{slotLabel(slot)}{inherited ? " · family" : ""}</span>
                              </div>
                              <div className={meal.status === "denied" ? "line-through" : ""}>{meal.name}</div>
                              {/* The recipe behind the meal and its calories per serving. A meal saved before recipes were
                                  linked has none: it can't be approved until one is picked or made from its name. */}
                              {meal.recipeId ? (
                                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                  {(() => {
                                    // The recipe line opens the viewer (ingredients and steps) for family, inherited and leftover meals
                                    // alike: a leftover meal carries its original meal's recipeId, so it opens the same recipe.
                                    const r = recipeById.get(meal.recipeId!);
                                    const kcal = kcalOf(r);
                                    if (!r) return <><ChefHat size={11} className="shrink-0" /><span>Recipe was deleted</span></>;
                                    return (
                                      <button
                                        onClick={() => setViewRecipeId(r.id)}
                                        className="flex items-center gap-1 text-left hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                                        aria-label={`View recipe for ${meal.name}`}
                                      >
                                        <ChefHat size={11} className="shrink-0" />
                                        <span>
                                          {kcal === null ? "No calories yet" : `${kcal} kcal/serving${r.nutrition && !r.nutrition.complete ? " (partly estimated)" : ""}`}
                                          {" · View recipe"}
                                        </span>
                                      </button>
                                    );
                                  })()}
                                  {meal.leftoverOf && <span className="ml-1 text-emerald-600 dark:text-emerald-400">leftovers</span>}
                                </div>
                              ) : (
                                !inherited && (
                                  <RecipePicker
                                    className="mt-1"
                                    compact
                                    recipes={jointRecipes}
                                    marks={marks}
                                    value=""
                                    onChange={(id) => setMealRecipe(meal.id, id)}
                                    special={[{ id: "__create__", label: "Create one from this meal" }]}
                                    placeholder="Pick a recipe…"
                                    ariaLabel={`Pick a recipe for ${meal.name}`}
                                  />
                                )
                              )}
                              {mealConflicts && (
                                <div className="mt-1.5 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                                  <span>{mealConflicts.join("; ")}</span>
                                </div>
                              )}
                              <div className="mt-2 flex flex-wrap items-center gap-1">
                                {!inherited && (
                                  <>
                                    <button
                                      onClick={() => setMealStatus(meal.id, meal.status === "approved" ? "proposed" : "approved")}
                                      className={`p-1 rounded ${
                                        meal.status === "approved"
                                          ? "bg-emerald-600 text-white"
                                          : "text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                      }`}
                                      aria-label={`Approve ${meal.name}`}
                                    >
                                      <Check size={13} />
                                    </button>
                                    <button
                                      onClick={() => setMealStatus(meal.id, meal.status === "denied" ? "proposed" : "denied")}
                                      className={`p-1 rounded ${
                                        meal.status === "denied"
                                          ? "bg-red-600 text-white"
                                          : "text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                      }`}
                                      aria-label={`Deny ${meal.name}`}
                                    >
                                      <X size={13} />
                                    </button>
                                    {meal.status === "denied" && !meal.leftoverOf && (
                                      <button
                                        onClick={() => replaceDenied(meal.id)}
                                        className="px-1.5 py-1 rounded text-xs text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1"
                                        title="Swap in a saved recipe that fits: pantry, calories, dislikes, no repeats"
                                        aria-label={`Suggest a replacement for ${meal.name}`}
                                      >
                                        <Sparkles size={13} /> Suggest replacement
                                      </button>
                                    )}
                                  </>
                                )}
                                {activeMember && !inherited && (
                                  <button
                                    onClick={() => mergeToFamily(meal)}
                                    className="ml-auto p-1 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                    title={`Merge back to the family meal`}
                                    aria-label={`Merge ${meal.name} back to family`}
                                  >
                                    <ArrowLeftRight size={13} />
                                  </button>
                                )}
                                {activeMember && inherited && (
                                  <button
                                    onClick={() => addIndividualMeal(day, slot, meal, activeMember.id)}
                                    className="ml-auto text-[10px] font-medium text-blue-600 hover:underline"
                                    title={`Give ${activeMember.name} a different ${slot}`}
                                  >
                                    Split for {activeMember.name}
                                  </button>
                                )}
                                {!inherited && (
                                  <button
                                    onClick={() => setMovingId(movingId === meal.id ? null : meal.id)}
                                    className="px-1.5 py-1 rounded text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1"
                                    title="Move to another day or meal"
                                    aria-label={`Move ${meal.name} to another day or meal`}
                                    aria-expanded={movingId === meal.id}
                                  >
                                    <CalendarDays size={13} /> Move
                                  </button>
                                )}
                                {!inherited && meal.recipeId && !meal.leftoverOf && meal.status !== "denied" && (
                                  <button
                                    onClick={() => showLeftoverOffer(meal.id)}
                                    className="p-1 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                    title="Leftovers from this meal"
                                    aria-label={`Leftovers from ${meal.name}`}
                                  >
                                    <Repeat size={13} />
                                  </button>
                                )}
                                {!activeMember && (
                                  <div className="ml-auto flex gap-1">
                                    {members.map((m) => (
                                      <button
                                        key={m.id}
                                        onClick={() => addIndividualMeal(day, slot, meal, m.id)}
                                        className="text-[10px] font-medium text-blue-600 hover:underline"
                                        title={`Give ${m.name} a different ${slot} instead of the family meal`}
                                      >
                                        Split for {m.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              {movingId === meal.id && !inherited && (
                                <MoveMeal
                                  meal={meal}
                                  meals={plan?.meals ?? []}
                                  slots={slots}
                                  busy={moveBusy}
                                  onMove={(d, sl) => moveMeal(meal.id, d, sl)}
                                  onClose={() => setMovingId(null)}
                                />
                              )}
                              {offers[meal.id] && (
                                <LeftoverPicker
                                  mealName={meal.name}
                                  offer={offers[meal.id]}
                                  slotLabel={slotLabel}
                                  onPick={(d, sl) => addLeftover(meal.id, d, sl)}
                                  onClose={() => setOffers((prev) => { const next = { ...prev }; delete next[meal.id]; return next; })}
                                />
                              )}
                              {isKioskLogin && (
                                <KioskLogFor
                                  mealName={meal.name}
                                  chips={logChips(boards[dayDate], meal, loggedFor)}
                                  isBusy={(userId) => logBusy.has(loggedKey(meal.id, userId))}
                                  onLog={(chip) => logForPerson(dayDate, meal.id, chip)}
                                />
                              )}
                            </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-3">Meal Plan</h2>
        {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {notice && <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{notice}</p>}

        {/* Sub-tabs. Planning the week, knowing who won't eat what, and keeping
            a collection to plan from are three jobs that all belong to meal
            planning. Note these are a different axis from the per-person tabs
            inside the Plan view below -- those pick whose meals you're looking
            at, these pick what you're doing -- which is why they sit above
            rather than beside them. */}
        <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800 overflow-x-auto">
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`px-3 py-1.5 text-sm border-b-2 -mb-px whitespace-nowrap ${
                view === id
                  ? "border-blue-600 text-blue-600 dark:text-blue-400 font-medium"
                  : "border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {view === "plan" && (
        <div>
          {groceryBudget && (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Wallet size={13} /> Planning to a grocery budget of about ${Math.round(groceryBudget.weekly)}/week
              (${Math.round(groceryBudget.monthly)}/month)
            </p>
          )}
          {weekNav}
          {!plan && <div className="mb-4"><PlanWeek onPlanned={refresh} /></div>}
          {(
            <>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span />
                {plan && !showPlanForm && (
                  <button
                    onClick={() => setShowPlanForm(true)}
                    className="px-2.5 py-1 rounded-lg text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 flex items-center gap-1.5"
                  >
                    <Sparkles size={14} /> Plan a week
                  </button>
                )}
              </div>
              {plan && showPlanForm && (
                <div className="mb-4">
                  <PlanWeek
                    existingWeekStart={plan?.weekStart}
                    onPlanned={() => { setShowPlanForm(false); refresh(); }}
                    onCancel={() => setShowPlanForm(false)}
                  />
                </div>
              )}

              {calories && hasCalorieRows(calories) && (
                <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{CALORIES_LEGEND}</p>
              )}
              {caloriesLocked && (
                <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                  Calories per person are hidden while your food diary is locked.{" "}
                  {onRequestUnlock && (
                    <button onClick={onRequestUnlock} className="text-blue-600 dark:text-blue-400 hover:underline">Unlock</button>
                  )}
                </p>
              )}

              {renderCalendar()}

              {sel && renderDetail()}

              {/* Add a meal: pick a recipe, or type a name and one is made for it (with its calories worked out from
                  the ingredients where it can be). Every planned meal is a recipe. */}
              <form onSubmit={addMeal} className="mt-4 p-3 rounded-lg border border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Add a meal</span>
                <select
                  className="px-2 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  value={addFor}
                  onChange={(e) => setAddFor(e.target.value)}
                  aria-label="For"
                >
                  <option value="family">Family</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <select
                  className="px-2 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  value={addDay}
                  onChange={(e) => setAddDay(e.target.value)}
                  aria-label="Day"
                >
                  {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <select
                  className="px-2 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  value={addSlot}
                  onChange={(e) => setAddSlot(e.target.value)}
                  aria-label="Meal"
                >
                  {slots.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <RecipePicker
                  className="min-w-[9rem]"
                  recipes={jointRecipes}
                  marks={marks}
                  value={addRecipeId}
                  onChange={setAddRecipeId}
                  special={[{ id: "", label: "A new dish…" }]}
                  placeholder="A new dish…"
                  ariaLabel="Recipe"
                />
                {!addRecipeId && (
                  <input
                    className="flex-1 min-w-[8rem] px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    placeholder="Dish name"
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                  />
                )}
                <button className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm" aria-label="Add meal">
                  <Plus size={16} />
                </button>
              </form>

              <div className="mt-6 p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                <h3 className="text-sm font-medium mb-2">Missing ingredients</h3>
                {listNotice && <p className="mb-2 text-sm text-green-700 dark:text-green-400">{listNotice}</p>}
                {missing.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">The pantry covers this plan.</p>
                ) : (
                  <>
                    <div className="text-sm mb-3 space-y-2">
                      {(data.missingByMeal ?? [])
                        .slice()
                        .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day))
                        .map((row) => (
                          <div key={row.mealId}>
                            <p className="font-medium">
                              {row.name}{" "}
                              <span className="font-normal text-xs text-slate-500 dark:text-slate-400">
                                {row.day.slice(0, 3)} · {slotLabel(row.slot)}
                                {row.memberId ? ` · for ${members.find((m) => m.id === row.memberId)?.name ?? "one person"}` : ""} · {row.missing.length} missing
                              </span>
                            </p>
                            <p className="text-slate-600 dark:text-slate-300">{row.missing.join(", ")}</p>
                          </div>
                        ))}
                    </div>
                    <div className="flex gap-2">
                      <select
                        className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                        value={newListName !== null ? NEW_LIST : selectedListId}
                        onChange={(e) => {
                          if (e.target.value === NEW_LIST) setNewListName(`Groceries, week of ${fmtDay(plan?.weekStart ?? week!)}`);
                          else { setNewListName(null); setSelectedListId(e.target.value); }
                        }}
                        aria-label="Shopping list"
                      >
                        {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        <option value={NEW_LIST}>+ New list…</option>
                      </select>
                      <button
                        onClick={addMissingToList}
                        disabled={newListName !== null ? !newListName.trim() : !selectedListId}
                        className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium"
                      >
                        {newListName !== null ? "Create list and add" : "Add to shopping list"}
                      </button>
                    </div>
                    {newListName !== null && (
                      <input
                        className="mt-2 w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                        value={newListName}
                        onChange={(e) => setNewListName(e.target.value)}
                        placeholder="Name the new list"
                        aria-label="New list name"
                      />
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {view === "plan" && (
        <div>
          {renderRequests("meal")}
          <div className="mt-6">{renderRequests("snack")}</div>
        </div>
      )}


      {view === "prefs" && <Preferences />}
      {view === "recipes" && (
        <Recipes recipes={recipes} marks={marks} onChanged={refresh} onRequestUnlock={onRequestUnlock} canCalculate={canCalculateCalories} canEdit canMark={!isKioskLogin} />
      )}
      {viewRecipeId && recipeById.get(viewRecipeId) && (
        <RecipeView
          recipe={recipeById.get(viewRecipeId)!}
          onClose={() => setViewRecipeId(null)}
          canEdit
          onSaved={refresh}
          onRequestUnlock={onRequestUnlock}
          mark={marks[viewRecipeId]}
          canMark={!isKioskLogin}
        />
      )}
    </div>
  );
}
