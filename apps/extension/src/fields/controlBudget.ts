import { deepQueryAll } from "../dom/deepDom";

/**
 * Application controls above this ceiling are not a plausible single ATS step.
 * The audit observed normal forms at 20–200 controls; 1,000 leaves substantial
 * headroom while bounding hostile/pathological pages before per-field work.
 */
export const MAX_APPLICATION_CONTROLS = 1_000;

/**
 * Options processed for ONE custom dropdown.
 *
 * The largest legitimate list an application renders is a country or
 * nationality picker at roughly 250 entries; a state, year or dial-code list is
 * smaller still. 2,000 leaves nearly an order of magnitude of headroom above
 * that while bounding a hostile page that renders tens of thousands of options
 * to make the extension walk them — every option costs a visibility read, which
 * forces layout.
 *
 * Applied to the RAW node list, before any per-option work, on both dropdown
 * paths. A menu over the bound is truncated rather than refused: the approved
 * option still has to be found among what was read, and a control whose answer
 * is past the ceiling fails closed as OPTION_NOT_FOUND like any other miss.
 */
export const MAX_DROPDOWN_OPTIONS = 2_000;

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
