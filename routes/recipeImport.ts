// Turning someone else's recipe into one of ours. Four ways in -- typed by
// hand, pasted as text, uploaded as a CSV/JSON file, or fetched from a URL --
// all of which have to end up as the same thing: a name and a list of
// ingredient names.
//
// "Ingredient names", not ingredient lines, is the part that matters. The
// pantry and the missing-ingredient maths in ingredients.ts match on the head
// noun, so a stored "2 1/2 cups all-purpose flour" never matches a pantry
// holding "flour" -- the meal plan would then insist on buying flour that's
// already in the cupboard. Everything here funnels through stripQuantity for
// that reason.
//
// Parsing is deliberately all pure functions with no I/O, so the awkward cases
// (fractions, parenthetical sizes, "to taste") are testable without a network
// or a file.

import dns from "node:dns/promises";
import net from "node:net";
import type { Nutrients } from "../nutrition/nutrients.ts";
import { stripQuantity } from "../recipeText.ts";
import { cleanInstructions, parseSiteNutrition, parseYield } from "../nutrition/recipeModel.ts";

/** An ingredient line as written, with the name pantry matching uses (`stripQuantity` of it). */
export interface ParsedLine {
  text: string;
  pantryName: string;
}

export interface ParsedRecipe {
  name: string;
  /** Pantry names -- what the pantry and shopping list match on. Always present; derived from `lines` when they are. */
  ingredients: string[];
  /** The ingredient lines as the source wrote them, quantities kept (pasted text and web pages; the other sources have none). */
  lines?: ParsedLine[];
  /** From a page's schema.org recipeYield. */
  yieldServings?: number;
  /** How to make it, as ordered steps: a page's recipeInstructions, or the method section of pasted text. */
  instructions?: string[];
  /** The page the recipe came from (set by the from-url route). */
  sourceUrl?: string;
  /** The page's own calories per serving (schema.org nutrition.calories) and whatever else it states. */
  nutrition?: { siteKcalPerServing: number; perServing: Nutrients };
}

// ---------------------------------------------------------------------------
// Ingredient lines
// ---------------------------------------------------------------------------

export { stripQuantity } from "../recipeText.ts";

/** Drops blank lines, section headers and step text from a block of lines; each keeps its original text beside its pantry name. */
function ingredientEntries(lines: string[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // A heading such as "Ingredients:" or "For the sauce".
    if (/^(ingredients?|for the .+|method|directions?|instructions?|steps?|notes?)\s*:?\s*$/i.test(line)) continue;
    const cleaned = stripQuantity(line);
    if (cleaned) out.push({ text: line.replace(/^[-*•▢□◦]+\s*/, "").replace(/^\d+[.)]\s+/, ""), pantryName: cleaned });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pasted text
// ---------------------------------------------------------------------------

const INSTRUCTIONS_HEADING = /^(method|directions?|instructions?|steps?|preparation)\s*:?\s*$/i;
const INGREDIENTS_HEADING = /^ingredients?\s*:?\s*$/i;

/**
 * One recipe out of a block of pasted text. Handles the shape almost every
 * recipe site and note-taking app produces: a title, an "Ingredients" heading,
 * a list, then a method (kept as the recipe's steps, one per line).
 *
 * Deliberately single-recipe: splitting a wall of text into several recipes
 * means guessing where one ends, and guessing wrong silently merges two
 * shopping lists. Several at once is what the file import is for.
 */
export function parseRecipeText(text: string): ParsedRecipe | null {
  const lines = String(text ?? "").split(/\r?\n/);
  const firstContent = lines.findIndex((l) => l.trim());
  if (firstContent === -1) return null;

  const headingAt = lines.findIndex((l) => INGREDIENTS_HEADING.test(l.trim()));

  // The title is the first real line, unless that line *is* the Ingredients
  // heading -- in which case the paste started at the list and has no title.
  const titleLine = lines[firstContent].trim();
  const name = INGREDIENTS_HEADING.test(titleLine) ? "" : titleLine.replace(/^#+\s*/, "").trim();

  const start = headingAt >= 0 ? headingAt + 1 : firstContent + 1;
  const endOffset = lines.slice(start).findIndex((l) => INSTRUCTIONS_HEADING.test(l.trim()));
  const end = endOffset === -1 ? lines.length : start + endOffset;

  const entries = ingredientEntries(lines.slice(start, end));
  const ingredients = dedupe(entries.map((e) => e.pantryName));
  if (!name || ingredients.length === 0) return null;
  const recipe: ParsedRecipe = { name, ingredients, lines: entries };
  // Everything under the method heading is the steps; "1." / "Step 1" numbering comes off in cleanInstructions.
  const instructions = endOffset === -1 ? [] : cleanInstructions(lines.slice(end + 1));
  if (instructions.length > 0) recipe.instructions = instructions;
  return recipe;
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Uploaded files
// ---------------------------------------------------------------------------

/**
 * JSON: either a bare array or {recipes: [...]}, with ingredients as an array
 * or as one comma/newline-separated string. Covers what the app's own export
 * produces as well as the shapes other recipe apps hand out.
 */
export function parseRecipesFromJson(content: string): ParsedRecipe[] {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data?.recipes) ? data.recipes : null;
  if (!rows) throw new Error("Expected a JSON array of recipes, or an object with a \"recipes\" array.");

  return (rows as unknown[]).map(toParsedRecipe).filter((r): r is ParsedRecipe => r !== null);
}

function toParsedRecipe(row: any): ParsedRecipe | null {
  if (!row || typeof row !== "object") return null;
  const name = String(row.name ?? row.title ?? "").trim();
  const rawIngredients = row.ingredients ?? row.ingredient ?? [];
  const list = Array.isArray(rawIngredients)
    ? rawIngredients
    : String(rawIngredients).split(/[,\n;]/);

  const ingredients = dedupe(
    list.map((i: unknown) => stripQuantity(String(i ?? ""))).filter(Boolean)
  );
  if (!name || ingredients.length === 0) return null;
  const out: ParsedRecipe = { name, ingredients };
  // The method, from any of the names other apps use: a list of steps, or text with one step per line (a CSV cell may
  // separate steps with " | " instead of a line break). cleanInstructions strips numbering and caps the list.
  const rawSteps = row.instructions ?? row.directions ?? row.method ?? row.steps;
  const steps = cleanInstructions(typeof rawSteps === "string" ? rawSteps.replace(/\s+\|\s+/g, "\n") : rawSteps);
  if (steps.length > 0) out.instructions = steps;
  const servings = parseYield(row.servings ?? row.yield ?? row.yieldServings ?? row.recipeYield);
  if (servings !== undefined) out.yieldServings = servings;
  return out;
}

/**
 * CSV with a header row. Needs a name column and an ingredients column; the
 * ingredients cell is split on commas or semicolons, which is why a quoted cell
 * has to survive the row split intact.
 */
export function parseRecipesFromCsv(content: string): ParsedRecipe[] {
  const rows = parseCsvRows(String(content ?? ""));
  if (rows.length < 2) throw new Error("That CSV needs a header row and at least one recipe.");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const nameCol = header.findIndex((h) => h === "name" || h === "title" || h === "recipe");
  const ingCol = header.findIndex((h) => h.startsWith("ingredient"));
  const stepsCol = header.findIndex((h) => ["instructions", "directions", "method", "steps"].includes(h));
  const yieldCol = header.findIndex((h) => ["servings", "yield", "makes"].includes(h));
  if (nameCol === -1 || ingCol === -1) {
    throw new Error('That CSV needs a "name" column and an "ingredients" column.');
  }

  const out: ParsedRecipe[] = [];
  for (const row of rows.slice(1)) {
    const parsed = toParsedRecipe({
      name: row[nameCol], ingredients: row[ingCol],
      ...(stepsCol >= 0 ? { instructions: row[stepsCol] } : {}),
      ...(yieldCol >= 0 ? { servings: row[yieldCol] } : {}),
    });
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, newlines in quotes. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim()));
}

export function parseRecipesFromFile(filename: string, content: string): ParsedRecipe[] {
  const lower = String(filename ?? "").toLowerCase();
  if (lower.endsWith(".json")) return parseRecipesFromJson(content);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return parseRecipesFromCsv(content);

  // No usable extension: go by what the content looks like rather than
  // refusing, since a file saved from a browser often loses its suffix.
  const trimmed = String(content ?? "").trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return parseRecipesFromJson(content);
  return parseRecipesFromCsv(content);
}

// ---------------------------------------------------------------------------
// A page on the web
// ---------------------------------------------------------------------------

/** The recipe on a re-fetched page that is the one we already have: the same name, else the only recipe on the page. */
export function pickPageRecipe(found: ParsedRecipe[], name: string): ParsedRecipe | null {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const want = norm(name);
  return found.find((r) => norm(r.name) === want) ?? (found.length === 1 ? found[0] : null);
}

/**
 * Recipes out of a page's schema.org JSON-LD.
 *
 * Only structured data, never the visible HTML. Scraping a page's markup means
 * guessing which <li>s are ingredients, and a wrong guess quietly puts the
 * navigation menu on the shopping list. Nearly every recipe site publishes
 * JSON-LD for Google; a site that doesn't gets an honest "couldn't find a
 * recipe here" and the user can paste the text instead.
 */
export function extractRecipesFromHtml(html: string): ParsedRecipe[] {
  const out: ParsedRecipe[] = [];
  const blocks = String(html ?? "").matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const block of blocks) {
    let data: any;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue; // One malformed block shouldn't cost us the others.
    }
    for (const node of flattenJsonLd(data)) {
      const types = ([] as string[]).concat(node["@type"] ?? []);
      if (!types.some((t) => String(t).toLowerCase() === "recipe")) continue;

      // Each line keeps what the page wrote ("2 1/2 cups all-purpose flour"); the pantry name is
      // derived from it exactly as it always was, so pantry matching sees the same names.
      const lines: ParsedLine[] = ([] as unknown[])
        .concat(node.recipeIngredient ?? node.ingredients ?? [])
        .map((i) => String(i ?? "").trim())
        .map((text) => ({ text, pantryName: stripQuantity(text) }))
        .filter((l) => l.text && l.pantryName);
      const ingredients = dedupe(lines.map((l) => l.pantryName));
      const name = String(node.name ?? node.headline ?? "").trim();
      if (name && ingredients.length > 0) {
        const recipe: ParsedRecipe = { name, ingredients, lines };
        const yieldServings = parseYield(node.recipeYield);
        if (yieldServings !== undefined) recipe.yieldServings = yieldServings;
        const instructions = cleanInstructions(instructionTexts(node.recipeInstructions));
        if (instructions.length > 0) recipe.instructions = instructions;
        const site = parseSiteNutrition(node.nutrition);
        if (site) recipe.nutrition = { siteKcalPerServing: site.kcal, perServing: site.nutrients };
        out.push(recipe);
      }
    }
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", frac12: "½", frac14: "¼", frac34: "¾",
};

/** HTML to plain text: block tags become line breaks, other tags go, entities are decoded (after, so "&lt;b&gt;" stays text). */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(?:br|\/p|\/li|\/div|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z0-9]+));/gi, (whole, dec, hex, name) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
      const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

/**
 * schema.org recipeInstructions in all the shapes sites publish: one string (possibly with line breaks or
 * HTML), a list of strings, HowToStep objects ({text} or {name}), and HowToSection objects whose
 * itemListElement holds more steps. Returns the raw step texts, tags and entities already out; the caller
 * runs cleanInstructions for numbering and caps. A section's own title is not kept.
 */
export function instructionTexts(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return htmlToText(value).split(/\r?\n/);
  if (Array.isArray(value)) return value.flatMap((v) => instructionTexts(v, depth + 1));
  if (typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  // A section (or a step that nests directions) holds its steps in itemListElement.
  if (node.itemListElement !== undefined) return instructionTexts(node.itemListElement, depth + 1);
  const text = typeof node.text === "string" && node.text.trim() ? node.text : node.name;
  return typeof text === "string" ? htmlToText(text).split(/\r?\n/) : [];
}

/** JSON-LD nests recipes under @graph, arrays, or neither. */
function flattenJsonLd(data: any): any[] {
  if (Array.isArray(data)) return data.flatMap(flattenJsonLd);
  if (!data || typeof data !== "object") return [];
  const nested = Array.isArray(data["@graph"]) ? data["@graph"].flatMap(flattenJsonLd) : [];
  return [data, ...nested];
}

// ---------------------------------------------------------------------------
// Fetching that URL safely
// ---------------------------------------------------------------------------

// This server sits on the household LAN, alongside Ollama on 11434 and its own
// admin routes, and its .env.local holds live Plaid credentials. A "fetch this
// recipe URL" feature is a request-forgery primitive if it will fetch anything:
// http://localhost:3200/api/... would let a pasted link make the server call
// itself as nobody, and cloud metadata endpoints (169.254.169.254) are the
// classic target. So the address is checked, not just the hostname -- a name
// the household's own DNS points at 192.168.x.x has to fail too.
function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 127) return true;               // this host
    if (a === 10) return true;                            // private
    if (a === 172 && b >= 16 && b <= 31) return true;     // private
    if (a === 192 && b === 168) return true;              // private
    if (a === 169 && b === 254) return true;              // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT, which is Tailscale's range
    if (a >= 224) return true;                            // multicast / reserved
    return false;
  }
  // Parsed into groups rather than matched as text: new URL() rewrites
  // "::ffff:192.168.1.1" into "::ffff:c0a8:101", so a check on how the address
  // happens to be spelled misses the very case it was written for.
  const groups = ipv6Groups(ip);
  if (!groups) return true; // unparseable is not something to fetch from

  // ::ffff:0:0/96 -- an IPv4 address wearing an IPv6 coat. Judge the IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = groups[6] >> 8, b = groups[6] & 0xff, c = groups[7] >> 8, d = groups[7] & 0xff;
    return isBlockedAddress(`${a}.${b}.${c}.${d}`);
  }

  if (groups.every((g) => g === 0)) return true;                            // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true;                         // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;                         // fe80::/10 link-local
  return false;
}

/** Expands an IPv6 address to its eight 16-bit groups, or null if it isn't one. */
function ipv6Groups(ip: string): number[] | null {
  const bare = ip.toLowerCase().split("%")[0];
  const [head, tail, extra] = bare.split("::");
  if (extra !== undefined) return null;

  const split = (part: string | undefined) => (part ? part.split(":").filter(Boolean) : []);
  const parts = [...split(head), ...(tail === undefined ? [] : split(tail))];

  // A trailing dotted quad ("::ffff:192.168.1.1") is two groups' worth.
  const out: number[] = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const octets = part.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
      out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out.push(parseInt(part, 16));
  }

  if (tail === undefined) return out.length === 8 ? out : null;
  if (out.length > 8) return null;

  // "::" stands for however many zero groups are needed to reach eight.
  const headCount = split(head).reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const filled = [...out];
  filled.splice(headCount, 0, ...Array(8 - out.length).fill(0));
  return filled;
}

/** Throws if this URL isn't safe for the server to fetch on a user's behalf. */
export async function assertSafeImportUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https addresses can be imported.");
  }

  // A literal IP skips DNS entirely, so check it directly first.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error("That address is on a private network, so it won't be fetched.");
    return url;
  }

  let resolved: { address: string }[];
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Couldn't find ${host}.`);
  }
  // Every answer must be public: one private address among several is enough
  // for a DNS-rebinding attempt to land on it.
  if (resolved.length === 0 || resolved.some((r) => isBlockedAddress(r.address))) {
    throw new Error("That address resolves to a private network, so it won't be fetched.");
  }
  return url;
}

const MAX_PAGE_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

/**
 * Fetches a recipe page with the guard applied at every hop. Redirects are
 * followed by hand rather than by fetch, because fetch's automatic following
 * would re-point a validated public URL at a private one without another check.
 */
export async function fetchRecipePage(rawUrl: string, timeoutMs = 10_000): Promise<string> {
  let target = await assertSafeImportUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(target, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Named honestly. Some sites will refuse it; that's their call to make.
          "user-agent": "household-app recipe import",
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (err: any) {
      throw new Error(err?.name === "AbortError" ? "That site took too long to respond." : "Couldn't reach that site.");
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("That site redirected without saying where.");
      target = await assertSafeImportUrl(new URL(location, target).toString());
      continue;
    }

    if (!res.ok) throw new Error(`That site returned ${res.status}.`);

    const type = res.headers.get("content-type") || "";
    if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      throw new Error("That link isn't a web page.");
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
      throw new Error("That page is too big to read.");
    }
    const body = await readCapped(res, MAX_PAGE_BYTES);
    return body;
  }
  throw new Error("That link redirected too many times.");
}

/** Reads at most `limit` bytes, so a missing content-length can't exhaust memory. */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.length, limit - at)), at);
    at += chunk.length;
    if (at >= limit) break;
  }
  return new TextDecoder("utf-8").decode(joined);
}
