/**
 * Form-filling engine. Deterministic DOM interaction with native setters so
 * React/Vue-controlled inputs register the change. Never overwrites a non-empty
 * value the user typed (unless forced), records what XpertApply filled so it can
 * be cleared in extension-private memory, and applies subtle, fully-removable
 * status highlighting.
 */

import type { DiscoveredField, FillOutcome } from "../types";
import { fillDropdown, selectAdapter } from "./dropdown";
import type { AnswerSource } from "./dropdown/types";
import { deepQueryAll } from "../dom/deepDom";
import { presentFieldStatus, removeFieldStatus } from "./statusPresentation";

export type FillStatus = "verified" | "generated" | "review" | "invalid" | "neutral";

interface DropdownOriginal {
  field: DiscoveredField;
  selected: string[];
}

interface PrivateFillState {
  filled: boolean;
  status: FillStatus;
}

/** Document-session only. Weak keys do not retain detached employer controls. */
const dropdownOriginals = new WeakMap<HTMLElement, DropdownOriginal>();
const originalValues = new WeakMap<HTMLElement, string>();
const fillStates = new WeakMap<HTMLElement, PrivateFillState>();
const repeaterElements = new WeakSet<HTMLElement>();

export interface FillOptions {
  force?: boolean; // overwrite an existing non-empty user value
  status?: FillStatus;
  /** Where the answer came from — recorded in dropdown diagnostics. */
  answerSource?: AnswerSource;
  /** Let the caller move the XpertApply widget out of the way of a dropdown
   * menu before interacting, and restore it afterwards (section L). */
  beforeInteract?: () => void | Promise<void>;
  afterInteract?: () => void | Promise<void>;
  /** Optional post-write check against the value the control actually holds
   * once the site's own formatting/validation has run. Used for inputs that
   * legitimately rewrite what was typed (phone masks), where exact string
   * equality would report a false failure — and where no check at all would
   * report a false success. Returning false yields `review_required`. */
  verify?: (finalValue: string) => boolean;
  /** Text used to reveal options in a search-only dropdown. It may differ from
   * the full value used for exact option matching (e.g. search "Tempe" while
   * matching "Tempe, Arizona, United States"). */
  dropdownSearchValue?: string;
  dropdownMatchMode?: "graduation_year" | "gpa";
}

/** A text input that is really a custom-combobox affordance. */
function isComboboxLike(el: HTMLElement): boolean {
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "combobox") return true;
  if ((el.getAttribute("aria-haspopup") || "").toLowerCase() === "listbox") return true;
  if (el.getAttribute("aria-autocomplete")) return true;
  if (el.getAttribute("aria-controls") && el.getAttribute("aria-expanded") != null) return true;
  if (el.closest('[class*="-control"], [class*="__control"]')) return true;
  return false;
}

/** Fill one field with a value. Returns the outcome for the audit trail.
 * Async: custom/JS-controlled dropdowns (comboboxes, React Select, etc.) may
 * render their options asynchronously, so filling one control involves a
 * short, bounded wait — never a synchronous guess. Callers process fields
 * ONE AT A TIME (await each fillField before starting the next) so options
 * from two different open dropdowns can never be confused with each other. */
export async function fillField(field: DiscoveredField, value: string | string[], options: FillOptions = {}): Promise<FillOutcome> {
  const el = field.element;
  if (!el) {
    return { uid: field.uid, status: "error", reason: "no element" };
  }
  const single = Array.isArray(value) ? value[0] ?? "" : value;
  try {
    switch (field.control) {
      case "text":
      case "textarea":
        return await fillTextLike(field, el as HTMLInputElement, single, options);
      case "contenteditable":
        return fillContentEditable(field, el, single, options);
      // Every dropdown-like control — native select, ARIA combobox, React
      // Select, Greenhouse custom, searchable, multi-select, radio-as-options —
      // goes through the ONE verified dropdown adapter path.
      case "select":
      case "combobox":
      case "listbox":
      case "radio":
        return await fillViaDropdown(field, toValues(value), options);
      case "checkbox":
        return fillCheckbox(field, el as HTMLInputElement, single, options);
      default:
        return { uid: field.uid, status: "skipped", reason: "unsupported control" };
    }
  } catch (err) {
    return { uid: field.uid, status: "error", reason: err instanceof Error ? err.message : "fill failed" };
  }
}

/** Multi-select answers are ARRAYS. A legacy pipe-joined string is split for
 * backward compatibility, but arrays are the stored representation. */
function toValues(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return value.includes("|") ? value.split("|").map((v) => v.trim()).filter(Boolean) : [value];
}

/** Drive a dropdown through the shared adapter and translate the verified
 * result into a FillOutcome. Never reports filled without DOM verification. */
async function fillViaDropdown(field: DiscoveredField, values: string[], options: FillOptions): Promise<FillOutcome> {
  const el = field.element as HTMLElement;
  const adapter = selectAdapter(field);
  if (!adapter) return { uid: field.uid, status: "skipped", reason: "unsupported control" };

  // Never overwrite a selection the user made themselves.
  const existing = adapter.readSelection(field);
  if (existing.length > 0 && !options.force && !isJobPilotFilled(el)) {
    return { uid: field.uid, status: "skipped", reason: "user value present" };
  }

  // Capture before interaction. Keep the FIRST snapshot across forced/repeated
  // fills so Clear always returns to the user's state, not an intermediate
  // XpertApply selection.
  const original = dropdownOriginals.get(el) ?? { field, selected: [...existing] };
  if (!dropdownOriginals.has(el)) dropdownOriginals.set(el, original);
  captureOriginalIfPossible(el);
  const result = await fillDropdown(field, {
    values,
    searchValue: options.dropdownSearchValue,
    matchMode: options.dropdownMatchMode,
    answerSource: options.answerSource,
    beforeInteract: options.beforeInteract,
    afterInteract: options.afterInteract
  });
  const detail = {
    adapterId: result.adapterId,
    reasonCode: result.reason,
    options: result.options,
    selected: result.selected
  };
  if (result.ok) {
    markFilled(el, options.status ?? "verified");
    return { uid: field.uid, status: "filled", dropdown: detail };
  }
  // A failed dropdown is ALWAYS surfaced — highlighted red when required.
  markFilled(el, field.required ? "invalid" : "review");
  return { uid: field.uid, status: "review_required", reason: result.reason, dropdown: detail };
}

function captureOriginalIfPossible(el: HTMLElement): void {
  const candidate = el as HTMLInputElement | HTMLSelectElement;
  if (typeof candidate.value === "string") captureOriginal(candidate);
}

function fillContentEditable(field: DiscoveredField, el: HTMLElement, value: string, options: FillOptions): FillOutcome {
  if ((el.textContent || "").trim() && !options.force && !isJobPilotFilled(el)) return { uid: field.uid, status: "skipped", reason: "user value present" };
  captureOriginalValue(el, el.textContent || "");
  el.textContent = value;
  dispatch(el, ["input", "change", "blur"]);
  markFilled(el, options.status ?? "verified");
  return (el.textContent || "").trim() === value.trim() ? { uid: field.uid, status: "filled" } : { uid: field.uid, status: "error", reason: "value did not stick" };
}

async function fillTextLike(field: DiscoveredField, el: HTMLInputElement, value: string, options: FillOptions): Promise<FillOutcome> {
  if (el.value && el.value.trim() && !options.force && !isJobPilotFilled(el)) {
    return { uid: field.uid, status: "skipped", reason: "user value present" };
  }
  // A text input that is really a combobox affordance (React Select's inner
  // input, an aria-autocomplete field): typing alone never commits a selection,
  // so drive it through the verified dropdown adapter instead.
  if (isComboboxLike(el)) {
    return fillViaDropdown({ ...field, control: "combobox" }, [value], options);
  }
  captureOriginal(el);
  setNativeValue(el, value);
  dispatch(el, ["input", "change", "blur"]);
  markFilled(el, options.status ?? "verified");
  if (el.validationMessage) {
    markFilled(el, "invalid");
    return { uid: field.uid, status: "review_required", reason: el.validationMessage };
  }
  // The site may have rewritten (or rejected) the value on blur.
  if (options.verify && !options.verify(el.value ?? "")) {
    markFilled(el, field.required ? "invalid" : "review");
    return { uid: field.uid, status: "review_required", reason: "value did not survive site formatting" };
  }
  if (el.getAttribute("aria-invalid") === "true") {
    markFilled(el, "invalid");
    return { uid: field.uid, status: "review_required", reason: "site marked the field invalid" };
  }
  return { uid: field.uid, status: "filled" };
}

function fillCheckbox(field: DiscoveredField, el: HTMLInputElement, value: string, _options: FillOptions): FillOutcome {
  const desired = /^(true|yes|1|on|checked)$/i.test(value.trim());
  captureOriginal(el);
  if (el.checked !== desired) {
    el.click(); // native toggle to the desired state (avoids double-toggling)
    dispatch(el, ["input", "change"]);
  }
  markFilled(el, "verified");
  return { uid: field.uid, status: "filled" };
}

// --------------------------------------------------------------------------- //
// Clearing + highlighting (fully reversible; never permanently alters the page)
// --------------------------------------------------------------------------- //
export interface ClearResult {
  cleared: number;
  failed: number;
}

export async function clearJobPilotFields(root: ParentNode = document): Promise<ClearResult> {
  const candidates = deepQueryAll<HTMLElement>(root, "*");
  if (root instanceof HTMLElement) candidates.unshift(root);
  const filled = candidates.filter((element) => isJobPilotFilled(element));
  let cleared = 0;
  let failed = 0;
  for (const el of filled) {
    const dropdownOriginal = dropdownOriginals.get(el);
    if (dropdownOriginal) {
      const adapter = selectAdapter(dropdownOriginal.field);
      const restored = Boolean(
        adapter?.restoreSelection
        && await adapter.restoreSelection(dropdownOriginal.field, dropdownOriginal.selected).catch(() => false)
      );
      if (!restored) {
        failed += 1;
        continue;
      }
      dropdownOriginals.delete(el);
    }
    const original = originalValues.get(el) ?? "";
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    if (dropdownOriginal) {
      // The adapter already restored and dispatched the framework-visible
      // events. Never overwrite that verified state through a second path.
    } else if (input.type === "checkbox" || input.type === "radio") {
      input.checked = original === "checked";
    } else if (el.getAttribute("contenteditable") === "true") {
      el.textContent = original;
    } else if (tag === "select") {
      (el as HTMLSelectElement).value = original;
    } else {
      setNativeValue(el as HTMLInputElement | HTMLTextAreaElement, original);
    }
    if (!dropdownOriginal) dispatch(el, ["input", "change"]);
    removeHighlight(el);
    fillStates.delete(el);
    originalValues.delete(el);
    repeaterElements.delete(el);
    cleared += 1;
  }
  return { cleared, failed };
}

export function highlight(el: HTMLElement, status: FillStatus): void {
  const current = fillStates.get(el);
  fillStates.set(el, { filled: current?.filled ?? false, status });
  paint(el, status);
}

export function removeHighlight(el: HTMLElement): void {
  removeFieldStatus(el);
  const current = fillStates.get(el);
  if (current) fillStates.set(el, { ...current, status: "neutral" });
}

export function isJobPilotFilled(el: HTMLElement): boolean {
  return fillStates.get(el)?.filled === true;
}

export function markJobPilotRepeater(el: HTMLElement): void {
  repeaterElements.add(el);
}

export function isJobPilotRepeater(el: HTMLElement): boolean {
  return repeaterElements.has(el);
}

// --------------------------------------------------------------------------- //
// Low-level helpers
// --------------------------------------------------------------------------- //
function markFilled(el: HTMLElement, status: FillStatus): void {
  fillStates.set(el, { filled: true, status });
  paint(el, status);
}

function paint(el: HTMLElement, status: FillStatus): void {
  if (status === "neutral") removeFieldStatus(el);
  else presentFieldStatus(el, status);
}

function captureOriginal(el: HTMLInputElement | HTMLSelectElement): void {
  if (originalValues.has(el)) return;
  const input = el as HTMLInputElement;
  const original = input.type === "checkbox" || input.type === "radio"
    ? (input.checked ? "checked" : "")
    : el.value;
  originalValues.set(el, original ?? "");
}

function captureOriginalValue(el: HTMLElement, value: string): void {
  if (!originalValues.has(el)) originalValues.set(el, value);
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const isTextarea = el.tagName.toLowerCase() === "textarea";
  const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const protoSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const instanceSetter = Object.getOwnPropertyDescriptor(el, "value")?.set;
  // React installs its own instance-level setter; call the prototype setter so
  // the value change is visible to React's synthetic event system.
  try {
    if (protoSetter && protoSetter !== instanceSetter) {
      protoSetter.call(el, value);
      return;
    }
  } catch {
    /* fall through to the plain assignment */
  }
  el.value = value;
}

/**
 * Fire the events a framework listens for.
 *
 * `composed: true` is required, not cosmetic: an event dispatched inside an open
 * shadow root does NOT cross the boundary unless it is composed, so a web
 * component's own listener (SmartRecruiters' `spl-input` wraps the real
 * `<input>` in a shadow root and syncs its value from these events) would never
 * see the change. Verified against the live SmartRecruiters "Easy Apply" form:
 * without `composed`, the inner input shows the value and the component — and
 * therefore the submitted model — keeps the old one.
 */
function dispatch(el: HTMLElement, events: string[]): void {
  for (const type of events) {
    const event = type === "click"
      ? new MouseEvent("click", { bubbles: true, composed: true })
      : new Event(type, { bubbles: true, composed: true });
    el.dispatchEvent(event);
  }
}
