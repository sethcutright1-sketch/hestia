# tests/

Unit tests for the pure logic the rest of the app trusts without checking.

    npm test

Node's own built-in runner (`node:test` + `node:assert/strict`) run through
`tsx`, so there is no test framework dependency to install or keep current --
same reasoning as `node:sqlite` over an ORM in `db.ts`. Each file runs in its
own process (that's `node --test`'s default), which is what lets every
database-backed file point `DB_PATH` at its own throwaway file without any
other test file seeing it.

## What's covered, and why these

Deliberately narrow. These are the places where being wrong is silent --
nothing crashes, a guarantee just quietly stops holding:

- **`providers.test.ts`** -- the data boundary from `PLAN.md` Stage 2: which
  turns are judged financial, which provider gets them, and which tools a cloud
  provider is even offered. The one guarantee this app makes about privacy.
- **`assistantHealthBoundary.test.ts`** -- the data boundary for *health* data, the independent twin of
  `providers.test.ts`: the routing signal, the per-provider switches (Claude and Gemini separate, independent of the money
  ones), the tool filter, the voice block, the food-diary PIN, the kiosk's tool set, the admin routes, and a wire-level check
  that Claude's request body holds no health tool.
- **`assistantCalorieTools.test.ts`** -- the calorie tools for the owner, another person at each visibility level from both
  sides (and the owner's PIN, a watch), chat logging that only ever adds planned entries, and the weekly planner that gets every
  login's calorie budget number and nothing else.
- **`assistantKioskTools.test.ts`** -- the kiosk assistant: plan-level only, and the quick-log tool following `POST /kiosk/log`'s rules.
- **`assistantSetMealStatus.test.ts`** -- bug 10.15: `set_meal_status` with split and leftover meals.
- **`voiceLocal.test.ts`** / **`whisperRunner.test.ts`** -- local voice input, the server half: `inputMode: "voice_local"`
  is a typed turn only while `assistant.speechBackend` is `whisper_local` (else refused like the watch's `"voice"`, which is
  unchanged); the setting's admin/real-session/device-token rules; `POST /api/assistant/transcribe` over real HTTP behind the
  app-wide JSON parser (409 off, 503, the WAV checks, 413, 429, the in-flight slot freed on every path, the transcript never
  logged); and the whisper-server runner against a fake child process: one shared start, GPU-to-CPU fallback at startup and
  on a failed request (retried once), idle shutdown on a hand-fired timer. No real binary is ever started.
- **`registry.test.ts`** -- that the tool list the client is shown (`GET
  /api/assistant/tools`) always agrees with the one a model is actually
  offered. server.ts derives those from different functions, and nothing else
  forces them to stay in step.
- **`auth.test.ts`** -- the gate every route sits behind: a stale session, the
  PIN lock's sliding window, the account cap, and that changing a password
  needs the old one and not just a live cookie.
- **`lockRoutes.test.ts`** -- setting, changing and removing the PIN, and the
  attempt limiter in front of it. A 4-6 digit PIN is 10,000-1,000,000 codes;
  a limiter that has quietly stopped working looks identical from outside.
- **`rateLimit.test.ts`** -- the one failed-attempt limiter behind sign-in, the household PIN
  on sign-up and the budget PIN unlock (10.3, 10.4): the lockout arithmetic on a fake clock,
  sweeping and the size cap, who shares a budget of attempts and who must not, a device token
  refused at `/unlock`, and what reaches the security log (never an unknown username as typed).
- **`plaidSecretEncryption.test.ts`** -- the Plaid client secret encrypted at rest (10.6),
  including the one-time boot migration run as a real boot against a database seeded before
  `db.ts` is first imported.
- **`keyRotation.test.ts`** -- changing `DB_ENCRYPTION_KEY`: every value verifies with the new
  key, any failure rolls the whole thing back, an encrypted value it doesn't know about is
  refused, and the CLI script run end to end in a temp folder (dry run writes nothing, `--apply`
  backs up and moves `.env.local`, no secret is ever printed, refused while the app is up).
- **`securityHeaders.test.ts`** -- `no-store` on `/api`, `nosniff` and `DENY` framing on
  everything, no `X-Powered-By`, and `/ua` gone (10.8, 10.9).
- **`securityBatch2.test.ts`** -- the app is public, so: a password change signs out that user's
  other sessions and revokes their device tokens (and nobody else's), the admin "sign out
  everywhere" route, the Secure cookie behind a loopback proxy (HTTPS yes, LAN HTTP no) while a
  forged `X-Forwarded-For` can't change the address the limiter keys on, and `/api/health`
  answering only `{ok:true}` when signed out (M4, L4).
- **`securityBatch3.test.ts`** -- Plaid access tokens never reach the browser: `/store` and every
  server read carry only `hasAccessToken`, a client-sent token is ignored (can't replace or plant
  one), a fresh link's token comes from server memory and belongs to its user (10.7); and only an
  admin can delete a family member linked to a login (L5).
- **`kroger.test.ts`** -- the household's Kroger connection (kroger.ts, routes/kroger.ts), all
  against a fake Kroger: the sign-in stored encrypted and never in any response; connecting,
  disconnecting and picking the store admin-only from a real browser session; the callback
  finishing only the sign-in this session started (state, PKCE verifier, 10 minutes, one use);
  each refresh's new refresh token saved, with one refresh at a time; a refused sign-in becoming
  "needs reconnect" while Kroger being down doesn't; and the cart call's exact shape, with junk
  refused before it reaches Kroger. `keyRotation.test.ts` covers the Kroger token's re-encryption.
  Phase 2 adds the list routes: a preview that searches only items with no known product and costs
  no calls for Pantry or already-sent items; a send that verifies every product at the store first,
  merges duplicates, stamps items and remembers Kroger's own label only after the cart accepted them,
  and refuses an already-sent item unless "send again"; per-login call limits.
- **`krogerMatch.test.ts`** -- Alex's matching rules, with no database or network: barcodes to Kroger's
  13-digit codes (UPC-A, EAN-13, GTIN-14, UPC-E, bad check digits), what counts as in the Pantry,
  head-noun Pantry matching, remembered pick before scanned product, quantities by the unit and by
  weight, and the estimate at sale prices.
- **`db.test.ts`** -- Plaid token encryption at rest, and the personal/joint
  row scoping every route depends on to keep one member's rows out of the
  other's reads and writes.
- **`tools-budget.test.ts`** -- the money math behind every financial answer.
  Signs, exclusions, and divide-by-zero: none of these throw when wrong, they
  just produce a plausible number the model then reports as fact.
- **`conversations.test.ts`** -- Stage 4's persisted transcripts: per-owner
  scoping, and tool calls/results surviving the round trip server.ts replays
  them from.
- **`tools.test.ts`** -- the assistant's tools called the way a provider calls
  them, against the real data layer. Mostly: the assistant can never see more
  than the person talking to it can.
- **`sessionStore.test.ts`** -- session persistence and `touch()`, which is why
  an always-on device stays signed in across a supervisor restart.
- **`systemPrompt.test.ts`** -- the roster and dietary lines, and that locking
  removes the finance section.
- **`ollama.test.ts`** -- the tool loop itself: rounds, the `maxRounds` cap, a
  tool that throws, a model inventing a tool name, and `coerceArgs`' repair of
  llama3.1's stringified arrays. Against a stubbed `fetch`, so it covers the
  cases you cannot reproduce on demand against a real model.
- **`cloudProviders.test.ts`** -- the Anthropic and Gemini adapters, also
  against a stubbed `fetch`. Holds the 2026-09-02 provider-review fixes in
  place (the project notes #1, #4, #5): the `max_tokens`/`MAX_TOKENS`
  cutoff detection, the transient-error retries, and abort propagating as an
  abort rather than as "unreachable".
- **`shared.test.ts`** -- the assistant's name matching and "did you mean"
  suggestions, which decide whether a tool call finds the right row.
- **`ingredients.test.ts`** -- ingredient matching, which decides what lands on
  a shopping list and whether a dislike conflict is caught.
- **The route-level files** -- `budgetRoutes.test.ts`, `sectionRoutes.test.ts`
  (grocery, pantry, members, calendar) and `mealplanRoutes.test.ts`. Every
  router now has these; see the note under "What's not covered" for how they
  work without supertest.
- **`recipeImport.test.ts`** -- the four import paths, and the guard on the URL
  one. Two things there are load-bearing. Quantity stripping: the pantry match
  works on the head noun, so a stored "2 1/2 cups all-purpose flour" never
  matches a pantry holding "flour", and every imported recipe would insist on
  buying what's already in the cupboard with nothing looking broken. And the
  SSRF guard: the fetch makes this server issue requests to a user-pasted
  address, on a LAN that also hosts Ollama, from a process holding live Plaid
  credentials. It is tested against the addresses that actually matter rather
  than assumed -- one of those tests caught a real hole, since `new URL()`
  rewrites `[::ffff:192.168.1.1]` as `::ffff:c0a8:101` and the original
  string-prefix check missed it.
- **`deviceAuth.test.ts`** -- device tokens (`PLAN.md` Stage 8c), including
  that a token can never satisfy `requireUnlocked` regardless of PIN state.
- **`nutrition*.test.ts`** -- the calorie tracker's data layer (`nutrition/`, phase 1 of
  `NUTRITION_MERGE_PLAN.md`). `nutritionSchema` is the migration runner (idempotent, atomic) and
  the guarantee that the journal mode is still `DELETE` after it; `nutritionAccess` is the rule that
  only admin and parent logins keep a diary (code and SQL triggers); `nutritionFoods` is joint vs
  personal visibility and search ranking; the rest port the calorie app's own suites (diary, bulk
  writes, slots, calorie schedule, streaks, saved meals, barcodes) and its pure maths
  (`nutritionCalorieBudget`, `nutritionDates`, ...). They use `helpers/nutritionWorld.ts`: a private
  in-memory database per test with the real `users` table, so nothing leaks between tests and nothing
  can reach `household.db`.
- **Phase 2 (the API)** -- `nutritionRoutes` is the HTTP contract over the data layer (who the person
  is, idempotent replays, one login can never reach another's diary by id); `nutritionBarcodeRoutes`
  is the scan, linking, miss log, offline list and the two-spouse case (barcode uniqueness per
  scope, migration 6); `nutritionKiosk` is the admin setting and the kiosk's 403s and two routes;
  `nutritionLookup` is the one lookup cascade (fake `fetch` and clock, FDC key handling, cache
  lifetimes) plus the USDA nutrient mapping; `nutritionUsdaImport` is the catalogue importer on a
  fixture (nothing downloaded); `nutritionWiring` runs the router behind the real `requireAuth` /
  `deviceTokenAuth` and `db.ts`'s handle over real HTTP on an ephemeral port. They use
  `helpers/nutritionApi.ts`, which drives the real router against a private in-memory household with
  a pinned clock and a fake lookup. `barcodeLookup` and `pantryScan` now exercise Pantry through the
  shared lookup service, including the old `app_config` cache fallback.

- **Phase 3 (recipes with calories)** -- `nutritionMigration7` builds a database as migration 6 left it,
  fills it (foods, servings, diary entries, saved-meal items, FTS rows) and checks the table rebuild lost
  nothing: rows, every index and trigger, search, barcode uniqueness, foreign keys switched off and back on.
  `nutritionRecipeModel` is the pure half (line parser, units, the matching and auto-link rule, the sum and
  `complete`, the site's calories and yield). `nutritionRecipes` is the data layer against a private
  household (the recipe's food, joint/personal, calculate with a fake model); `nutritionRecipeRoutes` is the
  HTTP over it plus the food routes' 409 for a recipe's food; `mealplanRecipes` is the old recipe routes
  after the change (typed, imported with lines/yield/site calories, personal); `assistantRecipes` is
  `save_recipe` working out calories. `nutritionPin` is the food-diary PIN option (on/off, 423, unlocking,
  turning off needs unlock, other login, device token, kiosk). `tests/helpers/testdb.ts` now also switches the
  local model off (`HOUSEHOLD_LOCAL_MODEL=off`) and clears `FDC_API_KEY`, so no test reaches Ollama or USDA.
- **Phase 5b (Weight & progress, Food settings, who sees what)** -- `nutritionVisibility` is the per-login level
  against every route that exposes another person (the household streaks, the week's calorie view, the read-only
  day and progress views): each of the three levels from both sides, the watch, the kiosk, the food-diary PIN
  (423 for a locked owner), and a before/after snapshot of every nutrition table to show that looking writes
  nothing and that no write route reaches another login. `nutritionSteps` and `nutritionPhotos` (with
  `nutritionMigration10` for the visibility column) are the new storage: steps by date, and photos as BLOBs with
  type and size read from the file header (`helpers/images.ts` builds tiny pictures), the size cap, and "only the
  owner gets a photo" at every level. `nutritionWiring` also runs photos and sharing over real HTTP (headers,
  the 10 MB body limit). The `food*` tests are the browser-free halves of the screens: `foodUnits`,
  `foodWeightChart`, `foodStepsChart`, `foodImageResize`, `foodPhotoGroups`, `foodSharing`,
  `foodSettingsForms`, and `foodRender` (charts, switcher and top card rendered to static HTML).
- **Phase 7 (the Lose It! import)** -- every fixture is synthetic (`helpers/loseitExport.ts` writes CSV with the real
  export's headers and made-up rows; nothing from a real export may ever be copied into `tests/`).
  `nutritionImportCsv`, `nutritionImportZip` (text by basename, progress photos as bytes, meal photos only counted) and
  `nutritionImportParse` (every file reader, the Deleted flag's `1/0` and `true/false` spellings, negative exercise calories)
  are the pure halves. `nutritionImport` is the engine against a private household: ported importer tests plus the
  fixes and new imports (Done logging days, steps never over typed ones, photos kept as they are, custom foods, the
  Only me choice, recipes skipped, the conflict modes, the dry run equalling the real run, re-run adding nothing,
  the calorie budget comparison never applied by the import). `nutritionImportRoutes` drives the routes with the ZIP as
  the raw body (kiosk 403, watch 403, food-diary PIN 423, another login 404 on an imported photo) and one test runs
  them behind a real HTTP server past the 10 MB JSON limit. `nutritionImportCli` is the flags and the `--yes` guard.
  `foodImportView` is the card's sentences and a static render.
- **Phase 4 (the meal plan and the diaries)** -- `nutritionMigration8` is the new columns and the snack allowance
  table on a populated migration-7 database. `nutritionPlanSync` is the sync itself against a private household
  (`helpers/planWorld.ts` gives recipes with a known kcal, plan meals in the sync's shape and an extra login):
  approve, individual, kiosk and missing logins skipped, the custom-slot fallback, moves/recipe changes/denials/
  deletes/audience changes touching only planned entries (a logged entry compared byte for byte), the deleted-entry
  rule, all-or-nothing including a write that fails half-way (a trigger), and "log all". `nutritionPlanRoutes` is
  the API: snack allowance, the week's calorie view (calorie schedule applied, read-only, kiosk 403), log-all,
  "Use from pantry?" (matching, decrement, never below zero, all or nothing, once, only visible items) and the
  kiosk board's plan side per setting. `mealplanDiary` drives the real `/api/mealplan` and `/api/members`
  routers and the assistant tools against the throwaway database: recipe links and joint-only, recipe-less
  meals, the roster link (admin only, unique, never the kiosk) and its re-sync, household slots, leftovers,
  and `create_meal_plan`/`set_meal_status`. `helpers/nutritionWorld.ts` now also copies `meal_plans`,
  `household_members` and `pantry_items` from db.ts, since the data layer reads them with plain SQL.
- **Phase 5c (Meal Plan, Recipes, kiosk buttons)** -- `planCells` is the pure Move rules (taken cell, leftover
  order); `mealplanMove` runs them through the real `PUT /api/mealplan/meals/:id` (diaries follow a legal move, a
  refused move changes nothing). `mealplanUi` is the screen's browser-free half: calories per person, the kiosk
  "Log for" matching and chips (no calories on the kiosk), the leftover picker and the Move panel, with static
  renders. `mealplanRecipeLines` is the recipe line editor's wording and requests, and drives the real recipe
  routes with exactly those requests. `nutritionRecipeRoutes` also covers `POST /recipes` (Save as recipe),
  `foodMeals` its request body and the saved-meal rename and delete, and `nutritionKiosk` the board's `mealId`.

The two `fetch`-stubbing files restore `globalThis.fetch` in an `afterEach`, and
`cloudProviders.test.ts` sets both API keys before its dynamic imports, since
each adapter captures `process.env.*_API_KEY` at module load.

`helpers/testdb.ts` owns the `DB_PATH` override. Import it **first** in any
file that touches the database, and reach db.ts only through its `loadDb()` --
a static `import ... from "../db.ts"` would open the real database before the
override ran. The helper explains the ordering rule in full.

## What's not covered

- **`useSyncedTable`** (the retry/queue state machine in
  `src/sections/budget/useSyncedTable.ts`) is still the highest-value untested
  thing here -- it stands between a failed write and silently losing someone's
  financial edits. It's a React hook, so its logic only runs inside a rendered
  component with a live effect loop, and `react-dom/client` needs browser
  globals Node doesn't have. That means a DOM implementation as a
  devDependency: `happy-dom` (~8.5MB, 7 direct deps) is the better fit than
  `jsdom` (~7MB but 18+ direct deps). It would never ship -- nothing in
  `server.ts` or `src/` imports it -- but it is a dependency decision rather
  than a file to write, and **has not been approved**. The alternative is
  extracting the queue/retry state machine into a plain function the hook wraps,
  testable with zero dependencies, at the cost of changing production code that
  currently has no test protecting it. Still worth doing, either way.
- ~~**Most HTTP routes**~~ -- now covered. `helpers/router.ts` drives an express
  Router directly with a fake req/res (`router.handle(req, res, next)` is
  exactly what `app.use()` does per request), so no supertest is needed. Every
  router has route-level tests. One gotcha it papers over: `req.query` is
  populated at the app level, not in the Router, so a directly-driven router
  needs `query` supplied by hand.
- **Answer quality** -- whether a real model picks the right tool and phrases
  the answer well is `scripts/eval-assistant.ts`'s job, not this suite's. These
  tests cover the plumbing around the model; that one covers the model.
