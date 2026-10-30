import express from "express";
import {
  getScopedItems,
  putScopedItemAs,
  deleteScopedItem,
  getConfig,
  setConfig,
  getMerchantRules,
  matchMerchantRule,
  upsertMerchantRule,
  deleteMerchantRule,
  type ScopedTable,
} from "../db.ts";
import { currentUserId, requireAdmin, verifyPassword } from "../auth.ts";
import { generateJson, OllamaUnavailableError } from "../ollama.ts";
import { appendSecurityEvent } from "../securityLog.ts";

// Ported from the standalone Budget Sync app (since retired, see
// SESSION_STATUS.md). Same data shapes; see src/sections/budget/types.ts
// for the frontend's view of these.
export interface Transaction {
  id: string;
  date: string;
  description: string;
  merchantName: string;
  amount: number;
  category: string;
  bankName: string;
  status: "pending" | "cleared";
  scope?: "personal" | "joint";
  transferId?: string;
  accountId?: string;
}

export interface Budget {
  category: string;
  limit: number;
  spent: number;
  scope?: "personal" | "joint" | "all";
  // Phase 5 (monthly budgets with rollover) -- see
  // src/sections/budget/types.ts's Budget for the full explanation. Optional
  // so a row written before this phase (only category/limit/spent/scope)
  // keeps behaving exactly as it did.
  monthlyLimits?: Record<string, number>;
  rollover?: boolean;
  rolloverSince?: string;
}

export const BUDGET_SCOPED_TABLES = ["transactions", "budgets", "bank_connections", "credit_cards", "alerts", "goals", "bills"] as const;
type BudgetScopedTable = (typeof BUDGET_SCOPED_TABLES)[number];

function isBudgetTable(table: string): table is BudgetScopedTable {
  return (BUDGET_SCOPED_TABLES as readonly string[]).includes(table);
}

// budgets are keyed by category (there's no generated id); everything else by id.
function itemKey(table: BudgetScopedTable, item: any): string {
  return table === "budgets" ? String(item.category) : String(item.id);
}

const CONFIG_KEYS = ["categories", "incomeCategories", "billCategories", "securityLog"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

// Prefixed so a future section's own "categories" setting in the shared
// app_config table can never collide with budget's.
const prefixed = (key: ConfigKey) => `budget.${key}`;

export const FALLBACK_CATEGORIES = [
  "Income", "Mortgage/Rent", "Car Payment", "Car Insurance", "Gas & Transport",
  "Utilities & Bills", "Groceries", "Eating Out", "Subscriptions", "Credit Cards & Debt",
  "Savings", "Family Activities", "Clothing", "Medical & Health", "Child Support",
  "Shopping", "Transfer", "Uncategorized",
];

function getCategories(): string[] {
  return getConfig(prefixed("categories"), FALLBACK_CATEGORIES) || FALLBACK_CATEGORIES;
}

// If `category` isn't already one of the household's categories, adds it (plus a
// $0-limit budget row so it shows up in the planner right away) -- lets the AI
// invent a sensible new category instead of forcing every transaction into an
// existing bucket. Returns whether it was actually new.
export function ensureCategoryExists(userId: string, category: string): boolean {
  const categories = getCategories();
  if (categories.includes(category)) return false;

  setConfig(prefixed("categories"), [...categories, category]);
  // budgets is keyed by category name, not a generated id, so this is the one
  // table in the app where two different members can genuinely collide on the
  // same key -- see the project notes 10.11/section 14. A refusal here
  // means another member already owns a personal budget under this exact
  // name; the category name itself is still fine to share in the picklist
  // above, but this user got no row of their own, and that used to vanish
  // with no trace at all.
  if (!putScopedItemAs("budgets", userId, category, { category, limit: 0, spent: 0 })) {
    console.warn(`ensureCategoryExists: "${category}" already belongs to another member's personal budget -- ${userId} got no row of their own.`);
  }
  return true;
}

// Keyword fallback used when Ollama is unavailable or errors out, so
// categorization never hard-fails just because the local model isn't running.
export function basicFallbackCategorizer(description: string, amount: number): { merchantName: string; category: string } {
  const desc = description.toLowerCase();
  let category = "Shopping";
  let merchantName = description;

  if (desc.includes("transfer") || desc.includes("internal transfer") || desc.includes("online transfer") || desc.includes("xfer") || desc.includes("between accounts") || desc.includes("to checking") || desc.includes("to savings") || desc.includes("transfer to") || desc.includes("transfer from")) {
    category = "Transfer";
    merchantName = "Account Transfer";
  } else if (desc.includes("rent") || desc.includes("mortgage") || desc.includes("landlord") || desc.includes("apartment") || desc.includes("hoa")) {
    category = "Mortgage/Rent";
    merchantName = "Rent / Mortgage Payment";
  } else if (desc.includes("car payment") || desc.includes("auto loan") || desc.includes("car loan")) {
    category = "Car Payment";
    merchantName = "Car Payment";
  } else if (desc.includes("car insur") || desc.includes("auto insur") || desc.includes("geico") || desc.includes("progressive") || desc.includes("state farm") || desc.includes("allstate")) {
    category = "Car Insurance";
    merchantName = "Car Insurance";
  } else if (desc.includes("child support")) {
    category = "Child Support";
    merchantName = "Child Support Payment";
  } else if (desc.includes("mcdonald") || desc.includes("starbucks") || desc.includes("uber eats") || desc.includes("restaurant") || desc.includes("domino") || desc.includes("pizza") || desc.includes("tasty") || desc.includes("grubhub") || desc.includes("dunkin") || desc.includes("doordash")) {
    category = "Eating Out";
    merchantName = desc.includes("mcdonald") ? "McDonald's" : desc.includes("starbucks") ? "Starbucks" : desc.includes("uber eats") ? "Uber Eats" : desc.includes("doordash") ? "DoorDash" : desc.includes("domino") ? "Domino's Pizza" : desc.includes("dunkin") ? "Dunkin' Donuts" : "Local Eatery";
  } else if (desc.includes("whole foods") || desc.includes("kroger") || desc.includes("grocery") || desc.includes("groceries") || desc.includes("trader joe") || desc.includes("aldi") || desc.includes("supermarket")) {
    category = "Groceries";
    merchantName = desc.includes("whole foods") ? "Whole Foods Market" : desc.includes("kroger") ? "Kroger" : desc.includes("trader joe") ? "Trader Joe's" : desc.includes("aldi") ? "Aldi" : "Grocery Store";
  } else if (desc.includes("netflix") || desc.includes("spotify") || desc.includes("disney+") || desc.includes("disney plus") || desc.includes("patreon") || desc.includes("amazon prime") || desc.includes("simplisafe") || desc.includes("xbox live") || desc.includes("hulu")) {
    category = "Subscriptions";
    merchantName = desc.includes("netflix") ? "Netflix" : desc.includes("spotify") ? "Spotify" : desc.includes("disney") ? "Disney+" : desc.includes("patreon") ? "Patreon" : desc.includes("amazon prime") ? "Amazon Prime" : desc.includes("simplisafe") ? "SimpliSafe" : desc.includes("xbox") ? "Xbox Live" : "Subscription Service";
  } else if (desc.includes("electric") || desc.includes("water") || desc.includes("comcast") || desc.includes("att") || desc.includes("verizon") || desc.includes("t-mobile") || desc.includes("power") || desc.includes("internet") || desc.includes("phone bill")) {
    category = "Utilities & Bills";
    merchantName = desc.includes("comcast") ? "Xfinity Comcast" : desc.includes("verizon") ? "Verizon" : desc.includes("att") ? "AT&T" : "Utility Company";
  } else if (desc.includes("amazon") || desc.includes("walmart") || desc.includes("target") || desc.includes("nike") || desc.includes("app store") || desc.includes("steam") || desc.includes("mall")) {
    category = "Shopping";
    merchantName = desc.includes("amazon") ? "Amazon" : desc.includes("walmart") ? "Walmart" : desc.includes("target") ? "Target" : desc.includes("app store") ? "App Store" : "Retailer";
  } else if (desc.includes("clothing") || desc.includes("apparel") || desc.includes("old navy") || desc.includes("gap ") || desc.includes("h&m")) {
    category = "Clothing";
    merchantName = "Clothing Store";
  } else if (desc.includes("uber") || desc.includes("lyft") || desc.includes("shell") || desc.includes("chevron") || desc.includes("gas station") || desc.includes("subway") || desc.includes("transit") || desc.includes("train") || desc.includes("flight") || desc.includes("airline")) {
    category = "Gas & Transport";
    merchantName = desc.includes("uber") ? "Uber" : desc.includes("lyft") ? "Lyft" : desc.includes("shell") ? "Shell Gas" : "Transport Services";
  } else if (desc.includes("kings island") || desc.includes("moss perf") || desc.includes("cinema") || desc.includes("movie") || desc.includes("concert") || desc.includes("ticketmaster") || desc.includes("bowling") || desc.includes("zoo") || desc.includes("family fun")) {
    category = "Family Activities";
    merchantName = desc.includes("kings island") ? "Kings Island" : desc.includes("moss perf") ? "Moss Performing Arts" : desc.includes("ticketmaster") ? "Ticketmaster" : "Family Activity";
  } else if (desc.includes("pharmacy") || desc.includes("cvs") || desc.includes("walgreens") || desc.includes("hospital") || desc.includes("clinic") || desc.includes("dental") || desc.includes("doctor") || desc.includes("medical") || desc.includes("ortho")) {
    category = "Medical & Health";
    merchantName = desc.includes("cvs") ? "CVS Pharmacy" : desc.includes("walgreens") ? "Walgreens" : desc.includes("ortho") ? "Orthodontist" : "Medical Services";
  } else if (desc.includes("credit card") || desc.includes("affirm") || desc.includes(" zip ") || desc.includes("klarna") || desc.includes("credit card payment")) {
    category = "Credit Cards & Debt";
    merchantName = "Credit Card / Debt Payment";
  } else if (desc.includes("savings") || desc.includes("transfer to savings")) {
    category = "Savings";
    merchantName = "Savings Transfer";
  } else if (amount > 0 || desc.includes("payroll") || desc.includes("salary") || desc.includes("direct deposit") || desc.includes("venmo cash") || desc.includes("dividend")) {
    category = "Income";
    merchantName = desc.includes("payroll") || desc.includes("salary") ? "Employer Deposit" : "Direct Deposit";
  }

  return { merchantName, category };
}

// Statement dates arrive in whatever format a pasted bank export or the AI
// parser happens to produce -- "9/23" with no year, "MM/DD/YYYY", already-ISO,
// or outright garbage. The UI groups transactions by `date.slice(0, 7)`, so
// anything that isn't a real "YYYY-MM-DD" silently lands in a bogus "month"
// and vanishes from every month view. Always returns something valid: today's
// date (local, en-CA) for anything unparseable or out-of-range.
export function normalizeStatementDate(raw: unknown, today: Date = new Date()): string {
  const fallback = today.toLocaleDateString("en-CA");
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  const isValidDate = (y: number, m: number, d: number): boolean => {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
    if (m < 1 || m > 12) return false;
    if (d < 1 || d > new Date(y, m, 0).getDate()) return false;
    return true;
  };
  const toISO = (y: number, m: number, d: number): string =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  // Already ISO-shaped: "YYYY-MM-DD" or "YYYY/MM/DD".
  const isoMatch = trimmed.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (isoMatch) {
    const [, yStr, mStr, dStr] = isoMatch;
    const y = Number(yStr), m = Number(mStr), d = Number(dStr);
    return isValidDate(y, m, d) ? toISO(y, m, d) : fallback;
  }

  // US-style: "M/D/YYYY", "M-D-YYYY", "M/D/YY", or a bare "M/D" with no year.
  const usMatch = trimmed.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (usMatch) {
    const [, mStr, dStr, yStr] = usMatch;
    const m = Number(mStr), d = Number(dStr);
    const hadYear = yStr !== undefined;
    let y = hadYear ? (yStr.length === 2 ? 2000 + Number(yStr) : Number(yStr)) : today.getFullYear();

    if (!isValidDate(y, m, d)) return fallback;

    if (!hadYear) {
      // Statements are about the past. A bare "M/D" that lands more than a
      // week past `today` almost certainly belongs to last year -- e.g.
      // parsing a December statement line in early January.
      const candidate = new Date(y, m - 1, d).getTime();
      const sevenDaysOut = today.getTime() + 7 * 86_400_000;
      if (candidate > sevenDaysOut) {
        y -= 1;
        if (!isValidDate(y, m, d)) return fallback;
      }
    }

    return toISO(y, m, d);
  }

  return fallback;
}

// Bug 10.10: the old amount regex (`/-?\$?\s*([0-9,]+\.[0-9]{2})/`) matched a
// leading minus sign OUTSIDE its capture group and then every caller hard-coded
// the result negative regardless -- so a pasted "+$3,200.00 PAYROLL" imported
// as spending, and basicFallbackCategorizer's income branch could never fire
// off a signed amount. This returns the real signed value instead: an
// explicit sign (before or after the $) or wrapping parens wins outright;
// otherwise most lines on a pasted statement are spending, unless the line
// itself reads as a deposit.
export function parseStatementAmount(line: string): number | null {
  // Parentheses are the standard accounting negative -- "(50.00)" means -50
  // no matter what else is on the line.
  const paren = line.match(/\(\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})\s*\)/);
  if (paren) return -parseFloat(paren[1].replace(/,/g, ""));

  // The sign can sit on either side of the "$" ("-$50.00" or "$-50.00"), but
  // must touch it (or the digits) -- whitespace is only allowed after a "$".
  // Otherwise the separator in a line like "PAYROLL DEPOSIT - $3,200.00" reads
  // as a minus sign and a deposit imports as a charge.
  const match = line.match(/([+-])?(?:\$\s*)?([+-])?([0-9][0-9,]*\.[0-9]{2})/);
  if (!match) return null;

  const amount = parseFloat(match[3].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;

  const sign = match[1] || match[2] || "";
  if (sign === "-") return -amount;
  if (sign === "+") return amount;

  // No bare "credit" here: "CREDIT CARD PAYMENT" is one of the most common
  // spending lines on a statement, and matching it would book it as income.
  const looksLikeIncome = /deposit|payroll|direct dep|salary|refund|interest paid/i.test(line);
  return looksLikeIncome ? amount : -amount;
}

// The local Ollama model has no built-in request timeout, and a manual add
// used to block on it for 20+ seconds with nothing to show for it (see
// the project notes 11.3) -- llama3.1 loading cold, or just being slow on
// modest hardware, shouldn't hang a simple "add a transaction" click. Races
// the model call against a timer and lets the timer win; the model call is
// also aborted so it isn't left running to completion in the background for
// no one. Overridable via env var (rather than a hard-coded constant) so
// tests can inject a short timeout instead of actually waiting 8s/45s.
class OllamaTimeoutError extends Error {
  constructor() {
    super("Ollama request timed out");
    this.name = "OllamaTimeoutError";
  }
}

function getTimeoutMs(envVar: string, fallbackMs: number): number {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new OllamaTimeoutError());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function regexFallbackParse(userId: string, rawText: string, message: string) {
  const lines = rawText.split("\n");
  const parsed: any[] = [];
  let idCounter = 1;
  const today = new Date();

  for (const line of lines) {
    if (!line.trim()) continue;
    // Matched purely to strip the amount text out of the description below --
    // parseStatementAmount below is the source of truth for the actual value.
    const amountMatch = line.match(/\(?\s*[+-]?\$?\s*[+-]?\s*[0-9][0-9,]*\.[0-9]{2}\s*\)?/);
    const amount = parseStatementAmount(line) ?? -25.0;
    const dateMatch = line.match(/(\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?)/);
    const date = normalizeStatementDate(dateMatch ? dateMatch[1] : undefined, today);

    const cleanLine = line.replace(amountMatch ? amountMatch[0] : "", "").replace(dateMatch ? dateMatch[0] : "", "").replace(/[\$,\-]/g, "").trim();
    const description = cleanLine || "Unidentified Transaction";

    const remembered = matchMerchantRule(userId, description);
    const fallback = remembered
      ? { merchantName: remembered.merchantDisplay, category: remembered.category }
      : basicFallbackCategorizer(description, amount);
    parsed.push({
      id: `stmt-${Date.now()}-${idCounter++}`,
      date,
      description,
      merchantName: fallback.merchantName,
      amount,
      category: fallback.category,
      bankName: "Parsed Statement",
      status: "cleared",
    });
  }

  return { transactions: parsed, aiProcessed: false, message };
}

export const budgetRoutes = express.Router();

// ==========================================
// STORE
// ==========================================

budgetRoutes.get("/store", (req, res) => {
  const userId = currentUserId(req);
  res.json({
    transactions: getScopedItems("transactions", userId),
    budgets: getScopedItems("budgets", userId),
    bankConnections: getScopedItems("bank_connections", userId),
    creditCards: getScopedItems("credit_cards", userId),
    alerts: getScopedItems("alerts", userId),
    goals: getScopedItems("goals", userId),
    bills: getScopedItems("bills", userId),
    categories: getConfig(prefixed("categories"), null),
    incomeCategories: getConfig(prefixed("incomeCategories"), null),
    billCategories: getConfig(prefixed("billCategories"), null),
    securityLog: getConfig(prefixed("securityLog"), null),
  });
});

// Registered before the generic "/:table/:id" PUT below, since Express matches
// routes in registration order and "store-config" would otherwise be swallowed
// by that route as an unrecognized table name (a real bug caught by the Stage
// 0.2 verification walkthrough: every store-config write 404'd).
budgetRoutes.put("/store-config/:key", (req, res) => {
  const key = req.params.key;
  if (!isConfigKey(key)) return res.status(404).json({ error: "Unknown config key" });
  setConfig(prefixed(key), req.body?.value);
  res.json({ success: true });
});

budgetRoutes.put("/:table/:id", (req, res) => {
  const userId = currentUserId(req);
  const { table, id } = req.params;
  if (!isBudgetTable(table)) return res.status(404).json({ error: "Unknown store table" });

  const item = req.body?.item;
  if (!item || typeof item !== "object") return res.status(400).json({ error: "Body must be { item: {...} }" });

  const key = itemKey(table, item);
  if (key !== id) return res.status(400).json({ error: "Body item key does not match :id" });

  // False means an existing row belongs to another member -- putScopedItemAs
  // refuses silently at the SQL level, so without this check the client would
  // be told the write succeeded when nothing changed.
  if (!putScopedItemAs(table as ScopedTable, userId, key, item)) {
    return res.status(403).json({ error: "That item belongs to another household member" });
  }
  res.json({ success: true });
});

// Registered before the generic "/:table/:id" DELETE for the same reason the
// store-config PUT above is: both are two-segment patterns, so Express would
// match the generic route first and every merchant-rule delete would 404 as an
// unrecognized table name. Same bug as store-config, same fix.
budgetRoutes.delete("/merchant-rules/:merchant", (req, res) => {
  deleteMerchantRule(currentUserId(req), decodeURIComponent(req.params.merchant));
  res.json({ success: true });
});

budgetRoutes.delete("/:table/:id", (req, res) => {
  const userId = currentUserId(req);
  const { table, id } = req.params;
  if (!isBudgetTable(table)) return res.status(404).json({ error: "Unknown store table" });

  const deleted = deleteScopedItem(table as ScopedTable, userId, id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// Wipes every joint and personal budget row this user can see. Admin-only
// (requireAdmin) plus a password re-check, same shape as POST
// /plaid/configure -- this is as destructive as it gets in this section, and
// previously had neither gate. See the project notes 10.20.
budgetRoutes.post("/store/reset", requireAdmin, async (req, res) => {
  const userId = currentUserId(req);
  if (!(await verifyPassword(userId, req.body?.password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  for (const table of BUDGET_SCOPED_TABLES) {
    for (const item of getScopedItems(table, userId)) {
      deleteScopedItem(table, userId, itemKey(table, item));
    }
  }
  res.json({ success: true });
});

const SECURITY_EVENT_TYPES = ["success", "warning", "critical", "info"] as const;
function isSecurityEventType(t: unknown): t is (typeof SECURITY_EVENT_TYPES)[number] {
  return typeof t === "string" && (SECURITY_EVENT_TYPES as readonly string[]).includes(t);
}

// A single-segment POST, so it can never be shadowed by the generic
// "/:table/:id" routes above (those only answer PUT and DELETE) -- ordering
// only matters between routes that share both a method and a URL shape.
//
// This is the fix for the client clobbering the server's own log entries: the
// old client-side logSecurityEvent() PUT the whole local securityLog array,
// so any event the server appended (a PIN lockout, see routes/lock.ts) after
// the page's last load got silently overwritten the next time the client
// logged anything. Routing every append through appendSecurityEvent's
// read-modify-write instead means neither writer can lose the other's entry.
budgetRoutes.post("/security-log", (req, res) => {
  const { event, type } = req.body || {};
  if (typeof event !== "string" || event.trim().length === 0) {
    return res.status(400).json({ error: "event must be a non-empty string" });
  }
  if (!isSecurityEventType(type)) {
    return res.status(400).json({ error: "type must be one of success, warning, critical, info" });
  }
  const entry = appendSecurityEvent(event.trim().slice(0, 300), type);
  res.json({ success: true, entry });
});

// ==========================================
// MERCHANT MEMORY
// ==========================================

budgetRoutes.get("/merchant-rules", (req, res) => {
  res.json({ rules: getMerchantRules(currentUserId(req)) });
});

budgetRoutes.post("/merchant-rules", (req, res) => {
  const { merchantName, category } = req.body || {};
  if (!merchantName || !category) return res.status(400).json({ error: "merchantName and category are required" });
  upsertMerchantRule(currentUserId(req), merchantName, category);
  res.json({ success: true });
});

// ==========================================
// AI CATEGORIZATION / STATEMENT PARSING
// ==========================================

budgetRoutes.post("/categorize", async (req, res) => {
  const userId = currentUserId(req);
  const { description, amount } = req.body;
  if (!description || typeof amount !== "number") {
    return res.status(400).json({ error: "Missing required fields description or amount" });
  }

  const remembered = matchMerchantRule(userId, description);
  if (remembered) {
    return res.json({ merchantName: remembered.merchantDisplay, category: remembered.category, aiProcessed: false, fromMerchantRule: true });
  }

  const controller = new AbortController();
  try {
    const categories = getCategories();
    const prompt = `You are a professional financial transaction parser. Categorize the target transaction and clean up its merchant name.
Transaction Raw Description: "${description}"
Transaction Amount: ${amount}

Existing categories: ${categories.join(", ")}

Prefer an existing category whenever it reasonably applies. Only if none of them fit well, invent a new short category name (2-3 words, Title Case, e.g. "Pet Care" or "Home Improvement") instead of forcing it into an unrelated bucket.

Return a valid JSON object ONLY, matching this schema:
{
  "merchantName": "Clean and professional merchant name",
  "category": "An existing category from the list above, or a new short category name if none fit"
}

Do not include markdown tags like \`\`\`json outside of the raw output if possible, but return valid parsed text in all situations.`;

    const timeoutMs = getTimeoutMs("BUDGET_CATEGORIZE_TIMEOUT_MS", 8000);
    const response = await withTimeout(generateJson(prompt, controller.signal), timeoutMs, controller);
    const cleanedText = (response.text || "").replace(/```json/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(cleanedText);

    const finalCategory = result.category || "Uncategorized";
    const isNewCategory = ensureCategoryExists(userId, finalCategory);

    res.json({ merchantName: result.merchantName || description, category: finalCategory, aiProcessed: true, isNewCategory });
  } catch (err: any) {
    const timedOut = err instanceof OllamaTimeoutError;
    if (!(err instanceof OllamaUnavailableError) && !timedOut) console.error("Ollama error during categorization:", err);
    // Same fallback path as OllamaUnavailableError -- a merchant rule was
    // already checked above, so this is the plain keyword categorizer.
    const fallback = basicFallbackCategorizer(description, amount);
    res.json({
      merchantName: fallback.merchantName,
      category: fallback.category,
      aiProcessed: false,
      error: err.message,
      ...(timedOut ? { timedOut: true } : {}),
    });
  }
});

budgetRoutes.post("/parse-statement", async (req, res) => {
  const userId = currentUserId(req);
  const { rawText } = req.body;
  if (!rawText || typeof rawText !== "string") {
    return res.status(400).json({ error: "rawText parameter must be a non-empty string" });
  }

  const controller = new AbortController();
  try {
    const categories = getCategories();
    const prompt = `You are a financial statement analyzer. You are given a copy-pasted raw text from a bank statement or a CSV of transactions. Your goal is to extract ALL transaction lines and turn them into a structured array. For each transaction, extract:
- date: format as "YYYY-MM-DD" or "MM/DD"
- description: original line text
- merchantName: cleaned up commercial name (e.g., "MCDONALDS STORE 12" -> "McDonald's")
- amount: the numeric amount (negative for spending/debits, positive for deposits/credits)
- category: prefer one of these existing categories when it reasonably applies: ${categories.join(", ")}. Only if none fit well, invent a new short category name (2-3 words, Title Case) instead of forcing an unrelated bucket.

Raw Statement:
"""
${rawText}
"""

Return a valid JSON object ONLY, matching this schema:
{
  "transactions": [
    { "date": "string", "description": "string", "merchantName": "string", "amount": number, "category": "string" }
  ]
}`;

    const timeoutMs = getTimeoutMs("BUDGET_PARSE_STATEMENT_TIMEOUT_MS", 45000);
    const response = await withTimeout(generateJson(prompt, controller.signal), timeoutMs, controller);
    const cleanedText = (response.text || "").replace(/```json/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(cleanedText);

    const newCategories = new Set<string>();
    const transactions = (result.transactions || []).map((t: any, idx: number) => {
      const description = t.description || "Unidentified Transaction";
      const remembered = matchMerchantRule(userId, description);
      const category = remembered ? remembered.category : (t.category || "Uncategorized");
      if (!remembered && !categories.includes(category)) newCategories.add(category);
      return {
        id: `ai-stmt-${Date.now()}-${idx}`,
        date: normalizeStatementDate(t.date),
        description,
        merchantName: remembered ? remembered.merchantDisplay : (t.merchantName || "Unidentified"),
        amount: typeof t.amount === "number" ? t.amount : -25.0,
        category,
        bankName: "Statement Import",
        status: "cleared",
      };
    });

    newCategories.forEach((c) => ensureCategoryExists(userId, c));

    res.json({ transactions, aiProcessed: true, newCategories: Array.from(newCategories) });
  } catch (err: any) {
    const timedOut = err instanceof OllamaTimeoutError;
    if (err instanceof OllamaUnavailableError) {
      return res.json(regexFallbackParse(userId, rawText, "Parsed using standard formatting logic because Ollama isn't running."));
    }
    if (timedOut) {
      return res.json({
        ...regexFallbackParse(userId, rawText, "Parsed using standard formatting logic because the AI took too long to respond."),
        timedOut: true,
      });
    }
    console.error("Ollama statement parsing failed:", err);
    res.json(regexFallbackParse(userId, rawText, "Parsed using standard formatting logic because the AI request failed."));
  }
});
