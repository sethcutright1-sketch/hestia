// The "which color is this person" swatch row, shared by the Family tab
// (Members.tsx) and the calendar's Personal view (PersonalView.tsx's
// Customize popover) -- extracted so there's one implementation of "8 dots,
// current one ringed" rather than two (Stage 10.2 bolder-calendar pass,
// PLAN.md).
//
// Both rows wrap (`flex-wrap`) rather than forcing their container wider --
// at phone width (~280-375px) 8 swatches plus a label don't fit on one line,
// and without wrap the overflow pushed the whole page's width out rather
// than staying inside the Customize popover (Coordinator review, Phase 3).

import { MEMBER_PALETTE, MEMBER_THEMES, resolveMemberColor, resolveMemberTheme, type MemberTheme } from "../calendar/palette.ts";
import type { HouseholdMember } from "../../api.ts";

const THEME_LABEL: Record<MemberTheme, string> = { soft: "Soft", bold: "Bold", gradient: "Gradient" };

export function ColorSwatches({
  member, onChange,
}: { member: Pick<HouseholdMember, "id" | "color">; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {MEMBER_PALETTE.map((c) => (
        <button
          key={c.key}
          onClick={() => onChange(c.key)}
          className={`w-5 h-5 rounded-full ${c.dot} ${
            resolveMemberColor(member).key === c.key
              ? "ring-2 ring-offset-1 ring-slate-500 dark:ring-offset-slate-900"
              : ""
          }`}
          aria-label={`Set calendar color to ${c.key}`}
        />
      ))}
    </div>
  );
}

// Tiny previews of each theme rendered in the member's own color, so picking
// a theme looks like what it'll actually do rather than reading a label.
export function ThemePicker({
  member, onChange,
}: { member: Pick<HouseholdMember, "id" | "color" | "theme">; onChange: (theme: MemberTheme) => void }) {
  const color = resolveMemberColor(member);
  const active = resolveMemberTheme(member);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {MEMBER_THEMES.map((theme) => {
        const isActive = active === theme;
        const previewClass =
          theme === "soft" ? `${color.bg} ${color.border} border` :
          theme === "bold" ? color.solid :
          `bg-linear-to-r ${color.gradient} text-white`;
        return (
          <button
            key={theme}
            onClick={() => onChange(theme)}
            className={`px-2 py-1 rounded-lg text-[11px] font-medium ${previewClass} ${
              isActive ? "ring-2 ring-offset-1 ring-slate-500 dark:ring-offset-slate-900" : ""
            }`}
            aria-label={`Set theme to ${THEME_LABEL[theme]}`}
          >
            {THEME_LABEL[theme]}
          </button>
        );
      })}
    </div>
  );
}
