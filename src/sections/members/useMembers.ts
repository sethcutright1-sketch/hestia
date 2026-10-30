// The household roster, shared by the two screens that edit it: the Family tab
// (who lives here) and Meal Plan's Likes & Dislikes tab (what they'll eat).
//
// It's a hook rather than two components each doing their own fetching because
// that split is exactly how this went wrong before. Meal Plan used to carry its
// own copy of this logic; the two kept separate state over the same rows, an
// edit in one didn't show in the other until a refresh, and the copy quietly
// supported fewer operations than the original. Splitting the *screens* by job
// is fine. Splitting the code that talks to /api/members is not.

import { useCallback, useEffect, useState } from "react";
import { api, type HouseholdMember, type LinkableLogin } from "../../api.ts";
import { useLiveRefresh } from "../../useLiveRefresh.ts";
import { KIOSK } from "../../kiosk.ts";

export interface MembersApi {
  members: HouseholdMember[];
  /** The logins a member can be linked to (those that keep a food diary). */
  logins: LinkableLogin[];
  error: string;
  setError: (message: string) => void;
  refresh: () => Promise<void>;
  addMember: (name: string) => Promise<void>;
  renameMember: (member: HouseholdMember, name: string) => Promise<void>;
  removeMember: (id: string) => Promise<void>;
  addLike: (member: HouseholdMember, like: string) => Promise<void>;
  removeLike: (member: HouseholdMember, like: string) => Promise<void>;
  addDislike: (member: HouseholdMember, dislike: string) => Promise<void>;
  removeDislike: (member: HouseholdMember, dislike: string) => Promise<void>;
  setColor: (member: HouseholdMember, color: string) => Promise<void>;
  setTheme: (member: HouseholdMember, theme: HouseholdMember["theme"]) => Promise<void>;
  setRole: (member: HouseholdMember, role: HouseholdMember["role"]) => Promise<void>;
  /** Admin only (the server refuses anyone else): link a member to a login, or null to unlink. */
  setLogin: (member: HouseholdMember, userId: string | null) => Promise<void>;
}

export function useMembers(): MembersApi {
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [logins, setLogins] = useState<LinkableLogin[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ members: HouseholdMember[]; logins?: LinkableLogin[] }>("/api/members");
      setMembers(res.members);
      setLogins(res.logins ?? []);
      setError("");
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Picks up a member added or edited on another device -- or by the assistant
  // -- without App.tsx's dataVersion remount, which would clear whatever tag
  // the user is halfway through typing.
  useLiveRefresh(() => { refresh(); }, KIOSK ? 30_000 : 60_000);

  const applyMember = useCallback((member: HouseholdMember) => {
    setMembers((prev) => {
      const next = prev.map((m) => (m.id === member.id ? member : m));
      return next.some((m) => m.id === member.id) ? next : [...next, member];
    });
  }, []);

  // Every edit goes through PUT /api/members/:id with only the field that
  // changed, so two people editing different members -- or the same member's
  // likes and dislikes -- don't overwrite each other's other fields.
  const update = useCallback(
    async (member: HouseholdMember, patch: Partial<Pick<HouseholdMember, "name" | "likes" | "dislikes" | "color" | "theme" | "role">> & { userId?: string | null }) => {
      try {
        const res = await api.put<{ member: HouseholdMember }>(`/api/members/${member.id}`, patch);
        applyMember(res.member);
      } catch (err: any) {
        setError(err.message);
      }
    },
    [applyMember]
  );

  return {
    members,
    logins,
    error,
    setError,
    refresh,

    addMember: useCallback(async (name: string) => {
      if (!name.trim()) return;
      try {
        await api.post("/api/members", { name: name.trim() });
        await refresh();
      } catch (err: any) { setError(err.message); }
    }, [refresh]),

    renameMember: useCallback(async (member: HouseholdMember, name: string) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === member.name) return;
      await update(member, { name: trimmed });
    }, [update]),

    removeMember: useCallback(async (id: string) => {
      try {
        await api.del(`/api/members/${id}`);
        await refresh();
      } catch (err: any) { setError(err.message); }
    }, [refresh]),

    addLike: useCallback(async (member: HouseholdMember, like: string) => {
      const value = like.trim();
      // Adding a tag someone already has would send a duplicate to the server
      // and render two identical chips with the same React key.
      if (!value || member.likes.includes(value)) return;
      await update(member, { likes: [...member.likes, value] });
    }, [update]),

    removeLike: useCallback(async (member: HouseholdMember, like: string) => {
      await update(member, { likes: member.likes.filter((l) => l !== like) });
    }, [update]),

    addDislike: useCallback(async (member: HouseholdMember, dislike: string) => {
      const value = dislike.trim();
      if (!value || member.dislikes.includes(value)) return;
      await update(member, { dislikes: [...member.dislikes, value] });
    }, [update]),

    removeDislike: useCallback(async (member: HouseholdMember, dislike: string) => {
      await update(member, { dislikes: member.dislikes.filter((d) => d !== dislike) });
    }, [update]),

    setColor: useCallback(async (member: HouseholdMember, color: string) => {
      await update(member, { color });
    }, [update]),

    setTheme: useCallback(async (member: HouseholdMember, theme: HouseholdMember["theme"]) => {
      await update(member, { theme });
    }, [update]),

    setRole: useCallback(async (member: HouseholdMember, role: HouseholdMember["role"]) => {
      await update(member, { role });
    }, [update]),

    setLogin: useCallback(async (member: HouseholdMember, userId: string | null) => {
      await update(member, { userId });
    }, [update]),
  };
}
