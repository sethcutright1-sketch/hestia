// Sets one NAME=value line in a dotenv file (.env.local), for the scripts that change a secret
// there without anyone having to see or paste the value.
import fs from "node:fs";

/** Replaces the NAME= line, or appends one, keeping every other line and the file's line endings.
 *  Written without a BOM: PowerShell 5.1's Set-Content adds one, and dotenv would then read it as
 *  part of the first variable's name. */
export function setEnvFileValue(file: string, name: string, value: string): void {
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^﻿/, "") : "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original === "" ? [] : original.split(/\r?\n/);
  const line = `${name}=${value}`;
  const index = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  if (index >= 0) lines[index] = line;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  fs.writeFileSync(file, lines.join(eol), "utf8");
}
