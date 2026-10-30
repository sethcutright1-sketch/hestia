// What every /api/nutrition/* route file shares: the context they are built from, the error
// mapping, and a few request helpers.
//
// The routes are thin HTTP wrappers over nutrition/data (the data layer takes the database
// handle first and throws NutritionError with an HTTP status). They never take "who" from a
// request body: it is always currentUserId(req), turned into a Tracker by getTracker.

import type express from "express";
import crypto from "node:crypto";
import { currentUserId } from "../../auth.ts";
import type { Tracker } from "../../nutrition/data/access.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { localDateField } from "../../nutrition/data/input.ts";
import type { Db } from "../../nutrition/data/sql.ts";
import { getTracker, todayFor } from "../../nutrition/data/tracker.ts";
import type { LookupResult } from "../../nutrition/lookup.ts";
import type { RecipeModel } from "../../nutrition/recipeAi.ts";

export const KIOSK_ACCESS_VALUES = ["hidden", "plan_only", "plan_and_quick_log"] as const;
/** What the kiosk (fridge) login may do with nutrition. Admin setting `nutrition_kiosk_access`; default hidden. */
export type KioskAccess = (typeof KIOSK_ACCESS_VALUES)[number];

export type LookupFn = (code: string, format?: string) => Promise<LookupResult>;

export interface Ctx {
  db: Db;
  /** The clock. Injectable so tests can pin "today". */
  now(): Date;
  lookup: LookupFn;
  kioskAccess(): KioskAccess;
  setKioskAccess(value: KioskAccess): void;
  /** The local model for recipe parsing / kcal estimates, or null when there is none (Ollama off). */
  recipeModel(): RecipeModel | null;
  /** The signed-in person as a Tracker (404 unknown, 403 kiosk) and their own local date. */
  who(req: express.Request): { user: Tracker; today: string };
}

export function makeWho(db: Db, now: () => Date): Ctx["who"] {
  return (req) => {
    const user = getTracker(db, currentUserId(req));
    return { user, today: todayFor(user, now()) };
  };
}

/** NutritionError -> its own status and message (plus `extra`); anything else is a bug: logged, answered generically. */
export function sendError(res: express.Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof NutritionError) {
    res.status(err.status).json({ error: err.message, ...err.extra });
    return;
  }
  console.error("nutrition route error:", err);
  res.status(500).json({ error: "Something went wrong on the server." });
}

type Handler = (req: express.Request, res: express.Response) => void | Promise<void>;

/** Wraps a handler so a throw (sync or async) becomes sendError's answer instead of an unhandled rejection. */
export const h = (fn: Handler): express.RequestHandler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

/** The :date path segment as a validated local date (400 otherwise). */
export const dateParam = (req: express.Request): string => localDateField(req.params.date, "date");

export const clampInt = (v: unknown, fallback: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(Number(v)) || fallback));

export const queryString = (req: express.Request, name: string): string => {
  const v = req.query?.[name];
  return typeof v === "string" ? v : "";
};

/** A client-less idempotency key: the same (person, group, position) always gives the same entry id, which never collides across people. */
export function derivedEntryId(userId: string, groupId: string, index: number): string {
  return crypto.createHash("sha256").update(`${userId}:${groupId}:${index}`).digest("hex").slice(0, 40);
}
