// Household-chores tools (Stage 10.3, PLAN.md). Chores render alongside
// calendar events in the UI rather than as their own screen, but "who's
// assigned what, and is it done" is a different question from "what's on
// when," so it's a separate tool domain. See ./README.md for the contract
// every domain module follows.

import type { DomainTool, ToolContext, ToolModule } from "../registry.ts";
import { listMembers, isParentMember } from "../../routes/members.ts";
import { listChores, saveChore, setChoreOccurrenceStatus, pointsByMember, getChore, deleteChoreRow } from "../../routes/chores.ts";
import { findByName, closestNames, notFound, toWeekdayCodes } from "./shared.ts";
import { gateBulkDelete } from "../confirmations.ts";

// Same wording everywhere a chore-management tool refuses for lack of a PIN --
// one string to keep in sync rather than four slightly different ones.
const LOCKED_ERROR = "Enter the parent PIN in the app first.";

function choreTools(userId: string, unlocked = true, ctx: ToolContext = {}): DomainTool[] {
  return [
    {
      name: "list_chores",
      description: "The household's chores -- who's assigned what, when it's due, and whether it's done.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Earliest due date to include, YYYY-MM-DD. Optional." },
          to: { type: "string", description: "Latest due date to include, YYYY-MM-DD. Optional." },
        },
      },
      run: async ({ from, to }) => {
        const members = listMembers(userId);
        return listChores(
          userId,
          typeof from === "string" ? from : undefined,
          typeof to === "string" ? to : undefined
        ).map((c) => ({
          date: c.date,
          title: c.title,
          member: c.memberId ? members.find((m) => m.id === c.memberId)?.name || c.memberId : undefined,
          status: c.status,
        }));
      },
    },

    {
      name: "create_chore",
      mutates: true,
      description:
        'Assign a chore, e.g. "Sam takes out the trash" or "empty the dishwasher tonight". Pass ' +
        "days (and optionally until) for something that repeats weekly, e.g. every Tuesday -- that " +
        "stores one real recurring rule rather than one row per occurrence, the same way " +
        "create_recurring_event works for the calendar. Leave member unset for a family/unassigned " +
        "chore anyone can do.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: 'The chore, e.g. "Take out the trash".' },
          dueDate: { type: "string", description: "The date it's due, or the first date if it repeats, YYYY-MM-DD." },
          member: { type: "string", description: "Who it's assigned to, by name. Omit for a family/unassigned chore." },
          days: {
            type: "array",
            items: { type: "string" },
            description: 'Weekdays it repeats on, e.g. ["tuesday"]. Omit for a one-time chore.',
          },
          until: { type: "string", description: "Last date it repeats, YYYY-MM-DD. Optional -- omit for no end date." },
          time: { type: "string", description: 'A specific time, "HH:MM" 24-hour. Optional.' },
        },
        required: ["title", "dueDate"],
      },
      run: async ({ title, dueDate, member, days, until, time }) => {
        // Assigning a chore is a parent action -- gated behind the same
        // household PIN as the Chores tab's Manage area and POST
        // /api/chores itself (routes/chores.ts). A device token (the watch)
        // is never unlocked in the first place, so it lands here too.
        if (!unlocked) return { error: LOCKED_ERROR };

        const cleanTitle = String(title || "").trim();
        if (!cleanTitle) return { error: "title is required." };

        const cleanDate = String(dueDate || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) return { error: "dueDate must be a date like 2026-08-24." };

        let memberId: string | undefined;
        if (member) {
          const members = listMembers(userId);
          const found = findByName(members, String(member));
          if (!found) return notFound("family member", String(member), closestNames(members, String(member)));
          memberId = found.id;
        }

        const byDay = toWeekdayCodes(days);
        const cleanUntil = typeof until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : undefined;
        if (cleanUntil && cleanUntil < cleanDate) return { error: "until cannot be before dueDate." };

        const chore = saveChore(userId, {
          title: cleanTitle,
          date: cleanDate,
          memberId,
          time,
          recurrence: byDay.length > 0 ? { freq: "weekly", byDay, until: cleanUntil } : undefined,
        });
        return { title: chore.title, date: chore.date, member: chore.memberId, recurring: !!chore.recurrence };
      },
    },

    {
      name: "complete_chore",
      mutates: true,
      description: "Mark a chore done. Match by title, and by date if given, to tell which one.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The chore's title, or enough of it to identify it." },
          date: { type: "string", description: "The chore's due date, YYYY-MM-DD. Optional if the title alone is enough." },
        },
        required: ["title"],
      },
      run: async ({ title, date }) => {
        const needle = String(title || "").trim().toLowerCase();
        const onDate = typeof date === "string" ? date : undefined;
        const matches = listChores(userId, onDate, onDate).filter((c) => c.title.toLowerCase().includes(needle));
        const match = matches.find((c) => c.status === "pending") || matches[0];
        if (!match) return { error: `No chore matching "${title}"${onDate ? ` on ${onDate}` : ""}.` };

        // Completing a chore is open to everyone, parent or kid, with no PIN
        // -- same as PUT /api/chores/:id's status-only branch. Only
        // create/delete_chore below stay gated.

        // match.id is occurrence-shaped ("<seriesId>::<date>") for a
        // recurring chore, or the bare series id for a one-off (see
        // listChores/expandOccurrences) -- setChoreOccurrenceStatus
        // dispatches on that shape, so this only ever completes the one
        // occurrence the user meant, not the whole series (Stage 10.3 fix,
        // PLAN.md).
        const result = setChoreOccurrenceStatus(userId, match.id, "done", userId);
        if ("error" in result) return { error: result.error };
        return { title: result.chore.title, date: result.chore.date, status: result.chore.status };
      },
    },

    {
      name: "delete_chore",
      mutates: true,
      description:
        "Remove one specific chore, e.g. because it was assigned by mistake. Match by title and date. " +
        'For "clear all the chores" requests, use delete_all_chores instead -- don\'t guess at a ' +
        "date or title to match everything.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The chore's title, or enough of it to identify it." },
          date: { type: "string", description: "The chore's due date, YYYY-MM-DD." },
        },
        required: ["title", "date"],
      },
      run: async ({ title, date }) => {
        if (!unlocked) return { error: LOCKED_ERROR };
        const needle = String(title || "").trim().toLowerCase();
        const found = listChores(userId, String(date), String(date)).find((c) => c.title.toLowerCase().includes(needle));
        if (!found) return { error: `No chore on ${date} matching "${title}".` };
        // Bug fix: go through deleteChoreRow (not a bare deleteScopedItem) so
        // any stars already approved on this series survive the delete --
        // see its comment in routes/chores.ts.
        const master = getChore(userId, found.seriesId);
        if (master) deleteChoreRow(userId, master);
        return found.seriesId === found.id
          ? { deleted: found.title, date: found.date }
          : {
              deleted: found.title,
              date: found.date,
              note: "This was part of a recurring series -- the entire series was removed, not just this date.",
            };
      },
    },

    {
      name: "delete_all_chores",
      mutates: true,
      description:
        'Remove chores in bulk -- everything, or everything in a date range. Use this for "clear all ' +
        'the chores" or "remove everything due this week" -- don\'t loop delete_chore or guess at ' +
        "matching every title. The first call deletes nothing and returns a confirmation to ask the person " +
        "about; pass it back only after they say yes in their next message.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Earliest due date to clear, YYYY-MM-DD. Omit to clear from the beginning." },
          to: { type: "string", description: "Latest due date to clear, YYYY-MM-DD. Omit to clear through the end." },
          confirmation: {
            type: "string",
            description: "The confirmation returned by the first call. Only pass it after the person has said yes in a new message.",
          },
        },
      },
      run: async ({ from, to, confirmation }) => {
        // The PIN lock comes first: a locked session is refused outright and is never even asked to confirm.
        if (!unlocked) return { error: LOCKED_ERROR };
        const chores = listChores(userId, typeof from === "string" ? from : undefined, typeof to === "string" ? to : undefined);
        const seriesIds = [...new Set(chores.map((c) => c.seriesId))];
        if (seriesIds.length === 0) return { deletedCount: 0 };

        // Bulk delete: nothing goes until the person has answered a question about exactly this set (see ../confirmations.ts).
        const dates = chores.map((c) => c.date).sort();
        const range = dates[0] === dates[dates.length - 1] ? `due ${dates[0]}` : `due ${dates[0]} to ${dates[dates.length - 1]}`;
        const titles = [...new Set(chores.map((c) => c.title))];
        const shown = titles.slice(0, 6).join(", ") + (titles.length > 6 ? `, and ${titles.length - 6} more` : "");
        const recurring = chores.some((c) => c.seriesId !== c.id);
        const gate = gateBulkDelete({
          userId,
          tool: "delete_all_chores",
          args: { from, to },
          scopeIds: seriesIds,
          summary:
            `This will delete ${seriesIds.length} chore${seriesIds.length === 1 ? "" : "s"} ${range} (${shown}).` +
            (recurring ? " Repeating chores are removed in full, including dates outside that range." : ""),
          ctx,
          confirmation,
        });
        if (gate) return gate;

        // deleteChoreRow, not a bare deleteScopedItem -- same reason as
        // delete_chore above.
        for (const id of seriesIds) {
          const master = getChore(userId, id);
          if (master) deleteChoreRow(userId, master);
        }
        return chores.some((c) => c.seriesId !== c.id)
          ? {
              deletedCount: seriesIds.length,
              note: "Any recurring series in range were removed in full, not just the occurrences that fell in range.",
            }
          : { deletedCount: seriesIds.length };
      },
    },

    {
      name: "get_chore_points",
      description:
        "Each household member's points balance from completed chores (Stage 10.4, PLAN.md) -- " +
        "points only, no money. Use this for \"how many points does Sam have\" or \"who's earned " +
        "the most chore points\".",
      parameters: { type: "object", properties: {} },
      run: async () => {
        // Stage 6.5: points only count once a parent approves a completion --
        // ticking a chore off puts it in `waitingCount`, not `earned`, until
        // then (see pointsByMember). Parent-role members are left out of the
        // list entirely, same as pointsByMember itself: parents track their
        // own chores without stars, so they never have a points balance.
        const members = listMembers(userId).filter((m) => !isParentMember(m));
        const points = pointsByMember(userId);
        return members.map((m) => ({
          member: m.name,
          earned: points[m.id]?.earned ?? 0,
          completedCount: points[m.id]?.completedCount ?? 0,
          waitingCount: points[m.id]?.waitingCount ?? 0,
        }));
        // pointsByMember's "family" bucket (unassigned chores) is
        // deliberately left out -- it's not redeemable by any one person, so
        // it isn't a "balance" this tool's callers would expect to see mixed
        // in with real members (see FAMILY_POINTS_BUCKET's comment in
        // routes/chores.ts).
      },
    },
  ];
}

export const choresModule: ToolModule = {
  domain: "chores",
  sensitivity: "household",
  label: "the household chore list",
  promptRules: [
    "If the user assigns a chore (\"Sam takes out the trash on Tuesdays\", \"someone needs to " +
      "empty the dishwasher tonight\"), call create_chore rather than just noting it in " +
      "conversation, so it shows up on the calendar. Use create_chore's days/until fields for " +
      "anything that repeats weekly, the same way create_recurring_event works for calendar " +
      "events. Call complete_chore when the user says something got done. If they want chores " +
      "cleared out, use delete_chore or delete_all_chores -- never guess at a title/date to " +
      "match everything. delete_all_chores is a bulk delete: its first call deletes nothing and " +
      "returns a confirmation. Tell the person exactly what would be deleted and wait for their yes " +
      "in a separate message; never pass the confirmation in the same reply you asked for it. Only call it when " +
      "the person clearly asks for chores to be cleared; a thought out loud is not a request.",
  ],
  build: choreTools,
};
