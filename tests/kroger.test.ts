// kroger.ts and routes/kroger.ts -- the household's Kroger connection. What has to hold:
//   - the sign-in (refresh token) is stored encrypted and never reaches a browser;
//   - only an admin, from a real signed-in browser, can connect, disconnect or pick the store;
//   - the callback only completes the exact sign-in this session started (state, PKCE, 10 min);
//   - each refresh's NEW refresh token is saved before it's used, and two requests never spend
//     the same one;
//   - a refused sign-in becomes "needs reconnect", but Kroger being unreachable doesn't;
//   - the cart call sends exactly what Kroger documents, and can't be sent junk.
// Every Kroger call goes to a fake fetch below; nothing here talks to the real API.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

process.env.KROGER_CLIENT_ID = "test-client-id";
process.env.KROGER_CLIENT_SECRET = "test-client-secret";
process.env.KROGER_REDIRECT_URI = "http://localhost:3210/api/grocery/kroger/callback";

const { createUser, getConfig, setConfig, decryptSecret, putScopedItem, getScopedItem, db } = await loadDb();
const kroger = await import("../kroger.ts");
const { krogerRoutes, resetKrogerBudgetsForTests, setCalorieLookupForTests } = await import("../routes/kroger.ts");

// ---------------------------------------------------------------------------------------------
// A fake Kroger. Each test queues the responses it expects; every request is recorded.

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}
type Reply = { status: number; body?: unknown } | Error;

let calls: Recorded[] = [];
let replies: Reply[] = [];
const realFetch = globalThis.fetch;

function queue(...r: Reply[]) {
  replies.push(...r);
}

function tokenReply(n: number, opts: { refresh?: boolean } = {}): Reply {
  return {
    status: 200,
    body: { access_token: `access-${n}`, expires_in: 1800, token_type: "bearer", ...(opts.refresh === false ? {} : { refresh_token: `refresh-${n}` }) },
  };
}

before(() => {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    calls.push({ method: init.method ?? "GET", url: new URL(String(input)), headers, body: String(init.body ?? "") });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected Kroger call: ${init.method ?? "GET"} ${input}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  cleanupDb();
});

beforeEach(() => {
  calls = [];
  replies = [];
  kroger.resetKrogerTokenCacheForTests();
  resetKrogerBudgetsForTests();
  // Calories would otherwise call Open Food Facts through the fake fetch above and eat its replies.
  setCalorieLookupForTests(async () => {
    throw new Error("no calorie lookup in this test");
  });
  setConfig(kroger.KROGER_CONFIG_KEY, {});
  setConfig(kroger.KROGER_PICKS_KEY, {});
});

function form(call: Recorded): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body));
}

/** Connects the household as if the callback had run, with refresh token `refresh-0`. */
async function connect() {
  queue(tokenReply(0));
  await kroger.exchangeCode("the-code", "the-verifier");
  calls = [];
}

let admin: string;
let parent: string;
let kiosk: string;

before(() => {
  admin = createUser("admin-kroger", "x", "Admin", "admin");
  parent = createUser("parent-kroger", "x", "Parent", "parent");
  kiosk = createUser("kiosk-kroger", "x", "Kiosk", "kiosk");
});

// ---------------------------------------------------------------------------------------------

describe("connecting", () => {
  test("the sign-in page asks only for the cart, with this server's redirect and an S256 PKCE challenge", () => {
    const { verifier, challenge } = kroger.newPkce();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.equal(challenge, expected);

    const url = new URL(kroger.authorizeUrl("the-state", challenge));
    assert.equal(url.origin + url.pathname, "https://api.kroger.com/v1/connect/oauth2/authorize");
    assert.equal(url.searchParams.get("scope"), "cart.basic:write");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "test-client-id");
    assert.equal(url.searchParams.get("redirect_uri"), process.env.KROGER_REDIRECT_URI);
    assert.equal(url.searchParams.get("state"), "the-state");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("client_secret"), null, "the secret never goes in a URL");
  });

  test("exchanging the code sends the verifier as this app, and stores the refresh token encrypted", async () => {
    queue(tokenReply(1));
    await kroger.exchangeCode("the-code", "the-verifier");

    const [call] = calls;
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, "/v1/connect/oauth2/token");
    assert.equal(call.headers.authorization, `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`);
    assert.deepEqual(form(call), {
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: process.env.KROGER_REDIRECT_URI,
      code_verifier: "the-verifier",
    });

    const stored = getConfig(kroger.KROGER_CONFIG_KEY, null);
    assert.match(stored.refreshToken, /^enc:v1:/);
    assert.equal(decryptSecret(stored.refreshToken), "refresh-1");
    assert.ok(stored.connectedAt);
  });

  test("a sign-in that comes back without a refresh token is refused, and nothing is stored", async () => {
    queue(tokenReply(1, { refresh: false }));
    await assert.rejects(kroger.exchangeCode("c", "v"), /didn't allow staying connected/);
    assert.equal(kroger.krogerStatus().connected, false);
  });

  test("status says which address connecting works from (the redirect's origin), and nothing more", () => {
    assert.equal(kroger.krogerStatus().connectOrigin, "http://localhost:3210");
  });

  test("status never carries a token, encrypted or not", async () => {
    await connect();
    const status = kroger.krogerStatus();
    assert.equal(status.connected, true);
    const text = JSON.stringify(status);
    assert.ok(!text.includes("refresh-0"));
    assert.ok(!text.includes("enc:v1:"));
    assert.ok(!text.includes("access-0"));
  });

  test("disconnecting forgets the sign-in but keeps the chosen store", async () => {
    await connect();
    setConfig(kroger.KROGER_CONFIG_KEY, { ...getConfig(kroger.KROGER_CONFIG_KEY, null), store: { locationId: "1", name: "K", address: "A" } });
    kroger.disconnectKroger();
    const status = kroger.krogerStatus();
    assert.equal(status.connected, false);
    assert.deepEqual(status.store, { locationId: "1", name: "K", address: "A" });
    assert.deepEqual(Object.keys(getConfig(kroger.KROGER_CONFIG_KEY, null)), ["store"]);
  });
});

describe("staying signed in", () => {
  test("an expired access token is refreshed, and the NEW refresh token is what's stored", async () => {
    await connect();
    kroger.resetKrogerTokenCacheForTests(); // as after a restart: no access token in memory
    queue(tokenReply(2), { status: 204 });
    await kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]);

    assert.deepEqual(form(calls[0]), { grant_type: "refresh_token", refresh_token: "refresh-0" });
    assert.equal(calls[1].headers.authorization, "Bearer access-2");
    assert.equal(decryptSecret(getConfig(kroger.KROGER_CONFIG_KEY, null).refreshToken), "refresh-2");
  });

  test("two requests at once share one refresh, so the same refresh token is never spent twice", async () => {
    await connect();
    kroger.resetKrogerTokenCacheForTests();
    queue(tokenReply(3), { status: 204 }, { status: 204 });
    await Promise.all([
      kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]),
      kroger.addToCart([{ upc: "0001111040101", quantity: 1 }]),
    ]);
    assert.equal(calls.filter((c) => c.url.pathname === "/v1/connect/oauth2/token").length, 1);
  });

  test("a refused refresh marks the connection as needing a reconnect, and says so plainly", async () => {
    await connect();
    kroger.resetKrogerTokenCacheForTests();
    queue({ status: 400, body: { error: "invalid_request", error_description: "invalid refresh_token" } });
    await assert.rejects(kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]), (err: any) => {
      assert.equal(err.reconnect, true);
      assert.match(err.message, /connect Kroger again/);
      return true;
    });
    assert.equal(kroger.krogerStatus().needsReconnect, true);
    // ...and then stops calling Kroger with a sign-in it knows is dead.
    calls = [];
    await assert.rejects(kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]));
    assert.equal(calls.length, 0);
  });

  test("Kroger being unreachable is not a dead sign-in", async () => {
    await connect();
    kroger.resetKrogerTokenCacheForTests();
    queue(new TypeError("fetch failed"));
    await assert.rejects(kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]), /didn't answer/);
    assert.equal(kroger.krogerStatus().needsReconnect, false);
  });

  test("the keep-alive refreshes a sign-in that's 12 hours old, and leaves a fresh one alone", async () => {
    await connect();
    const connectedAt = Date.parse(getConfig(kroger.KROGER_CONFIG_KEY, null).refreshedAt);
    assert.equal(await kroger.krogerKeepAlive(connectedAt + 60 * 60 * 1000), "skipped");
    assert.equal(calls.length, 0);

    queue(tokenReply(4));
    assert.equal(await kroger.krogerKeepAlive(connectedAt + kroger.KEEP_ALIVE_AFTER_MS + 1), "refreshed");
    assert.equal(decryptSecret(getConfig(kroger.KROGER_CONFIG_KEY, null).refreshToken), "refresh-4");
  });

  test("the keep-alive does nothing when Kroger isn't connected or needs a reconnect", async () => {
    assert.equal(await kroger.krogerKeepAlive(Date.now() + 10 * kroger.KEEP_ALIVE_AFTER_MS), "skipped");
    await connect();
    setConfig(kroger.KROGER_CONFIG_KEY, { ...getConfig(kroger.KROGER_CONFIG_KEY, null), needsReconnect: true });
    assert.equal(await kroger.krogerKeepAlive(Date.now() + 10 * kroger.KEEP_ALIVE_AFTER_MS), "skipped");
    assert.equal(calls.length, 0);
  });
});

describe("the cart", () => {
  test("sends Kroger's documented shape, with no pickup/delivery (Kroger's app decides that for the whole cart)", async () => {
    await connect();
    queue({ status: 204 });
    await kroger.addToCart([{ upc: "0001111041700", quantity: 2 }, { upc: "0001111040101", quantity: 1 }]);
    const [call] = calls;
    assert.equal(call.method, "PUT");
    assert.equal(call.url.pathname, "/v1/cart/add");
    assert.equal(call.headers.authorization, "Bearer access-0");
    assert.deepEqual(JSON.parse(call.body), {
      items: [
        { upc: "0001111041700", quantity: 2 },
        { upc: "0001111040101", quantity: 1 },
      ],
    });
  });

  test("junk never reaches Kroger: bad codes, quantities, or an empty list", async () => {
    await connect();
    for (const items of [
      [{ upc: "12345", quantity: 1 }],
      [{ upc: "0001111041700", quantity: 0 }],
      [{ upc: "0001111041700", quantity: 1.5 }],
      [{ upc: "0001111041700", quantity: 100 }],
      [],
    ]) {
      await assert.rejects(kroger.addToCart(items as any), (err: any) => err.status === 400);
    }
    assert.equal(calls.length, 0);
  });

  test("a refused access token is refreshed once and retried", async () => {
    await connect();
    queue({ status: 401 }, tokenReply(5), { status: 204 });
    await kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]);
    assert.deepEqual(calls.map((c) => c.url.pathname), ["/v1/cart/add", "/v1/connect/oauth2/token", "/v1/cart/add"]);
    assert.equal(calls[2].headers.authorization, "Bearer access-5");
  });

  test("refused again after a fresh token: needs a reconnect, and stops there", async () => {
    await connect();
    queue({ status: 401 }, tokenReply(6), { status: 401 });
    await assert.rejects(kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]), (err: any) => err.reconnect === true);
    assert.equal(calls.length, 3);
    assert.equal(kroger.krogerStatus().needsReconnect, true);
  });

  test("Kroger's own errors are turned into plain messages that hold nothing from the response", async () => {
    await connect();
    queue({ status: 400, body: { reason: "UPC must have a length of 13 characters", secret: "leak" } });
    await assert.rejects(kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]), (err: any) => {
      assert.equal(err.status, 400);
      assert.ok(!err.message.includes("leak"));
      return true;
    });
    queue({ status: 500 });
    await assert.rejects(kroger.addToCart([{ upc: "0001111041700", quantity: 1 }]), /Check your Kroger cart/);
  });
});

describe("stores and products (as the app, no sign-in needed)", () => {
  const LOCATION = {
    locationId: "01400513",
    name: "Kroger - Kroger On the Rhine",
    address: { addressLine1: "100 E Court St", city: "Cincinnati", state: "OH", zipCode: "45202", county: "HAMILTON COUNTY" },
  };

  test("finding stores uses one app token for several calls, and formats the address", async () => {
    queue({ status: 200, body: { access_token: "app-1", expires_in: 1800 } }, { status: 200, body: { data: [LOCATION] } }, { status: 200, body: { data: [] } });
    const stores = await kroger.findStores("45202");
    await kroger.findStores("45203");

    assert.deepEqual(form(calls[0]), { grant_type: "client_credentials", scope: "product.compact" });
    assert.equal(calls[1].url.searchParams.get("filter.zipCode.near"), "45202");
    assert.equal(calls[1].headers.authorization, "Bearer app-1");
    assert.equal(calls[2].headers.authorization, "Bearer app-1");
    assert.equal(calls.length, 3);
    assert.deepEqual(stores, [{ locationId: "01400513", name: "Kroger - Kroger On the Rhine", address: "100 E Court St, Cincinnati, OH 45202" }]);
  });

  test("a ZIP code that isn't 5 digits is refused before calling Kroger", async () => {
    for (const zip of ["", "4520", "452021", "abcde", "45202&x=1"]) {
      await assert.rejects(kroger.findStores(zip), /5-digit ZIP/);
    }
    assert.equal(calls.length, 0);
  });

  test("choosing a store saves Kroger's own name and address for it", async () => {
    queue({ status: 200, body: { access_token: "app-1" } }, { status: 200, body: { data: LOCATION } });
    const store = await kroger.chooseStore("01400513");
    assert.equal(calls[1].url.pathname, "/v1/locations/01400513");
    assert.deepEqual(store, { locationId: "01400513", name: "Kroger - Kroger On the Rhine", address: "100 E Court St, Cincinnati, OH 45202" });
    assert.deepEqual(kroger.krogerStatus().store, store);
  });

  test("an unknown store or a malformed ID is refused, and nothing is saved", async () => {
    queue({ status: 200, body: { access_token: "app-1" } }, { status: 404 });
    await assert.rejects(kroger.chooseStore("99999999"), /doesn't know that store/);
    await assert.rejects(kroger.chooseStore("../cart/add"), /isn't a Kroger store ID/);
    assert.equal(kroger.krogerStatus().store, null);
  });

  test("product search sends at most 8 words (Kroger's limit) and maps the result", async () => {
    queue(
      { status: 200, body: { access_token: "app-1" } },
      {
        status: 200,
        body: {
          data: [
            {
              upc: "0001111041700",
              description: "Kroger® 2% Reduced Fat Milk Gallon",
              brand: "Kroger",
              images: [
                { perspective: "back", sizes: [{ size: "thumbnail", url: "https://img/back" }] },
                { perspective: "front", sizes: [{ size: "large", url: "https://img/front-large" }, { size: "thumbnail", url: "https://img/front-thumb" }] },
              ],
              items: [{ size: "1 gal", price: { regular: 3.29, promo: 0 }, inventory: { stockLevel: "HIGH" }, fulfillment: { curbside: true, delivery: false } }],
            },
            { upc: "not-a-upc", description: "dropped" },
          ],
        },
      }
    );
    const products = await kroger.searchProducts("one two three four five six seven eight nine ten", "01400513");
    assert.equal(calls[1].url.searchParams.get("filter.term"), "one two three four five six seven eight");
    assert.equal(calls[1].url.searchParams.get("filter.locationId"), "01400513");
    assert.deepEqual(products, [
      {
        upc: "0001111041700",
        description: "Kroger® 2% Reduced Fat Milk Gallon",
        brand: "Kroger",
        size: "1 gal",
        price: { regular: 3.29, promo: null },
        stockLevel: "HIGH",
        curbside: true,
        delivery: false,
        imageUrl: "https://img/front-thumb",
        soldBy: "UNIT",
        pieceWeightLb: null,
      },
    ]);
  });

  test("an item Kroger sells by weight says so; anything else counts as by the unit", async () => {
    queue(
      { status: 200, body: { access_token: "app-1" } },
      {
        status: 200,
        body: {
          data: [
            { upc: "0000000004011", description: "Bananas", items: [{ size: "1 lb", soldBy: "WEIGHT", price: { regular: 0.49 } }] },
            { upc: "0001111041700", description: "Milk", items: [{ size: "1 gal", soldBy: "SOMETHING_NEW" }] },
          ],
        },
      }
    );
    const products = await kroger.searchProducts("bananas", "01400392");
    assert.deepEqual(products.map((p) => p.soldBy), ["WEIGHT", "UNIT"]);
  });

  test("a weight item's piece weight: Kroger's average, else its stated weight, in pounds", async () => {
    queue(
      { status: 200, body: { access_token: "app-1" } },
      {
        status: 200,
        body: {
          data: [
            { upc: "0000000004011", itemInformation: { averageWeightPerUnit: "2.1 [lb_av]", netWeight: "0.38 [lb_av]" }, items: [{ soldBy: "WEIGHT" }] },
            { upc: "0000000000021", itemInformation: { netWeight: "1.0 [lb_av]" }, items: [{ soldBy: "WEIGHT" }] },
            { upc: "0000000000022", itemInformation: { averageWeightPerUnit: "12 [oz_av]" }, items: [{ soldBy: "WEIGHT" }] },
            { upc: "0000000000023", itemInformation: { averageWeightPerUnit: "about two" }, items: [{ soldBy: "WEIGHT" }] },
            { upc: "0000000000024", itemInformation: { averageWeightPerUnit: "2.1 [lb_av]" }, items: [{ soldBy: "UNIT" }] },
          ],
        },
      }
    );
    const products = await kroger.searchProducts("produce", "01400392", 10);
    assert.deepEqual(products.map((p) => p.pieceWeightLb), [2.1, 1, 0.75, null, null]);
  });

  test("app keys Kroger refuses are reported as a server problem, not a reconnect", async () => {
    queue({ status: 401, body: { error: "unauthorized" } });
    await assert.rejects(kroger.findStores("45202"), (err: any) => err.status === 502 && err.reconnect === false);
  });

  test("without app keys configured, Kroger is simply 'not set up'", async () => {
    const saved = process.env.KROGER_CLIENT_SECRET;
    delete process.env.KROGER_CLIENT_SECRET;
    try {
      assert.equal(kroger.krogerStatus().configured, false);
      await assert.rejects(kroger.findStores("45202"), (err: any) => err.status === 503);
      assert.equal(calls.length, 0);
    } finally {
      process.env.KROGER_CLIENT_SECRET = saved;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Routes

describe("routes: who can do what", () => {
  test("status: any real member, never the kiosk", async () => {
    assert.equal((await callRoute(krogerRoutes, "GET", "/status", { session: { userId: parent } })).status, 200);
    assert.equal((await callRoute(krogerRoutes, "GET", "/status", { session: { userId: kiosk } })).status, 403);
    assert.equal((await callRoute(krogerRoutes, "GET", "/status", { session: {} })).status, 401);
  });

  test("connect, disconnect, store search and store choice are admin-only", async () => {
    for (const userId of [parent, kiosk]) {
      assert.equal((await callRoute(krogerRoutes, "POST", "/connect", { session: { userId } })).status, 403);
      assert.equal((await callRoute(krogerRoutes, "POST", "/disconnect", { session: { userId } })).status, 403);
      assert.equal((await callRoute(krogerRoutes, "GET", "/stores", { session: { userId }, query: { zip: "45202" } })).status, 403);
      assert.equal((await callRoute(krogerRoutes, "PUT", "/store", { session: { userId }, body: { locationId: "01400513" } })).status, 403);
    }
    assert.equal(calls.length, 0);
  });

  test("a watch's device token can't connect Kroger, even an admin's", async () => {
    const result = await callRoute(krogerRoutes, "POST", "/connect", { session: {}, deviceUserId: admin });
    assert.equal(result.status, 403);
  });

  test("the store routes pass Kroger's plain errors through", async () => {
    const result = await callRoute(krogerRoutes, "GET", "/stores", { session: { userId: admin }, query: { zip: "nope" } });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /5-digit ZIP/);
  });
});

describe("routes: the connect round trip", () => {
  async function startConnect(session: any) {
    const result = await callRoute(krogerRoutes, "POST", "/connect", { session });
    assert.equal(result.status, 200);
    return new URL(result.body.url);
  }

  function callback(session: any, query: Record<string, string>) {
    return callRoute(krogerRoutes, "GET", "/callback", { session, query });
  }

  test("connect hands back Kroger's sign-in page and keeps the verifier, not the challenge, in the session", async () => {
    const session: any = { userId: admin };
    const url = await startConnect(session);
    assert.equal(url.searchParams.get("state"), session.krogerAuth.state);
    const challenge = crypto.createHash("sha256").update(session.krogerAuth.verifier).digest("base64url");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
  });

  test("the matching callback stores the sign-in and lands back in the app", async () => {
    const session: any = { userId: admin };
    const url = await startConnect(session);
    const verifier = session.krogerAuth.verifier;
    queue(tokenReply(7));

    const result = await callback(session, { code: "abc", state: url.searchParams.get("state")! });
    assert.equal(result.status, 303);
    assert.equal(result.headers?.location, "/?kroger=connected");
    assert.equal(form(calls[0]).code_verifier, verifier);
    assert.equal(kroger.krogerStatus().connected, true);
    assert.equal(session.krogerAuth, undefined, "used up");
  });

  test("a second use of the same callback fails: one sign-in, one use", async () => {
    const session: any = { userId: admin };
    const url = await startConnect(session);
    queue(tokenReply(8));
    await callback(session, { code: "abc", state: url.searchParams.get("state")! });
    const replay = await callback(session, { code: "abc", state: url.searchParams.get("state")! });
    assert.equal(replay.headers?.location, "/?kroger=failed&reason=session");
    assert.equal(calls.length, 1);
  });

  for (const [name, mutate, reason] of [
    ["a different state", (_s: any, q: any) => (q.state = "forged"), "state"],
    ["no state at all", (_s: any, q: any) => delete q.state, "state"],
    ["a sign-in older than 10 minutes", (s: any) => (s.krogerAuth.createdAt -= 11 * 60 * 1000), "expired"],
    ["the person saying no at Kroger", (_s: any, q: any) => { q.error = "access_denied"; delete q.code; }, "denied"],
    ["no code", (_s: any, q: any) => delete q.code, "code"],
    ["a session that started no sign-in", (s: any) => delete s.krogerAuth, "session"],
    ["a session that is no longer signed in", (s: any) => delete s.userId, "session"],
  ] as const) {
    test(`refused, with no call to Kroger: ${name}`, async () => {
      const session: any = { userId: admin };
      const url = await startConnect(session);
      const query: Record<string, string> = { code: "abc", state: url.searchParams.get("state")! };
      (mutate as (s: any, q: any) => void)(session, query);

      const result = await callback(session, query);
      assert.equal(result.status, 303);
      assert.equal(result.headers?.location, `/?kroger=failed&reason=${reason}`);
      assert.equal(calls.length, 0);
      assert.equal(kroger.krogerStatus().connected, false);
    });
  }

  test("an admin who has since become a parent can't finish connecting", async () => {
    const userId = createUser("demoted-kroger", "x", "Demoted", "admin");
    const session: any = { userId };
    const url = await startConnect(session);
    db.prepare(`UPDATE users SET role = 'parent' WHERE id = ?`).run(userId);

    const result = await callback(session, { code: "abc", state: url.searchParams.get("state")! });
    assert.equal(result.headers?.location, "/?kroger=failed&reason=admin");
    assert.equal(calls.length, 0);
  });

  test("Kroger refusing the code lands back in the app with a failure, not an error page", async () => {
    const session: any = { userId: admin };
    const url = await startConnect(session);
    queue({ status: 400, body: { error: "invalid_request", error_description: "invalid code" } });
    const result = await callback(session, { code: "abc", state: url.searchParams.get("state")! });
    assert.equal(result.headers?.location, "/?kroger=failed&reason=exchange");
    assert.equal(kroger.krogerStatus().connected, false);
  });

  test("disconnect answers with the new status, which never holds a token", async () => {
    await connect();
    const result = await callRoute(krogerRoutes, "POST", "/disconnect", { session: { userId: admin } });
    assert.equal(result.status, 200);
    assert.equal(result.body.connected, false);
    assert.ok(!JSON.stringify(result.body).includes("refresh"));
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 2: previewing and sending a list

const STORE = { locationId: "01400392", name: "Kroger - Latonia", address: "4303 Winston Ave, Covington, KY 41015" };
const MILK = "0001111041700";
const EGGS = "0001111060903";

function krogerProduct(upc: string, description: string, over: Record<string, unknown> = {}) {
  return { upc, description, brand: "Kroger", items: [{ size: "1 ct", price: { regular: 2.5 }, soldBy: "UNIT", ...over }] };
}

const appTokenReply: Reply = { status: 200, body: { access_token: "app-1", expires_in: 1800 } };

async function connectWithStore() {
  await connect();
  setConfig(kroger.KROGER_CONFIG_KEY, { ...getConfig(kroger.KROGER_CONFIG_KEY, null), store: STORE });
}

let listSeq = 0;
function putList(owner: string, items: any[], scope: "joint" | "personal" = "joint"): string {
  const id = `list-kroger-${++listSeq}`;
  const now = new Date().toISOString();
  putScopedItem("shopping_lists", owner, {
    id,
    name: "Groceries",
    scope,
    status: "active",
    items: items.map((i) => ({ id: `item-${i.name}`, quantity: "", category: "Other", notes: "", checked: false, addedBy: owner, ...i })),
    createdBy: owner,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function readList(owner: string, id: string) {
  return getScopedItem("shopping_lists", owner, id);
}

function resetGroceries() {
  db.exec(`DELETE FROM shopping_lists`);
  db.exec(`DELETE FROM pantry_items`);
}

describe("routes: previewing a list", () => {
  beforeEach(resetGroceries);

  test("the kiosk can't, another member's personal list is 'not found', and no store means pick one first", async () => {
    await connectWithStore();
    const mine = putList(parent, [{ name: "milk" }], "personal");
    assert.equal((await callRoute(krogerRoutes, "GET", `/lists/${mine}/preview`, { session: { userId: kiosk } })).status, 403);
    assert.equal((await callRoute(krogerRoutes, "GET", `/lists/${mine}/preview`, { session: { userId: admin } })).status, 404);

    setConfig(kroger.KROGER_CONFIG_KEY, {});
    const joint = putList(admin, [{ name: "milk" }]);
    const result = await callRoute(krogerRoutes, "GET", `/lists/${joint}/preview`, { session: { userId: admin } });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /Pick a Kroger store/);
    assert.equal(calls.length, 0);
  });

  test("looks up remembered products in one call, searches only what has none, and skips the rest", async () => {
    await connectWithStore();
    kroger.rememberPicks([{ key: "milk", upc: MILK, label: "Kroger 2% milk, 1 gal" }]);
    putScopedItem("pantry_items", admin, { id: "pantry-rice", name: "rice", quantity: "1 bag", scope: "joint", updatedAt: "", updatedBy: admin });
    const id = putList(admin, [
      { name: "milk", quantity: "2" },
      { name: "eggs" },
      { name: "white rice" },
      { name: "bread", sentToKroger: "2026-10-16T12:00:00.000Z" },
      { name: "cheese", checked: true },
    ]);
    queue(
      appTokenReply,
      { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } },
      { status: 200, body: { data: [krogerProduct(EGGS, "Kroger Large Eggs")] } }
    );

    const result = await callRoute(krogerRoutes, "GET", `/lists/${id}/preview`, { session: { userId: parent } });
    assert.equal(result.status, 200);
    assert.equal(calls[1].url.searchParams.get("filter.productId"), MILK);
    assert.equal(calls[1].url.searchParams.get("filter.locationId"), STORE.locationId);
    assert.equal(calls[2].url.searchParams.get("filter.term"), "eggs");
    assert.equal(calls.length, 3, "bread, rice and cheese cost no Kroger calls");

    assert.deepEqual(
      result.body.items.map((i: any) => [i.name, i.state, i.quantity, i.product?.upc ?? null, i.options.length]),
      [
        ["milk", "ready", 2, MILK, 0],
        ["eggs", "choose", 1, null, 1],
        ["white rice", "inPantry", 1, null, 0],
        ["bread", "sent", 1, null, 0],
      ]
    );
    assert.deepEqual(result.body.estimate, { total: 5, pricedItems: 1, unpricedItems: 0 });
    assert.deepEqual(result.body.store, STORE);
    assert.ok(!JSON.stringify(result.body).includes("refresh-0"));
  });

  test("every product and option carries calories per serving when the lookup has them, null when not", async () => {
    await connectWithStore();
    kroger.rememberPicks([{ key: "milk", upc: MILK, label: "Kroger 2% milk, 1 gal" }]);
    const id = putList(admin, [{ name: "milk" }, { name: "eggs" }]);
    queue(
      appTokenReply,
      { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } },
      { status: 200, body: { data: [krogerProduct(EGGS, "Kroger Large Eggs")] } }
    );
    setCalorieLookupForTests(async (upc) => {
      if (upc !== MILK) throw new Error("unknown to every source");
      return { randomWeight: false, nameOnly: false, source: "off", servingText: "1 cup (240 ml)", servingGrams: 240, perServing: { kcal: 122 }, per100g: null } as any;
    });
    const result = await callRoute(krogerRoutes, "GET", `/lists/${id}/preview`, { session: { userId: admin } });
    assert.equal(result.status, 200);
    const [milk, eggs] = result.body.items;
    assert.deepEqual(milk.product.calories, { kcal: 122, serving: "1 cup (240 ml)" });
    assert.equal(eggs.options[0].calories, null, "a failed lookup is just no calories, not a failed preview");
  });

  test("search results get calories too", async () => {
    await connectWithStore();
    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(EGGS, "Kroger Large Eggs")] } });
    setCalorieLookupForTests(async () => ({ randomWeight: false, nameOnly: false, source: "fdc", servingText: "1 egg", servingGrams: 50, perServing: null, per100g: { kcal: 143 } } as any));
    const result = await callRoute(krogerRoutes, "GET", "/search", { session: { userId: admin }, query: { q: "eggs" } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.products[0].calories, { kcal: 72, serving: "1 egg" });
  });

  test("one failed search doesn't sink the preview: that item just has no options yet", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "eggs" }, { name: "bread" }]);
    queue(appTokenReply, { status: 500 }, { status: 200, body: { data: [krogerProduct(EGGS, "Kroger Large Eggs")] } });
    const result = await callRoute(krogerRoutes, "GET", `/lists/${id}/preview`, { session: { userId: admin } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items.map((i: any) => [i.name, i.state, i.options.length]), [
      ["eggs", "choose", 0],
      ["bread", "choose", 1],
    ]);    assert.equal(calls.filter((c) => c.url.pathname === "/v1/connect/oauth2/token").length, 1, "one app token for all the searches");
  });

  test("a list Kroger needn't be asked about costs no calls; past 60 an hour, it waits", async () => {
    await connectWithStore();
    putScopedItem("pantry_items", admin, { id: "pantry-milk", name: "milk", stockCount: 1, quantity: "1", scope: "joint", updatedAt: "", updatedBy: admin });
    const id = putList(admin, [{ name: "milk" }]);
    for (let i = 0; i < 60; i++) {
      assert.equal((await callRoute(krogerRoutes, "GET", `/lists/${id}/preview`, { session: { userId: admin } })).status, 200);
    }
    assert.equal(calls.length, 0);
    assert.equal((await callRoute(krogerRoutes, "GET", `/lists/${id}/preview`, { session: { userId: admin } })).status, 429);
    assert.equal((await callRoute(krogerRoutes, "GET", `/lists/${id}/preview`, { session: { userId: parent } })).status, 200, "per login");
  });
});

describe("routes: sending a list", () => {
  beforeEach(resetGroceries);

  function send(userId: string, listId: string, body: any) {
    return callRoute(krogerRoutes, "POST", `/lists/${listId}/send`, { session: { userId }, body });
  }

  test("adds the picks to the cart, stamps the items, and remembers Kroger's label for each pick", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "Milk" }, { name: "eggs" }, { name: "bread" }]);
    queue(
      appTokenReply,
      { status: 200, body: { data: [krogerProduct(EGGS, "Kroger Large Eggs", { size: "18 ct" }), krogerProduct(MILK, "Kroger 2% Milk", { size: "1 gal" })] } },
      { status: 204 }
    );

    const result = await send(parent, id, {
      items: [
        { itemId: "item-Milk", upc: MILK, quantity: 2, label: "client-made label is ignored" },
        { itemId: "item-eggs", upc: EGGS, quantity: 1 },
      ],
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.added, 2);

    const cart = calls.find((c) => c.url.pathname === "/v1/cart/add")!;
    assert.deepEqual(JSON.parse(cart.body), {
      items: [
        { upc: MILK, quantity: 2 },
        { upc: EGGS, quantity: 1 },
      ],
    });

    const stored = readList(admin, id);
    assert.ok(stored.items.find((i: any) => i.name === "Milk").sentToKroger);
    assert.ok(stored.items.find((i: any) => i.name === "eggs").sentToKroger);
    assert.equal(stored.items.find((i: any) => i.name === "bread").sentToKroger, undefined);

    const picks = getConfig(kroger.KROGER_PICKS_KEY, null);
    assert.deepEqual(
      Object.fromEntries(Object.entries(picks).map(([k, v]: [string, any]) => [k, [v.upc, v.label]])),
      { milk: [MILK, "Kroger 2% Milk, 1 gal"], egg: [EGGS, "Kroger Large Eggs, 18 ct"] }
    );
  });

  test("remember: false leaves the household's picks alone", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk" }]);
    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } }, { status: 204 });
    assert.equal((await send(admin, id, { remember: false, items: [{ itemId: "item-milk", upc: MILK, quantity: 1 }] })).status, 200);
    assert.deepEqual(getConfig(kroger.KROGER_PICKS_KEY, null), {});
  });

  test("two list items that picked the same product become one cart line", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk" }, { name: "2% milk" }]);
    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } }, { status: 204 });
    const result = await send(admin, id, {
      items: [
        { itemId: "item-milk", upc: MILK, quantity: 1 },
        { itemId: "item-2% milk", upc: MILK, quantity: 2 },
      ],
    });
    assert.equal(result.body.added, 1);
    assert.deepEqual(JSON.parse(calls.at(-1)!.body).items, [{ upc: MILK, quantity: 3 }]);
  });

  test("an item already in the cart is refused unless 'send again' is ticked for it", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk", sentToKroger: "2026-10-16T12:00:00.000Z" }]);
    const refused = await send(admin, id, { items: [{ itemId: "item-milk", upc: MILK, quantity: 1 }] });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.alreadySent, ["milk"]);
    assert.equal(calls.length, 0);

    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } }, { status: 204 });
    const again = await send(admin, id, { items: [{ itemId: "item-milk", upc: MILK, quantity: 1, again: true }] });
    assert.equal(again.status, 200);
    assert.notEqual(readList(admin, id).items[0].sentToKroger, "2026-10-16T12:00:00.000Z", "re-stamped");
  });

  test("bad requests never reach Kroger", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk" }, { name: "eggs", checked: true }]);
    const ok = { itemId: "item-milk", upc: MILK, quantity: 1 };
    for (const body of [
      { items: [] },
      {},
      { items: [{ ...ok, upc: "123" }] },
      { items: [{ ...ok, quantity: 0 }] },
      { items: [{ ...ok, quantity: 2.5 }] },
      { items: [ok, ok] },
      { items: [{ ...ok, itemId: "item-eggs" }] },
      { items: [{ ...ok, itemId: "item-nope" }] },
      { items: Array.from({ length: 101 }, (_, i) => ({ ...ok, itemId: `x${i}` })) },
    ]) {
      const result = await send(admin, id, body);
      assert.equal(result.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(calls.length, 0);
  });

  test("without a live Kroger sign-in, nothing is attempted", async () => {
    setConfig(kroger.KROGER_CONFIG_KEY, { store: STORE });
    const id = putList(admin, [{ name: "milk" }]);
    const body = { items: [{ itemId: "item-milk", upc: MILK, quantity: 1 }] };
    const result = await send(admin, id, body);
    assert.equal(result.status, 409);
    assert.equal(result.body.reconnect, true);

    await connectWithStore();
    setConfig(kroger.KROGER_CONFIG_KEY, { ...getConfig(kroger.KROGER_CONFIG_KEY, null), needsReconnect: true });
    assert.equal((await send(admin, id, body)).status, 409);
    assert.equal(calls.length, 0);
  });

  test("a product the store doesn't carry is caught before the cart, naming the item", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk" }, { name: "eggs" }]);
    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } });
    const result = await send(admin, id, {
      items: [
        { itemId: "item-milk", upc: MILK, quantity: 1 },
        { itemId: "item-eggs", upc: EGGS, quantity: 1 },
      ],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /eggs/);
    assert.ok(!calls.some((c) => c.url.pathname === "/v1/cart/add"));
    assert.equal(readList(admin, id).items[0].sentToKroger, undefined);
  });

  test("if Kroger fails the add, nothing is stamped or remembered", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk" }]);
    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } }, { status: 500 });
    const result = await send(admin, id, { items: [{ itemId: "item-milk", upc: MILK, quantity: 1 }] });
    assert.equal(result.status, 502);
    assert.match(result.body.error, /Check your Kroger cart/);
    assert.equal(readList(admin, id).items[0].sentToKroger, undefined);
    assert.deepEqual(getConfig(kroger.KROGER_PICKS_KEY, null), {});
  });

  test("who can send: members yes; the kiosk, a watch token, or another member's personal list no", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk" }]);
    const body = { items: [{ itemId: "item-milk", upc: MILK, quantity: 1 }] };
    assert.equal((await send(kiosk, id, body)).status, 403);
    assert.equal((await callRoute(krogerRoutes, "POST", `/lists/${id}/send`, { session: {}, deviceUserId: admin, body })).status, 403);
    const personal = putList(admin, [{ name: "milk" }], "personal");
    assert.equal((await send(parent, personal, body)).status, 404);
    assert.equal(calls.length, 0);

    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } }, { status: 204 });
    assert.equal((await send(parent, id, body)).status, 200);
  });
});

describe("routes: remembered picks and search", () => {
  test("only an admin can clear the household's picks", async () => {
    kroger.rememberPicks([{ key: "milk", upc: MILK, label: "milk" }]);
    assert.equal((await callRoute(krogerRoutes, "DELETE", "/picks", { session: { userId: parent } })).status, 403);
    assert.equal(Object.keys(getConfig(kroger.KROGER_PICKS_KEY, null)).length, 1);
    assert.equal((await callRoute(krogerRoutes, "DELETE", "/picks", { session: { userId: admin } })).status, 200);
    assert.deepEqual(getConfig(kroger.KROGER_PICKS_KEY, null), {});
  });

  test("search needs words and a store, and asks Kroger for ten at the household's store", async () => {
    assert.equal((await callRoute(krogerRoutes, "GET", "/search", { session: { userId: parent }, query: { q: "  " } })).status, 400);
    await connectWithStore();
    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } });
    const result = await callRoute(krogerRoutes, "GET", "/search", { session: { userId: parent }, query: { q: "2% milk" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.products[0].upc, MILK);
    assert.equal(calls[1].url.searchParams.get("filter.limit"), "10");
    assert.equal(calls[1].url.searchParams.get("filter.locationId"), STORE.locationId);
    assert.equal((await callRoute(krogerRoutes, "GET", "/search", { session: { userId: kiosk }, query: { q: "milk" } })).status, 403);
  });
});

describe("routes: a saved send screen", () => {
  beforeEach(resetGroceries);

  const draft = (upc: string, quantity = 2, include = true) => ({ include, quantity, product: { upc, description: "Kroger 2% Milk" } });
  const save = (userId: string, listId: string, rows: any) =>
    callRoute(krogerRoutes, "PUT", `/lists/${listId}/draft`, { session: { userId }, body: { rows } });
  const read = (userId: string, listId: string) =>
    callRoute(krogerRoutes, "GET", `/lists/${listId}/draft`, { session: { userId } });

  test("saves what was chosen, per list, and gives it back to the household", async () => {
    const id = putList(admin, [{ name: "milk" }, { name: "eggs" }]);
    assert.equal((await read(admin, id)).body.draft, null);
    assert.equal((await save(admin, id, { "item-milk": draft(MILK), "item-gone": draft(EGGS) })).status, 200);
    const back = (await read(parent, id)).body.draft;
    assert.deepEqual(Object.keys(back.rows), ["item-milk"], "an item that isn't on the list is dropped");
    assert.equal(back.rows["item-milk"].quantity, 2);
    assert.equal(back.rows["item-milk"].include, true);
  });

  test("a row without a product can't be ticked, and a silly quantity becomes 1", async () => {
    const id = putList(admin, [{ name: "milk" }]);
    await save(admin, id, { "item-milk": { include: true, quantity: 500, product: null } });
    const row = (await read(admin, id)).body.draft.rows["item-milk"];
    assert.equal(row.include, false);
    assert.equal(row.quantity, 1);
  });

  test("the kiosk and a watch token can't use it, and a personal list's draft stays personal", async () => {
    const id = putList(admin, [{ name: "milk" }]);
    assert.equal((await save(kiosk, id, {})).status, 403);
    assert.equal((await callRoute(krogerRoutes, "PUT", `/lists/${id}/draft`, { session: {}, deviceUserId: admin, body: { rows: {} } })).status, 403);
    const personal = putList(admin, [{ name: "milk" }], "personal");
    await save(admin, personal, { "item-milk": draft(MILK) });
    assert.equal((await read(parent, personal)).status, 404);
    assert.equal((await save(admin, id, "nope")).status, 400);
  });

  test("a send drops what was sent from the saved screen and keeps the rest", async () => {
    await connectWithStore();
    const id = putList(admin, [{ name: "milk" }, { name: "eggs" }]);
    await save(admin, id, { "item-milk": draft(MILK), "item-eggs": draft(EGGS) });
    queue(appTokenReply, { status: 200, body: { data: [krogerProduct(MILK, "Kroger 2% Milk")] } }, { status: 204 });
    const sent = await callRoute(krogerRoutes, "POST", `/lists/${id}/send`, { session: { userId: admin }, body: { items: [{ itemId: "item-milk", upc: MILK, quantity: 1 }] } });
    assert.equal(sent.status, 200);
    assert.deepEqual(Object.keys((await read(admin, id)).body.draft.rows), ["item-eggs"]);
  });

  test("clearing it removes it", async () => {
    const id = putList(admin, [{ name: "milk" }]);
    await save(admin, id, { "item-milk": draft(MILK) });
    assert.equal((await callRoute(krogerRoutes, "DELETE", `/lists/${id}/draft`, { session: { userId: admin } })).status, 200);
    assert.equal((await read(admin, id)).body.draft, null);
  });
});
