// Food settings > Profile: the text boxes as typed -> the body for PUT /me/profile (or the message to show).
// The first save needs sex, birth date and height (the server refuses less); after that it is a partial update,
// but the screen always sends all four so what is on screen is what is saved. Tested in tests/foodSettingsForms.test.ts.

import { isValidLocalDate } from "./dates.ts";
import type { Built } from "./forms.ts";
import type { Profile, Sex, UnitSystem } from "./types.ts";
import { heightBoxes, heightFromBoxes } from "./units.ts";

export interface ProfileForm {
  sex: Sex | "";
  birthDate: string;
  unitSystem: UnitSystem;
  ft: string;
  inch: string;
  cm: string;
  timezone: string;
}

export function profileFormFrom(p: Profile): ProfileForm {
  const h = heightBoxes(p.heightCm);
  return { sex: p.sex ?? "", birthDate: p.birthDate ?? "", unitSystem: p.unitSystem, ft: h.ft, inch: h.inch, cm: h.cm, timezone: p.timezone };
}

/**
 * Switching the units while the form is open keeps the height typed so far: it is read in the old units and
 * shown in the new ones. A height that can't be read yet (half typed) is cleared rather than guessed.
 */
export function switchUnits(form: ProfileForm, to: UnitSystem): ProfileForm {
  if (to === form.unitSystem) return form;
  const cm = heightFromBoxes(form.unitSystem, form);
  const boxes = heightBoxes(cm.ok ? cm.body : null);
  return { ...form, unitSystem: to, ft: boxes.ft, inch: boxes.inch, cm: boxes.cm };
}

export interface ProfileBody {
  sex: Sex;
  birthDate: string;
  heightCm: number;
  timezone: string;
  unitSystem: UnitSystem;
}

export function buildProfile(form: ProfileForm): Built<ProfileBody> {
  if (form.sex === "") return { ok: false, error: "Choose male or female (it is used for the calorie formula)." };
  if (!isValidLocalDate(form.birthDate) || form.birthDate < "1900-01-01") return { ok: false, error: "Enter your birth date." };
  const height = heightFromBoxes(form.unitSystem, form);
  if (!height.ok) return height;
  const timezone = form.timezone.trim();
  if (timezone === "") return { ok: false, error: "Enter your time zone, like America/New_York." };
  return { ok: true, body: { sex: form.sex, birthDate: form.birthDate, heightCm: height.body, timezone, unitSystem: form.unitSystem } };
}
