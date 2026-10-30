// Shared plumbing for the importer's phases (diary, exercise, weights, ...): the resolved options, a warning
// collector and the few helpers every phase needs.

import crypto from "node:crypto";
import type { Tracker } from "../data/access.ts";
import type { Scope } from "../data/foods.ts";
import type { Db } from "../data/sql.ts";
import type { ParsedExport } from "./loseitParse.ts";
import type { ConflictMode, WeightUnit } from "./types.ts";

export interface ResolvedOptions {
  dryRun: boolean;
  today: string;
  conflict: ConflictMode;
  from: string | null;
  to: string | null;
  weightUnit: WeightUnit | null;
  foodScope: Scope;
  applyCalibration: boolean;
}

export const MAX_WARNINGS = 50;

export class Warnings {
  total = 0;
  list: string[] = [];
  add(message: string): void {
    this.total++;
    if (this.list.length < MAX_WARNINGS) this.list.push(message);
  }
}

export interface Ctx {
  db: Db;
  user: Tracker;
  o: ResolvedOptions;
  parsed: ParsedExport;
  /** Progress photo files by lowercase basename. */
  photos: Map<string, Uint8Array>;
  warnings: Warnings;
  /** Dates left completely alone because you had already logged them here (conflict = skip). */
  skipped: Set<string>;
  inWindow(date: string): boolean;
}

export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** A number as it goes into a hash or id: no float noise, and null distinct from 0. */
export const normNum = (n: number | null, decimals: number): string => {
  if (n === null) return "na";
  const f = 10 ** decimals;
  return String(Math.round(n * f) / f);
};

/** The reconciliation tolerance: two calories, or one percent of the day, whichever is larger. */
export const kcalTolerance = (expected: number): number => Math.max(2, 0.01 * Math.abs(expected));
