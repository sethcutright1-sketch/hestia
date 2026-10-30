// The step list editor (RecipeView.tsx): moving, removing, adding and pasting steps, as plain functions over a list of
// strings so it can be tested without a browser. The server cleans and caps whatever is saved (cleanInstructions);
// these only shape the list a person is editing.

import { cleanInstructions, MAX_STEPS } from "../../../nutrition/recipeModel.ts";

/** A new list with the step at `index` moved up (-1) or down (+1); a move off either end changes nothing. */
export function moveStep(steps: string[], index: number, direction: -1 | 1): string[] {
  const to = index + direction;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export const removeStep = (steps: string[], index: number): string[] => steps.filter((_, i) => i !== index);

export const updateStep = (steps: string[], index: number, text: string): string[] => steps.map((s, i) => (i === index ? text : s));

/** A new empty step at the end, up to the cap. */
export const addStep = (steps: string[]): string[] => (steps.length >= MAX_STEPS ? steps : [...steps, ""]);

/** Steps from a pasted block ("1. Mix.\n2. Bake."), numbering removed, added after the ones already there (up to the cap). */
export function appendPasted(steps: string[], pasted: string): string[] {
  return [...steps.filter((s) => s.trim()), ...cleanInstructions(pasted)].slice(0, MAX_STEPS);
}

/** What gets saved: each step cleaned, empties dropped. */
export const stepsToSave = (steps: string[]): string[] => cleanInstructions(steps);

/** True when saving would change nothing (the list as cleaned equals the one the recipe has). */
export function sameSteps(editing: string[], saved: string[] | undefined): boolean {
  const a = stepsToSave(editing);
  const b = saved ?? [];
  return a.length === b.length && a.every((s, i) => s === b[i]);
}
