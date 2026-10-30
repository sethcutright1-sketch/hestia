// securityHeaders.ts and the server.ts wiring around it (the project notes 10.8, part of 10.9).
// Real HTTP on an ephemeral port, because what matters is what actually reaches the browser:
// a header set by one middleware and overridden by a route is invisible in a fake res.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";

import { securityHeaders } from "../securityHeaders.ts";

let server: ReturnType<express.Express["listen"]>;
let base = "";

before(async () => {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.get("/api/budget/store", (_req, res) => res.json({ transactions: [] }));
  // Progress photos set their own Cache-Control (routes/nutrition/photos.ts) and must keep it.
  app.get("/api/nutrition/photos/:id/image", (_req, res) => {
    res.setHeader("Cache-Control", "private, no-cache");
    res.type("image/jpeg").send(Buffer.from([0xff, 0xd8, 0xff]));
  });
  app.get("/api", (_req, res) => res.json({}));
  app.get("/apiary", (_req, res) => res.send("not the API"));
  app.get("/", (_req, res) => res.type("html").send("<!doctype html>"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test("API answers are marked no-store", async () => {
  const r = await fetch(`${base}/api/budget/store`);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/api`)).headers.get("cache-control"), "no-store");
});

test("a route's own Cache-Control still wins (progress photos)", async () => {
  const r = await fetch(`${base}/api/nutrition/photos/p1/image`);
  assert.equal(r.headers.get("cache-control"), "private, no-cache");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("pages are left cacheable, and only /api/ counts as the API", async () => {
  assert.equal((await fetch(`${base}/`)).headers.get("cache-control"), null);
  assert.equal((await fetch(`${base}/apiary`)).headers.get("cache-control"), null);
});

test("every response gets nosniff and DENY framing, and no X-Powered-By", async () => {
  for (const url of ["/", "/api/budget/store"]) {
    const r = await fetch(base + url);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", url);
    assert.equal(r.headers.get("x-frame-options"), "DENY", url);
    assert.equal(r.headers.get("x-powered-by"), null, url);
  }
});

// server.ts calls start() when imported, so its wiring is checked from the source.
test("server.ts mounts the headers first, turns off X-Powered-By, and has no /ua route", () => {
  const source = fs.readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const disable = source.indexOf(`app.disable("x-powered-by")`);
  const headers = source.indexOf("app.use(securityHeaders)");
  const firstOtherUse = source.indexOf("app.use((req, res, next) =>");
  assert.ok(disable > 0, "x-powered-by is disabled");
  assert.ok(headers > 0 && headers < firstOtherUse, "securityHeaders runs before every other middleware");
  assert.ok(!/app\.get\(\s*["']\/ua["']/.test(source), "the unauthenticated /ua diagnostic is gone");
});
