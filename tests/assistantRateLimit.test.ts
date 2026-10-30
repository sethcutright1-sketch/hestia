// rateLimit.ts's RequestRateLimiter -- the per-login cap on POST /api/assistant/chat turns:
// one in flight, 20 per 5 minutes, 300 per day -- and tooManyTurns, the 429 the route sends.
//
// server.ts calls listen() on import, so the route itself is not driven here; the limiter and the
// response helper are the parts with logic, and the route only wires them together (see the
// wrapper above assistantChat in server.ts). Everything runs on a fake clock.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { RequestRateLimiter, tooManyTurns } = await import("../rateLimit.ts");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Limiter = InstanceType<typeof RequestRateLimiter>;

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** Takes a turn and finishes it at once, the way a quick answer would. */
function takeAndFinish(limiter: Limiter, key: string) {
  const grant = limiter.acquire(key);
  if (grant.ok) grant.release();
  return grant;
}

function fakeRes() {
  const out: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    setHeader: (k: string, v: string) => ((out.headers[k] = v), res),
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
  };
  return { res, out };
}

describe("one turn in flight", () => {
  test("a second turn is refused until the first releases", () => {
    const limiter = new RequestRateLimiter({ now: clock().now });
    const first = limiter.acquire("u");
    assert.equal(first.ok, true);

    const second = limiter.acquire("u");
    assert.equal(second.ok, false);
    assert.equal((second as any).reason, "in_flight");
    assert.equal((second as any).announce, false, "a double-tap is not worth a log line");

    if (first.ok) first.release();
    assert.equal(limiter.acquire("u").ok, true, "free again once the first finished");
  });

  test("release can be called twice, and a stale release does not free a newer turn", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    const first = limiter.acquire("u");
    assert.ok(first.ok);
    first.release();
    first.release();

    const second = limiter.acquire("u");
    assert.ok(second.ok);
    first.release(); // the old turn's late 'close'
    assert.equal(limiter.acquire("u").ok, false, "the newer turn still holds the slot");
  });

  test("a turn that never releases stops blocking after 15 minutes", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    const wedged = limiter.acquire("u");
    assert.ok(wedged.ok);
    c.advance(14 * MIN);
    assert.equal(limiter.acquire("u").ok, false);
    c.advance(1 * MIN);
    const next = limiter.acquire("u");
    assert.equal(next.ok, true);
    wedged.release();
    assert.equal(limiter.acquire("u").ok, false, "the expired turn's late release does not free the new one");
  });
});

describe("20 turns per 5 minutes", () => {
  test("the 21st is refused, with a wait that ends when the oldest turn leaves the window", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    for (let i = 0; i < 20; i++) {
      assert.equal(takeAndFinish(limiter, "u").ok, true, `turn ${i + 1}`);
      c.advance(1_000);
    }
    // The first turn was 20 s ago; it leaves the window at 300 s.
    const refused = limiter.acquire("u") as any;
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "window");
    assert.equal(refused.retryAfterSeconds, 280);

    c.advance(279_000);
    assert.equal(limiter.acquire("u").ok, false, "one second early");
    c.advance(1_000);
    assert.equal(limiter.acquire("u").ok, true, "the oldest turn has aged out");
  });

  test("it is a sliding window: 20 at the end of one bucket do not buy 20 more at the start of the next", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    c.advance(4 * MIN + 59_000);
    for (let i = 0; i < 20; i++) takeAndFinish(limiter, "u");
    c.advance(2_000);
    assert.equal(limiter.acquire("u").ok, false);
  });

  test("refused requests are not counted, so retrying right on time works", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    for (let i = 0; i < 20; i++) takeAndFinish(limiter, "u");
    for (let i = 0; i < 500; i++) {
      assert.equal(limiter.acquire("u").ok, false);
      c.advance(100);
    }
    // 50 s of hammering later; all 20 real turns were at t=0 and leave at t=300 s.
    c.advance(5 * MIN - 50_000);
    assert.equal(takeAndFinish(limiter, "u").ok, true, "the 500 refusals did not push the window out");
  });

  test("an in-flight refusal is not counted either", () => {
    const limiter = new RequestRateLimiter({ now: clock().now });
    const held = limiter.acquire("u");
    assert.ok(held.ok);
    for (let i = 0; i < 50; i++) assert.equal(limiter.acquire("u").ok, false);
    held.release();
    for (let i = 0; i < 19; i++) assert.equal(takeAndFinish(limiter, "u").ok, true, "19 more fit beside the one real turn");
    assert.equal(limiter.acquire("u").ok, false);
  });

  test("a refusal burst is announced once, and again after a quiet spell", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    for (let i = 0; i < 20; i++) takeAndFinish(limiter, "u");
    assert.equal((limiter.acquire("u") as any).announce, true);
    c.advance(1_000);
    assert.equal((limiter.acquire("u") as any).announce, false);
    c.advance(4 * MIN);
    assert.equal((limiter.acquire("u") as any).announce, false, "still within 5 minutes of the last refusal");
    c.advance(5 * MIN + 1);
    // The window has emptied by now, so fill it again and be refused a second time.
    for (let i = 0; i < 20; i++) takeAndFinish(limiter, "u");
    assert.equal((limiter.acquire("u") as any).announce, true, "a new burst");
  });
});

describe("300 turns per day", () => {
  /** Spreads turns 20 s apart (3 a minute, under the window cap) and returns how many were granted. */
  function spend(limiter: Limiter, c: ReturnType<typeof clock>, key: string, n: number) {
    let granted = 0;
    for (let i = 0; i < n; i++) {
      if (takeAndFinish(limiter, key).ok) granted++;
      c.advance(20_000);
    }
    return granted;
  }

  test("the 301st within a day is refused, and the wait runs to when the oldest turn is a day old", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    assert.equal(spend(limiter, c, "u", 300), 300);
    // 300 turns x 20 s: the first is 6,000 s old.
    const refused = limiter.acquire("u") as any;
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "day");
    assert.equal(refused.retryAfterSeconds, DAY / 1000 - 300 * 20);

    c.advance(DAY - 300 * 20_000 - 1_000);
    assert.equal(limiter.acquire("u").ok, false, "one second early");
    c.advance(1_000);
    assert.equal(limiter.acquire("u").ok, true);
  });

  test("when only the day is full, the reason says so", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    spend(limiter, c, "u", 300);
    c.advance(10 * MIN); // the 5-minute window is empty again
    assert.equal((limiter.acquire("u") as any).reason, "day");
  });
});

describe("separate logins", () => {
  test("each login has its own slot and its own counts", () => {
    const limiter = new RequestRateLimiter({ now: clock().now });
    const a = limiter.acquire("chat:a");
    assert.ok(a.ok);
    assert.equal(limiter.acquire("chat:b").ok, true, "b is not blocked by a's turn in flight");

    for (let i = 0; i < 20; i++) takeAndFinish(limiter, "chat:c");
    assert.equal(limiter.acquire("chat:c").ok, false);
    assert.equal(takeAndFinish(limiter, "chat:d").ok, true, "d is not blocked by c's window");
  });
});

describe("key cap and sweep", () => {
  test("sweep forgets logins idle for a day and keeps one used since", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now });
    takeAndFinish(limiter, "old");
    c.advance(DAY - 1_000);
    takeAndFinish(limiter, "recent");
    limiter.sweep();
    assert.equal(limiter.size, 2);
    c.advance(1_000);
    limiter.sweep();
    assert.equal(limiter.size, 1, "only the login used within the day survives");
    assert.equal(limiter.acquire("recent").ok, true);
  });

  test("past the cap, the least recently used logins go and a held slot stays", () => {
    const c = clock();
    const limiter = new RequestRateLimiter({ now: c.now, maxKeys: 3 });
    const held = limiter.acquire("held");
    assert.ok(held.ok);
    for (const k of ["a", "b", "c", "d"]) {
      c.advance(1_000);
      takeAndFinish(limiter, k);
    }
    assert.equal(limiter.size, 3);
    assert.equal(limiter.acquire("held").ok, false, "its in-flight slot survived the eviction");
  });
});

describe("tooManyTurns", () => {
  test("in flight: 429, the Stop message, Retry-After", () => {
    const { res, out } = fakeRes();
    tooManyTurns(res, { ok: false, reason: "in_flight", retryAfterSeconds: 5, announce: false });
    assert.equal(out.status, 429);
    assert.equal(out.headers["Retry-After"], "5");
    assert.deepEqual(out.body, {
      error: "Still answering your last message — wait for it to finish or press Stop.",
      retryAfterSeconds: 5,
    });
  });

  test("window or day: minutes rounded up, never below 1", () => {
    for (const [seconds, text] of [
      [1, "1 minute"],
      [60, "1 minute"],
      [61, "2 minutes"],
      [280, "5 minutes"],
      [3 * 3600, "180 minutes"],
    ] as const) {
      const { res, out } = fakeRes();
      tooManyTurns(res, { ok: false, reason: "window", retryAfterSeconds: seconds, announce: true });
      assert.equal(out.status, 429);
      assert.equal(out.headers["Retry-After"], String(seconds));
      assert.equal(out.body.error, `You've sent a lot of messages in a short time. Try again in ${text}.`);
      assert.equal(out.body.retryAfterSeconds, seconds);
    }
  });
});
