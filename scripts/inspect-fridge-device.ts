// One-off discovery script -- run this BEFORE trusting routes/fridge.ts's
// capability mapping. Samsung fridges expose proprietary samsungce.* capabilities
// across several components (cooler/freezer/icemaker/...) that vary by model and
// firmware, so the exact field names for THIS unit are read from a real response
// here rather than guessed from documentation.
//
// Usage: npx tsx scripts/inspect-fridge-device.ts <smartthings-token>
import { listDevices, getDeviceStatus } from "../smartthings.ts";

async function main() {
  const token = process.argv[2] || process.env.SMARTTHINGS_TOKEN;
  if (!token) {
    console.error("Usage: npx tsx scripts/inspect-fridge-device.ts <smartthings-token>");
    process.exit(1);
  }

  console.log("Fetching device list...\n");
  const devices = await listDevices(token);
  for (const d of devices) {
    console.log(`${d.deviceId}  ${d.label || d.name}`);
  }

  const fridge = devices.find(
    (d) => /fridge|refrigerator|RF90/i.test(d.label) || /fridge|refrigerator|RF90/i.test(d.name)
  );
  if (!fridge) {
    console.log("\nNo device name matched \"fridge\"/\"refrigerator\"/\"RF90\" -- pick a deviceId from the list above and pass it manually.");
    return;
  }

  console.log(`\nMatched fridge: ${fridge.deviceId} (${fridge.label})\n`);
  const status = await getDeviceStatus(token, fridge.deviceId);
  console.log(JSON.stringify(status, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
