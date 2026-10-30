# Hestia

Hestia is a self-hosted web app that runs a whole household from one place: money,
groceries, the pantry, recipes and meal planning, calorie diaries, chores, a shared
calendar, the smart fridge, and an AI assistant that can read and act across all of it.
Everything lives on a PC in your home. The assistant uses a local model by default, so
your data stays in the house unless you choose otherwise.

It was built for one family and is shared as-is. It is not a hardened multi-tenant
service, so read the [security notes](#security-notes) before exposing it to the internet.

**Stack:** Node, Express and SQLite on the server; React, Vite and Tailwind on the client;
a small Wear OS companion app in `wearos-app/`.

## What it can do

### Budget
- Connects to your bank through **Plaid** and pulls in transactions, balances and credit
  cards.
- Budgets by category per pay period, with income, goals and alerts.
- Joint and personal budgets side by side, so each adult can have their own.
- Import and export transactions as CSV.
- Plaid access tokens are encrypted at rest and never sent to the browser.

### Groceries
- Shared shopping lists, with joint and personal lists.
- **Send to Kroger:** matches list items to Kroger products and fills your Kroger cart. It
  can never check out or spend money, only add to the cart.
- Calories shown on products and list items as clearly labelled model estimates.

### Pantry
- Track what you have, with quantities and expiration dates.
- **Barcode scan in and out** with a USB or Bluetooth scanner, or a phone or tablet camera.
  Barcodes resolve through Open Food Facts, USDA FoodData Central and UPCitemdb, and the
  answers are cached.
- **Camera scan:** point a camera at a shelf and get suggested items back.
- Pantry stock feeds the meal plan and the grocery list.

### Recipes
- Import a recipe four ways: type it, paste text, upload CSV or JSON, or fetch it from a
  web page's schema.org data. Everything except typing shows a preview you confirm first.
- Search, sort, tags, favourites, ratings, notes, prep and cook times, and one photo each.
  Favourites and ratings are per person.
- A recipe viewer that scales amounts to any number of servings, and **Cook mode** that
  shows one large step at a time.
- Calories are worked out from linked foods, with a one-tap "Improve calories" pass.
- Editing a recipe updates this week's and later planned meals automatically.
- The URL import is hardened against server-side request forgery. It refuses private,
  loopback and link-local addresses, re-checks every redirect, and caps size and time.

### Meal planning
- A weekly plan with breakfast, lunch, dinner and snacks, for the whole family or for
  individuals.
- Likes and dislikes per family member, and a way to deny a meal and get a replacement
  suggested.
- Missing-ingredients list that compares the plan against the pantry and builds the
  grocery list.
- Approving a meal puts planned entries into each person's food diary.

### Calorie and nutrition diaries
- A food diary per person, with a daily calorie budget, weigh-ins and progress.
- Food search backed by a local USDA generic-food catalogue, barcode scanning, and your own
  saved foods.
- Optional PIN on the diary, and per-person sharing controls for what others can see.
- Import from a Lose It! export.
- "Calorie budget" always means calories here, never the money budget.

### Chores and rewards
- Chores with recurrence, assignees, and a kid-friendly view.
- Points and rewards, with a shared "Manage" area locked behind the household PIN.

### Calendar
- A shared household calendar with joint and personal events, including recurring ones and
  meal-slot events.

### Family
- The household roster: who lives here, their preferences, and which login each person is
  linked to.

### Smart fridge
- Samsung SmartThings panel with status, temperatures, ice boost and a camera snapshot.

### The AI assistant
- A chat panel where the model calls about 55 tools across groceries, pantry, family,
  meal plan, recipes, calendar, chores, budget, fridge and calories.
- Runs on **Ollama** locally and always has that as its fallback. **Anthropic** and
  **Gemini** are optional and appear in a picker only when their keys are set.
- **Money questions never go to a cloud model by default.** Financial turns are routed to
  the local model, and financial tools are not even offered to cloud providers. An admin can
  opt each provider in separately, behind a password check.
- Destructive requests such as clearing a whole list need a "yes" in a later message.
- **Voice input** through a local whisper.cpp server: the audio stays in the house and is
  never logged. Replies can be read aloud.
- A built-in evaluation harness (`npm run eval`) scores models on realistic household tasks.

### Kiosk and devices
- A **kiosk login** for a wall tablet or fridge screen, with a read-mostly view and the
  ability to log meals.
- **Wear OS companion:** ask the assistant by voice and see today's calendar on a watch,
  using a revocable device token instead of a password.

### Accounts and security
- Three account tiers: admin, parent and kiosk, with at most six logins.
- Sign-in, registration and PIN unlock are rate limited, and a password change signs out
  other sessions and revokes device tokens.
- Security headers on every response, a security event log, and encrypted-at-rest secrets
  with a key-rotation script.

## Running it

```bash
npm install
cp .env.example .env.local   # then fill in what you want to use; everything is optional
npm run dev                  # http://localhost:3200
```

The assistant needs [Ollama](https://ollama.com) running locally (`ollama pull llama3.1`,
or any model named in `.env.local`). The rest of the app works without it. Windows helper
scripts for starting, stopping and supervising the server are in `scripts/`.

## Tests

```bash
npm test      # the full suite
npm run lint  # type check
```

## Configuration and secrets

All configuration is environment variables, documented in `.env.example`. Never commit
`.env.local`; it is git-ignored. You supply your own keys for Plaid, Kroger, SmartThings,
USDA FoodData Central and the optional cloud assistants. `DB_ENCRYPTION_KEY` encrypts
stored secrets, and `scripts/rotate-encryption-key.ts` rotates it.

## Security notes

- If you expose the app publicly, put an access layer such as Cloudflare Access or a
  VPN/Tailscale in front of it.
- Treat the SQLite database and `.env.local` as secrets. Back them up somewhere private.
- Report vulnerabilities privately through GitHub's "Report a vulnerability" button.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0):
free for personal, educational and other non-commercial use. Commercial use needs a
separate license from the copyright holder. See `LICENSE`.
