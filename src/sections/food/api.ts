// The Food section's calls to /api/nutrition/*, in one place. Plain online requests: nothing is queued
// or cached for later (offline logging is a future feature), so a failed call throws an ApiError whose
// message is the server's own, or "Request failed" for a network error, and the screen shows it.
//
// Who is asking is always the signed-in login (the server takes it from the session); nothing here sends
// a user id. "Calorie budget" is the only budget in these routes.

import { api, ApiError, type FoodDiaryPinStatus } from "../../api.ts";
import type {
  BarcodeMiss, DayResponse, DaySummary, Exercise, Food, Goal, GoalsResponse, KioskFoodAccess, KioskFoodSetting, PantrySuggestions, Photo, PreviousMeal,
  Profile, RecipeCreated, RecipeListItem, SavedMeal, SchedulePreview, SettingsSlot, SharedDay, SharedProgress, Sharer, SnackAllowance, StepsDay, Streak, StreakResponse,
  Visibility, VisibilitySetting, Weight, WeightStartSetting, WeightTrend,
} from "./types.ts";
import type { GoalBody } from "./goalForm.ts";
import type { ProfileBody } from "./profileForm.ts";
import type { BulkBody, RecipeFromMealBody } from "./meals.ts";
import type { CreateFoodBody, ExerciseBody, QuickAddBody } from "./forms.ts";
import type { ImportReport } from "./importView.ts";
import type { WeightRange } from "./weightRange.ts";

const N = "/api/nutrition";

export { ApiError };

/** The message to show for a failed call. A fetch that never got an answer is a TypeError; say what it means. */
export function errorText(err: unknown): string {
  // 423 is the food-diary PIN lock (requireUnlocked answers just "locked").
  if (err instanceof ApiError && err.status === 423) return "Your food diary is locked. Unlock it with the PIN, then try again.";
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  return err instanceof Error && err.message ? err.message : "Something went wrong.";
}

export interface BarcodeFoodAnswer {
  created: boolean;
  food: Food;
}

export interface BulkAnswer {
  created: number;
  summary: DaySummary;
}

export interface DoneAnswer extends DaySummary {
  streak: Streak;
}

/**
 * Sends the Lose It! ZIP as the raw request body (Content-Type: application/zip), with the options in the query. The server reads
 * it for the signed-in login only. A failure throws an ApiError carrying the server's own sentence, like api.ts's other calls.
 */
async function postZip<T>(url: string, file: Blob): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status, data);
  return data as T;
}

export const foodApi = {
  // ---- the day ----
  streak: () => api.get<StreakResponse>(`${N}/me/streak`),
  day: (date: string) => api.get<DayResponse>(`${N}/diary/${date}`),
  addEntry: (date: string, body: Record<string, unknown>) => api.post<{ summary: DaySummary }>(`${N}/diary/${date}`, body),
  addQuick: (date: string, body: QuickAddBody) => api.post<{ summary: DaySummary }>(`${N}/diary/${date}`, body),
  bulk: (date: string, body: BulkBody) => api.post<BulkAnswer>(`${N}/diary/${date}/bulk`, body),
  patchEntry: (id: string, body: Record<string, unknown>) => api.patch<{ summary: DaySummary }>(`${N}/diary/entry/${id}`, body),
  deleteEntry: (id: string) => api.del<{ ok: boolean }>(`${N}/diary/entry/${id}`),
  deleteGroup: (groupId: string) => api.del<{ ok: boolean; deleted: number }>(`${N}/diary/group/${groupId}`),
  logAll: (date: string, slot: string) => api.post<{ logged: string[]; summary: DaySummary }>(`${N}/diary/${date}/log-all`, { slot }),
  markDone: (date: string) => api.post<DoneAnswer>(`${N}/days/${date}/done`),

  // ---- foods ----
  search: (q: string) => api.get<Food[]>(`${N}/foods/search?q=${encodeURIComponent(q)}&limit=25`),
  recent: () => api.get<Food[]>(`${N}/foods/recent?limit=30`),
  food: (id: string) => api.get<Food>(`${N}/foods/${id}`),
  createFood: (body: CreateFoodBody) => api.post<Food>(`${N}/foods`, body),
  setFoodScope: (id: string, scope: "joint" | "personal") => api.patch<Food>(`${N}/foods/${id}`, { scope }),

  // ---- barcodes ----
  lookupBarcode: (code: string, format?: string) => api.post<BarcodeFoodAnswer>(`${N}/barcodes/lookup`, { code, format }),
  linkCandidates: (q: string) => api.get<Food[]>(`${N}/foods/link-candidates?q=${encodeURIComponent(q)}&limit=5`),
  linkBarcode: (foodId: string, body: { code: string; format?: string; replaceFoodId?: string }) =>
    api.post<{ food: Food }>(`${N}/foods/${foodId}/barcode`, body),
  unlinkBarcode: (foodId: string) => api.del<{ food: Food }>(`${N}/foods/${foodId}/barcode`),

  // ---- meals and recipes ----
  savedMeals: () => api.get<SavedMeal[]>(`${N}/saved-meals`),
  previousMeals: () => api.get<PreviousMeal[]>(`${N}/meals/previous?limit=20`),
  saveMeal: (body: { name: string; scope: "joint" | "personal"; defaultSlotKey: string; items: Array<Record<string, unknown>> }) =>
    api.post<SavedMeal>(`${N}/saved-meals`, body),
  recipes: () => api.get<RecipeListItem[]>(`${N}/recipes`),
  /** Save as recipe: a NEW recipe from the foods of a meal that was eaten. */
  createRecipe: (body: RecipeFromMealBody) => api.post<RecipeCreated>(`${N}/recipes`, body),
  renameSavedMeal: (id: string, name: string) => api.put<SavedMeal>(`${N}/saved-meals/${id}`, { name }),
  deleteSavedMeal: (id: string) => api.del<{ ok: boolean }>(`${N}/saved-meals/${id}`),

  // ---- exercise ----
  exercise: (date: string) => api.get<Exercise[]>(`${N}/exercise?date=${date}`),
  recentExercise: () => api.get<Exercise[]>(`${N}/exercise/recent?limit=8`),
  addExercise: (body: ExerciseBody & { localDate: string }) => api.post<Exercise>(`${N}/exercise`, body),
  updateExercise: (id: string, body: ExerciseBody) => api.patch<Exercise>(`${N}/exercise/${id}`, body),
  deleteExercise: (id: string) => api.del<{ ok: boolean }>(`${N}/exercise/${id}`),

  // ---- weigh-ins (stored in kg; a pound entry is sent as weightLb) ----
  weights: (from: string) => api.get<Weight[]>(`${N}/weights?from=${from}`),
  /** The chart's points for a range (the server works the trend out from the whole history), plus "I started on" and its trend. */
  weightTrend: (range: WeightRange) => api.get<WeightTrend>(`${N}/weights/trend?range=${range}`),
  weightStart: () => api.get<WeightStartSetting>(`${N}/me/weight-start`),
  /** null clears the start day. */
  setWeightStart: (weightStartDate: string | null) => api.put<WeightStartSetting>(`${N}/me/weight-start`, { weightStartDate }),
  addWeight: (body: ({ weightLb: number } | { weightKg: number }) & { measuredOn: string }) => api.post<{ created: boolean; id: string }>(`${N}/weights`, body),
  deleteWeight: (id: string) => api.del<{ ok: boolean }>(`${N}/weights/${id}`),

  // ---- steps, typed by hand ----
  steps: (from: string, to: string) => api.get<StepsDay[]>(`${N}/steps?from=${from}&to=${to}`),
  putSteps: (date: string, steps: number) => api.put<StepsDay>(`${N}/steps/${date}`, { steps }),
  deleteSteps: (date: string) => api.del<{ ok: boolean }>(`${N}/steps/${date}`),

  // ---- progress photos: private, never shared ----
  photos: () => api.get<Photo[]>(`${N}/photos`),
  addPhoto: (body: { data: string; takenOn: string }) => api.post<{ created: boolean; photo: Photo }>(`${N}/photos`, body),
  deletePhoto: (id: string) => api.del<{ ok: boolean }>(`${N}/photos/${id}`),
  /** Where the picture itself is (same-origin, so the session cookie rides along on an <img>). */
  photoUrl: (id: string) => `${N}/photos/${encodeURIComponent(id)}/image`,

  // ---- who sees what ----
  visibility: () => api.get<VisibilitySetting>(`${N}/me/visibility`),
  setVisibility: (visibility: Visibility) => api.put<VisibilitySetting>(`${N}/me/visibility`, { visibility }),
  sharing: () => api.get<Sharer[]>(`${N}/sharing`),
  /** `date` may be "today": THEIR today (their timezone). */
  sharedDay: (userId: string, date: string) => api.get<SharedDay>(`${N}/people/${encodeURIComponent(userId)}/day/${date}`),
  sharedProgress: (userId: string, range: WeightRange) => api.get<SharedProgress>(`${N}/people/${encodeURIComponent(userId)}/progress?range=${range}`),

  // ---- Food settings ----
  profile: () => api.get<Profile>(`${N}/me/profile`),
  saveProfile: (body: ProfileBody) => api.put<Profile>(`${N}/me/profile`, body),
  goals: () => api.get<GoalsResponse>(`${N}/me/goals`),
  saveGoal: (body: GoalBody) => api.post<Goal>(`${N}/me/goals`, body),
  previewGoal: (body: Record<string, unknown>) => api.post<SchedulePreview>(`${N}/me/goals/preview`, body),
  slots: () => api.get<SettingsSlot[]>(`${N}/me/slots`),
  addSlot: (body: Record<string, unknown>) => api.post<SettingsSlot>(`${N}/me/slots`, body),
  updateSlot: (key: string, body: Record<string, unknown>) => api.put<SettingsSlot>(`${N}/me/slots/${encodeURIComponent(key)}`, body),
  reorderSlots: (keys: string[]) => api.post<SettingsSlot[]>(`${N}/me/slots/reorder`, { keys }),
  snackAllowance: () => api.get<SnackAllowance>(`${N}/me/snack-allowance`),
  setSnackAllowance: (snackAllowancePct: number) => api.put<SnackAllowance>(`${N}/me/snack-allowance`, { snackAllowancePct }),
  pinSetting: () => api.get<FoodDiaryPinStatus>(`${N}/settings/pin`),
  setPinSetting: (requirePin: boolean) => api.put<FoodDiaryPinStatus>(`${N}/settings/pin`, { requirePin }),

  // ---- Import from Lose It! (into your own diary) ----
  /** The whole import, rolled back: the answer is exactly what a real run would do. */
  importLoseItDryRun: (file: Blob, query: string) => postZip<ImportReport>(`${N}/import/loseit/dry-run?${query}`, file),
  importLoseIt: (file: Blob, query: string) => postZip<ImportReport>(`${N}/import/loseit?${query}`, file),
  /** The separate, explicit "Match my Lose It! calorie budget": a NEW goal with this activity multiplier, effective today. */
  matchCalorieBudget: (palOverride: number) => api.post<{ applied: boolean; goal: Goal }>(`${N}/import/loseit/match-calorie-budget`, { palOverride }),

  // ---- admin (the header settings panel) ----
  kioskSetting: () => api.get<KioskFoodSetting>(`${N}/settings/kiosk`),
  setKioskSetting: (kioskAccess: KioskFoodAccess) => api.put<KioskFoodSetting>(`${N}/settings/kiosk`, { kioskAccess }),
  barcodeMisses: () => api.get<BarcodeMiss[]>(`${N}/barcodes/misses?limit=200`),

  // ---- "Use from pantry?" ----
  pantrySuggestions: (entryId: string) => api.get<PantrySuggestions>(`${N}/diary/entry/${entryId}/pantry-use`),
  usePantry: (entryId: string, items: Array<{ pantryItemId: string; amount: number }>) =>
    api.post<{ updated: Array<{ pantryItemId: string; name: string; before: number; after: number; clamped: boolean }> }>(
      `${N}/diary/entry/${entryId}/pantry-use`, { items }),
};
