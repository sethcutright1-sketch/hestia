// The Family tab: who lives in this household. Adding someone, renaming them,
// removing them.
//
// Deliberately not their likes and dislikes -- those are edited in Meal Plan's
// own Likes & Dislikes tab, next to the plan they actually affect. This screen
// still SHOWS them, read-only, because "who's in the family" and "what won't
// they eat" are questions people ask together; it just doesn't offer a second
// place to edit them. Both screens share useMembers, so there is one
// implementation talking to /api/members however many screens surface it.

import { useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import { useMembers } from "./members/useMembers.ts";
import { ColorSwatches, ThemePicker } from "./members/ColorSwatches.tsx";

export default function Members({ isAdmin = false }: { isAdmin?: boolean } = {}) {
  const { members, logins, error, addMember, renameMember, removeMember, setColor, setTheme, setRole, setLogin } = useMembers();
  const [newName, setNewName] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await addMember(newName);
    setNewName("");
  }

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold mb-3">Family</h2>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <form onSubmit={submit} className="flex gap-2 mb-4">
        <input
          className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          placeholder="Add a household member…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white" aria-label="Add member">
          <Plus size={16} />
        </button>
      </form>

      {members.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
          <Users size={32} className="mb-3" />
          <p className="text-sm">No household members recorded yet.</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {members.map((member) => (
              <li key={member.id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                <div className="flex items-center gap-3">
                  <input
                    className="flex-1 min-w-0 text-sm font-medium bg-transparent rounded-md px-1.5 py-0.5 -mx-1.5 border border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-slate-300 dark:focus:border-slate-700 focus:outline-none"
                    defaultValue={member.name}
                    onBlur={(e) => renameMember(member, e.target.value)}
                    aria-label={`${member.name} name`}
                  />
                  {/* Removing someone linked to a login is admin-only on the server (routes/members.ts), like linking. */}
                  {(isAdmin || !member.userId) && (
                    <button
                      onClick={() => removeMember(member.id)}
                      className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                      aria-label={`Remove ${member.name}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>

                {/* The calendar's Family/Personal views color-code events and
                    chores by this per-member choice (Stage 10.2, PLAN.md) --
                    a member with no choice made yet still gets a stable
                    color there, picked deterministically from their id. */}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Calendar color</span>
                  <ColorSwatches member={member} onChange={(color) => setColor(member, color)} />
                </div>

                {/* Governs how this member's own Personal-view calendar looks
                    (Stage 10.2 bolder-calendar pass, PLAN.md) -- same three
                    options PersonalView.tsx's Customize popover offers. */}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Theme</span>
                  <ThemePicker member={member} onChange={(theme) => setTheme(member, theme)} />
                </div>

                {/* Drives the Chores tab's Kid/Parent split (Stage 6.5,
                    PLAN.md) -- unset displays as Kid, same as the server's
                    isParentMember treats it. This is a UI convenience, not a
                    security boundary: see the hint below. */}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Role</span>
                  <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs">
                    <button
                      onClick={() => setRole(member, "kid")}
                      className={`px-2.5 py-1 ${
                        member.role !== "parent"
                          ? "bg-blue-600 text-white"
                          : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                      }`}
                      aria-pressed={member.role !== "parent"}
                    >
                      Kid
                    </button>
                    <button
                      onClick={() => setRole(member, "parent")}
                      className={`px-2.5 py-1 border-l border-slate-200 dark:border-slate-700 ${
                        member.role === "parent"
                          ? "bg-blue-600 text-white"
                          : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                      }`}
                      aria-pressed={member.role === "parent"}
                    >
                      Parent
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                  Parents don't earn stars, and approve kids' chores in the Chores tab.
                </p>

                {/* Which login this person is, so a meal made just for them lands in THEIR food diary. Only an
                    admin can change it (the server enforces that); everyone else sees who it is. */}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Food diary login</span>
                  {isAdmin ? (
                    <select
                      className="px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      value={member.userId ?? ""}
                      onChange={(e) => setLogin(member, e.target.value || null)}
                      aria-label={`${member.name} food diary login`}
                    >
                      <option value="">Not linked</option>
                      {logins.map((l) => {
                        const takenBy = members.find((m) => m.userId === l.id && m.id !== member.id);
                        return (
                          <option key={l.id} value={l.id} disabled={!!takenBy}>
                            {l.name}{takenBy ? ` (is ${takenBy.name})` : ""}
                          </option>
                        );
                      })}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-600 dark:text-slate-300">
                      {member.userId ? logins.find((l) => l.id === member.userId)?.name ?? "A login" : "Not linked"}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                  A linked person's own meals in the meal plan go into their food diary.{isAdmin ? "" : " Only an admin can change this."}
                </p>

                {(member.likes.length > 0 || member.dislikes.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {member.likes.map((like) => (
                      <span
                        key={`like-${like}`}
                        className="px-2 py-0.5 text-xs rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                      >
                        {like}
                      </span>
                    ))}
                    {member.dislikes.map((dislike) => (
                      <span
                        key={`dislike-${dislike}`}
                        className="px-2 py-0.5 text-xs rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 line-through decoration-slate-400"
                      >
                        {dislike}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* Says where the edit controls went. Without this, someone who
              remembers editing dislikes here just finds them missing -- and
              hunting for a control is what produced the duplicate editor in
              Meal Plan in the first place. */}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Likes and dislikes are edited under <span className="font-medium">Meal Plan → Likes &amp; Dislikes</span>.
          </p>
        </>
      )}
    </div>
  );
}
