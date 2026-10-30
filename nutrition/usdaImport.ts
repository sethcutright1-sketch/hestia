// The USDA generic-foods catalogue importer's logic (Foundation, SR Legacy, Survey/FNDDS), kept
// apart from the script that downloads it (scripts/import-usda-generic.ts) so it can be tested on
// a tiny fixture with no network. Foods are written as source 'usda_generic': owner-less, per
// 100 g, read-only to everyone, visible to every login.
//
// Upsert by FDC id (source_ref), so a re-run after an interruption, or later to pick up USDA's
// updates, is safe. A row whose name and nutrients are unchanged is not written at all; and
// the search index trigger on nutrition_foods only re-indexes when the name or brand actually
// changed (schema.ts migration 1), so a full re-import doesn't churn the FTS table.

import crypto from "node:crypto";
import { mapFdcNutrients } from "./usda.ts";
import { get, run, tx, type Db } from "./data/sql.ts";

export const USDA_DATA_TYPES = ["Foundation", "SR Legacy", "Survey (FNDDS)"] as const;
export const USDA_PAGE_SIZE = 200;

export interface ImportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  /** No usable energy value, or no name. */
  skipped: number;
}

/** One abridged FDC item (from /foods/list) into the catalogue. */
export function upsertGenericFood(db: Db, item: any, counts: ImportCounts): void {
  const nutrients = mapFdcNutrients(item?.foodNutrients);
  const name = typeof item?.description === "string" ? item.description.trim() : "";
  if (!nutrients || !name || item.fdcId === undefined || item.fdcId === null) {
    counts.skipped++;
    return;
  }
  const ref = String(item.fdcId);
  const json = JSON.stringify(nutrients);
  const existing = get<{ id: string; name: string; nutrients: string; deleted_at: string | null }>(db,
    "SELECT id, name, nutrients, deleted_at FROM nutrition_foods WHERE source = 'usda_generic' AND source_ref = ?", ref);
  if (existing) {
    if (existing.name === name && existing.nutrients === json && existing.deleted_at === null) {
      counts.unchanged++;
      return;
    }
    run(db, "UPDATE nutrition_foods SET name = ?, nutrients = ?, deleted_at = NULL WHERE id = ?", name, json, existing.id);
    counts.updated++;
    return;
  }
  const id = crypto.randomUUID();
  run(db,
    `INSERT INTO nutrition_foods (id, owner_user_id, created_by_user_id, name, brand, gtin14, basis, nutrients, source, source_ref, created_at)
     VALUES (?, NULL, NULL, ?, NULL, NULL, 'per100g', ?, 'usda_generic', ?, ?)`,
    id, name, json, ref, new Date().toISOString());
  // /foods/list items carry no household portions, so every catalogue food gets one "100 g" serving.
  run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES (?, ?, '100 g', 100, 1)", crypto.randomUUID(), id);
  counts.inserted++;
}

export interface ImportOptions {
  /** One page of /fdc/v1/foods/list. A short page (fewer than `size`) is the last one. */
  fetchPage(dataType: string, pageNumber: number, size: number): Promise<any[]>;
  /** Stop after this many foods and ignore saved progress (a changed page size would invalidate saved page numbers). */
  limit?: number;
  /** Progress, resumable between runs: the last finished page per data type, and `<type>:done` flags. Mutated as it goes. */
  state?: Record<string, number>;
  saveState?: () => void;
  log?: (line: string) => void;
}

/** Walks the data types page by page into the catalogue. Each page is one transaction. */
export async function importUsdaGeneric(db: Db, opts: ImportOptions): Promise<ImportCounts> {
  const counts: ImportCounts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  const limited = opts.limit !== undefined && Number.isFinite(opts.limit);
  // A limited run is a smoke test: it starts from page 1 and leaves the saved progress alone.
  const state = limited ? {} : opts.state ?? {};
  const saveState = limited ? undefined : opts.saveState;
  let remaining = limited ? opts.limit! : Infinity;

  for (const dataType of USDA_DATA_TYPES) {
    if (state[`${dataType}:done`]) continue; // finished on an earlier run; clear the state to refresh
    let page = (state[dataType] ?? 0) + 1;
    while (remaining > 0) {
      const size = Math.min(USDA_PAGE_SIZE, remaining);
      const items = await opts.fetchPage(dataType, page, size);
      tx(db, () => items.slice(0, remaining).forEach((item) => upsertGenericFood(db, item, counts)));
      remaining -= Math.min(items.length, remaining);
      state[dataType] = page;
      saveState?.();
      opts.log?.(`${dataType} page ${page}: ${items.length} items (inserted ${counts.inserted}, updated ${counts.updated}, unchanged ${counts.unchanged}, skipped ${counts.skipped})`);
      if (items.length < size) {
        state[`${dataType}:done`] = 1; // a short page is the last page of this data type
        saveState?.();
        break;
      }
      page++;
    }
    if (remaining <= 0) break;
  }
  return counts;
}
