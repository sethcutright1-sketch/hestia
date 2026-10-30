// A few response headers every page and API answer gets (the project notes 10.8, and the
// header part of 10.9). Mounted first in server.ts, so a route can still override any of them
// with its own res.setHeader (progress photos do, for Cache-Control).
import type express from "express";

export function securityHeaders(req: express.Request, res: express.Response, next: express.NextFunction) {
  // The browser must take Content-Type at its word instead of guessing.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Nobody needs to frame the app. A framed copy on another site is how clickjacking works,
  // even though sameSite=lax cookies already blunt most of it.
  res.setHeader("X-Frame-Options", "DENY");
  // API answers carry transactions, diaries and settings: no browser or proxy cache may keep a
  // copy (GET /api/budget/store is every transaction the household has). Pages and scripts
  // are left cacheable.
  if (req.path === "/api" || req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
}
