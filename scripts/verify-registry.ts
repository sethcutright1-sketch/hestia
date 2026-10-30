// Verifies the Stage 1 registry split preserved every tool contract: same tool
// names, same descriptions, same parameter schemas as the pre-split single file.
// Compares against `git show <ref>:assistant/tools.ts`, so the baseline is the real
// old code rather than anything transcribed by hand.
//
// The default ref is f155f96, the last commit before the split -- after that commit
// HEAD no longer has assistant/tools.ts, so passing HEAD will fail.
//
// Usage: npx tsx scripts/verify-registry.ts [git-ref-that-still-has-assistant/tools.ts]
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { buildTools, toolManifest, toolDomainLabels, TOOL_MODULES } from "../assistant/registry.ts";

const ref = process.argv[2] || "f155f96";
const USER = "verify-registry-user";

const oldSource = execSync(
  `git -c safe.directory="${process.cwd()}" show ${ref}:assistant/tools.ts`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
);

// Load the old file by writing it somewhere its relative imports still resolve.
const shim = path.join(process.cwd(), "assistant", `__old_tools_${process.pid}.ts`);
fs.writeFileSync(shim, oldSource);
let failures = 0;
const fail = (msg: string) => { console.error(`FAIL ${msg}`); failures++; };

try {
  const shimUrl = "file://" + shim.split(String.fromCharCode(92)).join("/");
  const { buildTools: oldBuildTools } = await import(shimUrl);
  const before = oldBuildTools(USER) as any[];
  const after = buildTools(USER);

  const key = (t: any) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });
  const beforeMap = new Map(before.map((t) => [t.name, key(t)]));
  const afterMap = new Map(after.map((t) => [t.name, key(t)]));

  if (before.length !== after.length) fail(`tool count changed: ${before.length} -> ${after.length}`);

  for (const [name, sig] of beforeMap) {
    if (!afterMap.has(name)) { fail(`tool "${name}" disappeared`); continue; }
    if (afterMap.get(name) !== sig) fail(`tool "${name}" contract changed (description or parameters)`);
  }
  for (const name of afterMap.keys()) {
    if (!beforeMap.has(name)) fail(`tool "${name}" appeared unexpectedly`);
  }

  // Order matters for how tools are presented to the model.
  const beforeOrder = before.map((t) => t.name).join(",");
  const afterOrder = after.map((t) => t.name).join(",");
  if (beforeOrder !== afterOrder) fail(`tool order changed:\n  ${beforeOrder}\n  ${afterOrder}`);

  // Metadata is new, so it can't be diffed -- check it's complete and coherent instead.
  const manifest = toolManifest(USER);
  const domains = new Set(TOOL_MODULES.map((m) => m.domain));
  for (const t of manifest) {
    if (!domains.has(t.domain)) fail(`tool "${t.name}" has unknown domain "${t.domain}"`);
    if (t.sensitivity !== "household" && t.sensitivity !== "financial" && t.sensitivity !== "health") {
      fail(`tool "${t.name}" has invalid sensitivity ${JSON.stringify(t.sensitivity)}`);
    }
    if (typeof t.mutates !== "boolean") fail(`tool "${t.name}" has non-boolean mutates`);
  }

  console.log(`${after.length} tools, contracts identical to ${ref}.`);
  console.log(`Domains: ${toolDomainLabels().join(", ")}`);
  console.log(`Financial tools: ${manifest.filter((t) => t.sensitivity === "financial").map((t) => t.name).join(", ")}`);
  const writes = manifest.filter((t) => t.mutates).map((t) => t.name);
  console.log(`Mutating (${writes.length}): ${writes.join(", ")}`);
} finally {
  fs.unlinkSync(shim);
}

process.exit(failures === 0 ? 0 : 1);
