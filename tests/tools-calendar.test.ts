// assistant/tools/calendar.ts -- list_calendar_events, create_calendar_event,
// create_recurring_event, delete_calendar_event, delete_all_calendar_events.
//
// create_calendar_event's name, description and parameter schema are frozen
// by assistant/tools/README.md's "never rename an existing tool" rule -- the
// regression test here guards that its *behavior* (not just its schema)
// stayed identical once create_recurring_event and the series-aware deletes
// were added alongside it.

import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

// create_recurring_event clamps a start date in the past to today, and these fixtures use fixed autumn-2026 dates, so
// pin the clock before them.
mock.timers.enable({ apis: ["Date"], now: new Date(2026, 7, 1, 9, 0) });

const { createUser, putScopedItem, getScopedItems } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

let userId: string;

function call(name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(userId).find((t) => t.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.run(args);
}

before(() => {
  userId = createUser("alice-tools-calendar", "not-a-real-hash", "Alice");
  putScopedItem("household_members", userId, {
    id: "member-sam", scope: "joint", name: "Sam", likes: [], dislikes: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

after(cleanupDb);

describe("create_calendar_event (unchanged behavior)", () => {
  test("creates one event per date, still stored as separate rows -- no recurrence rule attached", async () => {
    const result = await call("create_calendar_event", {
      dates: ["2026-11-02", "2026-11-03"],
      title: "Book club",
    });
    assert.equal(result.created.length, 2);

    const rows = (getScopedItems("events", userId) as any[]).filter((e) => e.title === "Book club");
    assert.equal(rows.length, 2, "each date is still its own stored row");
    assert.ok(rows.every((r) => r.recurrence === undefined));
  });

  test("fans out across named members, one event per person", async () => {
    putScopedItem("household_members", userId, {
      id: "member-jordan", scope: "joint", name: "Jordan", likes: [], dislikes: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const result = await call("create_calendar_event", {
      dates: ["2026-11-05"],
      title: "At school",
      audience: "individual",
      members: ["Sam", "Jordan"],
    });
    assert.equal(result.created.length, 2);
    assert.deepEqual(result.created.map((c: any) => c.member).sort(), ["member-jordan", "member-sam"]);
  });

  test("an unmatched member name returns a not-found error, not a crash", async () => {
    const result = await call("create_calendar_event", {
      dates: ["2026-11-05"],
      title: "X",
      audience: "individual",
      members: ["Nobody"],
    });
    assert.match(result.error, /No family member named/);
  });
});

describe("create_recurring_event", () => {
  test("stores one row with a real recurrence rule, not one row per occurrence", async () => {
    const result = await call("create_recurring_event", {
      startDate: "2026-09-07", // a Monday
      days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      until: "2026-09-11", // bounded so this fixture doesn't bleed into later tests' date ranges
      title: "School",
    });
    assert.equal(result.created.length, 1);

    const rows = (getScopedItems("events", userId) as any[]).filter((e) => e.title === "School");
    assert.equal(rows.length, 1, "one stored row for the whole series");
    assert.deepEqual(rows[0].recurrence, { freq: "weekly", byDay: ["MO", "TU", "WE", "TH", "FR"], until: "2026-09-11" });
  });

  // "Jordan has piano every Thursday" on Sunday 2026-10-18: gemma4:12b sent last Thursday (2026-10-15) as the start.
  test("a startDate in the past is clamped to today, with a note saying so", async () => {
    mock.timers.setTime(new Date(2026, 9, 18, 12, 0).getTime());
    try {
      const result = await call("create_recurring_event", { startDate: "2026-10-15", days: ["thursday"], until: "2026-10-25", title: "Piano" });
      assert.equal(result.error, undefined);
      assert.equal(result.created[0].startDate, "2026-10-18");
      assert.match(result.note, /startDate 2026-10-15 was in the past, so the series starts today \(2026-10-18\)/);
      const rows = (getScopedItems("events", userId) as any[]).filter((e) => e.title === "Piano");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].date, "2026-10-18");
      assert.deepEqual(rows[0].recurrence.byDay, ["TH"]);
    } finally {
      mock.timers.setTime(new Date(2026, 7, 1, 9, 0).getTime());
    }
  });

  test("a startDate of today or later is left alone and carries no note", async () => {
    mock.timers.setTime(new Date(2026, 9, 18, 12, 0).getTime());
    try {
      const today = await call("create_recurring_event", { startDate: "2026-10-18", days: ["sunday"], until: "2026-10-18", title: "Today start" });
      assert.equal(today.created[0].startDate, "2026-10-18");
      assert.equal(today.note, undefined);
      const later = await call("create_recurring_event", { startDate: "2026-10-22", days: ["thursday"], until: "2026-10-22", title: "Later start" });
      assert.equal(later.created[0].startDate, "2026-10-22");
      assert.equal(later.note, undefined);
    } finally {
      mock.timers.setTime(new Date(2026, 7, 1, 9, 0).getTime());
    }
  });

  test("a series that ended before today is refused, not created", async () => {
    mock.timers.setTime(new Date(2026, 9, 18, 12, 0).getTime());
    try {
      const result = await call("create_recurring_event", { startDate: "2026-10-01", days: ["monday"], until: "2026-10-10", title: "Over" });
      assert.match(result.error, /ended on 2026-10-10, before today \(2026-10-18\)/);
      assert.equal((getScopedItems("events", userId) as any[]).some((e) => e.title === "Over"), false);
    } finally {
      mock.timers.setTime(new Date(2026, 7, 1, 9, 0).getTime());
    }
  });

  test("accepts abbreviated day names too", async () => {
    const result = await call("create_recurring_event", {
      startDate: "2026-09-08", // a Tuesday
      days: ["tue"],
      until: "2026-09-08",
      title: "Practice",
    });
    assert.deepEqual(result.created[0].days, ["TU"]);
  });

  test("rejects an unrecognized day list", async () => {
    const result = await call("create_recurring_event", {
      startDate: "2026-09-07",
      days: ["someday"],
      title: "X",
    });
    assert.match(result.error, /at least one real weekday/);
  });

  test("rejects until before startDate", async () => {
    const result = await call("create_recurring_event", {
      startDate: "2026-09-07",
      days: ["monday"],
      until: "2026-09-01",
      title: "X",
    });
    assert.match(result.error, /until cannot be before startDate/);
  });

  test("fans out across named members, same as create_calendar_event", async () => {
    const result = await call("create_recurring_event", {
      startDate: "2026-09-07",
      days: ["monday"],
      until: "2026-09-07",
      title: "Standing appointment",
      audience: "individual",
      members: ["Sam"],
    });
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].member, "member-sam");
  });
});

describe("list_calendar_events transparently expands recurring series", () => {
  test("a stored weekly series shows up as one entry per matching date in range", async () => {
    await call("create_recurring_event", {
      startDate: "2026-10-05", // a Monday
      days: ["monday"],
      until: "2026-10-19",
      title: "Weekly standing meeting",
    });

    const events = await call("list_calendar_events", { from: "2026-10-05", to: "2026-10-19" });
    const dates = events.filter((e: any) => e.title === "Weekly standing meeting").map((e: any) => e.date);
    assert.deepEqual(dates, ["2026-10-05", "2026-10-12", "2026-10-19"]);
  });
});

describe("delete_calendar_event on a recurring series", () => {
  test("deleting one occurrence removes the whole series and says so", async () => {
    const created = await call("create_recurring_event", {
      startDate: "2026-12-07", // a Monday
      days: ["monday"],
      title: "Temp series",
    });
    assert.equal(created.created.length, 1);

    // The occurrence two weeks out, not the anchor date itself.
    const result = await call("delete_calendar_event", { date: "2026-12-21", title: "Temp series" });
    assert.equal(result.deleted, "Temp series");
    assert.match(result.note, /entire series was removed/);

    const remaining = (getScopedItems("events", userId) as any[]).filter((e) => e.title === "Temp series");
    assert.equal(remaining.length, 0);
  });

  test("deleting a plain one-off event carries no series note", async () => {
    await call("create_calendar_event", { dates: ["2026-12-25"], title: "Holiday" });
    const result = await call("delete_calendar_event", { date: "2026-12-25", title: "Holiday" });
    assert.equal(result.deleted, "Holiday");
    assert.equal(result.note, undefined);
  });
});

describe("delete_all_calendar_events on a mix of recurring and one-off events", () => {
  test("counts and removes each series once, not once per occurrence", async () => {
    await call("create_recurring_event", { startDate: "2027-01-04", days: ["monday"], title: "Bulk series" }); // a Monday
    await call("create_calendar_event", { dates: ["2027-01-06"], title: "Bulk one-off" });

    // Bulk deletes ask first (assistant/confirmations.ts): the first call deletes nothing; the next call -- a new buildTools,
    // so a later turn -- carries the confirmation. The full flow is covered in assistantBulkDelete.test.ts.
    const args = { from: "2027-01-01", to: "2027-01-31" };
    const asked = await call("delete_all_calendar_events", args);
    assert.equal(asked.needsConfirmation, true);
    const result = await call("delete_all_calendar_events", { ...args, confirmation: asked.confirmation });
    assert.equal(result.deletedCount, 2, "one series + one one-off, not one row per occurrence");
    assert.match(result.note, /removed in full/);

    const remaining = (getScopedItems("events", userId) as any[]).filter(
      (e) => e.title === "Bulk series" || e.title === "Bulk one-off"
    );
    assert.equal(remaining.length, 0);
  });
});

// Models send {"members":["Sam"],"title":"Soccer"} with no audience. That used to save a family event and drop Sam
// without a word (eval deep #80); naming people now means it is theirs.
describe("members without an audience", () => {
  test("create_calendar_event treats named members as an individual event", async () => {
    const result = await call("create_calendar_event", { dates: ["2026-11-10"], title: "Soccer", members: ["Sam"] });
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].member, "member-sam");
    assert.equal(result.note, undefined);
    const row = (getScopedItems("events", userId) as any[]).find((e) => e.title === "Soccer" && e.date === "2026-11-10");
    assert.equal(row.audience, "individual");
    assert.equal(row.memberId, "member-sam");
  });

  test("create_recurring_event does the same", async () => {
    const result = await call("create_recurring_event", {
      startDate: "2026-11-10", days: ["tuesday"], title: "Soccer practice", members: ["Sam"],
    });
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].member, "member-sam");
    assert.equal(result.note, undefined);
    const row = (getScopedItems("events", userId) as any[]).find((e) => e.title === "Soccer practice");
    assert.equal(row.audience, "individual");
    assert.equal(row.memberId, "member-sam");
  });

  test("a single member given as a bare string, and an unknown name, are handled the same way as with audience", async () => {
    const ok = await call("create_calendar_event", { dates: ["2026-11-11"], title: "Dentist", members: "Sam" });
    assert.equal(ok.created[0].member, "member-sam");
    const bad = await call("create_calendar_event", { dates: ["2026-11-11"], title: "X", members: ["Nobody"] });
    assert.match(bad.error, /No family member named/);
  });

  test("an empty members list with no audience is still a family event", async () => {
    const result = await call("create_calendar_event", { dates: ["2026-11-12"], title: "Movie night", members: [] });
    assert.equal(result.created[0].member, undefined);
    assert.equal(result.note, undefined);
  });

  test("an explicit family audience is respected, and the result says the members were ignored", async () => {
    const one = await call("create_calendar_event", {
      dates: ["2026-11-13"], title: "Picnic", audience: "family", members: ["Sam"],
    });
    assert.equal(one.created[0].member, undefined);
    assert.match(one.note, /family event/);
    assert.match(one.note, /Sam/);
    assert.match(one.note, /ignored/);

    const rec = await call("create_recurring_event", {
      startDate: "2026-11-13", days: ["friday"], title: "Family pizza", audience: "family", members: ["Sam"],
    });
    assert.equal(rec.created[0].member, undefined);
    assert.match(rec.note, /ignored/);
    const row = (getScopedItems("events", userId) as any[]).find((e) => e.title === "Family pizza");
    assert.equal(row.audience, "family");
  });
});
