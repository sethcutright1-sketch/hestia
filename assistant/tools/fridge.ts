// Smart-fridge tools -- reads/controls the Samsung fridge over SmartThings.
// See ./README.md for the contract every domain module follows. Calls the same
// smartthings.ts functions routes/fridge.ts uses, directly, not over HTTP.

import type { DomainTool, ToolModule } from "../registry.ts";
import { getFridgeStatus, setFridgeCommand, getFridgeCameraImageUrl, FridgeDisconnectedError } from "../../smartthings.ts";
import { identifyFoodItems, annotateAgainstPantry, VisionUnavailableError } from "../../vision.ts";

function attr(raw: any, component: string, capability: string, attribute: string): any {
  return raw?.components?.[component]?.[capability]?.[attribute]?.value;
}

// The fridge device itself isn't user-scoped like most domains -- there's one
// physical fridge shared by the whole household. userId is only used to check
// scan results against that user's (joint) pantry rows, same as the route does.
function fridgeTools(userId: string): DomainTool[] {
  return [
    {
      name: "get_fridge_status",
      description: "The smart fridge's current door status, cooler/freezer temperature, and setpoints.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        try {
          const raw = await getFridgeStatus();
          return {
            coolerDoorOpen: attr(raw, "cooler", "contactSensor", "contact") === "open",
            freezerDoorOpen: attr(raw, "freezer", "contactSensor", "contact") === "open",
            coolerTemperature: attr(raw, "cooler", "temperatureMeasurement", "temperature"),
            freezerTemperature: attr(raw, "freezer", "temperatureMeasurement", "temperature"),
            coolerSetpoint: attr(raw, "cooler", "thermostatCoolingSetpoint", "coolingSetpoint"),
            freezerSetpoint: attr(raw, "freezer", "thermostatCoolingSetpoint", "coolingSetpoint"),
          };
        } catch (err) {
          if (err instanceof FridgeDisconnectedError) return { error: err.message };
          return { error: "Couldn't reach the fridge." };
        }
      },
    },

    {
      name: "set_fridge_temperature",
      mutates: true,
      description: "Set the cooler or freezer compartment's target temperature.",
      parameters: {
        type: "object",
        properties: {
          component: { type: "string", description: '"cooler" or "freezer".' },
          temperature: { type: "number", description: "Target temperature." },
        },
        required: ["component", "temperature"],
      },
      run: async ({ component, temperature }) => {
        if (component !== "cooler" && component !== "freezer") {
          return { error: 'component must be "cooler" or "freezer".' };
        }
        try {
          await setFridgeCommand(component, "thermostatCoolingSetpoint", "setCoolingSetpoint", [Number(temperature)]);
          return { component, temperature: Number(temperature) };
        } catch (err) {
          if (err instanceof FridgeDisconnectedError) return { error: err.message };
          return { error: "Couldn't reach the fridge." };
        }
      },
    },

    {
      name: "scan_fridge_camera_for_pantry_items",
      description:
        "Look at the fridge's AI Vision Inside camera and identify food items visible inside it. " +
        "Read-only -- reports what it saw, does not add anything to the pantry itself.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        try {
          const imageUrl = await getFridgeCameraImageUrl();
          if (!imageUrl) return { error: "The camera snapshot isn't available right now." };
          const imageRes = await fetch(imageUrl);
          if (!imageRes.ok) return { error: "The camera snapshot isn't available right now." };
          const bytes = Buffer.from(await imageRes.arrayBuffer());
          const mediaType = imageRes.headers.get("content-type") || "image/jpeg";
          const { items } = await identifyFoodItems(bytes.toString("base64"), mediaType, "assistant");
          return { items: annotateAgainstPantry(items, userId) };
        } catch (err) {
          if (err instanceof FridgeDisconnectedError) return { error: err.message };
          if (err instanceof VisionUnavailableError) return { error: err.message };
          return { error: "Couldn't analyze the camera snapshot." };
        }
      },
    },

    {
      name: "toggle_ice_boost",
      mutates: true,
      description: "Turn the fridge's ice boost mode on or off, to chill drinks faster.",
      parameters: {
        type: "object",
        properties: { on: { type: "boolean", description: "true to turn ice boost on, false to turn it off." } },
        required: ["on"],
      },
      run: async ({ on }) => {
        try {
          await setFridgeCommand("icemaker", "samsungce.iceMaker", "setIceMaker", [on ? "on" : "off"]);
          return { iceBoostOn: !!on };
        } catch (err) {
          if (err instanceof FridgeDisconnectedError) return { error: err.message };
          return { error: "Couldn't reach the fridge." };
        }
      },
    },
  ];
}

export const fridgeModule: ToolModule = {
  domain: "fridge",
  sensitivity: "household",
  label: "the fridge",
  build: fridgeTools,
};
