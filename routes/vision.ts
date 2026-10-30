// Generic "identify food items in this photo" endpoint -- no fridge
// involvement, used by Pantry's photo-import and reusable by anything else
// that just has an image. See vision.ts for the actual analysis and the
// multi-provider fallback/settings logic this route is a thin wrapper over.
import express from "express";
import { currentUserId } from "../auth.ts";
import {
  getVisionProviderSetting,
  setVisionProviderSetting,
  visionProviderStatus,
  identifyFoodItems,
  annotateAgainstPantry,
  VisionUnavailableError,
  type VisionProviderSetting,
} from "../vision.ts";

const VALID_PROVIDERS: VisionProviderSetting[] = ["auto", "anthropic", "gemini", "ollama"];

export const visionRoutes = express.Router();

visionRoutes.get("/config", async (_req, res) => {
  res.json({ provider: getVisionProviderSetting(), providers: await visionProviderStatus() });
});

visionRoutes.put("/config", (req, res) => {
  const { provider } = req.body || {};
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
  }
  setVisionProviderSetting(provider);
  res.json({ success: true, provider });
});

visionRoutes.post("/scan", async (req, res) => {
  const { image, mediaType } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "image (base64) is required" });
  }

  try {
    const { items, provider } = await identifyFoodItems(image, typeof mediaType === "string" ? mediaType : "image/jpeg", "upload");
    const userId = currentUserId(req);
    res.json({ items: annotateAgainstPantry(items, userId), provider });
  } catch (err: any) {
    if (err instanceof VisionUnavailableError) {
      return res.status(503).json({ error: err.message });
    }
    console.error("Vision scan failed:", err);
    res.status(500).json({ error: "Couldn't analyze that photo." });
  }
});
