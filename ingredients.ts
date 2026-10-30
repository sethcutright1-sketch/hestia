// Matching food names written by different hands: a recipe says "white rice",
// the pantry says "Rice", someone's dislikes say "rices". None of it is
// normalized at entry, so it gets normalized here at comparison time.

export function normalizeName(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/s$/, "");
}

// Head-noun matching: the candidate must be the head noun at the end of the
// name, which is what distinguishes "white rice" (rice) from "rice vinegar" (a
// vinegar). "rice" should match "white rice" but not "rice vinegar", which is a
// different thing you'd still need to buy.
export function matchesAny(ingredient: string, names: string[]): boolean {
  const needle = normalizeName(ingredient);
  if (!needle) return false;

  return names.some((name) => {
    const candidate = normalizeName(name);
    if (!candidate) return false;
    if (candidate === needle) return true;
    return new RegExp(`\\b${escapeRegExp(candidate)}$`).test(needle);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MealLike {
  ingredients?: string[];
  status?: string;
  audience?: "family" | "individual";
  memberId?: string;
}

/**
 * Ingredients the household would have to buy: everything the plan calls for
 * that the pantry doesn't already cover.
 *
 * Denied meals are skipped -- you shouldn't shop for a dinner you rejected.
 * Proposed meals still count, so the list is useful before anyone has worked
 * through approving all twenty-one entries.
 *
 * Recomputed on every read rather than stored, so buying an item makes it drop
 * off the list instead of lingering in a stale snapshot.
 */
export function computeMissing(meals: MealLike[], pantryNames: string[]): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const meal of meals) {
    if (meal.status === "denied") continue;
    for (const ingredient of meal.ingredients || []) {
      const key = normalizeName(ingredient);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!matchesAny(ingredient, pantryNames)) {
        missing.push(String(ingredient).trim());
      }
    }
  }

  return missing;
}

export interface MissingForMeal {
  mealId: string;
  name: string;
  day: string;
  slot: string;
  /** Set when the meal is one person's (a split-off meal), so two meals in one slot can be told apart. */
  memberId?: string;
  missing: string[];
}

/**
 * The same shortfall as computeMissing, but kept per meal: each meal lists what it alone needs, so an
 * ingredient two meals share appears under both (the flat list dedupes it). Meals with nothing missing
 * are left out; denied meals are skipped for the same reason as above.
 */
export function computeMissingByMeal(
  meals: Array<MealLike & { id: string; name: string; day: string; slot: string }>,
  pantryNames: string[]
): MissingForMeal[] {
  const rows: MissingForMeal[] = [];
  for (const meal of meals) {
    if (meal.status === "denied") continue;
    const seen = new Set<string>();
    const missing: string[] = [];
    for (const ingredient of meal.ingredients || []) {
      const key = normalizeName(ingredient);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!matchesAny(ingredient, pantryNames)) missing.push(String(ingredient).trim());
    }
    if (missing.length > 0) {
      const row: MissingForMeal = { mealId: meal.id, name: meal.name, day: meal.day, slot: meal.slot, missing };
      if (meal.audience === "individual" && meal.memberId) row.memberId = meal.memberId;
      rows.push(row);
    }
  }
  return rows;
}

export interface MemberLike {
  id?: string;
  name: string;
  dislikes?: string[];
}

export interface DislikeConflict {
  mealId: string;
  member: string;
  ingredient: string;
}

/**
 * Meals that call for something a family member won't eat.
 *
 * The model is told everyone's dislikes up front, so this should usually come
 * back empty -- but it's checked server-side anyway, because a prompt rule is a
 * request and this is a fact. Conflicts are surfaced, never silently dropped:
 * the household decides whether tonight is worth an argument.
 */
export function findDislikeConflicts(
  meals: (MealLike & { id: string })[],
  members: MemberLike[]
): DislikeConflict[] {
  const conflicts: DislikeConflict[] = [];

  for (const meal of meals) {
    if (meal.status === "denied") continue;
    // A meal made just for one person can only conflict with THEIR dislikes --
    // checking everyone would flag a dish someone else isn't even eating.
    const relevantMembers =
      meal.audience === "individual" && meal.memberId
        ? members.filter((m) => m.id === meal.memberId)
        : members;
    for (const ingredient of meal.ingredients || []) {
      for (const member of relevantMembers) {
        if (!member.dislikes?.length) continue;
        if (matchesAny(ingredient, member.dislikes)) {
          conflicts.push({ mealId: meal.id, member: member.name, ingredient });
        }
      }
    }
  }

  return conflicts;
}
