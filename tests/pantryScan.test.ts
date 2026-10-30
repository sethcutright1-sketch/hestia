// Barcode scan-in/scan-out on top of routes/pantry.ts: /barcode/lookup,
// /scan/in, /scan/out, and PUT /:id's new barcode field. Complements the core
// CRUD coverage in sectionRoutes.test.ts's "pantry" describe block, which this
// file doesn't repeat.
//
// Open Food Facts is stubbed via globalThis.fetch (see stubOff below) --
// never hit the real API from a test. barcodeLookup.test.ts covers that
// module's own parsing/caching in isolation; this file only needs it to
// exercise the routes' branching (known locally / OFF hit / OFF miss).

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser } = await loadDb();
const { pantryRoutes } = await import("../routes/pantry.ts");

let alice: string;
let bob: string;

const asAlice = () => ({ session: { userId: alice } });
const asBob = () => ({ session: { userId: bob } });

before(() => {
  alice = createUser("alice-pantryscan", "not-a-real-hash", "Alice");
  bob = createUser("bob-pantryscan", "not-a-real-hash", "Bob");
});

after(cleanupDb);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function offResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubOff(hit: { product_name: string; brands?: string } | null): void {
  globalThis.fetch = (async () => (hit ? offResponse({ status: 1, product: hit }) : offResponse({ status: 0 }))) as any;
}

describe("pantry barcode scan", () => {
  test("scan/in creates a new item with stockCount 1 when a name is supplied", async () => {
    const result = await callRoute(pantryRoutes, "POST", "/scan/in", {
      ...asAlice(),
      body: { barcode: "1111111111111", name: "Cheerios" },
    });

    assert.equal(result.body.resolved, "created");
    assert.equal(result.body.item.name, "Cheerios");
    assert.equal(result.body.item.barcode, "1111111111111");
    assert.equal(result.body.item.stockCount, 1);
    assert.equal(result.body.item.quantity, "1", "quantity mirrors stockCount for display");
  });

  test("scan/in on an already-linked barcode increments instead of duplicating", async () => {
    const first = await callRoute(pantryRoutes, "POST", "/scan/in", {
      ...asAlice(),
      body: { barcode: "2222222222222", name: "Oat Milk" },
    });
    const id = first.body.item.id;

    const second = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "2222222222222" } });
    const third = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "2222222222222" } });

    assert.equal(second.body.resolved, "existing");
    assert.equal(second.body.item.id, id, "same barcode must not create a second row");
    assert.equal(second.body.item.stockCount, 2);
    assert.equal(third.body.item.stockCount, 3);
    assert.equal(third.body.item.quantity, "3");
  });

  test("scan/in on an unknown barcode with no name asks for one, offering an Open Food Facts hit as a suggestion", async () => {
    stubOff({ product_name: "Cheerios", brands: "General Mills" });

    const result = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "3333333333338" } });

    assert.equal(result.body.needsName, true);
    assert.equal(result.body.suggestion, "Cheerios");
    assert.equal(result.body.item, undefined, "must not create anything until a name is confirmed");
  });

  test("scan/in on an unknown barcode with no name and no Open Food Facts match still asks, with no suggestion", async () => {
    stubOff(null);

    const result = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "4444444444444" } });

    assert.equal(result.body.needsName, true);
    assert.equal(result.body.suggestion, null);
  });

  test("scan/in requires a barcode", async () => {
    assert.equal((await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: {} })).status, 400);
  });

  test("scan/in accepts an optional expiration date and stamps lastScannedInAt", async () => {
    const created = await callRoute(pantryRoutes, "POST", "/scan/in", {
      ...asAlice(),
      body: { barcode: "1414141414141", name: "Milk", expirationDate: "2026-10-05" },
    });
    assert.equal(created.body.item.expirationDate, "2026-10-05");
    assert.ok(created.body.item.lastScannedInAt, "a scan-in must stamp lastScannedInAt");

    const second = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "1414141414141" } });
    assert.equal(second.body.item.expirationDate, "2026-10-05", "omitting expirationDate on a later scan must not clear it");

    const third = await callRoute(pantryRoutes, "POST", "/scan/in", {
      ...asAlice(),
      body: { barcode: "1414141414141", expirationDate: "2026-11-01" },
    });
    assert.equal(third.body.item.expirationDate, "2026-11-01", "a later scan can still update the date");
  });

  test("an invalid expiration date on scan/in is dropped rather than stored as garbage", async () => {
    const result = await callRoute(pantryRoutes, "POST", "/scan/in", {
      ...asAlice(),
      body: { barcode: "1616161616161", name: "Eggs", expirationDate: "next Tuesday" },
    });
    assert.equal(result.body.item.expirationDate, undefined);
  });

  test("lastScannedInAt is set only by scan/in, never by scan/out or a manual PUT", async () => {
    const handAdded = await callRoute(pantryRoutes, "POST", "/", { ...asAlice(), body: { name: "Never Scanned" } });
    assert.equal(handAdded.body.item.lastScannedInAt, undefined);

    const scannedIn = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "1717171717171", name: "Was Scanned" } });
    const stamp = scannedIn.body.item.lastScannedInAt;
    assert.ok(stamp);

    const scannedOut = await callRoute(pantryRoutes, "POST", "/scan/out", { ...asAlice(), body: { barcode: "1717171717171" } });
    assert.equal(scannedOut.body.item.lastScannedInAt, stamp, "scan-out must not touch the scanned-in stamp");

    const edited = await callRoute(pantryRoutes, "PUT", `/${scannedOut.body.item.id}`, { ...asAlice(), body: { quantity: "0" } });
    assert.equal(edited.body.item.lastScannedInAt, stamp, "a manual edit must not touch it either");
  });

  test("hand-editing quantity via PUT does not corrupt a barcode-tracked item's stockCount", async () => {
    const created = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "1313131313131", name: "Honey" } });
    const id = created.body.item.id;

    const edited = await callRoute(pantryRoutes, "PUT", `/${id}`, { ...asAlice(), body: { quantity: "a lot" } });
    assert.equal(edited.body.item.quantity, "a lot");
    assert.equal(edited.body.item.stockCount, 1, "stockCount must survive a manual quantity edit");

    // A later scan still increments from the real stockCount, not from
    // whatever the hand-typed string would parse to -- and overwrites the
    // display string back to the numeric mirror.
    const scanned = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "1313131313131" } });
    assert.equal(scanned.body.item.stockCount, 2);
    assert.equal(scanned.body.item.quantity, "2");
  });

  test("scan/out decrements an existing item and mirrors quantity", async () => {
    await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "5555555555555", name: "Yogurt" } });
    await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "5555555555555" } }); // now 2

    const result = await callRoute(pantryRoutes, "POST", "/scan/out", { ...asAlice(), body: { barcode: "5555555555555" } });

    assert.equal(result.body.found, true);
    assert.equal(result.body.changed, true);
    assert.equal(result.body.item.stockCount, 1);
    assert.equal(result.body.item.quantity, "1");
    assert.equal(result.body.hitZero, false);
  });

  test("scan/out clamps at 0 and never deletes the row", async () => {
    await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "6666666666666", name: "Butter" } }); // 1

    const toZero = await callRoute(pantryRoutes, "POST", "/scan/out", { ...asAlice(), body: { barcode: "6666666666666" } });
    assert.equal(toZero.body.item.stockCount, 0);
    assert.equal(toZero.body.hitZero, true);
    assert.equal(toZero.body.changed, true);

    const alreadyZero = await callRoute(pantryRoutes, "POST", "/scan/out", { ...asAlice(), body: { barcode: "6666666666666" } });
    assert.equal(alreadyZero.body.item.stockCount, 0, "must never go negative");
    assert.equal(alreadyZero.body.changed, false, "a clamp at an existing 0 is not a real change");

    const list = (await callRoute(pantryRoutes, "GET", "/", asAlice())).body.items;
    assert.ok(list.some((i: any) => i.name === "Butter" && i.stockCount === 0), "the row survives at 0, it is not deleted");
  });

  test("scan/out on a barcode never scanned in returns found:false with a close-name suggestion, not a 404", async () => {
    await callRoute(pantryRoutes, "POST", "/", { ...asAlice(), body: { name: "Peanut Butter" } }); // manually tracked, no barcode
    stubOff({ product_name: "Peanut Butter" });

    const result = await callRoute(pantryRoutes, "POST", "/scan/out", { ...asAlice(), body: { barcode: "7777777777772" } });

    assert.equal(result.status, 200, "this is a business outcome, not a missing resource");
    assert.equal(result.body.found, false);
    assert.equal(result.body.suggestion, "Peanut Butter");
    assert.ok(result.body.closeMatches.includes("Peanut Butter"));
  });

  test("scan/out requires a barcode", async () => {
    assert.equal((await callRoute(pantryRoutes, "POST", "/scan/out", { ...asAlice(), body: {} })).status, 400);
  });

  test("barcode/lookup finds a locally-linked item before ever asking Open Food Facts", async () => {
    const created = await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "8888888888888", name: "Rice" } });

    globalThis.fetch = (async () => {
      throw new Error("must not call Open Food Facts for an already-tracked barcode");
    }) as any;

    const result = await callRoute(pantryRoutes, "POST", "/barcode/lookup", { ...asAlice(), body: { barcode: "8888888888888" } });
    assert.equal(result.body.found, true);
    assert.equal(result.body.item.id, created.body.item.id);
  });

  test("barcode/lookup falls through to Open Food Facts for an unknown barcode", async () => {
    stubOff({ product_name: "Ketchup" });
    const result = await callRoute(pantryRoutes, "POST", "/barcode/lookup", { ...asAlice(), body: { barcode: "9999999999994" } });
    assert.equal(result.body.found, false);
    assert.equal(result.body.suggestion, "Ketchup");
  });

  test("barcode/lookup requires a barcode", async () => {
    assert.equal((await callRoute(pantryRoutes, "POST", "/barcode/lookup", { ...asAlice(), body: {} })).status, 400);
  });

  test("PUT /:id can attach a barcode to a manually-created item, and omitting it afterward leaves it alone", async () => {
    const created = await callRoute(pantryRoutes, "POST", "/", { ...asAlice(), body: { name: "Flour" } });
    const id = created.body.item.id;

    const attached = await callRoute(pantryRoutes, "PUT", `/${id}`, { ...asAlice(), body: { barcode: "1010101010101" } });
    assert.equal(attached.body.item.barcode, "1010101010101");

    const untouched = await callRoute(pantryRoutes, "PUT", `/${id}`, { ...asAlice(), body: { quantity: "2 bags" } });
    assert.equal(untouched.body.item.barcode, "1010101010101", "omitting barcode must not clear it");
  });

  test("pantry items are joint -- a barcode-linked item is scannable by any household member", async () => {
    await callRoute(pantryRoutes, "POST", "/scan/in", { ...asAlice(), body: { barcode: "1212121212121", name: "Shared Item" } });

    const bobScansOut = await callRoute(pantryRoutes, "POST", "/scan/out", { ...asBob(), body: { barcode: "1212121212121" } });
    assert.equal(bobScansOut.body.found, true);
    assert.equal(bobScansOut.body.item.stockCount, 0);
  });
});
