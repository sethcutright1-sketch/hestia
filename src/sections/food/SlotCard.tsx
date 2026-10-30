// One meal of the day: its name, "eaten / target kcal" (red when over), its entries, and the buttons to log
// planned ones, add food, and open the "…" menu.

import { CalendarDays, Clock, MoreHorizontal, Plus } from "lucide-react";
import { amountText, kcalText, slotView } from "./calories.ts";
import type { DiaryEntry, DaySlot } from "./types.ts";
import { LOG_ON_THE_DAY } from "./dates.ts";
import { chipCls, chipPrimaryCls, mutedCls } from "./ui.tsx";

interface Props {
  slot: DaySlot;
  busyIds: ReadonlySet<string>;
  onAdd: () => void;
  onMenu: () => void;
  onOpenEntry: (entry: DiaryEntry) => void;
  onLog: (entry: DiaryEntry) => void;
  onLogAll: () => void;
  /** false on a day that hasn't happened yet: planned entries stay greyed and can't be logged until their day. */
  canLog: boolean;
}

export default function SlotCard({ slot, busyIds, onAdd, onMenu, onOpenEntry, onLog, onLogAll, canLog }: Props) {
  const v = slotView(slot);
  const planned = slot.entries.filter((e) => e.status === "planned");

  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2" aria-label={slot.label}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100 break-words">
            {slot.label}
            {!slot.enabled && <span className={`font-normal text-sm ${mutedCls}`}> (inactive)</span>}
          </h3>
          <span
            className={`text-sm tabular-nums ${v.over ? "text-red-600 dark:text-red-400 font-medium" : mutedCls}`}
            title={v.detail ?? undefined}
          >
            {v.text}
            {v.over && <span className="sr-only"> (over this meal's target)</span>}
          </span>
        </div>
        {planned.length > 0 && canLog && (
          <button onClick={onLogAll} className={chipCls} aria-label={`Log all planned in ${slot.label}`}>
            Log all
          </button>
        )}
        {slot.enabled && (
          <button onClick={onAdd} className={`${chipPrimaryCls} inline-flex items-center gap-1`} aria-label={`Add food to ${slot.label}`}>
            <Plus size={14} /> Add
          </button>
        )}
        {slot.entries.length > 0 && (
          <button onClick={onMenu} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`${slot.label} options`}>
            <MoreHorizontal size={18} />
          </button>
        )}
      </div>

      {slot.entries.length === 0 ? (
        <p className={`text-sm ${mutedCls}`}>Nothing here yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {slot.entries.map((e) => (
            <EntryRow key={e.id} entry={e} busy={busyIds.has(e.id)} canLog={canLog} onOpen={() => onOpenEntry(e)} onLog={() => onLog(e)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EntryRow({ entry, busy, canLog, onOpen, onLog }: { entry: DiaryEntry; busy: boolean; canLog: boolean; onOpen: () => void; onLog: () => void }) {
  const planned = entry.status === "planned";
  return (
    <li className={`flex items-center gap-2 py-2 ${planned ? "opacity-70" : ""}`}>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left" aria-label={`${entry.name}${planned ? ", planned" : ""}: edit`}>
        <span className={`flex items-center gap-1.5 text-sm font-medium break-words ${planned ? "italic text-slate-600 dark:text-slate-300" : "text-slate-900 dark:text-slate-100"}`}>
          {planned && <Clock size={13} className="shrink-0 text-slate-400" aria-label="Planned" />}
          <span className="min-w-0 break-words">{entry.name}</span>
        </span>
        <span className={`flex items-center flex-wrap gap-x-2 text-xs ${mutedCls}`}>
          {amountText(entry.quantity, entry.unit)}
          {planned && !canLog && <span>{LOG_ON_THE_DAY}</span>}
          {entry.source === "plan" && (
            <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
              <CalendarDays size={11} /> from plan
            </span>
          )}
        </span>
      </button>
      <span className={`shrink-0 text-sm tabular-nums ${planned ? "text-slate-400 dark:text-slate-500" : "text-slate-800 dark:text-slate-200"}`}>
        {kcalText(entry.nutrients.kcal)}
      </span>
      {planned && canLog && (
        <button onClick={onLog} disabled={busy} className={chipPrimaryCls} aria-label={`Log ${entry.name}`}>
          Log
        </button>
      )}
    </li>
  );
}
