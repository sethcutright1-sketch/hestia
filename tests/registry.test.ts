// assistant/registry.ts -- the tool registry, and the invariant that the tool
// list the CLIENT is shown always agrees with the one a model is actually
// offered.
//
// server.ts derives those two lists from different functions (`toolManifest`
// for GET /api/assistant/tools, `buildTools` + `toolsForProvider` for the chat
// loop). Nothing forces them to stay in step, so if they drift the UI starts
// advertising a capability the chat endpoint is about to refuse -- or worse,
// hides one it will happily run.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { createUser } = await loadDb();
const { buildTools, findTool, toolManifest, toolDomainLabels, toolPromptRules, TOOL_MODULES } =
  await import("../assistant/registry.ts");
const { toolsForProvider } = await import("../assistant/providers/index.ts");

const userId = createUser("alice-registry", "not-a-real-hash", "Alice");

after(cleanupDb);

describe("every module declares the metadata the registry stamps on", () => {
  test("each module has a domain, a sensitivity, a label, and builds tools", () => {
    assert.ok(TOOL_MODULES.length > 0);
    for (const module of TOOL_MODULES) {
      assert.equal(typeof module.domain, "string", "domain");
      assert.ok(module.domain.length > 0, `${module.domain}: empty domain`);
      assert.ok(
        module.sensitivity === "financial" || module.sensitivity === "household" || module.sensitivity === "health",
        `${module.domain}: sensitivity must be "financial", "household" or "health", got ${module.sensitivity}`
      );
      assert.ok(module.label.length > 0, `${module.domain}: empty label`);
      assert.ok(module.build(userId).length > 0, `${module.domain}: built no tools`);
    }
  });

  test("domains are unique", () => {
    const domains = TOOL_MODULES.map((m) => m.domain);
    assert.equal(new Set(domains).size, domains.length);
  });
});

describe("buildTools stamps domain and sensitivity from the module", () => {
  const tools = buildTools(userId);

  test("every tool carries both fields", () => {
    for (const tool of tools) {
      assert.ok(tool.domain, `${tool.name} has no domain`);
      assert.ok(tool.sensitivity, `${tool.name} has no sensitivity`);
    }
  });

  test("a tool's sensitivity always matches its own module's", () => {
    // The point of stamping rather than letting a tool literal declare it: a
    // budget tool cannot accidentally ship as "household" and slip past
    // toolsForProvider into a cloud request.
    const byDomain = new Map(TOOL_MODULES.map((m) => [m.domain, m.sensitivity]));
    for (const tool of tools) {
      assert.equal(tool.sensitivity, byDomain.get(tool.domain), `${tool.name} disagrees with its module`);
    }
  });

  test("every budget-domain tool is financial", () => {
    const budgetTools = tools.filter((t) => t.domain === "budget");
    assert.ok(budgetTools.length > 0, "expected the budget module to contribute tools");
    for (const tool of budgetTools) {
      assert.equal(tool.sensitivity, "financial", `${tool.name} must be financial`);
    }
  });

  test("`mutates` is normalized to a real boolean on every tool", () => {
    // The client reads this to decide what counts as a write; `undefined`
    // would be falsy but would also break a strict === true check somewhere.
    for (const tool of tools) {
      assert.equal(typeof tool.mutates, "boolean", `${tool.name}.mutates is ${typeof tool.mutates}`);
    }
  });

  test("tool names are unique and every tool is callable", () => {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool name");
    for (const tool of tools) {
      assert.equal(typeof tool.run, "function", `${tool.name} has no run()`);
      assert.ok(tool.description.length > 0, `${tool.name} has no description`);
      assert.equal(tool.parameters.type, "object", `${tool.name} parameters must be an object schema`);
    }
  });

  test("every declared required parameter actually exists in properties", () => {
    // A required name with no matching property is a schema a model cannot
    // satisfy -- it reads as "you must pass X" with no description of X.
    for (const tool of tools) {
      for (const required of tool.parameters.required || []) {
        assert.ok(
          Object.hasOwn(tool.parameters.properties, required),
          `${tool.name}: required "${required}" is not in properties`
        );
      }
    }
  });
});

describe("findTool", () => {
  test("finds a real tool and returns undefined for an unknown name", () => {
    assert.equal(findTool(userId, "list_shopping_lists")?.name, "list_shopping_lists");
    assert.equal(findTool(userId, "launch_missiles"), undefined);
  });
});

describe("toolManifest agrees with what the chat loop actually offers", () => {
  test("unlocked: the manifest lists exactly the tools built", () => {
    const built = buildTools(userId).map((t) => t.name).sort();
    const manifest = toolManifest(userId, false).map((t) => t.name).sort();
    assert.deepEqual(manifest, built);
  });

  test("locked: the manifest lists exactly what a locked chat turn would offer", () => {
    // server.ts, when the PIN lock is engaged, filters buildTools by
    // `sensitivity !== "financial"`. The manifest has to reach the same set,
    // or the client advertises a tool the chat endpoint will refuse.
    const offeredWhenLocked = buildTools(userId)
      .filter((t) => t.sensitivity !== "financial")
      .map((t) => t.name)
      .sort();
    const manifest = toolManifest(userId, true).map((t) => t.name).sort();

    assert.deepEqual(manifest, offeredWhenLocked);
    assert.ok(offeredWhenLocked.length > 0, "locking should not remove everything");
    assert.ok(
      manifest.length < toolManifest(userId, false).length,
      "locking should actually remove something"
    );
  });

  test("the locked manifest contains no financial tool at all", () => {
    for (const entry of toolManifest(userId, true)) {
      assert.notEqual(entry.sensitivity, "financial", `${entry.name} leaked into the locked manifest`);
    }
  });

  test("the manifest deliberately withholds `run` and the parameter schema", () => {
    // The client needs to know what each tool is and whether it writes, not
    // how to call it -- the schema is the model's business.
    for (const entry of toolManifest(userId, false) as any[]) {
      assert.equal(entry.run, undefined);
      assert.equal(entry.parameters, undefined);
      assert.deepEqual(
        Object.keys(entry).sort(),
        ["description", "domain", "mutates", "name", "sensitivity"]
      );
    }
  });

  test("a cloud provider's offered set matches the locked manifest's shape", () => {
    // Different code path, same guarantee: nothing financial, and nothing health either (the calorie-diary
    // lock). If these two ever disagree, one of the two layers has stopped filtering.
    const cloudNames = toolsForProvider("anthropic", buildTools(userId)).map((t) => t.name).sort();
    const lockedNames = toolManifest(userId, true, { foodDiaryLocked: true }).map((t) => t.name).sort();
    assert.deepEqual(cloudNames, lockedNames);
  });
});

describe("prompt generation follows the same lock rule", () => {
  test("locking removes the finance section label from the prompt", () => {
    const unlocked = toolDomainLabels(false);
    const locked = toolDomainLabels(true);

    assert.ok(unlocked.includes("household finances"));
    assert.equal(locked.includes("household finances"), false);
    assert.equal(locked.length, unlocked.length - 1);
  });

  test("labels and rules are generated from the modules, not hand-maintained", () => {
    assert.deepEqual(toolDomainLabels(false), TOOL_MODULES.map((m) => m.label));
    assert.deepEqual(
      toolPromptRules(false),
      TOOL_MODULES.flatMap((m) => m.promptRules || [])
    );
  });

  test("rule lines carry no leading dash -- systemPrompt adds it", () => {
    // Double-dashed bullets would show up in the prompt as "- - Rule".
    for (const rule of toolPromptRules(false)) {
      assert.equal(rule.trimStart().startsWith("-"), false, `rule starts with a dash: ${rule}`);
      assert.ok(rule.trim().length > 0);
    }
  });

  test("locking drops any rule lines owned by a financial module", () => {
    const financialRules = TOOL_MODULES.filter((m) => m.sensitivity === "financial").flatMap(
      (m) => m.promptRules || []
    );
    const locked = toolPromptRules(true);
    for (const rule of financialRules) {
      assert.equal(locked.includes(rule), false, `financial rule leaked while locked: ${rule}`);
    }
  });
});
