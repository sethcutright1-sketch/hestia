// The nutrition tables and the migration runner that creates them.
//
// These live in household-app's one database file next to the JSON-document tables db.ts
// creates, but they are ordinary relational tables, not item_id/owner_user_id/data blobs:
// food search (FTS5), frozen diary snapshots and per-day joins need real columns. They are
// kept apart from db.ts's own schema three ways:
//
//   - every table is prefixed `nutrition_`;
//   - they have their own append-only migration list and version table
//     (`nutrition_schema_migrations`), so db.ts's idempotent CREATE TABLE IF NOT EXISTS
//     block never has to learn about them and a nutrition change never touches it;
//   - db.ts runs them at boot, AFTER its own tables exist (they reference `users`).
//
// Conventions, carried over from the calorie app: local dates are TEXT 'YYYY-MM-DD' in the
// person's own timezone (never UTC); timestamps are ISO-8601 UTC TEXT; nutrient blobs are
// JSON TEXT keyed like the Nutrients type; `deleted_at` is a soft delete; ids the server makes
// are random UUIDs, ids a client makes (for idempotent replays) are 8-64 safe characters.
//
// Visibility follows db.ts's scoped-item convention instead of the calorie app's household
// table: `owner_user_id IS NULL` is joint (every login sees it), a user id is personal (only
// that login does). The shared USDA catalogue is also owner-less; what separates it from a
// joint food is source = 'usda_generic' (read-only, never edited by anyone).
//
// Foreign keys: declared, and ENFORCED. This header used to say they weren't; that was wrong.
// node:sqlite's DatabaseSync turns `PRAGMA foreign_keys` on by default and db.ts never turns it
// off, so a row naming a missing user or food is refused. Nothing here relies on ON DELETE
// CASCADE; the places that need one delete explicitly. It matters for table rebuilds: migration
// 7 drops and recreates nutrition_foods, which with enforcement on would delete (or refuse to
// delete) every row that points at a food -- so a migration that rebuilds a table says so
// (`rebuildsTable`) and the runner follows SQLite's documented procedure for it.
//
// Journal mode is not touched here. db.ts keeps `journal_mode = DELETE` on its single handle
// so backupIfNeeded()'s plain file copy stays complete -- never WAL (see db.ts and README).

import { all, get, run, tx, type Db } from "./sql.ts";

export interface NutritionMigration {
  id: number;
  name: string;
  sql: string;
  /**
   * The migration drops and recreates a table that other tables point at. The runner then follows
   * sqlite.org/lang_altertable.html: `PRAGMA foreign_keys = OFF` before the transaction starts (it
   * is a no-op inside one), and a `foreign_key_check` before commit that refuses the migration if
   * the rebuild left more violations than it found. Enforcement is put back afterwards either way.
   */
  rebuildsTable?: boolean;
}

// Diaries are for the household's people, never the shared kiosk device. The data layer
// checks this in code (tracker.ts assertCanTrack); this trigger is the backstop for any
// path that writes SQL directly. It also rejects an id that isn't a user at all, which
// duplicates what the foreign key does, for anything that writes SQL by hand.
const trackersOnly = (table: string, column = "user_id"): string => `
  CREATE TRIGGER ${table}_trackers_only BEFORE INSERT ON ${table}
  WHEN COALESCE((SELECT role FROM users WHERE id = NEW.${column}), '') NOT IN ('admin', 'parent')
  BEGIN
    SELECT RAISE(ABORT, 'nutrition: only admin and parent logins can track food (not kiosk, not an unknown user)');
  END;`;

// Migrations are append-only: never edit one that has shipped, add a new entry. Each runs in
// its own transaction and is recorded in nutrition_schema_migrations.
//
// Later phases append here.
export const NUTRITION_MIGRATIONS: NutritionMigration[] = [
  {
    id: 1,
    name: "foods, servings and search index",
    sql: `
      CREATE TABLE nutrition_foods (
        id                 TEXT PRIMARY KEY,
        owner_user_id      TEXT REFERENCES users(id),   -- NULL = joint (or the USDA catalogue); a user id = personal
        created_by_user_id TEXT REFERENCES users(id),   -- who typed it in; NULL for the USDA catalogue
        name               TEXT NOT NULL,
        brand              TEXT,
        gtin14             TEXT,
        basis              TEXT NOT NULL CHECK (basis IN ('per100g', 'per_serving')),
        nutrients          TEXT NOT NULL,   -- JSON; per 100 g, or per ONE default serving when basis = per_serving
        source             TEXT NOT NULL CHECK (source IN ('usda_generic', 'off', 'fdc', 'custom', 'import_loseit', 'quick')),
        source_ref         TEXT,
        usage_count        INTEGER NOT NULL DEFAULT 0,
        last_used_at       TEXT,
        created_at         TEXT NOT NULL,
        deleted_at         TEXT,
        CHECK (source <> 'usda_generic' OR owner_user_id IS NULL)
      );
      -- One food per barcode, household-wide. Partial so a soft-deleted food doesn't block
      -- re-adding it. (The calorie app scoped this per household; there is only one here.)
      CREATE UNIQUE INDEX nutrition_foods_gtin ON nutrition_foods (gtin14)
        WHERE gtin14 IS NOT NULL AND deleted_at IS NULL;
      CREATE UNIQUE INDEX nutrition_foods_source_ref ON nutrition_foods (source, source_ref)
        WHERE source_ref IS NOT NULL AND source = 'usda_generic';
      CREATE INDEX nutrition_foods_owner ON nutrition_foods (owner_user_id, deleted_at);

      CREATE TABLE nutrition_food_servings (
        id         TEXT PRIMARY KEY,
        food_id    TEXT NOT NULL REFERENCES nutrition_foods(id),
        label      TEXT NOT NULL,
        grams      REAL,               -- NULL for per_serving foods with no known weight ("1 Each")
        is_default INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX nutrition_food_servings_food ON nutrition_food_servings (food_id);

      -- Search index. A standalone FTS5 table (it keeps its own copy of name/brand) rather
      -- than external-content: the food id is TEXT, so nutrition_foods has no stable integer
      -- rowid to point an external-content table at (VACUUM may renumber it). A copy of ~10k
      -- short names is a few hundred KB, and the triggers below keep it in step.
      CREATE VIRTUAL TABLE nutrition_foods_fts USING fts5(
        name, brand, food_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER nutrition_foods_fts_ai AFTER INSERT ON nutrition_foods BEGIN
        INSERT INTO nutrition_foods_fts (name, brand, food_id) VALUES (new.name, COALESCE(new.brand, ''), new.id);
      END;
      -- WHEN-guarded: the USDA importer upserts every row and most are unchanged.
      CREATE TRIGGER nutrition_foods_fts_au AFTER UPDATE OF name, brand ON nutrition_foods
        WHEN old.name IS NOT new.name OR old.brand IS NOT new.brand BEGIN
        DELETE FROM nutrition_foods_fts WHERE food_id = old.id;
        INSERT INTO nutrition_foods_fts (name, brand, food_id) VALUES (new.name, COALESCE(new.brand, ''), new.id);
      END;
      CREATE TRIGGER nutrition_foods_fts_ad AFTER DELETE ON nutrition_foods BEGIN
        DELETE FROM nutrition_foods_fts WHERE food_id = old.id;
      END;
    `,
  },
  {
    id: 2,
    name: "profiles, calorie goals and meal slots",
    sql: `
      -- The per-person facts the calorie budget needs. Keyed by household-app's user id; the
      -- display name stays on users. A login without a row here just has no calorie budget yet.
      CREATE TABLE nutrition_profiles (
        user_id     TEXT PRIMARY KEY REFERENCES users(id),
        sex         TEXT NOT NULL CHECK (sex IN ('male', 'female')),
        birth_date  TEXT NOT NULL,
        height_cm   REAL NOT NULL,
        timezone    TEXT NOT NULL,   -- IANA zone; "today" for this person is the date in it
        unit_system TEXT NOT NULL DEFAULT 'imperial' CHECK (unit_system IN ('imperial', 'metric')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      ${trackersOnly("nutrition_profiles")}

      -- The goal in effect on a date is the latest row with effective_from <= date (ties:
      -- highest id), so editing goals never rewrites earlier days. "budget" here is always
      -- the CALORIE budget, never money.
      CREATE TABLE nutrition_goals (
        id                          INTEGER PRIMARY KEY,
        user_id                     TEXT NOT NULL REFERENCES users(id),
        effective_from              TEXT NOT NULL,
        plan_lb_per_week            REAL NOT NULL,  -- positive = lose, negative = gain
        activity_level              TEXT NOT NULL CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'very')),
        pal_override                REAL,
        min_calorie_budget_mode     TEXT NOT NULL DEFAULT 'safe' CHECK (min_calorie_budget_mode IN ('safe', 'low', 'none')),
        calorie_budget_override_kcal REAL,
        macro_mode                  TEXT NOT NULL DEFAULT 'percent' CHECK (macro_mode IN ('percent', 'grams')),
        macro_protein               REAL NOT NULL,
        macro_carbs                 REAL NOT NULL,
        macro_fat                   REAL NOT NULL,
        goal_weight_kg              REAL,
        -- JSON { highDays: number[] (0 = Sunday ... 6 = Saturday), extraKcal: number } or NULL for none.
        -- It lives on the goal row, so it is "effective from" a date like everything else about a goal.
        calorie_schedule            TEXT
      );
      CREATE INDEX nutrition_goals_user_date ON nutrition_goals (user_id, effective_from);
      ${trackersOnly("nutrition_goals")}

      -- Each person's own meals, in their own order. The KEY is what diary entries and saved
      -- meals store, so it never changes; a rename only changes the label.
      CREATE TABLE nutrition_meal_slots (
        id         INTEGER PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id),
        key        TEXT NOT NULL,
        label      TEXT NOT NULL,
        sort       INTEGER NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        -- At most one of the two is set (slots.ts enforces it; SQLite can't add a table CHECK
        -- later): a fixed number of kcal, or a share of that day's calorie budget.
        target_kcal REAL CHECK (target_kcal IS NULL OR target_kcal > 0),
        target_pct  REAL CHECK (target_pct IS NULL OR (target_pct > 0 AND target_pct <= 100)),
        UNIQUE (user_id, key)
      );
      ${trackersOnly("nutrition_meal_slots")}
    `,
  },
  {
    id: 3,
    name: "diary, day logs, weights and exercise",
    sql: `
      -- Part reference, part snapshot: food_id points at the food, but name/unit/
      -- nutrients_total are frozen at log time so correcting a food never rewrites history.
      CREATE TABLE nutrition_diary_entries (
        id              TEXT PRIMARY KEY,   -- a client-supplied id when there is one: replays become no-ops
        user_id         TEXT NOT NULL REFERENCES users(id),
        local_date      TEXT NOT NULL,
        slot_key        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'logged' CHECK (status IN ('logged', 'planned')),
        food_id         TEXT REFERENCES nutrition_foods(id),
        is_quick_add    INTEGER NOT NULL DEFAULT 0,
        name_snapshot   TEXT NOT NULL,
        quantity        REAL NOT NULL,
        unit_snapshot   TEXT NOT NULL,
        grams           REAL,
        nutrients_total TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scan', 'copy', 'plan', 'llm', 'import_loseit', 'quick')),
        import_hash     TEXT UNIQUE,
        -- Entries written together (a saved meal, a copy, later a meal plan) share a
        -- client-supplied group_id, so they can be shown and undone as one.
        group_id        TEXT,
        logged_at       TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX nutrition_diary_user_date ON nutrition_diary_entries (user_id, local_date);
      CREATE INDEX nutrition_diary_group ON nutrition_diary_entries (user_id, group_id) WHERE group_id IS NOT NULL;
      ${trackersOnly("nutrition_diary_entries")}

      -- One row per person per day, made the first time something needs it. The calorie
      -- budget is frozen here for days that have passed, so changing a goal later never
      -- rewrites a day already lived.
      CREATE TABLE nutrition_day_logs (
        user_id                    TEXT NOT NULL REFERENCES users(id),
        local_date                 TEXT NOT NULL,
        done_logging_at            TEXT,
        calorie_budget_kcal_snapshot REAL,
        maintenance_kcal_snapshot  REAL,
        PRIMARY KEY (user_id, local_date)
      );
      ${trackersOnly("nutrition_day_logs")}

      CREATE TABLE nutrition_weights (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        measured_on TEXT NOT NULL,
        weight_kg   REAL NOT NULL,
        source      TEXT NOT NULL DEFAULT 'manual',
        deleted_at  TEXT
      );
      CREATE INDEX nutrition_weights_user_date ON nutrition_weights (user_id, measured_on);
      ${trackersOnly("nutrition_weights")}

      CREATE TABLE nutrition_exercise (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id),
        local_date          TEXT NOT NULL,
        name                TEXT NOT NULL,
        kcal                REAL NOT NULL,
        exclude_from_budget INTEGER NOT NULL DEFAULT 0,   -- 1 = don't add it to the day's CALORIE budget
        source              TEXT NOT NULL DEFAULT 'manual',
        deleted_at          TEXT
      );
      CREATE INDEX nutrition_exercise_user_date ON nutrition_exercise (user_id, local_date);
      ${trackersOnly("nutrition_exercise")}
    `,
  },
  {
    id: 4,
    name: "saved meals",
    sql: `
      -- Named templates of food amounts ("my usual breakfast"). owner_user_id NULL = joint.
      CREATE TABLE nutrition_saved_meals (
        id                 TEXT PRIMARY KEY,
        owner_user_id      TEXT REFERENCES users(id),
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        name               TEXT NOT NULL,
        default_slot_key   TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        deleted_at         TEXT
      );
      CREATE INDEX nutrition_saved_meals_owner ON nutrition_saved_meals (owner_user_id, deleted_at);
      ${trackersOnly("nutrition_saved_meals", "created_by_user_id")}

      -- Items point at foods. Amounts follow the diary write: quantity of a serving, or grams
      -- for a per-100 g food.
      CREATE TABLE nutrition_saved_meal_items (
        id            TEXT PRIMARY KEY,
        saved_meal_id TEXT NOT NULL REFERENCES nutrition_saved_meals(id),
        position      INTEGER NOT NULL,
        food_id       TEXT NOT NULL REFERENCES nutrition_foods(id),
        quantity      REAL NOT NULL CHECK (quantity > 0),
        serving_id    TEXT,
        grams         REAL
      );
      CREATE INDEX nutrition_saved_meal_items_meal ON nutrition_saved_meal_items (saved_meal_id, position);
    `,
  },
  {
    id: 5,
    name: "barcode lookup cache and miss log",
    sql: `
      -- The upstream lookup cascade's memory. Public product data, so one copy for the whole
      -- install. See barcodeCache.ts.
      CREATE TABLE nutrition_barcode_lookups (
        gtin14       TEXT PRIMARY KEY,
        result       TEXT,                -- JSON of the lookup (name, brand, nutrition, serving); NULL for a miss
        source       TEXT,                -- 'off' | 'fdc' | 'upcitemdb'; NULL for a miss
        found        INTEGER NOT NULL,    -- 1 = something answered (TTL 90 days), 0 = a miss (TTL 14 days)
        looked_up_at TEXT NOT NULL,
        tries        INTEGER NOT NULL DEFAULT 1   -- upstream lookups that produced / refreshed this row
      );

      -- Scans that ended without nutrition (nothing knew the code, or only a name). This is
      -- the "data gate": if it stays long, a paid fallback may be worth it. A row counts as
      -- resolved once a food owns the same gtin14 (no flag is stored; the list joins to
      -- nutrition_foods). One list for the household.
      CREATE TABLE nutrition_barcode_misses (
        gtin14        TEXT PRIMARY KEY,
        count         INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        name          TEXT,                -- what a name-only source called it, if any
        brand         TEXT
      );
    `,
  },
  {
    id: 6,
    name: "barcode uniqueness per scope, not household-wide",
    sql: `
      -- Migration 1 made the barcode unique across the whole household. But a personal food is
      -- invisible to the other login: if one spouse had a personal food with code X, the other
      -- could never see it and could never save their own food with X either (the insert hit
      -- the index). A code is now unique within a scope instead:
      --   - one non-deleted joint food per code (the USDA catalogue is owner-less too, and
      --     holds no barcodes), and
      --   - one non-deleted personal food per (owner, code).
      -- A person's personal food and a joint food may therefore both carry X; a scan prefers
      -- the person's own (foodBarcodes.ts findFoodByBarcode). Nobody's personal food can ever
      -- block, or be reached by, another login.
      DROP INDEX nutrition_foods_gtin;
      CREATE UNIQUE INDEX nutrition_foods_gtin_joint ON nutrition_foods (gtin14)
        WHERE gtin14 IS NOT NULL AND deleted_at IS NULL AND owner_user_id IS NULL;
      CREATE UNIQUE INDEX nutrition_foods_gtin_personal ON nutrition_foods (owner_user_id, gtin14)
        WHERE gtin14 IS NOT NULL AND deleted_at IS NULL AND owner_user_id IS NOT NULL;
      -- Looking a code up (any scope) by gtin alone: the joint index covers joint rows only.
      CREATE INDEX nutrition_foods_gtin_any ON nutrition_foods (gtin14)
        WHERE gtin14 IS NOT NULL AND deleted_at IS NULL;
    `,
  },
  {
    id: 7,
    name: "recipe foods: source 'recipe' and a recipe_id column",
    rebuildsTable: true,
    sql: `
      -- A recipe is materialized as a read-only food (merge plan section 3). SQLite cannot widen a
      -- CHECK constraint in place, so nutrition_foods is rebuilt with the procedure from
      -- sqlite.org/lang_altertable.html ("Making Other Kinds Of Table Schema Changes"): create the
      -- new table, copy every row, drop the old one, rename, then recreate each index and trigger.
      -- Foreign keys ARE enforced here, so rebuildsTable makes the runner switch them off first
      -- (the pragma cannot change inside a transaction) and run foreign_key_check before commit;
      -- rows in other tables that name a food keep pointing at the same ids. The migration runs in
      -- the runner's one transaction, so a failure part-way leaves the old table exactly as it was.
      --
      -- nutrition_foods_fts is keyed by the food's TEXT id, not by a rowid of the table being
      -- dropped, so its rows survive untouched. Dropping the old table drops its three triggers
      -- but fires none of them, so nothing is deleted from the index.
      CREATE TABLE nutrition_foods_new (
        id                 TEXT PRIMARY KEY,
        owner_user_id      TEXT REFERENCES users(id),   -- NULL = joint (or the USDA catalogue); a user id = personal
        created_by_user_id TEXT REFERENCES users(id),   -- who typed it in; NULL for the USDA catalogue
        name               TEXT NOT NULL,
        brand              TEXT,
        gtin14             TEXT,
        basis              TEXT NOT NULL CHECK (basis IN ('per100g', 'per_serving')),
        nutrients          TEXT NOT NULL,   -- JSON; per 100 g, or per ONE default serving when basis = per_serving
        source             TEXT NOT NULL CHECK (source IN ('usda_generic', 'off', 'fdc', 'custom', 'import_loseit', 'quick', 'recipe')),
        source_ref         TEXT,
        usage_count        INTEGER NOT NULL DEFAULT 0,
        last_used_at       TEXT,
        created_at         TEXT NOT NULL,
        deleted_at         TEXT,
        recipe_id          TEXT,            -- the household-app recipe this food is the materialized form of (source = 'recipe')
        CHECK (source <> 'usda_generic' OR owner_user_id IS NULL),
        CHECK (recipe_id IS NULL OR source = 'recipe')
      );
      INSERT INTO nutrition_foods_new
        (id, owner_user_id, created_by_user_id, name, brand, gtin14, basis, nutrients, source, source_ref,
         usage_count, last_used_at, created_at, deleted_at, recipe_id)
      SELECT id, owner_user_id, created_by_user_id, name, brand, gtin14, basis, nutrients, source, source_ref,
             usage_count, last_used_at, created_at, deleted_at, NULL
        FROM nutrition_foods;
      DROP TABLE nutrition_foods;
      ALTER TABLE nutrition_foods_new RENAME TO nutrition_foods;

      -- Every index the old table had, exactly as migrations 1 and 6 left them.
      CREATE UNIQUE INDEX nutrition_foods_source_ref ON nutrition_foods (source, source_ref)
        WHERE source_ref IS NOT NULL AND source = 'usda_generic';
      CREATE INDEX nutrition_foods_owner ON nutrition_foods (owner_user_id, deleted_at);
      CREATE UNIQUE INDEX nutrition_foods_gtin_joint ON nutrition_foods (gtin14)
        WHERE gtin14 IS NOT NULL AND deleted_at IS NULL AND owner_user_id IS NULL;
      CREATE UNIQUE INDEX nutrition_foods_gtin_personal ON nutrition_foods (owner_user_id, gtin14)
        WHERE gtin14 IS NOT NULL AND deleted_at IS NULL AND owner_user_id IS NOT NULL;
      CREATE INDEX nutrition_foods_gtin_any ON nutrition_foods (gtin14)
        WHERE gtin14 IS NOT NULL AND deleted_at IS NULL;
      -- New: one live food per recipe.
      CREATE UNIQUE INDEX nutrition_foods_recipe ON nutrition_foods (recipe_id)
        WHERE recipe_id IS NOT NULL AND deleted_at IS NULL;

      -- The three search-index triggers, exactly as migration 1 made them.
      CREATE TRIGGER nutrition_foods_fts_ai AFTER INSERT ON nutrition_foods BEGIN
        INSERT INTO nutrition_foods_fts (name, brand, food_id) VALUES (new.name, COALESCE(new.brand, ''), new.id);
      END;
      CREATE TRIGGER nutrition_foods_fts_au AFTER UPDATE OF name, brand ON nutrition_foods
        WHEN old.name IS NOT new.name OR old.brand IS NOT new.brand BEGIN
        DELETE FROM nutrition_foods_fts WHERE food_id = old.id;
        INSERT INTO nutrition_foods_fts (name, brand, food_id) VALUES (new.name, COALESCE(new.brand, ''), new.id);
      END;
      CREATE TRIGGER nutrition_foods_fts_ad AFTER DELETE ON nutrition_foods BEGIN
        DELETE FROM nutrition_foods_fts WHERE food_id = old.id;
      END;
    `,
  },
  {
    id: 8,
    name: "meal plan link on diary entries, pantry-used mark, snack allowance",
    sql: `
      -- The household meal plan lives in household-app's meal_plans JSON documents (one per week), so a
      -- planned meal has no row to point a foreign key at. The entries a meal makes carry its id instead:
      --   meal_plan_id   the PlannedMeal id (text; nothing to reference). NULL for every entry not made by the plan.
      --   plan_slot_key  the slot the PLAN named when it differs from the one this person has (a custom
      --                  meal they lack falls back to a standard one), so the choice is on record.
      --   pantry_used_at set once "Use from pantry?" has been confirmed for this entry, so a double tap or a
      --                  retried request cannot take the same items out of the pantry twice.
      ALTER TABLE nutrition_diary_entries ADD COLUMN meal_plan_id TEXT;
      ALTER TABLE nutrition_diary_entries ADD COLUMN plan_slot_key TEXT;
      ALTER TABLE nutrition_diary_entries ADD COLUMN pantry_used_at TEXT;
      CREATE INDEX nutrition_diary_meal_plan ON nutrition_diary_entries (meal_plan_id, user_id)
        WHERE meal_plan_id IS NOT NULL;

      -- Per-login nutrition settings that are not part of a calorie goal. A small table of its own rather
      -- than a column on nutrition_profiles: a profile needs sex, birth date and height before it can exist,
      -- but a login can pick a snack allowance first, and later per-login options can join this row.
      -- Absent row = the default (10%). The allowance is a percentage of that person's CALORIE budget that
      -- calorie-aware planning leaves free for snacks (target = calorie budget x (1 - pct / 100)).
      CREATE TABLE nutrition_user_settings (
        user_id             TEXT PRIMARY KEY REFERENCES users(id),
        snack_allowance_pct REAL NOT NULL DEFAULT 10 CHECK (snack_allowance_pct >= 0 AND snack_allowance_pct <= 50),
        updated_at          TEXT NOT NULL
      );
      ${trackersOnly("nutrition_user_settings")}
    `,
  },
  {
    id: 9,
    name: "exercise minutes",
    sql: `
      -- The Food section's Exercise list asks for name, minutes and calories burned. Minutes are for the
      -- person's own reference (they never change the day's CALORIE budget); NULL = not entered, which is
      -- every row that existed before this and anything typed in without a duration.
      ALTER TABLE nutrition_exercise ADD COLUMN minutes REAL;
    `,
  },
  {
    id: 10,
    name: "who can see my food data",
    sql: `
      -- Each diary login decides what the OTHER diary logins can see of THEIR data (merge plan, Phase 5 decisions):
      --   nothing     (the default) nobody else sees anything
      --   totals      the day's calories eaten against the calorie budget (no foods), and the logging streak
      --   everything  also the diary entries, exercise, weigh-ins and steps, read-only
      -- Progress photos are never shared at any level (nutrition_photos is owner-only in every route).
      -- Stored on the per-login settings row (migration 8) so it sits with the snack allowance, is checked by the
      -- same diary-logins-only trigger, and travels in the same daily database copy. Absent row = 'nothing'.
      ALTER TABLE nutrition_user_settings ADD COLUMN visibility TEXT NOT NULL DEFAULT 'nothing'
        CHECK (visibility IN ('nothing', 'totals', 'everything'));
    `,
  },
  {
    id: 11,
    name: "steps typed by hand",
    sql: `
      -- One row per login per local date; typing a date again replaces it. 'source' tells typed rows
      -- ('manual') from rows a later Lose It! import (steps.csv, Date|Value|...) will upsert by date
      -- ('import_loseit'). Steps never change the calorie budget.
      CREATE TABLE nutrition_steps (
        user_id    TEXT NOT NULL REFERENCES users(id),
        local_date TEXT NOT NULL,
        steps      INTEGER NOT NULL CHECK (steps >= 0),
        source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import_loseit')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, local_date)
      );
      ${trackersOnly("nutrition_steps")}
    `,
  },
  {
    id: 12,
    name: "progress photos",
    sql: `
      -- Progress photos: private to the login that took them, never shared at any visibility level. The image
      -- bytes live HERE, as a BLOB, because the household's only backup is the daily copy of this one database
      -- file (db.ts backupIfNeeded): a file saved anywhere else would not be backed up. New photos arrive already
      -- shrunk by the browser (about 1600 px on the long side); imported Lose It! photos (phase 7) are kept as they
      -- were. Deleting a photo sets deleted_at AND empties 'bytes', so a deleted photo no longer takes room.
      CREATE TABLE nutrition_photos (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id),
        taken_on   TEXT NOT NULL,
        mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
        bytes      BLOB NOT NULL,
        width      INTEGER NOT NULL,
        height     INTEGER NOT NULL,
        source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import_loseit')),
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX nutrition_photos_user_date ON nutrition_photos (user_id, taken_on);
      ${trackersOnly("nutrition_photos")}
    `,
  },
  {
    id: 13,
    name: "weight loss start date",
    sql: `
      -- "I started my weight loss on <date>": the day the Weight & progress tab measures "lost so far" from. A
      -- plain local date (YYYY-MM-DD) on the per-login settings row (migration 8), beside the snack allowance and the
      -- visibility level. NULL = not set, which is every login that existed before this: the tab then shows no number,
      -- only a link to set it. Private to the login: nothing in the sharing routes reads it.
      ALTER TABLE nutrition_user_settings ADD COLUMN weight_start_date TEXT
        CHECK (weight_start_date IS NULL OR weight_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
    `,
  },
  {
    id: 14,
    name: "recipe photos and per-person recipe marks",
    sql: `
      -- One photo per recipe, kept in the database file (the household's only backup is the daily copy of that file).
      -- Never inside the recipe's JSON document: every plan load sends every recipe, and the assistant reads them.
      -- The browser shrinks it to about 800 px before upload (routes/mealplan.ts caps it at 1 MB). Who may see it is
      -- whoever may see the recipe: there is deliberately no owner column here.
      CREATE TABLE nutrition_recipe_photos (
        recipe_id  TEXT PRIMARY KEY,
        mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
        bytes      BLOB NOT NULL,
        width      INTEGER NOT NULL,
        height     INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- A login's own favourite star and 1-5 rating for a recipe. Per person, never shared: a login reads and writes
      -- only its own rows. No rows for the kiosk. A recipe with neither set has no row.
      CREATE TABLE nutrition_recipe_marks (
        recipe_id  TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        favorite   INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
        rating     INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (recipe_id, user_id)
      );
      CREATE INDEX nutrition_recipe_marks_user ON nutrition_recipe_marks (user_id);
    `,
  },
];

/**
 * Create the nutrition tables, or bring them up to date. Idempotent: a migration that is
 * already recorded in nutrition_schema_migrations is skipped, so running this on every boot
 * (db.ts does) does nothing after the first. Returns the ids applied by THIS call.
 *
 * A database that records a migration this build doesn't know (restored from a newer
 * checkout) is left alone rather than refused: the extra tables are harmless to older code,
 * and refusing to boot the live app over them would be worse.
 */
export function runNutritionMigrations(db: Db, migrations: NutritionMigration[] = NUTRITION_MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS nutrition_schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(all<{ id: number }>(db, "SELECT id FROM nutrition_schema_migrations").map((r) => r.id));
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    const fkWasOn = get<{ foreign_keys: number }>(db, "PRAGMA foreign_keys")?.foreign_keys === 1;
    const switchOff = m.rebuildsTable === true && fkWasOn && !db.isTransaction;
    if (switchOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      tx(db, () => {
        const violationsBefore = m.rebuildsTable ? all(db, "PRAGMA foreign_key_check").length : 0;
        db.exec(m.sql);
        if (m.rebuildsTable && all(db, "PRAGMA foreign_key_check").length > violationsBefore) {
          throw new Error(`nutrition migration ${m.id} left foreign key violations; rolled back`);
        }
        run(db, "INSERT INTO nutrition_schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", m.id, m.name, new Date().toISOString());
      });
    } finally {
      if (switchOff) db.exec("PRAGMA foreign_keys = ON");
    }
    ran.push(m.id);
  }
  return ran;
}

/** Highest migration this database has recorded (0 for none). For tests and diagnostics. */
export function nutritionSchemaVersion(db: Db): number {
  return get<{ v: number | null }>(db, "SELECT MAX(id) AS v FROM nutrition_schema_migrations")?.v ?? 0;
}
