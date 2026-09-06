import { deepQueryAll } from "../dom/deepDom";

/**
 * Application controls above this ceiling are not a plausible single ATS step.
 * The audit observed normal forms at 20–200 controls; 1,000 leaves substantial
 * headroom while bounding hostile/pathological pages before per-field work.
 */
export const MAX_APPLICATION_CONTROLS = 1_000;

export const APPLICATION_CONTROL_SELECTOR = [
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image])",
  "textarea",
  "select",
  "[contenteditable=true]",
  '[role="combobox"]',
  '[role="listbox"]',
  '[aria-haspopup="listbox"]',
  '[class*="-control"]',
  '[class*="__control"]'
].join(",");

export interface ControlBudgetResult {
  count: number;
  limit: number;
  exceeded: boolean;
}

/** Cheap, side-effect-free gate before label, visibility, or scoring work. */
export function inspectControlBudget(root: ParentNode): ControlBudgetResult {
  const count = deepQueryAll(root, APPLICATION_CONTROL_SELECTOR).length;
  return { count, limit: MAX_APPLICATION_CONTROLS, exceeded: count > MAX_APPLICATION_CONTROLS };
}
