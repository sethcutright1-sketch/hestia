// Thin fetch wrapper. Every endpoint is same-origin and session-cookie
// authenticated, so there are no tokens to thread through.

// Carries the HTTP status alongside the message so a caller can tell "locked"
// (423, from requireUnlocked in auth.ts) apart from every other failure and
// show a PIN prompt instead of a generic error toast.
export class ApiError extends Error {
  status: number;
  // The parsed JSON body of the failed response, for the callers that need more than the message
  // (the food scan reads `lookup`, `unavailable` and `randomWeight` off a 404 / 503 / 422).
  body: any;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((data as any).error || `Request failed (${res.status})`, res.status, data);
  }
  return data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T,>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T,>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T,>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  // "admin" = account/security settings (Plaid, household/lock PIN, kiosk
  // management, backup download, budget reset) on top of "parent"'s full
  // access; "kiosk" reaches every section except those, via ownership scoping
  // -- see requireAdmin/forbidKiosk in auth.ts, the actual server-side gates.
  // Every UI check on this is a convenience (skip showing a control that
  // would just 403), never the enforcement itself.
  role: "admin" | "parent" | "kiosk";
}

export interface AuthStatus {
  userCount: number;
  canRegister: boolean;
  authenticated: boolean;
  user: SessionUser | null;
}

// Mirrors GET /api/lock/status (routes/lock.ts). `unlockedUntil` is epoch ms,
// or null when no PIN is configured (nothing to unlock). See auth.ts's
// requireUnlocked for what this actually gates: budget routes, the backup
// download, and the assistant's financial tools.
export interface LockStatus {
  pinSet: boolean;
  unlocked: boolean;
  unlockedUntil: number | null;
  kioskMinutes: number;
  trustedMinutes: number;
}

// Mirrors GET /api/auth/household-pin (auth.ts). Not to be confused with LockStatus
// above -- this is the PIN required to create a new account at all, not the budget
// PIN lock. `isDefault` is only ever true/false to a signed-in caller; the
// unauthenticated GET /api/auth/status deliberately says nothing about this.
export interface HouseholdPinStatus {
  isDefault: boolean;
}

// Mirrors GET /api/auth/kiosk (auth.ts). At most one kiosk login exists at a
// time, so this is a status, not a list.
export interface KioskLoginStatus {
  exists: boolean;
  username: string | null;
}

/** Mirrors itemCalories.ts. An "estimate" is a model's guess from the name; the others are data. */
export interface ItemCalories {
  kcal: number;
  serving: string | null;
  source: "barcode" | "food_db" | "estimate";
  model: string | null;
  at: string;
}

/** Mirrors the reply of the two "calories/fill" routes (routes/itemCaloriesFill.ts), minus the items. */
export interface CalorieFillOutcome {
  summary: { alreadyHad: number; barcode: number; foodDb: number; estimated: number; stillMissing: number };
  warning: string | null;
  model: string | null;
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string;
  category: string;
  notes: string;
  checked: boolean;
  addedBy: string;
  /** ISO time this item was last added to the household's Kroger cart. */
  sentToKroger?: string;
  calories?: ItemCalories;
}

export interface ShoppingList {
  id: string;
  name: string;
  scope: "joint" | "personal";
  status: "active" | "archived";
  items: ShoppingItem[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PantryItem {
  id: string;
  name: string;
  quantity: string;
  stockCount?: number; // exact count, maintained only by barcode scan in/out
  barcode?: string; // permanent barcode -> item link, once resolved by a scan
  lastScannedInAt?: string; // ISO datetime, set only by a scan-in, never a manual edit
  expirationDate?: string; // YYYY-MM-DD
  calories?: ItemCalories;
  scope: "joint";
  updatedAt: string;
  updatedBy: string;
}

// Mirrors POST /api/pantry/barcode/lookup (routes/pantry.ts) -- a read-only
// probe the scan UI uses to decide whether to write instantly (barcode
// already known), show a confirm ("Cheerios -- add?"), or ask for a name.
export interface BarcodeLookupResult {
  found: boolean;
  item?: PantryItem;
  suggestion?: string | null;
}

// Mirrors POST /api/pantry/scan/in.
export interface ScanInResult {
  item?: PantryItem;
  resolved?: "existing" | "created";
  needsName?: boolean;
  suggestion?: string | null;
}

// Mirrors POST /api/pantry/scan/out. `found: false` is a normal response, not
// an error -- "nothing to decrement" is a business-logic outcome, so this
// stays a 200 (see routes/pantry.ts) so the full body (suggestion/closeMatches)
// survives api.ts's ApiError, which otherwise only keeps the message.
export interface ScanOutResult {
  found: boolean;
  item?: PantryItem;
  hitZero?: boolean;
  // False when the item was already at 0 and the decrement clamped to a
  // no-op -- distinguishing this from a real decrement matters for undo (see
  // PantryBarcodeScan.tsx): undoing a no-op by scanning back in would add a
  // phantom unit that was never actually removed.
  changed?: boolean;
  error?: string;
  suggestion?: string | null;
  closeMatches?: string[];
}

export interface HouseholdMember {
  id: string;
  name: string;
  likes: string[];
  dislikes: string[];
  color?: string; // a palette key (see src/sections/calendar/palette.ts), never a raw hex
  theme?: "soft" | "bold" | "gradient"; // personal-view style (see palette.ts's MEMBER_THEMES)
  // Stage 6.5 (PLAN.md): drives Chores' Kid/Parent split -- unset counts as
  // "kid" (see isParentMember in routes/members.ts), and the split is a UI
  // convenience, not a security boundary (there's no PIN on Parent).
  role?: "parent" | "kid";
  // The login this person is (an admin or parent login), so an "individual" meal reaches THEIR food diary.
  // Set only by an admin, in the Family tab. At most one member per login.
  userId?: string;
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

// GET /api/members also lists the logins a member can be linked to (those that keep a food diary).
export interface LinkableLogin {
  id: string;
  name: string;
  role: string;
}

// Mirrors Nutrients in nutrition/nutrients.ts.
export interface Nutrients {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  satFat: number;
  sugars: number;
  fiber: number;
  cholesterolMg: number;
  sodiumMg: number;
}

// Mirrors Line in nutrition/recipeModel.ts. Everything after pantryName is set only once calories are in play.
export interface RecipeLine {
  /** As written: "2 1/2 cups all-purpose flour". */
  text: string;
  /** What the pantry and shopping list match on. */
  pantryName: string;
  foodId?: string;
  quantity?: number;
  servingId?: string;
  grams?: number;
  /** No food linked; `estimatedKcal` is the local model's guess for this line (the whole dish). */
  estimated?: boolean;
  estimatedKcal?: number;
}

// Mirrors RecipeNutrition. "site" = the web page's own figure; "calculated" = added up from linked foods;
// "mixed" = calculated, with at least one line the model's estimate. `complete` is false while any line is
// estimated or has no food ("calories partly estimated").
export interface RecipeNutrition {
  perServing: Nutrients;
  siteKcalPerServing?: number;
  origin: "site" | "calculated" | "mixed";
  complete: boolean;
}

// Mirrors RecipeDoc in nutrition/recipeModel.ts: the original name + ingredients, plus optional calorie fields.
// A recipe saved before calories existed has none of them (shown as "no calories yet").
export interface Recipe {
  id: string;
  name: string;
  ingredients: string[];
  scope: "joint" | "personal";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lines?: RecipeLine[];
  yieldServings?: number;
  /** Nobody said how many servings it makes; 4 was assumed. */
  yieldAssumed?: boolean;
  servingLabel?: string;
  totalCookedG?: number;
  sourceUrl?: string;
  /** How to make it: ordered steps. Recipes saved before this existed have none. */
  instructions?: string[];
  /** Free-text labels ("quick", "crockpot"), lower case. */
  tags?: string[];
  prepMinutes?: number;
  cookMinutes?: number;
  notes?: string;
  /** When the photo was set (a cache-buster for /api/mealplan/recipes/:id/photo); absent = no photo. */
  photoAt?: string;
  nutrition?: RecipeNutrition;
  /** The read-only food this recipe is in the food diary. */
  foodId?: string;
}

/** This login's own favourite star and rating for a recipe (per person; the server only ever sends your own). */
export interface RecipeMark {
  favorite: boolean;
  /** 1 to 5, or null when not rated. */
  rating: number | null;
}

// POST /api/nutrition/recipes/:id/calculate
export interface RecipeCalculateReport {
  linked: number[];
  estimated: number[];
  unresolved: number[];
  modelAvailable: boolean;
  modelError?: string;
}

// GET/PUT /api/nutrition/settings/pin: the per-login "Require the PIN for my food diary" option.
export interface FoodDiaryPinStatus {
  requirePin: boolean;
  /** False when no household PIN exists yet: the option then has no effect. */
  householdPinSet: boolean;
  unlocked: boolean;
}

// Calendar events only know the three classic meals.
export type MealSlot = "breakfast" | "lunch" | "dinner";
export type MealStatus = "proposed" | "approved" | "denied";

// A planned meal's slot is a key: breakfast, lunch, dinner, snacks, or a custom meal someone has ("brunch").
export interface PlanSlotOption {
  key: string;
  label: string;
  standard: boolean;
}

export interface PlannedMeal {
  id: string;
  day: string;
  slot: string;
  name: string;
  ingredients: string[];
  status: MealStatus;
  audience: "family" | "individual";
  memberId?: string;
  // The (joint) recipe this meal is. Meals saved before recipes were linked have none: they still show,
  // and can't be approved until one is picked or created.
  recipeId?: string;
  // Set on a leftover meal: the id of the meal it is the leftovers of.
  leftoverOf?: string;
}

// What the diaries did about a meal change (PUT/POST/DELETE /api/mealplan/meals...).
export interface MealSyncReport {
  created: { userId: string; name: string; entryId: string; slotKey: string }[];
  removed: number;
  kept: number;
  alreadyLogged: { userId: string; name: string }[];
  skipped: { userId: string | null; name?: string; reason: string }[];
  slotFallbacks: { userId: string; name: string; from: string; to: string }[];
  note?: string;
}

// GET /api/mealplan/meals/:id/leftover-offer
export interface LeftoverOffer {
  mealId: string;
  name: string;
  recipeId: string;
  yieldServings: number;
  yieldAssumed: boolean;
  headcount: number;
  servingsLeft: number;
  reason?: string;
  suggestion: { day: string; slot: string } | null;
  alternatives: { day: string; slot: string }[];
}

// Weekly recurrence only -- see routes/recurrence.ts for why. `byDay` uses
// the same two-letter weekday codes as iCal (MO, TU, ...).
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

export interface RecurrenceRule {
  freq: "weekly";
  byDay: Weekday[];
  until?: string; // YYYY-MM-DD, inclusive. Omitted = open-ended.
}

export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD -- the anchor date; the only date for a one-off event, the first occurrence for a recurring series
  time?: string; // "HH:MM", 24h. Absent = all-day.
  endTime?: string; // "HH:MM". Absent = a default visual duration when `time` is set.
  title: string;
  audience: "family" | "individual";
  memberId?: string;
  mealSlot?: MealSlot;
  recurrence?: RecurrenceRule;
  seriesId: string; // the master event's own id -- equal to `id` unless this is one occurrence of a recurring series
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

export type ChoreStatus = "pending" | "done";

// Stage 10.4 (PLAN.md), extended by Stage 6.5's approval step: "none" means
// not done, or the assignee is a parent-role member (parents never need
// approval -- ticking it means done); "waiting" means a kid (or unassigned/
// family) chore is done but a parent hasn't approved it yet; "approved" means
// a parent signed off, which is also the point pointsByMember counts it.
export type ChoreApproval = "none" | "waiting" | "approved";

export interface Chore {
  id: string;
  title: string;
  memberId?: string; // absent = a family/unassigned chore
  // A chore assigned to 2+ members is stored as one row per member, all
  // sharing this groupId -- see routes/chores.ts's Chore.groupId comment.
  // Absent = an ungrouped chore (a group of one, keyed by its own id).
  groupId?: string;
  date: string; // anchor due date, YYYY-MM-DD
  time?: string;
  recurrence?: RecurrenceRule;
  seriesId: string; // the master chore's own id -- equal to `id` unless this is one occurrence of a recurring series
  status: ChoreStatus;
  completedAt?: string;
  approval: ChoreApproval;
  points?: number; // 1-10, absent = worth the default (1) -- Stage 10.4
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

// Points-only rewards catalog (Stage 10.4, PLAN.md) -- no money, deliberately
// outside the financial privacy boundary. See routes/rewards.ts.
export interface Reward {
  id: string;
  title: string;
  cost: number; // 1-1000
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

export interface Redemption {
  id: string;
  rewardId: string;
  rewardTitle: string; // snapshotted at redemption time
  memberId: string;
  cost: number; // snapshotted at redemption time
  redeemedAt: string;
  byUserId: string;
}

export interface MemberBalance {
  earned: number;
  adjusted: number; // net of every PointAdjustment for this member -- Phase 3
  spent: number;
  balance: number;
}

// Mirrors routes/rewards.ts's PointAdjustment (Phase 3, PLAN.md): a manual
// +/- a parent applies outside of chores ("+5 for helping with the garage
// sale"), folded into MemberBalance.adjusted/balance alongside chore earnings
// and redemptions.
export interface PointAdjustment {
  id: string;
  memberId: string;
  amount: number; // non-zero integer, -100 to 100
  note: string;
  createdAt: string;
  byUserId: string;
}

export interface MealPlan {
  id: string;
  weekStart: string;
  meals: PlannedMeal[];
  scope: "joint";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DislikeConflict {
  mealId: string;
  member: string;
  ingredient: string;
}

export interface MealRequest {
  id: string;
  name: string;
  notes: string;
  memberId?: string;
  scope: "joint";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MealPlanResponse {
  plan: MealPlan | null;
  missing: string[];
  /** The same shortfall per meal (shared ingredients repeat under each meal); meals missing nothing are left out. */
  missingByMeal: { mealId: string; name: string; day: string; slot: string; memberId?: string; missing: string[] }[];
  conflicts: DislikeConflict[];
  recipes: Recipe[];
  /** Your favourites and ratings by recipe id; a recipe you have not marked is absent. */
  marks?: Record<string, RecipeMark>;
  requests: MealRequest[];
  /** Snack requests: the same shape as meal requests, in their own list. */
  snackRequests: MealRequest[];
  /** The Groceries budgeted amount, only when an admin has shared it with meal planning. */
  groceryBudget: GroceryBudget | null;
  /** The meals a planned meal can use: the standard four plus the household's own. */
  slots: PlanSlotOption[];
  /** What the food diaries did about the change, on the responses to a meal change. */
  sync?: MealSyncReport;
}

// Mirrors groceryBudget() in routes/mealplan.ts.
export interface GroceryBudget {
  month: string;
  monthly: number;
  weekly: number;
}

export type VisionProviderId = "anthropic" | "gemini" | "ollama";

export interface VisionProviderStatus {
  id: VisionProviderId;
  label: string;
  available: boolean;
  reason?: string;
}

export interface VisionConfig {
  provider: VisionProviderId | "auto";
  providers: VisionProviderStatus[];
}

export interface PantryScanSuggestion {
  name: string;
  alreadyTracked: boolean;
}

export interface FridgeStatus {
  doorOpen: { cooler?: boolean; freezer?: boolean };
  temperature: { cooler?: number; freezer?: number };
  setpoint: { cooler?: number; freezer?: number };
  powerSaveOn?: boolean;
  iceBoostOn?: boolean;
  updatedAt: string;
}

// Stage 4: persisted assistant conversations (see PLAN.md).
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationToolStep {
  tool: string;
  args: Record<string, any>;
  result?: unknown;
  error?: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
  steps?: ConversationToolStep[];
}

// Mirrors GET/PUT /api/auth/devices (routes/devices.ts) -- long-lived tokens
// for non-browser clients like the Wear OS app. `token` is only ever present
// in the response to the POST that creates one; it's never stored or
// returned again after that.
export interface DeviceToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface NewDeviceToken {
  id: string;
  label: string;
  token: string;
}

// Mirrors GET/PUT /api/assistant/settings (routes/assistant.ts).
export interface AssistantSettings {
  noFinanceVoiceData: boolean;
  /** Per-provider admin opt-in: financial turns/tools may run on that cloud provider. All off by default. */
  allowCloudFinance: CloudFinanceSettings;
  /** The health twins: which cloud providers may receive food-diary / calorie / weight data (all off by default), and whether a spoken health question is refused (on by default). */
  allowCloudHealth: CloudHealthSettings;
  noHealthVoiceData: boolean;
  /** Whether meal planning may see the Groceries budgeted amount. Off by default. */
  shareGroceryBudget: boolean;
  /** Voice input: "whisper_local" turns speech into text on this PC; "off" hides the mic everywhere. */
  speechBackend: "off" | "whisper_local";
  /** Whether Whisper is installed and configured on the server (the admin can't turn voice on without it). */
  whisperConfigured: boolean;
}

export interface CloudFinanceSettings {
  anthropic: boolean;
  gemini: boolean;
}

export interface CloudHealthSettings {
  anthropic: boolean;
  gemini: boolean;
}
