# Tool modules — the contract

Every file in this folder is one **domain module**: a group of assistant tools that
belong to the same section of the app. `../registry.ts` is the only place that knows
the full set. Adding a tool means editing one file in here and nothing else — that is
the whole point of the split, and it's expected to hold for months.

## Adding a tool

1. Add the definition to the domain module it belongs to, inside the array its
   `*Tools(userId)` function returns.
2. Set `mutates: true` if running it changes data. Leave it off if it only reads.
3. That's it. The registry stamps `domain` and `sensitivity` from the module, the
   system prompt's section list is generated, and the client learns about the new
   tool through `GET /api/assistant/tools`.

## Adding a domain

Create the file, export a `ToolModule`, and add it to `TOOL_MODULES` in
`../registry.ts`. Pick `label` as the model should say it out loud ("the pantry"),
because that string lands verbatim in the system prompt.

`build(userId, unlocked, ctx)`'s second argument mirrors `auth.ts`'s `isUnlocked` for the
household PIN lock (the same one that gates Budget) — `true` unless the caller is
mid-request with a locked session. Almost every module ignores it; `chores.ts` is the one
that reads it, refusing a create/edit/delete-shaped tool call with a plain "Enter the parent
PIN in the app first." while locked, the same way `routes/chores.ts` refuses the matching
HTTP route. Default it to `true` (or just omit the parameter) unless your module has its own
PIN-gated mutation.

`ctx` (`ToolContext` in `../registry.ts`) carries the rest of the request. `calories.ts` reads the login's role, whether it came with a
Wear OS device token, whether the person's own food-diary PIN lock is engaged and the clock seam; the modules with a bulk delete
(`calendar.ts`, `chores.ts`, `grocery.ts`) read `turnId` and the clock for the confirmation step (see "Bulk deletes need
confirmation" below). Everyone else ignores it.

## The three metadata fields

| Field | Who reads it |
|---|---|
| `mutates` | The client, to know when a section's data needs re-reading. **Single source of truth** — there is no second list anywhere. (A general Stage 6 "confirm every write" flow is still not built; the only confirmation that exists is the one for bulk deletes below, which is wired per tool, not read from this flag.) |
| `domain` | **Presentation and grouping only**: the generated prompt section list, and grouping in the UI. Never read it for a security or privacy decision. |
| `sensitivity` | **The single field every privacy and safety decision reads** — Stage 2 provider routing (financial tools stay on Ollama unless an admin opts a cloud provider in via `assistant.allowCloudFinance.<provider>`; `health` tools — the food diary, calories, calorie budgets, weight — the same way via an independent `assistant.allowCloudHealth.<provider>`), and, when they are built, Stage 6 `money_only` confirmation and Stage 6.5 child-account gating (neither exists yet). Keyed off this and nothing else. |

`sensitivity` is deliberately separate from `domain`: a future tool could be financial
without living in the budget section, and a boundary that depends on a string chosen
for UI grouping is one that will eventually be crossed by accident. Because it's set
per-module and stamped by the registry, auditing it is reading one column —
`TOOL_MODULES` in `../registry.ts`.

## Rules that don't bend

- **Never rename an existing tool, its description, or its parameter schema.** The
  prompt behaviour that works today is tuned to those exact strings.
- Tools are built per-request with the signed-in user bound in. Every read goes
  through the same personal/joint scoping the UI uses, so the assistant can never
  see more than the person talking to it can. Keep new tools `userId`-scoped.
- Share **code**, never a network hop. Each app holds its own DB handle; a module
  here must not reach its own data over HTTP.

- **`health` tools** (`calories.ts`) are about a *person*: what they ate, their calorie budget, weight, steps, goals. A recipe's
  calories, the meal plan and the food catalogue are `household`. Every health tool, description and parameter says "calorie"
  next to any use of "budget" (the money budget tools are `financial`); `tests/assistantCalorieTools.test.ts` enforces it.
- **The assistant never logs for a normal login.** Its only diary write is `add_planned_calorie_diary_entries` (planned entries the
  person confirms). The kiosk login alone may mark a planned *meal-plan* entry eaten, and only if the admin allows it.

## Bulk deletes need confirmation

A tool that removes MANY things at once (`delete_all_calendar_events`, `delete_all_chores`, `clear_shopping_list`) must not
delete on the first call. Models reach for a bulk tool on a vague complaint ("the calendar is a mess") or the wrong one for the
job (clearing a shopping list by wiping the chores), and a prompt rule alone cannot stop that. The guarantee is in the server,
in `../confirmations.ts`:

1. The first call (no `confirmation`) deletes nothing. It returns `{ needsConfirmation: true, summary, confirmation, instruction }`:
   a concrete summary computed at that moment ("This will delete 6 calendar events from 2026-10-19 to 2026-11-02 ...") and a
   one-time token.
2. The model tells the person exactly what would go and asks.
3. Only a **later chat request** can finish it. The model calls the tool again with the same arguments and the token. It is
   accepted only for the same person, the same tool, the same arguments *and the same set of things to delete*, within 10
   minutes, and when the token was issued by a different `ctx.turnId` than the one now running. Then the delete runs and the
   token is spent. Any mismatch deletes nothing and returns an `error` plus a fresh request.

What the server can promise is that a separate message from the person came in between; it cannot read whether that message
was a "yes". That is what the tool description and the module's `promptRules` line are for.

`turnId` is one value per `POST /api/assistant/chat` (made in `server.ts`, passed through `planTurn` into `ToolContext`).
`buildTools` makes up a fresh one when the caller gives none, so a script or test that builds tools twice has two turns and can
request through the first set and redeem through the second; pass `ctx.turnId` explicitly to pin it. Pending confirmations are in
memory: a restart just means the person is asked again. Tests reset them with `clearConfirmations()` and inspect them with
`pendingConfirmations()`; `ctx.now` is the clock for expiry.

Adding it to a new bulk-delete tool:

1. Take `ctx` as the third parameter of your module's build function and add an optional `confirmation` string parameter to the
   tool (appending one sentence to the description saying the first call deletes nothing).
2. After your own checks (a PIN lock comes first -- a locked session is refused, not asked) work out what would be deleted. If
   it is nothing, return without confirming.
3. Call `gateBulkDelete({ userId, tool, args, confirmation, scopeIds, summary, ctx })`. `args` are the values that define the scope,
   `scopeIds` the ids that would be removed, `summary` the sentence the person will be told. If it returns something, return that
   to the model unchanged; if it returns `null`, delete.
4. Add a line to the module's `promptRules`: the bulk delete needs the person's yes in a separate message, and the confirmation is
   never passed in the same reply that asked for it.

Single-item deletes stay immediate.
