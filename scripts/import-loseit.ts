// Imports a Lose It! full-account export (the ZIP from https://loseit.com/export/data) into one login's own diary.
//
//   npm run import:loseit -- --user <username> --zip <file> [--dry-run] [--only-me]
//       [--conflict skip|merge|replace] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--weight-unit lb|kg] [--apply-calibration] [--yes]
//   npm run import:loseit -- --zip <file> --inspect [--samples]      (needs no database)
//
// WRITES TO whatever database db.ts opens: the DB_PATH environment variable, else the live data/household.db.
// The path is printed first; a real run (no --dry-run) refuses to start without --yes. To rehearse on a COPY:
//   DB_PATH=C:\path\to\copy\household.db npm run import:loseit -- --user alex --zip alex.zip --dry-run
// Like the server, opening the database runs the nutrition migrations and takes the daily backup copy next to it
// (<database folder>/backups). Relative --zip paths are relative to the folder you ran npm from.
//
// All of the logic (flags, guards, the report) is in nutrition/import/cli.ts, tested without a real database.

import fs from "node:fs";
import path from "node:path";
import { runCli } from "../nutrition/import/cli.ts";

// A DB_PATH typed in the shell wins over the one in .env.local (env.ts would otherwise let .env.local override it,
// and a rehearsal on a copy of the real database would quietly land on data/dev.db instead). Same rule env.ts already
// has for PORT. The path that is used is always printed before anything is opened.
const shellDbPath = process.env.DB_PATH;
await import("../env.ts");
if (shellDbPath) process.env.DB_PATH = shellDbPath;

// The same rule as db.ts, worked out BEFORE db.ts is imported (importing it would create an empty database at a mistyped path).
const dbPath = (): string => (process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(process.cwd(), "data", "household.db"));
const fromInvocation = (p: string): string => path.resolve(process.env.INIT_CWD || process.cwd(), p);

const code = await runCli(process.argv.slice(2), {
  out: (text) => console.log(text),
  readFile: (p) => fs.readFileSync(fromInvocation(p)),
  databasePath: () => {
    const p = dbPath();
    // openDb would happily create an empty database at a mistyped path; don't.
    if (!fs.existsSync(p)) throw new Error(`No database at ${p}. Set DB_PATH to the database you mean (or run from the app's folder).`);
    return p;
  },
  openDb: async () => {
    const { db, DB_PATH } = await import("../db.ts");
    if (path.resolve(DB_PATH) !== dbPath()) throw new Error(`Refusing to run: db.ts opened ${DB_PATH}, not ${dbPath()}.`);
    return { db, close: () => db.close() };
  },
});
process.exitCode = code;
