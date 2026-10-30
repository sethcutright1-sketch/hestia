// The barcode lookup cache, in SQLite (table nutrition_barcode_lookups).
//
// It remembers what the upstream lookup cascade answered so a code already scanned never
// costs another network round trip:
//
//   found = 1  the cascade produced something (nutrition, or just a name): 90 days
//   found = 0  nothing knew the code: 14 days, short enough that a newly added product is found
//
// A miss is only ever stored when every source answered; that rule belongs to the lookup itself
// (nutrition/lookup.ts, the barcode service shared with Pantry) -- this file stores whatever it is told. `tries` counts the
// upstream lookups that produced the row, which is what you would look at before deciding a code
// is hopeless.
//
// Pantry's barcodeLookup.ts and the food diary's scanner both read and write this table through
// nutrition/lookup.ts.

import { get, run, type Db } from "./sql.ts";

export const POSITIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const NEGATIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What a lookup stored: the answer minus the per-call bits (gtin14/raw/cached/timings). Kept
 * loose on purpose -- nutrition/lookup.ts owns the exact result type (Core) and casts to and from this.
 */
export interface CachedLookup {
  source: string | null;
  servingUnit: "g" | "ml";
  [field: string]: unknown;
}

interface Row {
  gtin14: string;
  result: string | null;
  source: string | null;
  found: number;
  looked_up_at: string;
  tries: number;
}

const ttlFor = (found: boolean): number => (found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);

/** A still-fresh answer, or null when there is none (never looked up, or expired). `core: null` is a remembered miss. */
export function readCached(db: Db, gtin14: string, now: number): { core: CachedLookup | null } | null {
  const row = get<Row>(db, "SELECT * FROM nutrition_barcode_lookups WHERE gtin14 = ?", gtin14);
  if (!row) return null;
  const at = Date.parse(row.looked_up_at);
  if (!Number.isFinite(at) || now - at >= ttlFor(row.found === 1)) return null;
  if (row.found !== 1) return { core: null };
  try {
    const core = JSON.parse(row.result ?? "null") as Partial<CachedLookup>;
    return { core: { ...core, source: core.source ?? row.source, servingUnit: core.servingUnit ?? "g" } };
  } catch {
    return null; // unreadable JSON: look it up again rather than fail the scan
  }
}

export function writeCached(db: Db, gtin14: string, core: CachedLookup | null, now: number): void {
  run(db,
    `INSERT INTO nutrition_barcode_lookups (gtin14, result, source, found, looked_up_at, tries) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT (gtin14) DO UPDATE SET result = excluded.result, source = excluded.source, found = excluded.found,
       looked_up_at = excluded.looked_up_at, tries = tries + 1`,
    gtin14, core ? JSON.stringify(core) : null, core?.source ?? null, core ? 1 : 0, new Date(now).toISOString());
}
