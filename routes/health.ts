// GET /api/health. Signed out it answers only {ok:true} -- enough for the supervisor and
// Cloudflare to see the app is up, and nothing a stranger can map the setup with (audit L4:
// the model name and Ollama/database state used to be public). Signed in (cookie or device
// token) it also reports whether the assistant's dependencies are actually up, so a failure
// is diagnosable without reading server logs.
import express from "express";
import { db, getUserById } from "../db.ts";
import { OLLAMA_MODEL } from "../ollama.ts";

export const healthRoutes = express.Router();

healthRoutes.get("/", async (req, res) => {
  const userId = req.session?.userId ?? req.deviceUserId;
  if (!userId || !getUserById(userId)) return res.json({ ok: true });

  const checks: Record<string, string> = {};
  try {
    const r = await fetch(`${process.env.OLLAMA_URL || "http://localhost:11434"}/api/tags`, { signal: AbortSignal.timeout(3000) });
    checks.ollama = r.ok ? "ok" : `status ${r.status}`;
  } catch {
    checks.ollama = "unreachable";
  }

  // Cheapest possible proof the SQLite handle is still alive -- matters once the app runs
  // unattended from a removable drive that can glitch without the Node process itself crashing.
  try {
    db.prepare("SELECT 1").get();
    checks.db = "ok";
  } catch (err: any) {
    checks.db = `error: ${err?.message || err}`;
  }

  res.json({ ok: true, model: OLLAMA_MODEL, checks });
});
