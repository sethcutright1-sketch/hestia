// "Me · Bea": a small switcher in the Food header, shown only when at least one other diary login shares
// something with you. Picking a person puts the Diary and Weight & progress tabs into a read-only view of them,
// at the level they chose. With nobody sharing, Food shows no switcher at all (switcherPeople returns null).

import { chipLabel } from "./sharing.ts";
import type { Sharer } from "./types.ts";

interface Props {
  people: Sharer[];
  /** The login being looked at; null = me. */
  value: string | null;
  onChange: (userId: string | null) => void;
}

const chip = (on: boolean) =>
  `px-3 py-1 rounded-full border text-xs font-medium max-w-[10rem] truncate ${
    on
      ? "bg-blue-600 border-blue-600 text-white"
      : "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
  }`;

export default function PersonSwitcher({ people, value, onChange }: Props) {
  return (
    <div role="group" aria-label="Whose food diary to look at" className="flex flex-wrap items-center gap-1.5 mb-3">
      <button onClick={() => onChange(null)} aria-pressed={value === null} className={chip(value === null)}>
        {chipLabel("Me", true)}
      </button>
      {people.map((p) => (
        <button key={p.userId} onClick={() => onChange(p.userId)} aria-pressed={value === p.userId} className={chip(value === p.userId)} title={`${p.name} shares ${p.level === "everything" ? "everything" : "daily totals"} with you`}>
          {chipLabel(p.name, false)}
        </button>
      ))}
    </div>
  );
}
