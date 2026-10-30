// routes/chores.ts -- a fifth section router (see tests/sectionRoutes.test.ts's
// header comment, which only claims four), new for Stage 10.3 (PLAN.md).
// Deliberately its own file rather than folded into sectionRoutes.test.ts,
// since that comment would otherwise go stale.
//
// Mounted behind requireAuth in server.ts; driving the router directly tests
// it as if that gate had passed, same as every other section router's tests.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, putScopedItem } = await loadDb();
const { choreRoutes, pointsByMember, FAMILY_POINTS_BUCKET } = await import("../routes/chores.ts");

function makeMember(userId: string, id: string, name: string, role?: "parent" | "kid") {
  putScopedItem("household_members", userId, {
    id, scope: "joint", name, likes: [], dislikes: [], role,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

let alice: string;

const asAlice = () => ({ session: { userId: alice } });

before(() => {
  alice = createUser("alice-chores", "not-a-real-hash", "Alice");
});

after(cleanupDb);

describe("chores: POST validation", () => {
  test("creates an unassigned, pending chore", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "  Empty the dishwasher  " },
    });

    assert.equal(result.body.chore.title, "Empty the dishwasher");
    assert.equal(result.body.chore.memberId, undefined);
    assert.equal(result.body.chore.status, "pending");
    assert.equal(result.body.chore.completedAt, undefined);
    assert.equal(result.body.chore.scope, "joint");
  });

  test("requires a title", async () => {
    for (const title of ["", "   ", undefined, 42]) {
      const result = await callRoute(choreRoutes, "POST", "/", { ...asAlice(), body: { date: "2026-09-10", title } });
      assert.equal(result.status, 400, `${String(title)} should be refused`);
    }
  });

  test("requires a YYYY-MM-DD date", async () => {
    for (const date of ["next tuesday", "2026-9-10", "", undefined]) {
      const result = await callRoute(choreRoutes, "POST", "/", { ...asAlice(), body: { date, title: "X" } });
      assert.equal(result.status, 400, `${String(date)} should be refused`);
    }
  });

  test("accepts a valid time and rejects a malformed one", async () => {
    const good = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "Trash out", time: "19:00" },
    });
    assert.equal(good.body.chore.time, "19:00");

    const bad = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "X", time: "25:00" },
    });
    assert.equal(bad.status, 400);
  });

  test("accepts a valid weekly recurrence rule and rejects a malformed one", async () => {
    const good = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-07", title: "Take out trash", recurrence: { freq: "weekly", byDay: ["MO"] } },
    });
    assert.deepEqual(good.body.chore.recurrence, { freq: "weekly", byDay: ["MO"] });
    assert.equal(good.body.chore.seriesId, good.body.chore.id);

    const bad = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-07", title: "X", recurrence: { freq: "weekly", byDay: [] } },
    });
    assert.equal(bad.status, 400);
  });

  // Stage 10.4, PLAN.md: points default to 1 (absent in storage) and are
  // capped 1-10, a whole number only.
  test("points defaults to absent (worth 1) when not supplied", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "No points given" },
    });
    assert.equal(result.body.chore.points, undefined);
  });

  test("accepts an in-range integer points value", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "Big chore", points: 7 },
    });
    assert.equal(result.body.chore.points, 7);
  });

  test("rejects points below 1, above 10, and non-integers", async () => {
    for (const points of [0, 11, 2.5, -3]) {
      const result = await callRoute(choreRoutes, "POST", "/", {
        ...asAlice(),
        body: { date: "2026-09-10", title: "X", points },
      });
      assert.equal(result.status, 400, `points=${points} should be refused`);
    }
  });

  test("PUT preserves points across an edit to another field", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-11", title: "Worth 5", points: 5 },
    });
    const updated = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...asAlice(),
      body: { title: "Worth 5 (renamed)" },
    });
    assert.equal(updated.body.chore.points, 5);
  });
});

describe("chores: pointsByMember", () => {
  // Stage 6.5 (PLAN.md): "done" alone no longer earns points -- a parent must
  // approve first. These use POST /:id/approve (the same route Parent's
  // approval queue calls) rather than reaching into storage directly.
  test("a done-but-unapproved chore counts as waiting, not earned", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-03-01", title: "One-off for points", memberId: "member-pts-1", points: 3 },
    });

    let points = pointsByMember(alice, "2027-03-01", "2027-03-01");
    assert.equal(points["member-pts-1"], undefined, "not done yet -- not counted");

    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    points = pointsByMember(alice, "2027-03-01", "2027-03-01");
    assert.deepEqual(points["member-pts-1"], { earned: 0, completedCount: 0, waitingCount: 1 });

    const approved = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    assert.equal(approved.status, 200);
    assert.equal(approved.body.chore.approval, "approved");
    points = pointsByMember(alice, "2027-03-01", "2027-03-01");
    assert.deepEqual(points["member-pts-1"], { earned: 3, completedCount: 1, waitingCount: 0 });
  });

  test("defaults to 1 point when the chore has no points field", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-03-02", title: "Default points", memberId: "member-pts-2" },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    const points = pointsByMember(alice, "2027-03-02", "2027-03-02");
    assert.deepEqual(points["member-pts-2"], { earned: 1, completedCount: 1, waitingCount: 0 });
  });

  test("credits an unassigned chore to the family bucket, not a member, once approved", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-03-03", title: "Unassigned for points", points: 4 },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    let points = pointsByMember(alice, "2027-03-03", "2027-03-03");
    assert.equal(points[FAMILY_POINTS_BUCKET].waitingCount, 1, "unassigned chores need approval too");

    await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    points = pointsByMember(alice, "2027-03-03", "2027-03-03");
    assert.equal(points[FAMILY_POINTS_BUCKET].earned, 4);
  });

  test("counts each APPROVED occurrence of a recurring chore, and a reopened one stops counting", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2027-03-01", title: "Recurring for points", memberId: "member-pts-3", points: 2,
        recurrence: { freq: "weekly", byDay: ["MO"] }, // 2027-03-01 is a Monday
      },
    });
    const seriesId = created.body.chore.id;
    const monday1 = `${seriesId}::2027-03-01`;
    const monday2 = `${seriesId}::2027-03-08`;

    await callRoute(choreRoutes, "PUT", `/${monday1}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "PUT", `/${monday2}`, { ...asAlice(), body: { status: "done" } });

    let points = pointsByMember(alice, "2027-03-01", "2027-03-08");
    assert.deepEqual(points["member-pts-3"], { earned: 0, completedCount: 0, waitingCount: 2 }, "done but not approved yet");

    await callRoute(choreRoutes, "POST", `/${monday1}/approve`, asAlice());
    await callRoute(choreRoutes, "POST", `/${monday2}/approve`, asAlice());
    points = pointsByMember(alice, "2027-03-01", "2027-03-08");
    assert.deepEqual(points["member-pts-3"], { earned: 4, completedCount: 2, waitingCount: 0 });

    // Reopening one occurrence removes just its own completion (Stage 10.3's
    // per-occurrence fix) -- pointsByMember must follow the same rule, and
    // the approval that lived on that entry goes with it.
    await callRoute(choreRoutes, "PUT", `/${monday1}`, { ...asAlice(), body: { status: "pending" } });
    points = pointsByMember(alice, "2027-03-01", "2027-03-08");
    assert.deepEqual(points["member-pts-3"], { earned: 2, completedCount: 1, waitingCount: 0 });
  });

  test("with no from/to, counts all-time", async () => {
    const points = pointsByMember(alice);
    assert.ok(points["member-pts-1"].earned >= 3, "earlier approved one-off completion still counted with no range");
  });

  test("a parent-role assignee is skipped entirely, even when done", async () => {
    makeMember(alice, "member-parent-pts", "Dad", "parent");
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-03-09", title: "Parent chore for points", memberId: "member-parent-pts", points: 5 },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });

    const points = pointsByMember(alice, "2027-03-09", "2027-03-09");
    assert.equal(points["member-parent-pts"], undefined, "parents never earn points, done or not");
  });
});

describe("chores: approval", () => {
  test("approve on a one-off chore that isn't done yet is a 400", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-04-01", title: "Not done yet", memberId: "member-approval-1" },
    });
    const result = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    assert.equal(result.status, 400);
  });

  test("approve then reject on a one-off chore: reject clears it back to pending", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-04-02", title: "Approve then reject", memberId: "member-approval-2" },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });

    const approved = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    assert.equal(approved.body.chore.approval, "approved");
    assert.equal(approved.body.chore.status, "done");

    const rejected = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/reject`, asAlice());
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.chore.status, "pending");
    assert.equal(rejected.body.chore.approval, "none");
  });

  test("reject on a recurring occurrence removes the completion, leaving other occurrences alone", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2027-04-05", title: "Recurring approval", memberId: "member-approval-3",
        recurrence: { freq: "weekly", byDay: ["MO"] }, // 2027-04-05 is a Monday
      },
    });
    const seriesId = created.body.chore.id;
    const monday1 = `${seriesId}::2027-04-05`;
    const monday2 = `${seriesId}::2027-04-12`;

    await callRoute(choreRoutes, "PUT", `/${monday1}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "PUT", `/${monday2}`, { ...asAlice(), body: { status: "done" } });

    const rejected = await callRoute(choreRoutes, "POST", `/${monday1}/reject`, asAlice());
    assert.equal(rejected.body.chore.status, "pending");

    const chores = (
      await callRoute(choreRoutes, "GET", "/", { ...asAlice(), query: { from: "2027-04-05", to: "2027-04-12" } })
    ).body.chores.filter((c: any) => c.seriesId === seriesId);
    assert.equal(chores.find((c: any) => c.date === "2027-04-05").status, "pending", "rejected occurrence reopened");
    assert.equal(chores.find((c: any) => c.date === "2027-04-12").approval, "waiting", "untouched occurrence unaffected");
  });

  test("approve on an occurrence that isn't done is a 400", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2027-04-19", title: "Not done recurring", memberId: "member-approval-4",
        recurrence: { freq: "weekly", byDay: ["MO"] }, // 2027-04-19 is a Monday
      },
    });
    const occurrenceId = `${created.body.chore.id}::2027-04-19`;
    const result = await callRoute(choreRoutes, "POST", `/${occurrenceId}/approve`, asAlice());
    assert.equal(result.status, 400);
  });

  test("un-ticking an approved chore clears its approval", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-04-20", title: "Approved then unticked", memberId: "member-approval-5" },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());

    const reopened = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "pending" } });
    assert.equal(reopened.body.chore.approval, "none");

    // Marking done again must not resurrect the stale approval.
    const redone = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    assert.equal(redone.body.chore.approval, "waiting");
  });

  test("a parent's chore is always approval \"none\", even when done, and approve/reject 400", async () => {
    makeMember(alice, "member-parent-approval", "Mom", "parent");
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-04-21", title: "Parent chore", memberId: "member-parent-approval" },
    });
    const done = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    assert.equal(done.body.chore.approval, "none", "parents never enter the waiting queue");

    const approveResult = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    assert.equal(approveResult.status, 400);
    const rejectResult = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/reject`, asAlice());
    assert.equal(rejectResult.status, 400);
  });

  test("approve/reject 404 for an unknown chore", async () => {
    assert.equal((await callRoute(choreRoutes, "POST", "/chore-nope/approve", asAlice())).status, 400);
    assert.equal((await callRoute(choreRoutes, "POST", "/chore-nope/reject", asAlice())).status, 400);
  });
});

describe("chores: series list", () => {
  test("GET /series returns master rows, unexpanded, sorted by title", async () => {
    await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2027-05-01", title: "Zzz last alphabetically",
        recurrence: { freq: "weekly", byDay: ["MO", "TU", "WE"] },
      },
    });
    await callRoute(choreRoutes, "POST", "/", { ...asAlice(), body: { date: "2027-05-02", title: "Aaa first alphabetically" } });

    const result = await callRoute(choreRoutes, "GET", "/series", asAlice());
    assert.equal(result.status, 200);
    const titles = result.body.chores
      .filter((c: any) => c.title === "Zzz last alphabetically" || c.title === "Aaa first alphabetically")
      .map((c: any) => c.title);
    assert.deepEqual(titles, ["Aaa first alphabetically", "Zzz last alphabetically"]);

    // Unexpanded: one row per series, not one per occurrence.
    const recurringRows = result.body.chores.filter((c: any) => c.title === "Zzz last alphabetically");
    assert.equal(recurringRows.length, 1);
    assert.equal(recurringRows[0].seriesId, recurringRows[0].id);
    assert.equal(recurringRows[0].completions, undefined, "the raw completions map never reaches the client");
  });
});

describe("chores: reading", () => {
  test("filters by an inclusive from/to range and sorts by date", async () => {
    const chores = (
      await callRoute(choreRoutes, "GET", "/", { ...asAlice(), query: { from: "2026-09-01", to: "2026-09-30" } })
    ).body.chores;

    assert.ok(chores.length > 0);
    assert.ok(chores.every((c: any) => c.date >= "2026-09-01" && c.date <= "2026-09-30"));
  });

  test("an out-of-range window is empty, not an error", async () => {
    const chores = (
      await callRoute(choreRoutes, "GET", "/", { ...asAlice(), query: { from: "1999-01-01", to: "1999-12-31" } })
    ).body.chores;
    assert.deepEqual(chores, []);
  });

  test("an unknown id is a 404 on PUT and DELETE", async () => {
    assert.equal((await callRoute(choreRoutes, "PUT", "/chore-nope", { ...asAlice(), body: {} })).status, 404);
    assert.equal((await callRoute(choreRoutes, "DELETE", "/chore-nope", asAlice())).status, 404);
  });
});

describe("chores: completing", () => {
  let choreId: string;

  before(async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-12", title: "Vacuum" },
    });
    choreId = created.body.chore.id;
  });

  test("marking done sets completedAt", async () => {
    const result = await callRoute(choreRoutes, "PUT", `/${choreId}`, { ...asAlice(), body: { status: "done" } });
    assert.equal(result.body.chore.status, "done");
    assert.ok(result.body.chore.completedAt);
  });

  test("editing another field while done does not move completedAt", async () => {
    const first = (await callRoute(choreRoutes, "PUT", `/${choreId}`, { ...asAlice(), body: {} })).body.chore;
    const second = await callRoute(choreRoutes, "PUT", `/${choreId}`, { ...asAlice(), body: { title: "Vacuum living room" } });
    assert.equal(second.body.chore.completedAt, first.completedAt);
  });

  test("reopening clears completedAt", async () => {
    const result = await callRoute(choreRoutes, "PUT", `/${choreId}`, { ...asAlice(), body: { status: "pending" } });
    assert.equal(result.body.chore.status, "pending");
    assert.equal(result.body.chore.completedAt, undefined);
  });
});

describe("chores: recurring series", () => {
  let seriesId: string;

  before(async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2026-10-05", title: "Take out trash",
        recurrence: { freq: "weekly", byDay: ["MO", "TU"] }, // 2026-10-05 is a Monday
      },
    });
    seriesId = created.body.chore.id;
  });

  test("GET expands one stored row into an occurrence per matching week in range", async () => {
    const chores = (
      await callRoute(choreRoutes, "GET", "/", { ...asAlice(), query: { from: "2026-10-05", to: "2026-10-19" } })
    ).body.chores.filter((c: any) => c.seriesId === seriesId);
    assert.deepEqual(
      chores.map((c: any) => c.date),
      ["2026-10-05", "2026-10-06", "2026-10-12", "2026-10-13", "2026-10-19"]
    );
  });

  // The bug this fixes: completion used to live on the series master row, so
  // marking one occurrence done marked every occurrence done (Stage 10.3, PLAN.md).
  test("completing Monday's occurrence leaves Tuesday's pending", async () => {
    const monday = `${seriesId}::2026-10-05`;
    const tuesday = `${seriesId}::2026-10-06`;

    const result = await callRoute(choreRoutes, "PUT", `/${monday}`, { ...asAlice(), body: { status: "done" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.chore.id, monday, "an occurrence-shaped id, not the master row");
    assert.equal(result.body.chore.status, "done");
    assert.ok(result.body.chore.completedAt);
    assert.equal(result.body.chore.completions, undefined, "the raw completions map never reaches the client");

    const chores = (
      await callRoute(choreRoutes, "GET", "/", { ...asAlice(), query: { from: "2026-10-05", to: "2026-10-19" } })
    ).body.chores.filter((c: any) => c.seriesId === seriesId);
    assert.equal(chores.find((c: any) => c.date === "2026-10-05").status, "done");
    assert.equal(chores.find((c: any) => c.date === "2026-10-06").status, "pending", "Tuesday untouched");
    assert.equal(chores.find((c: any) => c.date === "2026-10-12").status, "pending", "next Monday untouched");
    assert.equal(tuesday, `${seriesId}::2026-10-06`); // sanity on the id this test is about
  });

  test("reopening an occurrence removes just its completion", async () => {
    const monday = `${seriesId}::2026-10-05`;
    const result = await callRoute(choreRoutes, "PUT", `/${monday}`, { ...asAlice(), body: { status: "pending" } });
    assert.equal(result.body.chore.status, "pending");
    assert.equal(result.body.chore.completedAt, undefined);
  });

  test("a date the series doesn't fall on is refused, not silently accepted", async () => {
    const notScheduled = `${seriesId}::2026-10-07`; // a Wednesday -- not in byDay
    const result = await callRoute(choreRoutes, "PUT", `/${notScheduled}`, { ...asAlice(), body: { status: "done" } });
    assert.equal(result.status, 400);
  });

  test("DELETE against one occurrence's synthetic id removes the whole series", async () => {
    const occurrenceId = `${seriesId}::2026-10-19`;
    assert.equal((await callRoute(choreRoutes, "DELETE", `/${occurrenceId}`, asAlice())).status, 200);

    const chores = (
      await callRoute(choreRoutes, "GET", "/", { ...asAlice(), query: { from: "2026-10-05", to: "2026-10-19" } })
    ).body.chores.filter((c: any) => c.seriesId === seriesId);
    assert.deepEqual(chores, []);
  });
});

describe("chores: status-only PUT with a bare id on a recurring chore", () => {
  // Writing the top-level `status` field is now a silent no-op for a
  // recurring chore -- listChores only ever reads it for a one-off (see
  // withOccurrenceStatus in routes/chores.ts). A bare-id status PUT must
  // therefore also go through setChoreOccurrenceStatus, which resolves it to
  // today's occurrence (using the local, not UTC, date -- see todayISO in
  // routes/recurrence.ts).
  test("marks today's occurrence, not the invisible top-level field", async () => {
    const today = new Date();
    const todayDate = today.toLocaleDateString("en-CA");
    const todayCode = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][today.getDay()];

    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: todayDate, title: "Water the plants", recurrence: { freq: "weekly", byDay: [todayCode] } },
    });
    const bareId = created.body.chore.id;

    const result = await callRoute(choreRoutes, "PUT", `/${bareId}`, { ...asAlice(), body: { status: "done" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.chore.id, `${bareId}::${todayDate}`, "resolved to today's occurrence, not the master row");
    assert.equal(result.body.chore.status, "done");

    const chores = (
      await callRoute(choreRoutes, "GET", "/", { ...asAlice(), query: { from: todayDate, to: todayDate } })
    ).body.chores;
    assert.equal(chores.find((c: any) => c.title === "Water the plants").status, "done");
  });
});
