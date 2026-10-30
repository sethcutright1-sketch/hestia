// Household-roster tools. See ./README.md for the contract every domain module follows.

import type { DomainTool, ToolModule } from "../registry.ts";
import { putScopedItem } from "../../db.ts";
import { listMembers, type HouseholdMember } from "../../routes/members.ts";
import { normalizeName } from "../../ingredients.ts";
import { findByName, closestNames, notFound } from "./shared.ts";

function memberTools(userId: string): DomainTool[] {
  const saveMember = (
    member: HouseholdMember,
    updates: Partial<Pick<HouseholdMember, "likes" | "dislikes">>
  ) => {
    // Keep EVERYTHING else on the record. This used to rebuild the member from id/name/likes/dislikes/color/scope only,
    // so one "Alex loves pizza" silently erased their role (a parent became a kid on the Chores screen), their theme
    // and the login they are linked to. Spread the stored row and change just likes/dislikes/updatedAt; `scope` is
    // pinned because it drives row ownership in putScopedItem.
    //
    // No resyncAfterRosterChange here, unlike routes/members.ts: that exists for a changed login link (moving approved
    // individual meals into or out of a food diary), and likes/dislikes never touch the link.
    const updated: HouseholdMember = {
      ...member,
      likes: updates.likes ?? member.likes,
      dislikes: updates.dislikes ?? member.dislikes,
      scope: "joint",
      updatedAt: new Date().toISOString(),
    };
    putScopedItem("household_members", userId, updated);
    return updated;
  };

  return [
    {
      name: "list_household_members",
      description: "Who lives here, what foods each person likes, and what they won't eat.",
      parameters: { type: "object", properties: {} },
      run: async () => listMembers(userId).map((m) => ({ name: m.name, likes: m.likes, dislikes: m.dislikes })),
    },

    {
      name: "add_like",
      mutates: true,
      description: "Record that a family member likes something.",
      parameters: {
        type: "object",
        properties: {
          member: { type: "string", description: "Whose like this is." },
          item: { type: "string", description: 'The food, e.g. "tacos".' },
        },
        required: ["member", "item"],
      },
      run: async ({ member, item }) => {
        const members = listMembers(userId);
        const found = findByName(members, member);
        if (!found) return notFound("family member", member, closestNames(members, member));

        const addition = String(item).trim();
        if (!addition) return { error: "No food given." };
        if (found.likes.some((l) => normalizeName(l) === normalizeName(addition))) {
          return { member: found.name, item: addition, action: "already recorded" };
        }

        const updated = saveMember(found, { likes: [...found.likes, addition] });
        return { member: updated.name, likes: updated.likes };
      },
    },

    {
      name: "remove_like",
      mutates: true,
      description: "Record that a family member no longer especially likes something.",
      parameters: {
        type: "object",
        properties: {
          member: { type: "string", description: "Whose like to clear." },
          item: { type: "string", description: "The food to remove from their likes." },
        },
        required: ["member", "item"],
      },
      run: async ({ member, item }) => {
        const members = listMembers(userId);
        const found = findByName(members, member);
        if (!found) return notFound("family member", member, closestNames(members, member));

        const target = normalizeName(String(item));
        const remaining = found.likes.filter((l) => normalizeName(l) !== target);
        if (remaining.length === found.likes.length) {
          return { error: `${found.name} has no recorded like of "${item}".` };
        }

        const updated = saveMember(found, { likes: remaining });
        return { member: updated.name, likes: updated.likes };
      },
    },

    {
      name: "add_dislike",
      mutates: true,
      description: "Record that a family member won't eat something.",
      parameters: {
        type: "object",
        properties: {
          member: { type: "string", description: "Whose dislike this is." },
          item: { type: "string", description: 'The food, e.g. "mushrooms".' },
        },
        required: ["member", "item"],
      },
      run: async ({ member, item }) => {
        const members = listMembers(userId);
        const found = findByName(members, member);
        if (!found) return notFound("family member", member, closestNames(members, member));

        const addition = String(item).trim();
        if (!addition) return { error: "No food given." };
        if (found.dislikes.some((d) => normalizeName(d) === normalizeName(addition))) {
          return { member: found.name, item: addition, action: "already recorded" };
        }

        const updated = saveMember(found, { dislikes: [...found.dislikes, addition] });
        return { member: updated.name, dislikes: updated.dislikes };
      },
    },

    {
      name: "remove_dislike",
      mutates: true,
      description: "Record that a family member will eat something after all.",
      parameters: {
        type: "object",
        properties: {
          member: { type: "string", description: "Whose dislike to clear." },
          item: { type: "string", description: "The food they'll now eat." },
        },
        required: ["member", "item"],
      },
      run: async ({ member, item }) => {
        const members = listMembers(userId);
        const found = findByName(members, member);
        if (!found) return notFound("family member", member, closestNames(members, member));

        const target = normalizeName(String(item));
        const remaining = found.dislikes.filter((d) => normalizeName(d) !== target);
        if (remaining.length === found.dislikes.length) {
          return { error: `${found.name} has no recorded dislike of "${item}".` };
        }

        const updated = saveMember(found, { dislikes: remaining });
        return { member: updated.name, dislikes: updated.dislikes };
      },
    },
  ];
}

export const membersModule: ToolModule = {
  domain: "members",
  sensitivity: "household",
  label: "the household roster",
  build: memberTools,
};
