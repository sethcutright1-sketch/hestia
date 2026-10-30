// The miss log: scans that ended without nutrition. It exists to answer one question with
// evidence instead of a hunch: "is a paid fallback database (Chomp, about a cent a lookup) worth
// it?" If the unresolved list stays short, the free sources are enough. If it keeps growing with
// things you really buy, it isn't. One list for the household.
//
// Only definite answers are logged -- every source replied and none had nutrition. A lookup
// where a source was down says nothing about the product, so it never lands here (the scan
// route answers that case with a retryable 503 instead).

import { lookupVariants } from "../barcode.ts";
import type { Tracker } from "./access.ts";
import { all, run, type Db } from "./sql.ts";

/** The shortest form the number is printed in (a UPC-A is 12 digits, an EAN-13 13, an EAN-8 8), for people to read. */
export function displayCode(gtin14: string): string {
  return lookupVariants(gtin14).reduce((a, b) => (b.length < a.length ? b : a));
}

export function recordMiss(db: Db, gtin14: string, learned: { name: string | null; brand: string | null }, at: Date): void {
  const ts = at.toISOString();
  run(db,
    `INSERT INTO nutrition_barcode_misses (gtin14, count, first_seen_at, last_seen_at, name, brand)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT (gtin14) DO UPDATE SET
       count = count + 1, last_seen_at = excluded.last_seen_at,
       -- a later scan that learned a name keeps it; one that learned nothing doesn't erase it
       name = COALESCE(excluded.name, name), brand = COALESCE(excluded.brand, brand)`,
    gtin14, ts, ts, learned.name, learned.brand);
}

interface MissRow {
  gtin14: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  name: string | null;
  brand: string | null;
  food_id: string | null;
  food_name: string | null;
  owner_user_id: string | null;
}

export function listMisses(db: Db, user: Tracker, limit: number) {
  // A code can be held by a joint food and by several people's personal foods (migration 6), so
  // the join picks ONE food the person can see: their own personal food first, then the joint
  // one. Another person's personal food is never joined, so it can neither resolve a miss for
  // this person nor leak its name.
  const rows = all<MissRow>(db,
    `SELECT m.gtin14, m.count, m.first_seen_at, m.last_seen_at, m.name, m.brand,
            f.id AS food_id, f.name AS food_name, f.owner_user_id
       FROM nutrition_barcode_misses m
       LEFT JOIN nutrition_foods f ON f.id = (
         SELECT x.id FROM nutrition_foods x
          WHERE x.gtin14 = m.gtin14 AND x.deleted_at IS NULL AND (x.owner_user_id IS NULL OR x.owner_user_id = ?)
          ORDER BY (x.owner_user_id IS NULL), x.rowid LIMIT 1)
      ORDER BY m.count DESC, m.last_seen_at DESC, m.gtin14
      LIMIT ?`,
    user.id, limit);
  return rows.map((r) => {
    // Resolved = a food you can use now carries the code (added, imported-and-linked, or created by hand).
    const usable = r.food_id !== null;
    return {
      gtin14: r.gtin14,
      code: displayCode(r.gtin14),
      count: r.count,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      name: r.name,
      brand: r.brand,
      resolved: usable,
      foodId: usable ? r.food_id : null,
      foodName: usable ? r.food_name : null,
    };
  });
}
