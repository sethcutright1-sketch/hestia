// Long-lived device tokens for non-browser clients (the Wear OS app, and any
// future one) that can't reasonably hold a username+password or a rolling
// session cookie -- see auth.ts's deviceTokenAuth for how a token is actually
// authenticated on each request. This file is only the issue/list/revoke
// surface, reachable exclusively from a real interactive login.
import express from "express";
import crypto from "node:crypto";
import { createDeviceToken, listDeviceTokens, deleteDeviceToken, hashDeviceToken } from "../db.ts";

export const deviceRoutes = express.Router();

// Every handler checks req.session.userId directly rather than using
// currentUserId(req), which would also accept a device token -- a device
// token must never be usable to mint or revoke device tokens, only an actual
// interactive login can manage them.
function requireRealSession(req: express.Request, res: express.Response): string | null {
  if (!req.session.userId) {
    res.status(403).json({ error: "Sign in with your account to manage devices." });
    return null;
  }
  return req.session.userId;
}

deviceRoutes.get("/", (req, res) => {
  const userId = requireRealSession(req, res);
  if (!userId) return;
  const tokens = listDeviceTokens(userId).map((t) => ({
    id: t.id,
    label: t.label,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
  }));
  res.json({ tokens });
});

deviceRoutes.post("/", (req, res) => {
  const userId = requireRealSession(req, res);
  if (!userId) return;

  const { label } = req.body || {};
  if (!label || typeof label !== "string" || !label.trim()) {
    return res.status(400).json({ error: "label is required" });
  }

  // 256 bits of entropy, base64url so it's copy/paste and watch-keyboard
  // friendly (no +, /, or = to mistype). Sent to the client exactly once --
  // only the SHA-256 hash (hashDeviceToken, db.ts) is ever stored.
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const token = createDeviceToken(userId, label.trim(), hashDeviceToken(rawToken));
  res.json({ id: token.id, label: token.label, token: rawToken });
});

deviceRoutes.delete("/:id", (req, res) => {
  const userId = requireRealSession(req, res);
  if (!userId) return;

  const ok = deleteDeviceToken(userId, req.params.id);
  if (!ok) return res.status(404).json({ error: "Token not found" });
  res.json({ success: true });
});
