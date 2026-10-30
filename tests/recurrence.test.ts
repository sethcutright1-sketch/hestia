// recurrence.ts -- expanding a stored weekly rule into individual occurrence
// rows, the piece everything else in Stage 10's recurrence work depends on.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { expandOccurrences, seriesIdOf, isValidRecurrence, type Recurring } from "../routes/recurrence.ts";

describe("isValidRecurrence", () => {
  test("accepts a minimal weekly rule", () => {
    assert.equal(isValidRecurrence({ freq: "weekly", byDay: ["MO"] }), true);
  });

  test("accepts an until date", () => {
    assert.equal(isValidRecurrence({ freq: "weekly", byDay: ["MO", "TU"], until: "2026-12-31" }), true);
  });

  test("rejects a non-weekly freq", () => {
    assert.equal(isValidRecurrence({ freq: "monthly", byDay: ["MO"] }), false);
  });

  test("rejects an empty or missing byDay", () => {
    assert.equal(isValidRecurrence({ freq: "weekly", byDay: [] }), false);
    assert.equal(isValidRecurrence({ freq: "weekly" }), false);
  });

  test("rejects an unrecognized weekday code", () => {
    assert.equal(isValidRecurrence({ freq: "weekly", byDay: ["Monday"] }), false);
  });

  test("rejects a malformed until", () => {
    assert.equal(isValidRecurrence({ freq: "weekly", byDay: ["MO"], until: "12/31/2026" }), false);
  });

  test("rejects non-objects", () => {
    assert.equal(isValidRecurrence(undefined), false);
    assert.equal(isValidRecurrence("weekly"), false);
  });
});

describe("seriesIdOf", () => {
  test("recovers the master id from a synthetic occurrence id", () => {
    assert.equal(seriesIdOf("event-abc123::2026-09-14"), "event-abc123");
  });

  test("passes a plain id through unchanged", () => {
    assert.equal(seriesIdOf("event-abc123"), "event-abc123");
  });
});

describe("expandOccurrences", () => {
  test("a non-recurring row passes through unchanged, seriesId equal to its own id", () => {
    const rows: Recurring[] = [{ id: "e1", date: "2026-09-10" }];
    const result = expandOccurrences(rows, "2026-09-01", "2026-09-30");
    assert.deepEqual(result, [{ id: "e1", date: "2026-09-10", seriesId: "e1" }]);
  });

  test("a non-recurring row outside [from, to] is dropped", () => {
    const rows: Recurring[] = [{ id: "e1", date: "2026-09-10" }];
    assert.deepEqual(expandOccurrences(rows, "2026-10-01", "2026-10-31"), []);
  });

  test("with neither from nor to, a non-recurring row is returned regardless of date -- unbounded, unchanged from before recurrence existed", () => {
    const rows: Recurring[] = [{ id: "e1", date: "1999-01-01" }];
    assert.deepEqual(expandOccurrences(rows), [{ id: "e1", date: "1999-01-01", seriesId: "e1" }]);
  });

  test("a weekly Mon-Fri series yields one occurrence per matching weekday in range", () => {
    const rows: Recurring[] = [
      { id: "school", date: "2026-09-07", recurrence: { freq: "weekly", byDay: ["MO", "TU", "WE", "TH", "FR"] } },
    ];
    // 2026-09-07 is a Monday; ask for that Monday through the following Sunday.
    const result = expandOccurrences(rows, "2026-09-07", "2026-09-13");
    assert.deepEqual(
      result.map((r) => r.date),
      ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]
    );
    assert.ok(result.every((r) => r.seriesId === "school"));
    assert.deepEqual(
      result.map((r) => r.id),
      ["school::2026-09-07", "school::2026-09-08", "school::2026-09-09", "school::2026-09-10", "school::2026-09-11"]
    );
  });

  test("occurrences never appear before the series' own anchor date", () => {
    const rows: Recurring[] = [
      { id: "practice", date: "2026-09-08", recurrence: { freq: "weekly", byDay: ["TU"] } }, // first Tuesday it applies
    ];
    // Query window starts a week earlier, on 2026-09-01 -- also a Tuesday --
    // which would wrongly appear if the anchor weren't respected.
    const result = expandOccurrences(rows, "2026-09-01", "2026-09-15");
    assert.deepEqual(result.map((r) => r.date), ["2026-09-08", "2026-09-15"]);
  });

  test("`until` stops expansion after that date, inclusive", () => {
    const rows: Recurring[] = [
      { id: "temp", date: "2026-09-07", recurrence: { freq: "weekly", byDay: ["MO"], until: "2026-09-14" } },
    ];
    const result = expandOccurrences(rows, "2026-09-01", "2026-09-30");
    assert.deepEqual(result.map((r) => r.date), ["2026-09-07", "2026-09-14"]);
  });

  test("an open-ended series (no until) is capped at the horizon when `to` is omitted", () => {
    const rows: Recurring[] = [
      { id: "forever", date: "2026-01-05", recurrence: { freq: "weekly", byDay: ["MO"] } },
    ];
    const result = expandOccurrences(rows, "2026-01-05");
    assert.ok(result.length > 0);
    // Every occurrence must fall within 180 days of the query start -- none run away unbounded.
    for (const r of result) {
      const days = (Date.parse(r.date) - Date.parse("2026-01-05")) / 86_400_000;
      assert.ok(days <= 180, `occurrence ${r.date} is more than 180 days out`);
    }
  });

  test("a series anchored in the future produces nothing for a window entirely before it", () => {
    const rows: Recurring[] = [
      { id: "later", date: "2027-01-01", recurrence: { freq: "weekly", byDay: ["FR"] } },
    ];
    assert.deepEqual(expandOccurrences(rows, "2026-09-01", "2026-09-30"), []);
  });

  test("mixes recurring and non-recurring rows in one call", () => {
    const rows: Recurring[] = [
      { id: "one-off", date: "2026-09-10" },
      { id: "weekly", date: "2026-09-07", recurrence: { freq: "weekly", byDay: ["MO"] } },
    ];
    const result = expandOccurrences(rows, "2026-09-01", "2026-09-30");
    assert.deepEqual(
      result.map((r) => r.id).sort(),
      ["one-off", "weekly::2026-09-07", "weekly::2026-09-14", "weekly::2026-09-21", "weekly::2026-09-28"].sort()
    );
  });
});
