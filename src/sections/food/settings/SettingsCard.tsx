// A titled card in the Food settings column, with an optional one-line description under the title.

import type { ReactNode } from "react";
import { cardCls, mutedCls } from "../ui.tsx";

export default function SettingsCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className={`${cardCls} space-y-3`} aria-label={title}>
      <div className="space-y-1">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        {description && <p className={`text-xs leading-normal ${mutedCls}`}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** A native <select> in the section's style. */
export function Select({ id, value, onChange, children }: { id: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
    >
      {children}
    </select>
  );
}
