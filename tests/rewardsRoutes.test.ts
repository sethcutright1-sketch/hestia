// routes/rewards.ts -- the points-only rewards catalog and redemptions,
// new for Stage 10.4 (PLAN.md). Same testing approach as
// tests/choresRoutes.test.ts: drives the router directly, as if requireAuth
// had already passed (see tests/helpers/router.ts's header comment).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, putScopedItem } = await loadDb();
const { rewardRoutes } = await import("../routes/rewards.ts");
const { choreRoutes } = await import("../routes/chores.ts");

let alice: string;
let memberId: string;

const asAlice = () => ({ session: { userId: alice } });

function makeMember(id: string, name: string, role?: "parent" | "kid") {
  putScopedItem("household_members", alice, {
    id, scope: "joint", name, likes: [], dislikes: [], role,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

// Stage 6.5 (PLAN.md): a chore only counts toward points/balances once a
// parent approves it -- earn a member points here via create -> done ->
// approve, the same three steps Parent's approval queue drives.
async function earnPoints(targetMemberId: string, date: string, points: number, title: string) {
  const chore = await callRoute(choreRoutes, "POST", "/", {
    ...asAlice(),
    body: { date, title, memberId: targetMemberId, points },
  });
  await callRoute(choreRoutes, "PUT", `/${chore.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
  await callRoute(choreRoutes, "POST", `/${chore.body.chore.id}/approve`, asAlice());
}

before(() => {
  alice = createUser("alice-rewards", "not-a-real-hash", "Alice");
  memberId = "member-rewards-sam";
  makeMember(memberId, "Sam");
});

after(cleanupDb);

describe("rewards: POST validation", () => {
  test("creates a reward", async () => {
    const result = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "Movie night", cost: 20 } });
    assert.equal(result.body.reward.title, "Movie night");
    assert.equal(result.body.reward.cost, 20);
    assert.equal(result.body.reward.scope, "joint");
  });

  test("requires a title", async () => {
    const result = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "", cost: 5 } });
    assert.equal(result.status, 400);
  });

  test("rejects a non-integer, zero, negative, or too-large cost", async () => {
    for (const cost of [0, -1, 2.5, 1001]) {
      const result = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "X", cost } });
      assert.equal(result.status, 400, `cost=${cost} should be refused`);
    }
  });
});

describe("rewards: reading", () => {
  test("GET / lists created rewards", async () => {
    const result = await callRoute(rewardRoutes, "GET", "/", asAlice());
    assert.ok(result.body.rewards.some((r: any) => r.title === "Movie night"));
  });

  test("DELETE removes a reward, 404 on an unknown id", async () => {
    const created = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "Temp", cost: 3 } });
    const deleted = await callRoute(rewardRoutes, "DELETE", `/${created.body.reward.id}`, asAlice());
    assert.equal(deleted.status, 200);
    assert.equal((await callRoute(rewardRoutes, "DELETE", "/reward-nope", asAlice())).status, 404);
  });
});

describe("rewards: balances and redemptions", () => {
  test("balance starts at zero for a member with no completed chores", async () => {
    const balances = (await callRoute(rewardRoutes, "GET", "/balances", asAlice())).body.balances;
    assert.deepEqual(balances[memberId], { earned: 0, adjusted: 0, spent: 0, balance: 0 });
  });

  test("redeem fails with 400 when the balance is below the reward's cost", async () => {
    const reward = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "Too expensive", cost: 100 } });
    const result = await callRoute(rewardRoutes, "POST", `/${reward.body.reward.id}/redeem`, {
      ...asAlice(), body: { memberId },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /point/i);
  });

  test("redeem 404s for an unknown reward or an unknown member", async () => {
    const rewardMissing = await callRoute(rewardRoutes, "POST", "/reward-nope/redeem", { ...asAlice(), body: { memberId } });
    assert.equal(rewardMissing.status, 404);

    const reward = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "X", cost: 1 } });
    const memberMissing = await callRoute(rewardRoutes, "POST", `/${reward.body.reward.id}/redeem`, {
      ...asAlice(), body: { memberId: "member-nope" },
    });
    assert.equal(memberMissing.status, 404);
  });

  test("earning points then redeeming succeeds and updates the balance", async () => {
    // Earn 10 points via a completed AND APPROVED chore, same as
    // pointsByMember reads (Stage 6.5 -- "done" alone isn't enough).
    await earnPoints(memberId, "2027-04-01", 10, "Chore for redemption");

    const before = (await callRoute(rewardRoutes, "GET", "/balances", asAlice())).body.balances[memberId];
    assert.equal(before.balance, 10);

    const reward = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "Ice cream", cost: 6 } });
    const redeemed = await callRoute(rewardRoutes, "POST", `/${reward.body.reward.id}/redeem`, {
      ...asAlice(), body: { memberId },
    });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.body.redemption.rewardTitle, "Ice cream");
    assert.equal(redeemed.body.redemption.cost, 6);
    assert.equal(redeemed.body.balance, 4);

    const after = (await callRoute(rewardRoutes, "GET", "/balances", asAlice())).body.balances[memberId];
    assert.deepEqual(after, { earned: 10, adjusted: 0, spent: 6, balance: 4 });

    const redemptions = (await callRoute(rewardRoutes, "GET", "/redemptions", { ...asAlice(), query: { memberId } })).body
      .redemptions;
    assert.ok(redemptions.some((r: any) => r.rewardTitle === "Ice cream" && r.cost === 6));
  });

  test("deleting the reward afterward does not change the redemption's snapshot", async () => {
    const reward = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "Snapshot test", cost: 1 } });
    // Give the member exactly enough via another chore.
    await earnPoints(memberId, "2027-04-02", 1, "Chore for snapshot");

    const redeemed = await callRoute(rewardRoutes, "POST", `/${reward.body.reward.id}/redeem`, {
      ...asAlice(), body: { memberId },
    });
    assert.equal(redeemed.status, 200);

    await callRoute(rewardRoutes, "DELETE", `/${reward.body.reward.id}`, asAlice());

    const redemptions = (await callRoute(rewardRoutes, "GET", "/redemptions", { ...asAlice(), query: { memberId } })).body
      .redemptions;
    const snapshot = redemptions.find((r: any) => r.id === redeemed.body.redemption.id);
    assert.equal(snapshot.rewardTitle, "Snapshot test");
    assert.equal(snapshot.cost, 1);
  });

  test("a done-but-unapproved chore doesn't move the balance", async () => {
    const waitingMember = "member-rewards-waiting";
    makeMember(waitingMember, "Waiting Kid");
    const chore = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-04-03", title: "Waiting chore", memberId: waitingMember, points: 5 },
    });
    await callRoute(choreRoutes, "PUT", `/${chore.body.chore.id}`, { ...asAlice(), body: { status: "done" } });

    const balance = (await callRoute(rewardRoutes, "GET", "/balances", asAlice())).body.balances[waitingMember];
    assert.deepEqual(balance, { earned: 0, adjusted: 0, spent: 0, balance: 0 }, "waiting doesn't count until approved");
  });
});

describe("rewards: parent members are excluded from balances", () => {
  const parentMemberId = "member-rewards-dad";

  before(() => {
    makeMember(parentMemberId, "Dad", "parent");
  });

  test("balancesByMember has no entry for a parent member", async () => {
    const balances = (await callRoute(rewardRoutes, "GET", "/balances", asAlice())).body.balances;
    assert.equal(balances[parentMemberId], undefined);
  });

  test("redeeming for a parent member is a 400", async () => {
    const reward = await callRoute(rewardRoutes, "POST", "/", { ...asAlice(), body: { title: "Parent reward attempt", cost: 1 } });
    const result = await callRoute(rewardRoutes, "POST", `/${reward.body.reward.id}/redeem`, {
      ...asAlice(), body: { memberId: parentMemberId },
    });
    assert.equal(result.status, 400);
  });
});

describe("rewards: point adjustments", () => {
  const adjustMemberId = "member-rewards-adjust";
  const parentMemberId = "member-rewards-adjust-parent";

  before(() => {
    makeMember(adjustMemberId, "Adjustable Kid");
    makeMember(parentMemberId, "Adjustable Parent", "parent");
  });

  test("a positive adjustment raises the balance, visible in GET /adjustments", async () => {
    const result = await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...asAlice(),
      body: { memberId: adjustMemberId, amount: 5, note: "Helped with the garage sale" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.adjustment.amount, 5);
    assert.equal(result.body.adjustment.note, "Helped with the garage sale");
    assert.equal(result.body.balance, 5);

    const balance = (await callRoute(rewardRoutes, "GET", "/balances", asAlice())).body.balances[adjustMemberId];
    assert.equal(balance.balance, 5);

    const adjustments = (
      await callRoute(rewardRoutes, "GET", "/adjustments", { ...asAlice(), query: { memberId: adjustMemberId } })
    ).body.adjustments;
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0].amount, 5);
  });

  test("a negative adjustment lowers the balance and newest comes first", async () => {
    const result = await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...asAlice(),
      body: { memberId: adjustMemberId, amount: -2, note: "" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.balance, 3);

    const adjustments = (
      await callRoute(rewardRoutes, "GET", "/adjustments", { ...asAlice(), query: { memberId: adjustMemberId } })
    ).body.adjustments;
    assert.equal(adjustments[0].amount, -2, "newest first");
    assert.equal(adjustments[1].amount, 5);
  });

  test("note is trimmed and capped at 200 characters, and may be empty", async () => {
    const long = "x".repeat(500);
    const result = await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...asAlice(),
      body: { memberId: adjustMemberId, amount: 1, note: `  ${long}  ` },
    });
    assert.equal(result.body.adjustment.note.length, 200);
  });

  test("rejects a zero, too-large, or non-integer amount", async () => {
    for (const amount of [0, 101, -101, 2.5]) {
      const result = await callRoute(rewardRoutes, "POST", "/adjustments", {
        ...asAlice(),
        body: { memberId: adjustMemberId, amount, note: "" },
      });
      assert.equal(result.status, 400, `amount=${amount} should be refused`);
    }
  });

  test("GET /balances exposes the adjusted total alongside earned/spent/balance", async () => {
    const balanceMemberId = "member-rewards-balance-adjusted";
    makeMember(balanceMemberId, "Balance Adjusted Kid");
    await earnPoints(balanceMemberId, "2027-04-04", 4, "Chore for adjusted balance check");
    await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...asAlice(),
      body: { memberId: balanceMemberId, amount: 3, note: "Bonus" },
    });
    await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...asAlice(),
      body: { memberId: balanceMemberId, amount: -1, note: "Oops" },
    });

    const balance = (await callRoute(rewardRoutes, "GET", "/balances", asAlice())).body.balances[balanceMemberId];
    assert.deepEqual(balance, { earned: 4, adjusted: 2, spent: 0, balance: 6 });
  });

  test("404s for an unknown member", async () => {
    const result = await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...asAlice(),
      body: { memberId: "member-nope", amount: 5, note: "" },
    });
    assert.equal(result.status, 404);
  });

  test("400s for a parent member", async () => {
    const result = await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...asAlice(),
      body: { memberId: parentMemberId, amount: 5, note: "" },
    });
    assert.equal(result.status, 400);
  });
});
