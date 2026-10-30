// Loads .env / .env.local before any other module's top-level code runs.
// Must be the first import wherever a module's own top-level code (not just a
// function body invoked later) reads process.env.
//
// Why this is its own file: ES module imports are fully evaluated (including
// all of *their* imports, transitively) before the importing module's own
// later statements run -- regardless of where the import statement sits in
// that module's source. server.ts used to load dotenv itself, after which it
// imported db.ts -- but that import is still hoisted ahead of server.ts's own
// dotenv.config() calls, so db.ts's top-level code (its bare `backupIfNeeded()`
// call, and `DB_PATH`'s `process.env.DB_PATH` read) ran with an empty
// environment every time. `import "./env.ts"` as db.ts's first import forces
// this file to finish running before db.ts's own top-level code does, closing
// that gap without db.ts needing to know anything about dotenv itself.
import dotenv from "dotenv";

// .env first, then .env.local layered on top (override: true) so real
// secrets in the gitignored .env.local always win over any placeholder in
// the committed .env -- see .env.example for what belongs in each.
//
// PORT is the one exception: it's not a secret, and a shell-set PORT (e.g.
// to run a second dev instance alongside the live one) needs to win over
// .env.local's own PORT rather than being clobbered by override: true.
const shellPort = process.env.PORT;

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

if (shellPort !== undefined) {
  process.env.PORT = shellPort;
}
