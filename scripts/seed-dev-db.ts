// Creates a throwaway database at data/dev.db with the real schema, two fake
// logins, and obviously-fake sample data -- so development (any dev checkout or
// test run) never has to touch the one real household.db. (Stage 0.5.1)
// Safe to re-run: deletes and recreates the file each time.
//
//   npx tsx scripts/seed-dev-db.ts
//   DB_PATH=data/dev.db npm run dev

// env.ts first and explicitly, not left to db.ts's own import of it: this
// script relies on setting process.env.DB_PATH itself (below) and having that
// win. If db.ts's dotenv load happened to run AFTER that assignment (as it
// would if this script only imported db.ts and let db.ts pull in env.ts on
// its own), a DB_PATH line ever added to .env.local would silently clobber
// it back via override:true. Loading env.ts here first means dotenv has
// already run (and is a cached no-op by the time db.ts imports it too) before
// this script's own DB_PATH assignment below, so that assignment always wins.
import "../env.ts";

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

const DEV_DB_PATH = path.join("data", "dev.db");

if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) !== path.resolve(DEV_DB_PATH)) {
  console.error(
    `DB_PATH is set to "${process.env.DB_PATH}", not the expected dev database (${DEV_DB_PATH}). ` +
      `Unset DB_PATH or point it at data/dev.db before running this -- refusing to guess, since a ` +
      `typo here could seed fake data into the real database.`
  );
  process.exit(1);
}
process.env.DB_PATH = DEV_DB_PATH;

if (fs.existsSync(DEV_DB_PATH)) fs.unlinkSync(DEV_DB_PATH);

const { createUser, putScopedItem, newId } = await import("../db.ts");

const passwordHash = await bcrypt.hash("devpassword123", 12);
const alice = createUser("alice", passwordHash, "Alice (dev)");
createUser("bob", passwordHash, "Bob (dev)");
// Admin tier, so AdminSettings' admin-only tabs (Security, Kiosk) have a dev
// account to sign in as -- alice/bob default to "parent" and can't reach them.
createUser("admin-dev", passwordHash, "Admin (dev)", "admin");
// The kiosk login (the third account class), so the kiosk's view -- no Food section, nutrition routes
// refused -- can be checked in a browser. Same fake password.
createUser("kiosk-dev", passwordHash, "Kiosk", "kiosk");

putScopedItem("shopping_lists", alice, {
  id: newId("list"),
  scope: "joint",
  name: "Weekly Groceries",
  items: [{ id: newId("item"), name: "Milk", qty: "1" }],
});
putScopedItem("pantry_items", alice, {
  id: newId("pantry"),
  scope: "joint",
  name: "Rice",
  quantity: "2 boxes",
});

console.log(`Seeded ${DEV_DB_PATH} with 4 fake users (alice / bob / admin-dev / kiosk-dev, password: devpassword123) and sample data.`);
console.log("Point the app at it with: DB_PATH=data/dev.db npm run dev");
