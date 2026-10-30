// Hand-written guards for untrusted input (a request body, an assistant tool's arguments).
// The surface is small enough that a schema library isn't worth a dependency, and every
// failure is a NutritionError(400) with a message a person can act on.
//
// Ported from the calorie app's http.ts without the Express parts: the data layer takes a
// plain object, so routes and tools (phase 6) both feed it the same way.

import { isValidLocalDate } from "../dates.ts";
import { NutritionError } from "./errors.ts";

export type Body = Record<string, unknown>;

const bad = (field: string, want: string): never => {
  throw new NutritionError(400, `${field} must be ${want}.`);
};

// Bodies may use snake_case (food_id, weight_kg) or camelCase (foodId, weightKg);
// top-level keys are normalised to camelCase so the data layer only looks for one spelling.
// Nested objects (e.g. nutrients) are already camelCase and left untouched.
export function camelKeys(o: object): Body {
  const out: Body = {};
  for (const [k, v] of Object.entries(o)) out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  return out;
}

/** A request body that must be a JSON object (not an array, not null). */
export function bodyObject(raw: unknown): Body {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NutritionError(400, "Body must be a JSON object.");
  return camelKeys(raw);
}

export function reqString(b: Body, field: string, max = 200): string {
  const v = b[field];
  if (typeof v !== "string" || v.trim() === "") return bad(field, "a non-empty string");
  if (v.length > max) return bad(field, `at most ${max} characters`);
  return v.trim();
}

export function optString(b: Body, field: string, max = 200): string | null {
  if (b[field] === undefined || b[field] === null || b[field] === "") return null;
  return reqString(b, field, max);
}

export function reqNumber(b: Body, field: string, min = -Infinity, max = Infinity): number {
  const v = b[field];
  if (typeof v !== "number" || !Number.isFinite(v)) return bad(field, "a number");
  if (v < min || v > max) return bad(field, `between ${min} and ${max}`);
  return v;
}

export function optNumber(b: Body, field: string, min = -Infinity, max = Infinity): number | null {
  if (b[field] === undefined || b[field] === null) return null;
  return reqNumber(b, field, min, max);
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    return bad(field, `one of ${allowed.join("|")}`);
  }
  return v as T;
}

export function localDateField(v: unknown, field: string): string {
  if (!isValidLocalDate(v)) return bad(field, "a local date like 2026-03-31");
  return v;
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Client-supplied ids make an offline replay idempotent (the outbox may resend a write whose
// answer it never saw). Restricting the charset keeps them safe as URL segments and log lines.
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const CLIENT_ID_HINT = "8-64 characters of A-Z a-z 0-9 _ -";
export const isClientId = (v: unknown): v is string => typeof v === "string" && CLIENT_ID.test(v);

export function optClientId(b: Body): string | null {
  if (b.id === undefined || b.id === null) return null;
  if (!isClientId(b.id)) return bad("id", CLIENT_ID_HINT);
  return b.id;
}

export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}
