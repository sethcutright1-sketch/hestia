// Meal Plan → Likes & Dislikes. What each person will and won't eat, edited
// next to the plan it affects rather than in a settings screen.
//
// This is where dislikes earn their keep: routes/mealplan.ts runs
// findDislikeConflicts over the week and the Plan tab shows a warning against
// any meal containing something a member won't eat. Likes are for the
// assistant, which reads them when proposing meals.
//
// Adding or removing people is the Family tab's job, not this screen's. The
// shared useMembers hook means both are the same rows and the same code path --
// only the controls on offer differ.

import { useState } from "react";
import { Users, X } from "lucide-react";
import type { HouseholdMember } from "../../api.ts";
import { useMembers } from "../members/useMembers.ts";

export default function Preferences() {
  const { members, error, addLike, removeLike, addDislike, removeDislike } = useMembers();

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
        <Users size={32} className="mb-3" />
        <p className="text-sm">No household members yet.</p>
        <p className="text-xs mt-1">Add them under the Family tab first.</p>
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Dislikes flag a clash on any planned meal that uses them. Likes are what the assistant reaches for first.
      </p>

      <ul className="space-y-3">
        {members.map((member) => (
          <li key={member.id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <p className="text-sm font-medium mb-2">{member.name}</p>

            <TagEditor
              label="Likes"
              placeholder="Add a like…"
              tone="like"
              values={member.likes}
              onAdd={(value) => addLike(member, value)}
              onRemove={(value) => removeLike(member, value)}
              member={member}
            />
            <div className="mt-3">
              <TagEditor
                label="Dislikes"
                placeholder="Add a dislike…"
                tone="dislike"
                values={member.dislikes}
                onAdd={(value) => addDislike(member, value)}
                onRemove={(value) => removeDislike(member, value)}
                member={member}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TagEditor({
  label,
  placeholder,
  tone,
  values,
  onAdd,
  onRemove,
  member,
}: {
  label: string;
  placeholder: string;
  tone: "like" | "dislike";
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  member: HouseholdMember;
}) {
  // Draft state is per-editor rather than a map keyed by member id: a component
  // per person means a refresh landing mid-typing can't shuffle anyone's draft
  // into someone else's box.
  const [draft, setDraft] = useState("");

  const chip =
    tone === "like"
      ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
      : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300";
  const button =
    tone === "like"
      ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60"
      : "bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700";

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span key={value} className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ${chip}`}>
            {value}
            <button
              onClick={() => onRemove(value)}
              className="hover:text-red-600 dark:hover:text-red-400"
              aria-label={`Remove ${label.toLowerCase().replace(/s$/, "")} ${value} for ${member.name}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); onAdd(draft); setDraft(""); }}
        className="mt-1.5 flex gap-2"
      >
        <input
          className="flex-1 min-w-0 px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`${label} for ${member.name}`}
        />
        <button className={`px-2 rounded-lg text-xs ${button}`}>Add</button>
      </form>
    </div>
  );
}
