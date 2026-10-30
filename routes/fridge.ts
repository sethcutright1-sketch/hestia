import express from "express";
import {
  isFridgeConfigured,
  getFridgeDeviceId,
  disconnectFridge,
  connectFridge,
  getFridgeStatus,
  setFridgeCommand,
  getFridgeCameraImageUrl,
  FridgeDisconnectedError,
} from "../smartthings.ts";
import { currentUserId } from "../auth.ts";
import { identifyFoodItems, annotateAgainstPantry, VisionUnavailableError } from "../vision.ts";

export interface FridgeStatus {
  doorOpen: { cooler?: boolean; freezer?: boolean };
  temperature: { cooler?: number; freezer?: number };
  setpoint: { cooler?: number; freezer?: number };
  powerSaveOn?: boolean;
  iceBoostOn?: boolean;
  updatedAt: string;
}

// Reads one attribute out of SmartThings' per-component status tree, tolerant
// of a missing path -- fields legitimately vary by model/firmware.
function attr(raw: any, component: string, capability: string, attribute: string): any {
  return raw?.components?.[component]?.[capability]?.[attribute]?.value;
}

// PLACEHOLDER MAPPING -- these component/capability/attribute names are the
// commonly-documented ones for SmartThings-connected fridges, but Samsung's
// samsungce.* capabilities vary by model and firmware. Before trusting this in
// real use, run `npx tsx scripts/inspect-fridge-device.ts <token>` against the
// real fridge and adjust any path below that doesn't match its actual
// status JSON. Every read is defensive (optional chaining), so a wrong path
// degrades to `undefined` in the response rather than throwing.
function mapStatus(raw: any): FridgeStatus {
  return {
    doorOpen: {
      cooler: attr(raw, "cooler", "contactSensor", "contact") === "open",
      freezer: attr(raw, "freezer", "contactSensor", "contact") === "open",
    },
    temperature: {
      cooler: attr(raw, "cooler", "temperatureMeasurement", "temperature"),
      freezer: attr(raw, "freezer", "temperatureMeasurement", "temperature"),
    },
    setpoint: {
      cooler: attr(raw, "cooler", "thermostatCoolingSetpoint", "coolingSetpoint"),
      freezer: attr(raw, "freezer", "thermostatCoolingSetpoint", "coolingSetpoint"),
    },
    powerSaveOn: attr(raw, "main", "custom.energySavingSupport", "energySavingOperation") === "on",
    iceBoostOn: attr(raw, "icemaker", "samsungce.iceMaker", "iceMaker") === "on",
    updatedAt: new Date().toISOString(),
  };
}

// component -> {capability, command} for the two controllable settings. Same
// placeholder-pending-discovery caveat as mapStatus above.
const SETPOINT_CAPABILITY = "thermostatCoolingSetpoint";
const SETPOINT_COMMAND = "setCoolingSetpoint";
const ICE_BOOST_CAPABILITY = "samsungce.iceMaker";
const ICE_BOOST_COMMAND = "setIceMaker";

export const fridgeRoutes = express.Router();

fridgeRoutes.get("/config", (_req, res) => {
  res.json({ configured: isFridgeConfigured(), deviceId: getFridgeDeviceId() || undefined });
});

// Body is the OAuth authorization_code exchange, not a pasted token -- see
// smartthings.ts's OAuth section. The user gets `code` by opening the
// authorize URL the Fridge section builds and pasting back what comes out
// the other end (this app has no public HTTPS endpoint for a real redirect).
fridgeRoutes.post("/config", async (req, res) => {
  const { clientId, clientSecret, redirectUri, code, deviceId } = req.body || {};
  for (const [name, value] of Object.entries({ clientId, clientSecret, redirectUri, code, deviceId })) {
    if (!value || typeof value !== "string" || !value.trim()) {
      return res.status(400).json({ error: `${name} is required` });
    }
  }

  try {
    await connectFridge({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      redirectUri: redirectUri.trim(),
      code: code.trim(),
      deviceId: deviceId.trim(),
    });
    res.json({ success: true, configured: true, deviceId: deviceId.trim() });
  } catch (err: any) {
    console.error("Fridge OAuth connect failed:", err);
    res.status(400).json({ error: "Couldn't complete authorization -- check the code and try again." });
  }
});

fridgeRoutes.post("/disconnect", (_req, res) => {
  disconnectFridge();
  res.json({ success: true });
});

fridgeRoutes.get("/status", async (_req, res) => {
  try {
    const raw = await getFridgeStatus();
    res.json({ status: mapStatus(raw) });
  } catch (err: any) {
    if (err instanceof FridgeDisconnectedError) {
      return res.status(409).json({ code: "fridge_disconnected", error: err.message });
    }
    console.error("Fridge status fetch failed:", err);
    res.status(500).json({ error: "Couldn't reach the fridge." });
  }
});

fridgeRoutes.put("/setpoint", async (req, res) => {
  const { component, temperature } = req.body || {};
  if (component !== "cooler" && component !== "freezer") {
    return res.status(400).json({ error: 'component must be "cooler" or "freezer"' });
  }
  if (typeof temperature !== "number" || Number.isNaN(temperature)) {
    return res.status(400).json({ error: "temperature must be a number" });
  }

  try {
    await setFridgeCommand(component, SETPOINT_CAPABILITY, SETPOINT_COMMAND, [temperature]);
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof FridgeDisconnectedError) {
      return res.status(409).json({ code: "fridge_disconnected", error: err.message });
    }
    console.error("Fridge setpoint command failed:", err);
    res.status(500).json({ error: "Couldn't reach the fridge." });
  }
});

fridgeRoutes.post("/ice-boost", async (req, res) => {
  const { on } = req.body || {};
  if (typeof on !== "boolean") {
    return res.status(400).json({ error: "on must be a boolean" });
  }

  try {
    await setFridgeCommand("icemaker", ICE_BOOST_CAPABILITY, ICE_BOOST_COMMAND, [on ? "on" : "off"]);
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof FridgeDisconnectedError) {
      return res.status(409).json({ code: "fridge_disconnected", error: err.message });
    }
    console.error("Fridge ice-boost command failed:", err);
    res.status(500).json({ error: "Couldn't reach the fridge." });
  }
});

// Best-effort raw AI Vision Inside camera snapshot. This calls an undocumented,
// reverse-engineered SmartThings endpoint (there is no official API for it) --
// Samsung can change or block it with no notice, so failures here are always
// reported as "unavailable" rather than surfaced as an error.
fridgeRoutes.get("/camera", async (_req, res) => {
  if (!isFridgeConfigured()) return res.status(409).json({ code: "fridge_disconnected", error: "The fridge isn't connected yet." });

  try {
    const imageUrl = await getFridgeCameraImageUrl();
    if (!imageUrl) return res.json({ unavailable: true });
    res.json({ unavailable: false, imageUrl });
  } catch (err: any) {
    if (err instanceof FridgeDisconnectedError) {
      return res.status(409).json({ code: "fridge_disconnected", error: err.message });
    }
    res.json({ unavailable: true });
  }
});

// Fetches the snapshot (same undocumented endpoint as GET /camera) and runs it
// through vision.ts's multi-provider item identification -- see vision.ts for
// the provider fallback/settings logic. Suggestion-only: nothing is written to
// the pantry here, matching every other pantry-adjacent action in this app.
fridgeRoutes.post("/camera/scan", async (req, res) => {
  if (!isFridgeConfigured()) return res.status(409).json({ code: "fridge_disconnected", error: "The fridge isn't connected yet." });

  try {
    const imageUrl = await getFridgeCameraImageUrl();
    if (!imageUrl) return res.json({ unavailable: true });

    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) return res.json({ unavailable: true });
    const bytes = Buffer.from(await imageRes.arrayBuffer());
    const mediaType = imageRes.headers.get("content-type") || "image/jpeg";

    const { items, provider } = await identifyFoodItems(bytes.toString("base64"), mediaType, "camera");
    res.json({ items: annotateAgainstPantry(items, currentUserId(req)), provider });
  } catch (err: any) {
    if (err instanceof FridgeDisconnectedError) {
      return res.status(409).json({ code: "fridge_disconnected", error: err.message });
    }
    if (err instanceof VisionUnavailableError) {
      return res.status(503).json({ error: err.message });
    }
    console.error("Fridge camera scan failed:", err);
    res.status(500).json({ error: "Couldn't analyze the camera snapshot." });
  }
});
