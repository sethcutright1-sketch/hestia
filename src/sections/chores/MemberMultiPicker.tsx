// A row of colored toggle chips for picking one or more household members,
// plus an optional "Whole family" chip mutually exclusive with picking
// members -- shared by ChoreFields.tsx (Parent tab) and EventForm.tsx's
// chore mode (calendar), so "assign a chore to more than one kid" looks and
// behaves the same wherever a chore can be created or edited.

import type { HouseholdMember } from "../../api.ts";
import { resolveMemberColor, FAMILY_COLOR } from "../calendar/palette.ts";

interface Props {
  members: HouseholdMember[];
  selectedIds: string[]; // empty = "Whole family" (when allowFamily -- see below)
  onChange: (ids: string[]) => void;
  // False hides the "Whole family" chip entirely, rather than just disabling
  // it -- used when editing an existing multi-member chore group, where
  // collapsing the group down to a family chore isn't a supported edit (see
  // useChoreAdmin.ts's editSeries). Default true.
  allowFamily?: boolean;
  familyLabel?: string;
}

export default function MemberMultiPicker({
  members, selectedIds, onChange, allowFamily = true, familyLabel = "Whole family",
}: Props) {
  function toggle(id: string) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((m) => m !== id) : [...selectedIds, id]);
  }

  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Assign to">
      {allowFamily && (
        <button
          type="button"
          onClick={() => onChange([])}
          aria-pressed={selectedIds.length === 0}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${
            selectedIds.length === 0
              ? `${FAMILY_COLOR.solid} border-transparent`
              : `${FAMILY_COLOR.bg} ${FAMILY_COLOR.text} ${FAMILY_COLOR.border}`
          }`}
        >
          {familyLabel}
        </button>
      )}
      {members.map((m) => {
        const c = resolveMemberColor(m);
        const active = selectedIds.includes(m.id);
        return (
          <button
            type="button"
            key={m.id}
            onClick={() => toggle(m.id)}
            aria-pressed={active}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${
              active ? `${c.solid} border-transparent` : `${c.bg} ${c.text} ${c.border}`
            }`}
          >
            {m.name}
          </button>
        );
      })}
    </div>
  );
}
