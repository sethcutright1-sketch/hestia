// Household-calendar tools. See ./README.md for the contract every domain module follows.

import type { DomainTool, ToolContext, ToolModule } from "../registry.ts";
import { deleteScopedItem } from "../../db.ts";
import { listMembers, type HouseholdMember } from "../../routes/members.ts";
import { listEvents, saveEvent } from "../../routes/calendar.ts";
import { findByName, closestNames, notFound, toWeekdayCodes, type ToolError } from "./shared.ts";
import { gateBulkDelete } from "../confirmations.ts";
import { serverToday } from "../../nutrition/dates.ts";

function calendarTools(userId: string, _unlocked = true, ctx: ToolContext = {}): DomainTool[] {
  // Shared by create_calendar_event and create_recurring_event: "family" is a
  // single undefined target, "individual" resolves one member per requested
  // name (erroring on the first name that doesn't match a real member).
  //
  // Naming people IS the signal that the event is theirs: models send {"members":["Sam"],"title":"Soccer"} and leave
  // audience out, and that used to save a family event with Sam silently dropped. So members with no audience at all
  // means "individual". An explicit non-individual audience is still respected (the person or model said family on
  // purpose), but the result carries a `note` saying the names were not used, so the model can tell the person
  // instead of claiming Sam's event was saved.
  function resolveTargets(
    audience: unknown,
    members: unknown
  ): { targets: (HouseholdMember | undefined)[]; note?: string } | { error: ToolError } {
    const requestedNames = (Array.isArray(members) ? members : members ? [members] : []).filter(
      (n) => String(n ?? "").trim() !== ""
    );
    const audienceText = String(audience || "").trim().toLowerCase();
    const wantsIndividual = audienceText === "individual" || (audienceText === "" && requestedNames.length > 0);
    if (!wantsIndividual) {
      return requestedNames.length > 0
        ? {
            targets: [undefined],
            note: `Saved as a family event because audience was "${audienceText}"; members (${requestedNames.join(", ")}) was ignored. To make it that person's own event, call again with audience "individual" (or leave audience out).`,
          }
        : { targets: [undefined] };
    }

    if (requestedNames.length === 0) return { error: { error: "members is required when audience is individual." } };

    const allMembers = listMembers(userId);
    const matched = requestedNames.map((n) => findByName(allMembers, String(n)));
    const missingIndex = matched.findIndex((m) => !m);
    if (missingIndex !== -1) {
      return { error: notFound("family member", requestedNames[missingIndex], closestNames(allMembers, requestedNames[missingIndex])) };
    }
    return { targets: matched as HouseholdMember[] };
  }

  return [
    {
      name: "list_calendar_events",
      description:
        "The household's calendar events, so you can tell whether a meal should be planned for " +
        "the whole family or just one person. Call this before create_meal_plan.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Earliest date to include, YYYY-MM-DD. Optional." },
          to: { type: "string", description: "Latest date to include, YYYY-MM-DD. Optional." },
        },
      },
      run: async ({ from, to }) => {
        const members = listMembers(userId);
        return listEvents(
          userId,
          typeof from === "string" ? from : undefined,
          typeof to === "string" ? to : undefined
        ).map((e) => ({
          date: e.date,
          title: e.title,
          audience: e.audience,
          member: e.memberId ? members.find((m) => m.id === e.memberId)?.name || e.memberId : undefined,
          mealSlot: e.mealSlot,
        }));
      },
    },

    {
      name: "create_calendar_event",
      mutates: true,
      description:
        "Record something on the household calendar, e.g. a member being away at a mealtime. " +
        "Pass multiple dates to record the same thing on each one -- for a recurring schedule like " +
        '"school Monday through Friday", pass one date per weekday it applies to rather than calling ' +
        "this once per day. If it's about more than one person (e.g. two kids both at school), pass " +
        "all of their names in members -- this creates one event per person so each is tracked " +
        "individually, rather than one vague event with nobody attached. Call list_calendar_events " +
        "afterward before planning meals around it.",
      parameters: {
        type: "object",
        properties: {
          dates: {
            type: "array",
            items: { type: "string" },
            description: "One or more dates, each YYYY-MM-DD.",
          },
          title: { type: "string", description: 'What it is, e.g. "At school, no lunch needed".' },
          audience: {
            type: "string",
            description: '"individual" if this is about one or more specific people, otherwise "family". Defaults to family.',
          },
          members: {
            type: "array",
            items: { type: "string" },
            description: 'Everyone this applies to, by name. Required when audience is "individual" -- one entry per person, even if just one. Naming people makes it their event.',
          },
          mealSlot: { type: "string", description: "breakfast, lunch or dinner, if this affects one mealtime. Optional." },
        },
        required: ["dates", "title"],
      },
      run: async ({ dates, title, audience, members, mealSlot }) => {
        const cleanTitle = String(title || "").trim();
        if (!cleanTitle) return { error: "title is required." };

        const cleanDates = (Array.isArray(dates) ? dates : [dates])
          .map((d: unknown) => String(d).trim())
          .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));
        if (cleanDates.length === 0) return { error: "At least one date like 2026-08-24 is required." };

        const resolved = resolveTargets(audience, members);
        if ("error" in resolved) return resolved.error;

        const created = cleanDates.flatMap((date) =>
          resolved.targets.map((m) =>
            saveEvent(userId, {
              date,
              title: cleanTitle,
              audience: m ? "individual" : "family",
              memberId: m?.id,
              mealSlot,
            })
          )
        );
        return {
          created: created.map((e) => ({ date: e.date, title: e.title, member: e.memberId })),
          ...(resolved.note ? { note: resolved.note } : {}),
        };
      },
    },

    {
      name: "create_recurring_event",
      mutates: true,
      description:
        "Record a schedule that repeats every week, e.g. school Monday through Friday or a " +
        "standing Tuesday practice. Stores one real recurring rule instead of one row per " +
        "occurrence -- prefer this over create_calendar_event whenever the thing repeats weekly. " +
        "If it's about more than one person, pass all their names in members, same as " +
        "create_calendar_event. Call list_calendar_events afterward before planning meals around it.",
      parameters: {
        type: "object",
        properties: {
          startDate: { type: "string", description: "The first date it applies, YYYY-MM-DD." },
          days: {
            type: "array",
            items: { type: "string" },
            description: 'Weekdays it repeats on, e.g. ["monday","tuesday","wednesday","thursday","friday"].',
          },
          until: { type: "string", description: "Last date it applies, YYYY-MM-DD. Optional -- omit for no end date." },
          title: { type: "string", description: 'What it is, e.g. "At school, no lunch needed".' },
          audience: {
            type: "string",
            description: '"individual" if this is about one or more specific people, otherwise "family". Defaults to family.',
          },
          members: {
            type: "array",
            items: { type: "string" },
            description: 'Everyone this applies to, by name. Required when audience is "individual". Naming people makes it their event.',
          },
          mealSlot: { type: "string", description: "breakfast, lunch or dinner, if this affects one mealtime. Optional." },
          time: { type: "string", description: 'Start time, "HH:MM" 24-hour. Optional -- omit for an all-day item.' },
        },
        required: ["startDate", "days", "title"],
      },
      run: async ({ startDate, days, until, title, audience, members, mealSlot, time }) => {
        const cleanTitle = String(title || "").trim();
        if (!cleanTitle) return { error: "title is required." };

        let cleanStart = String(startDate || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStart)) return { error: "startDate must be a date like 2026-08-24." };

        const byDay = toWeekdayCodes(days);
        if (byDay.length === 0) return { error: "days must include at least one real weekday." };

        const cleanUntil = typeof until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : undefined;
        if (cleanUntil && cleanUntil < cleanStart) return { error: "until cannot be before startDate." };

        // "Every Thursday" is about the future, but a model on a Sunday sent last Thursday as the start (the series
        // then begins in the past). Clamp a past start to today and say so; the weekdays still decide the occurrences.
        let startNote: string | undefined;
        const today = serverToday();
        if (cleanStart < today) {
          startNote = `startDate ${cleanStart} was in the past, so the series starts today (${today}) instead. Tell the person if they meant an earlier start.`;
          cleanStart = today;
        }
        if (cleanUntil && cleanUntil < cleanStart) return { error: `That series ended on ${cleanUntil}, before today (${today}), so nothing was created.` };

        const resolved = resolveTargets(audience, members);
        if ("error" in resolved) return resolved.error;

        const created = resolved.targets.map((m) =>
          saveEvent(userId, {
            date: cleanStart,
            title: cleanTitle,
            audience: m ? "individual" : "family",
            memberId: m?.id,
            mealSlot,
            time,
            recurrence: { freq: "weekly", byDay, until: cleanUntil },
          })
        );
        return {
          created: created.map((e) => ({ startDate: e.date, title: e.title, member: e.memberId, days: byDay, until: cleanUntil })),
          ...(resolved.note || startNote ? { note: [resolved.note, startNote].filter(Boolean).join(" ") } : {}),
        };
      },
    },

    {
      name: "delete_calendar_event",
      mutates: true,
      description:
        "Remove one specific calendar event, e.g. because a schedule changed. Match by date and " +
        "title. For \"clear the calendar\" / \"remove everything\" requests, use " +
        "delete_all_calendar_events instead -- don't guess at a date or title to match everything.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "The event's date, YYYY-MM-DD." },
          title: { type: "string", description: "The event's title, or enough of it to identify it." },
        },
        required: ["date", "title"],
      },
      run: async ({ date, title }) => {
        const needle = String(title || "").trim().toLowerCase();
        const found = listEvents(userId, String(date), String(date)).find((e) =>
          e.title.toLowerCase().includes(needle)
        );
        if (!found) return { error: `No event on ${date} matching "${title}".` };
        deleteScopedItem("events", userId, found.seriesId);
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
      name: "delete_all_calendar_events",
      mutates: true,
      description:
        "Remove calendar events in bulk -- everything, everything in a date range, everything at a " +
        "given mealtime, or any combination. Use this for \"clear the calendar\", \"remove everything " +
        "on the 29th\", or \"clear all the lunch events\" -- don't loop delete_calendar_event or guess " +
        "at matching every title. The first call deletes nothing and returns a confirmation to ask the person " +
        "about; pass it back only after they say yes in their next message.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Earliest date to clear, YYYY-MM-DD. Omit to clear from the beginning." },
          to: { type: "string", description: "Latest date to clear, YYYY-MM-DD. Omit to clear through the end. Pass the same value as from to target one day." },
          mealSlot: { type: "string", description: "Only clear events at this mealtime: breakfast, lunch or dinner. Omit to clear regardless of mealtime." },
          confirmation: {
            type: "string",
            description: "The confirmation returned by the first call. Only pass it after the person has said yes in a new message.",
          },
        },
      },
      run: async ({ from, to, mealSlot, confirmation }) => {
        const wantedSlot = typeof mealSlot === "string" ? mealSlot.trim().toLowerCase() : undefined;
        const events = listEvents(
          userId,
          typeof from === "string" ? from : undefined,
          typeof to === "string" ? to : undefined
        ).filter((e) => !wantedSlot || e.mealSlot === wantedSlot);

        // A recurring series can appear many times in `events` (once per
        // occurrence in range) but is one row in the database -- delete each
        // series once, not once per occurrence.
        const seriesIds = [...new Set(events.map((e) => e.seriesId))];
        if (seriesIds.length === 0) return { deletedCount: 0 };

        // Bulk delete: nothing goes until the person has answered a question about exactly this set (see ../confirmations.ts).
        const dates = events.map((e) => e.date).sort();
        const range = dates[0] === dates[dates.length - 1] ? `on ${dates[0]}` : `from ${dates[0]} to ${dates[dates.length - 1]}`;
        const titles = [...new Set(events.map((e) => e.title))];
        const shown = titles.slice(0, 6).join(", ") + (titles.length > 6 ? `, and ${titles.length - 6} more` : "");
        const recurring = events.some((e) => e.seriesId !== e.id);
        const gate = gateBulkDelete({
          userId,
          tool: "delete_all_calendar_events",
          args: { from, to, mealSlot: wantedSlot },
          scopeIds: seriesIds,
          summary:
            `This will delete ${seriesIds.length} calendar event${seriesIds.length === 1 ? "" : "s"}${wantedSlot ? ` at ${wantedSlot}` : ""} ${range} (${shown}).` +
            (recurring ? " Repeating events are removed in full, including dates outside that range." : ""),
          ctx,
          confirmation,
        });
        if (gate) return gate;

        for (const id of seriesIds) deleteScopedItem("events", userId, id);

        return events.some((e) => e.seriesId !== e.id)
          ? {
              deletedCount: seriesIds.length,
              note: "Any recurring series in range were removed in full, not just the occurrences that fell in range.",
            }
          : { deletedCount: seriesIds.length };
      },
    },
  ];
}

export const calendarModule: ToolModule = {
  domain: "calendar",
  sensitivity: "household",
  label: "the household calendar",
  promptRules: [
    // Eval deep #80: "add soccer for sam every tuesday at 5" came back with the name only in the title ("soccer for
    // Sam") and no members, so a family event was saved while the reply said it was Sam's. members is what makes an
    // event someone's; audience can be left out.
    "When an event is for a named person (\"soccer for Sam\"), put their name in members, not just in the title -- " +
      "members is what attaches the event to them (audience can be left out), and a title alone saves a family " +
      "event. Leave members out only for whole-family events.",
    "If the user tells you about someone's schedule (e.g. \"the kids are at school " +
      "Monday through Friday\" or \"Sam has practice Tuesdays\"), don't just note it in " +
      "the conversation and move on -- record it so it's still there next time meals get " +
      "planned. Ask which week (or how long it runs) if that's unclear. Use " +
      "delete_calendar_event if the user says a schedule changed or was wrong. If " +
      "they want everything cleared out (\"remove all the calendar items\"), use " +
      "delete_all_calendar_events -- never guess at a date/title to match everything. That is a bulk " +
      "delete: its first call deletes nothing and returns a confirmation. Tell the person exactly what " +
      "would be deleted and wait for their yes in a separate message; never pass the confirmation in the " +
      "same reply you asked for it. Only call it when the person clearly asks for events to be cleared; a complaint " +
      "or a thought out loud is not a request.",
    "When something repeats every week on the same day(s) -- a class schedule, a work " +
      "shift, a standing practice -- call create_recurring_event instead of " +
      "create_calendar_event, so it's stored as one real rule rather than one row per " +
      "occurrence. Only fall back to create_calendar_event's one-date-per-occurrence " +
      "style for things that don't repeat weekly (a few specific one-off dates).",
  ],
  build: calendarTools,
};
