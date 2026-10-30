// src/sections/chores/parentHelpers.ts -- pure helpers behind Phase 3's
// ParentView.tsx (PLAN.md). No DOM/React involved, so these can be driven
// directly like routes/recurrence.test.ts drives its pure functions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  addDaysISO, startOfWeek, isParentMember, occurrenceMark, formatRepeatSummary,
} from "../src/sections/chores/parentHelpers.ts";

describe("parentHelpers: date math", () => {
  test("addDaysISO adds/subtracts days across a month boundary", () => {
    assert.equal(addDaysISO("2027-04-30", 1), "2027-05-01");
    assert.equal(addDaysISO("2027-05-01", -1), "2027-04-30");
  });

  test("startOfWeek returns the preceding (or same) Sunday", () => {
    assert.equal(startOfWeek("2027-04-07"), "2027-04-04"); // Wednesday -> that week's Sunday
    assert.equal(startOfWeek("2027-04-04"), "2027-04-04"); // already a Sunday
  });
});

describe("parentHelpers: isParentMember", () => {
  test("only role === \"parent\" counts as a parent; unset or \"kid\" does not", () => {
    assert.equal(isParentMember({ role: "parent" }), true);
    assert.equal(isParentMember({ role: "kid" }), false);
    assert.equal(isParentMember({ role: undefined }), false);
  });
});

describe("parentHelpers: occurrenceMark", () => {
  const today = "2027-04-10";

  test("approved beats everything else", () => {
    assert.equal(occurrenceMark({ date: "2027-04-01", status: "done", approval: "approved" }, today), "✓");
  });

  test("waiting shows the hourglass", () => {
    assert.equal(occurrenceMark({ date: "2027-04-10", status: "done", approval: "waiting" }, today), "⏳");
  });

  test("a past pending occurrence is missed", () => {
    assert.equal(occurrenceMark({ date: "2027-04-09", status: "pending", approval: "none" }, today), "✗");
  });

  test("today's pending occurrence is upcoming, not missed", () => {
    assert.equal(occurrenceMark({ date: "2027-04-10", status: "pending", approval: "none" }, today), "○");
  });

  test("a future pending occurrence is upcoming", () => {
    assert.equal(occurrenceMark({ date: "2027-04-15", status: "pending", approval: "none" }, today), "○");
  });
});

describe("parentHelpers: formatRepeatSummary", () => {
  test("a one-off chore shows its date", () => {
    assert.equal(formatRepeatSummary({ date: "2027-09-25" }), "One-off Sep 25");
  });

  test("a weekly chore lists days in week order, regardless of storage order", () => {
    assert.equal(
      formatRepeatSummary({ date: "2027-04-05", recurrence: { freq: "weekly", byDay: ["FR", "MO", "WE"] } }),
      "Mon, Wed, Fri"
    );
  });

  test("a single weekday", () => {
    assert.equal(
      formatRepeatSummary({ date: "2027-04-05", recurrence: { freq: "weekly", byDay: ["SU"] } }),
      "Sun"
    );
  });
});
