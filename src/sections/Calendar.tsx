// The Calendar tab: a colored week grid (Stage 10.1, PLAN.md) replacing what
// used to be a bare chronological list, split Family/Personal (Stage 10.2)
// the same way MealPlan.tsx splits into Plan/Likes & Dislikes/Recipes.

import { useState } from "react";
import { useMembers } from "./members/useMembers.ts";
import FamilyGrid from "./calendar/FamilyGrid.tsx";
import PersonalView from "./calendar/PersonalView.tsx";

type View = "family" | "personal";

const VIEWS: { id: View; label: string }[] = [
  { id: "family", label: "Family" },
  { id: "personal", label: "Personal" },
];

interface Props {
  // The household PIN lock (auth.ts / routes/lock.ts), same one Budget and
  // the Chores tab's Manage area use -- FamilyGrid needs it to explain a
  // 423 from creating a chore, and to open the existing PIN prompt (App.tsx)
  // rather than a calendar-specific one.
  locked: boolean;
  onRequestUnlock: () => void;
}

export default function Calendar({ locked, onRequestUnlock }: Props) {
  const { members, setColor, setTheme } = useMembers();
  const [view, setView] = useState<View>("family");

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Calendar</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        Mark an event as one person's, and the Meal Plan section will split that day/slot off for just
        them instead of the whole family.
      </p>

      <div className="flex gap-1 mb-4 border-b border-slate-200 dark:border-slate-800">
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
              view === id
                ? "border-blue-600 text-blue-600 dark:text-blue-400 font-medium"
                : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "family" ? (
        <FamilyGrid members={members} locked={locked} onRequestUnlock={onRequestUnlock} />
      ) : (
        <PersonalView members={members} setColor={setColor} setTheme={setTheme} locked={locked} onRequestUnlock={onRequestUnlock} />
      )}
    </div>
  );
}
