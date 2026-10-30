// Imports the USDA generic-foods catalogue (Foundation, SR Legacy, Survey/FNDDS) into the nutrition
// tables as per-100 g foods with source 'usda_generic', visible to every login and editable by none.
//
//   npm run import:usda                 the whole catalogue (about 8,000 foods; an hour or two)
//   npm run import:usda -- --limit 200  a smoke test: stops after 200 foods, ignores saved progress
//
// THIS DOWNLOADS FROM api.nal.usda.gov, and writes to whatever database db.ts opens: the DB_PATH
// environment variable, else the live data/household.db. The target is printed first. To rehearse
// on the fake data instead:   DB_PATH=data/dev.db npm run import:usda -- --limit 200
// Do not point it at the live database until you mean to; nothing in the test suite runs it.
//
// - Needs FDC_API_KEY (free, https://fdc.nal.usda.gov/api-key-signup). Without one the script
//   refuses: api.data.gov's DEMO_KEY allows about 30 requests an hour, hopeless for a full import.
// - Resumable: the last completed page per data type is saved next to the database in
//   usda-import-state.json, and rows are upserted by FDC id, so re-running after an interruption
//   (or later, to pick up USDA's updates) is safe. Delete the state file to start over.
// - Respects the 1,000 requests/hour limit with a sliding window.
// - Every food gets a single "100 g" serving: /foods/list returns abridged items without
//   household portions ("1 medium"); those would need one extra request per food. A follow-up.
// - The logic is in nutrition/usdaImport.ts (tested on a fixture); this file is the download.

import "../env.ts";

import fs from "node:fs";
import path from "node:path";
import { db, DB_PATH } from "../db.ts";
import { get } from "../nutrition/data/sql.ts";
import { importUsdaGeneric } from "../nutrition/usdaImport.ts";

const MAX_REQUESTS_PER_HOUR = 950; // headroom under the 1,000/hr key limit
const STATE_FILE = path.join(path.dirname(path.resolve(DB_PATH)), "usda-import-state.json");

const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : undefined;
if (limitIdx >= 0 && !(LIMIT! > 0)) throw new Error("--limit needs a positive number");
const KEY = process.env.FDC_API_KEY?.trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const requestTimes: number[] = [];

async function throttle(): Promise<void> {
  const hourAgo = Date.now() - 3_600_000;
  while (requestTimes.length && requestTimes[0] < hourAgo) requestTimes.shift();
  if (requestTimes.length >= MAX_REQUESTS_PER_HOUR) {
    const wait = requestTimes[0] + 3_600_000 - Date.now() + 1000;
    console.log(`Rate window full; waiting ${Math.ceil(wait / 1000)}s...`);
    await sleep(wait);
  }
  requestTimes.push(Date.now());
}

async function fetchPage(dataType: string, pageNumber: number, pageSize: number): Promise<any[]> {
  const url =
    `${process.env.FDC_BASE_URL || "https://api.nal.usda.gov"}/fdc/v1/foods/list?api_key=${encodeURIComponent(KEY!)}` +
    `&dataType=${encodeURIComponent(dataType)}&pageSize=${pageSize}&pageNumber=${pageNumber}`;
  for (let attempt = 1; ; attempt++) {
    await throttle();
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (res?.ok) return (await res.json()) as any[];
    // 429 = quota; network failure or 5xx = transient. Back off, but give up eventually.
    const why = res ? `status ${res.status}` : "network error";
    if (attempt >= 4 || (res && res.status !== 429 && res.status < 500)) {
      throw new Error(`FDC ${dataType} page ${pageNumber}: ${why}${res?.status === 429 ? " (rate limited; try again later)" : ""}`);
    }
    console.log(`FDC ${why}; retrying in ${attempt * 30}s...`);
    await sleep(attempt * 30_000);
  }
}

async function main(): Promise<void> {
  console.log(`Importing into ${path.resolve(DB_PATH)}`);
  if (!KEY) throw new Error("Set FDC_API_KEY first (free: https://fdc.nal.usda.gov/api-key-signup).");

  const limited = LIMIT !== undefined;
  const state: Record<string, number> = !limited && fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  const saveState = () => {
    if (limited) return;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  };

  const counts = await importUsdaGeneric(db, { fetchPage, limit: LIMIT, state, saveState, log: console.log });
  const total = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_foods WHERE source = 'usda_generic' AND deleted_at IS NULL")!.n;
  console.log(`Done. inserted ${counts.inserted}, updated ${counts.updated}, unchanged ${counts.unchanged}, skipped ${counts.skipped} (no energy value). usda_generic foods in the database: ${total}.`);
}

main()
  .catch((err) => {
    console.error(String(err?.message ?? err));
    process.exitCode = 1;
  })
  .finally(() => db.close());
