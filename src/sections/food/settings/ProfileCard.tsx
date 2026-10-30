// Food settings > Profile: sex (for the calorie formula), birth date, height (ft/in or cm by unit system), unit
// system and time zone. The first save needs sex, birth date and height; saving also gives a new profile a
// "maintain weight" starting goal, so a calorie budget exists as soon as there is a weigh-in.

import { useMemo, useState } from "react";
import { foodApi } from "../api.ts";
import { buildProfile, profileFormFrom, switchUnits, type ProfileForm } from "../profileForm.ts";
import type { Profile, UnitSystem } from "../types.ts";
import { Field, Notice, btnPrimary, inputCls } from "../ui.tsx";
import SettingsCard, { Select } from "./SettingsCard.tsx";

interface Props {
  profile: Profile;
  fail: (err: unknown) => string;
  onSaved: (profile: Profile) => void;
}

const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
};

export default function ProfileCard({ profile, fail, onSaved }: Props) {
  const [form, setForm] = useState<ProfileForm>(() => profileFormFrom(profile));
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const zoneList = useMemo(zones, []);
  const imperial = form.unitSystem === "imperial";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildProfile(form);
    if (!built.ok) return setStatus({ tone: "error", text: built.error });
    setBusy(true);
    setStatus(null);
    try {
      const saved = await foodApi.saveProfile(built.body);
      onSaved(saved);
      setForm(profileFormFrom(saved));
      setStatus({ tone: "ok", text: "Saved." });
    } catch (err) {
      setStatus({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Profile"
      description={profile.hasProfile ? "These work out your calorie budget." : "Your calorie budget needs your sex, birth date and height. Save them once to get started."}
    >
      <form onSubmit={save} className="space-y-3">
        <Field label="Sex (for the calorie formula)" htmlFor="pf-sex">
          <Select id="pf-sex" value={form.sex} onChange={(v) => setForm({ ...form, sex: v as ProfileForm["sex"] })}>
            <option value="">Choose…</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </Select>
        </Field>
        <Field label="Birth date" htmlFor="pf-birth">
          <input id="pf-birth" type="date" className={inputCls} value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
        </Field>
        <Field label="Units" htmlFor="pf-units">
          <Select id="pf-units" value={form.unitSystem} onChange={(v) => setForm(switchUnits(form, v as UnitSystem))}>
            <option value="imperial">Imperial (lb, ft, in)</option>
            <option value="metric">Metric (kg, cm)</option>
          </Select>
        </Field>
        {imperial ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Height (ft)" htmlFor="pf-ft">
              <input id="pf-ft" type="number" inputMode="numeric" min="1" max="8" step="1" className={inputCls} value={form.ft} onChange={(e) => setForm({ ...form, ft: e.target.value })} />
            </Field>
            <Field label="(in)" htmlFor="pf-in">
              <input id="pf-in" type="number" inputMode="decimal" min="0" max="11.9" step="any" className={inputCls} value={form.inch} onChange={(e) => setForm({ ...form, inch: e.target.value })} />
            </Field>
          </div>
        ) : (
          <Field label="Height (cm)" htmlFor="pf-cm">
            <input id="pf-cm" type="number" inputMode="decimal" min="50" max="260" step="any" className={inputCls} value={form.cm} onChange={(e) => setForm({ ...form, cm: e.target.value })} />
          </Field>
        )}
        <Field label="Time zone" htmlFor="pf-tz" hint="Your food days start and end at midnight in this zone.">
          <input id="pf-tz" type="text" list="pf-tzlist" autoCapitalize="off" autoComplete="off" className={inputCls} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          <datalist id="pf-tzlist">{zoneList.map((z) => <option key={z} value={z} />)}</datalist>
        </Field>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>Save profile</button>
      </form>
    </SettingsCard>
  );
}
