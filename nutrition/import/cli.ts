// The command-line side of the Lose It! import (scripts/import-loseit.ts is the thin wrapper that supplies the real
// database and files). Kept here, with its dependencies passed in, so the tests can run every flag against a
// private in-memory database and prove the guards (no real run without --yes, no database for --inspect).
//
//   npm run import:loseit -- --user <username> --zip <file> [--dry-run] [--only-me]
//       [--conflict skip|merge|replace] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--weight-unit lb|kg] [--apply-calibration] [--yes]
//   npm run import:loseit -- --zip <file> --inspect [--samples]
//
// - --dry-run runs the whole import and rolls it back: the summary is exactly what a real run does.
// - A real run (no --dry-run) must say --yes. The database it will write to is printed first.
// - --user is a login's username (or its id). The import always goes into THAT login's own diary.
// - --only-me makes the foods created by the import personal (default: shared with the household).
// - --conflict says what to do with a day you already logged in this app (default skip).
// - --apply-calibration also adds a goal row carrying the activity multiplier implied by your Lose It! calorie
//   budgets (the web screen has a separate button for this; nothing applies it unless you ask).
// - --inspect writes nothing and needs no database: it lists each file's name, row count and headers.

import { NutritionError } from "../data/errors.ts";
import { peekTracker, todayFor } from "../data/tracker.ts";
import { get, type Db } from "../data/sql.ts";
import { formatInventory, formatReport } from "./format.ts";
import { importLoseIt } from "./loseitImport.ts";
import { inventoryOf } from "./loseitParse.ts";
import type { ConflictMode, WeightUnit } from "./types.ts";
import { readZip, type LoseItExport } from "./zip.ts";

export const USAGE = `Usage:
  npm run import:loseit -- --user <username> --zip <file> [--dry-run] [--only-me]
      [--conflict skip|merge|replace] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
      [--weight-unit lb|kg] [--apply-calibration] [--yes]
  npm run import:loseit -- --zip <file> --inspect [--samples]

A real run (without --dry-run) needs --yes. Use DB_PATH to point it at a database (it is printed first).`;

const VALUE_FLAGS = ["user", "zip", "conflict", "from", "to", "weight-unit"];
const SWITCH_FLAGS = ["dry-run", "only-me", "apply-calibration", "inspect", "samples", "yes", "help"];

export function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`Unexpected argument "${argv[i]}".\n${USAGE}`);
    const [, name, inline] = m;
    if (SWITCH_FLAGS.includes(name)) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.\n${USAGE}`);
      flags.set(name, value);
    } else {
      throw new Error(`Unknown option --${name}.\n${USAGE}`);
    }
  }
  return flags;
}

export interface CliDeps {
  out(text: string): void;
  /** The ZIP's bytes; throws a Node fs error (ENOENT...) when it can't be read. */
  readFile(path: string): Uint8Array;
  /** The database path that a real or dry run will use, printed before anything is opened. Throws when there is none. */
  databasePath(): string;
  /** Opens the database. Called only after every flag has been checked, and never for --inspect. */
  openDb(): Promise<{ db: Db; close?: () => void }>;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
}

function pickUser(db: Db, who: string): UserRow {
  const row = get<UserRow>(db, "SELECT id, username, display_name FROM users WHERE lower(username) = lower(?) OR id = ?", who, who);
  if (!row) throw new Error(`No login "${who}". Use the username the person signs in with.`);
  return row;
}

/** Runs the CLI; resolves to the exit code. Never throws: problems are printed and become exit code 1. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    await main(argv, deps);
    return 0;
  } catch (err: any) {
    deps.out(String(err instanceof NutritionError ? err.message : err?.message ?? err));
    return 1;
  }
}

async function main(argv: string[], deps: CliDeps): Promise<void> {
  const flags = parseArgs(argv);
  if (flags.has("help")) return deps.out(USAGE);
  const str = (name: string): string | undefined => {
    const v = flags.get(name);
    return typeof v === "string" ? v : undefined;
  };

  const zip = str("zip");
  if (!zip) throw new Error(`--zip is required.\n${USAGE}`);
  if (flags.has("samples") && !flags.has("inspect")) throw new Error("--samples only goes with --inspect.");
  let exp: LoseItExport;
  try {
    exp = readZip(deps.readFile(zip));
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "EISDIR" || err?.code === "EACCES") {
      throw new Error(`Can't read ${zip}: ${err.code === "ENOENT" ? "no such file" : err.code === "EISDIR" ? "that is a folder" : "permission denied"}.`);
    }
    throw err;
  }
  deps.out(`Read ${exp.files.size} file(s) and ${exp.photos.size} progress photo(s) from ${zip}.`);

  if (flags.has("inspect")) {
    deps.out(`\n${formatInventory(inventoryOf(exp.files, { samples: flags.has("samples") }), { samples: flags.has("samples") })}`);
    return;
  }

  const who = str("user");
  if (!who) throw new Error(`--user is required.\n${USAGE}`);
  const dryRun = flags.has("dry-run");
  // The guard comes before the database is even opened: a real import is a decision, not a default.
  if (!dryRun && !flags.has("yes")) {
    throw new Error("A real import writes to the database. Run it with --dry-run first, then add --yes to do it for real.");
  }

  deps.out(`Database: ${deps.databasePath()}`);
  const { db, close } = await deps.openDb();
  try {
    const login = pickUser(db, who);
    const user = peekTracker(db, login.id); // 403 for the kiosk login; writes nothing
    const report = importLoseIt(db, user, exp, {
      dryRun,
      today: todayFor(user),
      conflict: str("conflict") as ConflictMode | undefined,
      from: str("from"),
      to: str("to"),
      weightUnit: str("weight-unit") as WeightUnit | undefined,
      foodScope: flags.has("only-me") ? "personal" : "joint",
      applyCalibration: flags.has("apply-calibration"),
    });
    deps.out(`\n${formatReport(report, `${login.display_name} (${login.username})`)}`);
    if (report.dryRun) deps.out("\nRun it again without --dry-run, with --yes, to import.");
  } finally {
    close?.();
  }
}
