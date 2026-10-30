// Puts a fresh random SESSION_SECRET into .env.local, without printing it. Run from the app folder,
// then restart the app: every signed-in device has to sign in again once.
//
//   npx tsx scripts/new-session-secret.ts
//
// Why a script and not a one-liner: the value should never appear in a console or shell history,
// and PowerShell 5.1 mangles quotes passed to `node -e`. See SECURITY_SHIP_CHECKLIST.md.
import crypto from "node:crypto";
import path from "node:path";
import { setEnvFileValue } from "./envFile.ts";

const file = path.join(process.cwd(), ".env.local");
setEnvFileValue(file, "SESSION_SECRET", crypto.randomBytes(32).toString("hex"));
console.log(`Wrote a new SESSION_SECRET to ${file} (value not shown). Restart the app for it to take effect.`);
