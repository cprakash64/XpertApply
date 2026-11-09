/**
 * Workday control drivers (EXT-LIVE-06).
 *
 * Every setter OPENS/FOCUSES the real control, acts, then READS THE RENDERED STATE BACK. A dispatched
 * event is never success. Matching an option is exact (normalised) or unambiguous-by-level for degrees;
 * the "closest" option is never chosen. Failures return a reason code, never a value.
 *
 * Markup names (`data-automation-id`) come from public descriptions of Workday and from owned fixtures;
 * they were NOT verified on a live tenant. Each lookup has a role/label fallback.
 */

export type ControlResult = { ok: true } | { ok: false; reason: string };
const OK: ControlResult = { ok: true };
const fail = (reason: string): ControlResult => ({ ok: false, reason });

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function norm(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function visible(el: HTMLElement): boolean {
  const s = el.ownerDocument.defaultView?.getComputedStyle(el);
  return s?.display !== "none" && s?.visibility !== "hidden" && el.getAttribute("aria-hidden") !== "true" && !el.hidden;
}

async function until(check: () => boolean, ms: number, step = 40): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(step); }
  return check();
}

const setter = (el: HTMLInputElement | HTMLTextAreaElement) =>
  Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!;

function press(el: HTMLElement): void {
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true }));
  }
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus();
  setter(el).call(el, value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

/** First descendant matching any automation id (as the element or as a wrapper of one input). */
export function byAutomation<T extends HTMLElement = HTMLElement>(scope: ParentNode, ids: string[], inner = "input,textarea,button,[role=combobox]"): T | null {
  for (const id of ids) {
    const direct = scope.querySelector<HTMLElement>(`[data-automation-id="${id}"]`);
    if (!direct) continue;
    if (direct.matches(inner)) return direct as T;
    const nested = direct.querySelector<HTMLElement>(inner);
    if (nested) return nested as T;
  }
  return null;
}

/** Label-text fallback: the control owned by a <label> whose text matches. */
export function byLabel<T extends HTMLElement = HTMLElement>(scope: ParentNode, label: RegExp): T | null {
  for (const l of Array.from(scope.querySelectorAll<HTMLLabelElement>("label"))) {
    if (!label.test((l.textContent || "").replace(/[*✱]/g, "").replace(/\s+/g, " ").trim())) continue;
    const forId = l.getAttribute("for");
    const target = forId ? (scope as Document).querySelector?.<HTMLElement>(`#${CSS.escape(forId)}`) ?? l.ownerDocument.getElementById(forId) : l.querySelector<HTMLElement>("input,textarea,button,select");
    if (target) return target as T;
  }
  return null;
}

// ---- text --------------------------------------------------------------------------------------
export async function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<ControlResult> {
  if (el.disabled || el.readOnly) return fail("CONTROL_NOT_EDITABLE");
  typeInto(el, value);
  el.dispatchEvent(new FocusEvent("blur", { bubbles: true, composed: true }));
  await sleep(30);
  return norm(el.value) === norm(value) ? OK : fail("COMMITTED_VALUE_DIFFERS");
}

// ---- date (month / day / year spinbuttons) -----------------------------------------------------
export interface DateParts { month?: string; day?: string; year?: string }

export function parseIsoParts(iso: string | undefined | null): DateParts {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec((iso ?? "").trim());
  if (!m) return {};
  return { year: m[1], month: m[2], day: m[3] };
}

function dateInput(wrapper: HTMLElement, part: "Month" | "Day" | "Year"): HTMLInputElement | null {
  return wrapper.querySelector<HTMLInputElement>(`[data-automation-id="dateSection${part}-input"], input[aria-label="${part}" i], [role=spinbutton][aria-label="${part}" i]`);
}

export function readDate(wrapper: HTMLElement): DateParts {
  const read = (p: "Month" | "Day" | "Year") => dateInput(wrapper, p)?.value?.trim() || undefined;
  return { month: read("Month"), day: read("Day"), year: read("Year") };
}

const sameNumber = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a !== "" && Number(a) === Number(b);

/** Sets only the parts requested AND present as inputs; every part is read back. */
export async function setDate(wrapper: HTMLElement, want: DateParts): Promise<ControlResult> {
  for (const [part, key, width] of [["Month", "month", 2], ["Day", "day", 2], ["Year", "year", 4]] as const) {
    const value = want[key];
    if (!value) continue;
    const input = dateInput(wrapper, part);
    if (!input) return fail(`DATE_${part.toUpperCase()}_INPUT_MISSING`);
    if (input.disabled || input.readOnly) return fail("CONTROL_NOT_EDITABLE");
    typeInto(input, value.padStart(width, "0"));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true, composed: true }));
  }
  await sleep(40);
  const got = readDate(wrapper);
  for (const key of ["month", "day", "year"] as const) {
    if (want[key] && !sameNumber(got[key], want[key])) return fail(`DATE_${key.toUpperCase()}_NOT_COMMITTED`);
  }
  return OK;
}

// ---- option lists (prompt dropdowns and typeaheads) --------------------------------------------
export interface Opt { label: string; el: HTMLElement }

/** Visible options anywhere in the document (Workday renders the list in a portal). */
export function visibleOptions(doc: Document, within?: HTMLElement): Opt[] {
  const scope: ParentNode = within ?? doc;
  const nodes = Array.from(scope.querySelectorAll<HTMLElement>('[data-automation-id="promptOption"], [role="option"]')).filter(visible);
  return nodes.map((el) => ({ label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim(), el })).filter((o) => o.label);
}

export type Pick = { kind: "one"; option: Opt } | { kind: "none" } | { kind: "ambiguous"; count: number };

/** Exact normalised label. Two identical labels are ambiguous and are NOT guessed between. */
export function pickExact(options: Opt[], wanted: string): Pick {
  const hits = options.filter((o) => norm(o.label) === norm(wanted));
  return hits.length === 1 ? { kind: "one", option: hits[0]! } : hits.length === 0 ? { kind: "none" } : { kind: "ambiguous", count: hits.length };
}

export const DEGREE_LEVELS: Array<[string, RegExp]> = [
  ["doctor", /\b(ph\.?d|doctor(ate)?|doctoral)\b/i],
  ["master", /\b(master'?s?|m\.?s\.?c?|m\.?a\.?|mba|m\.?eng)\b/i],
  ["bachelor", /\b(bachelor'?s?|b\.?s\.?c?|b\.?a\.?|b\.?eng|b\.?tech)\b/i],
  ["associate", /\bassociate'?s?\b/i]
];

/** Degree level word ("bachelor"...) or null. Two degree texts of the same level describe the same degree. */
export function degreeLevel(value: string): string | null {
  return DEGREE_LEVELS.find(([, re]) => re.test(value))?.[0] ?? null;
}

export function sameDegree(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const la = degreeLevel(a);
  return la !== null && la === degreeLevel(b);
}

/**
 * Degree: exact label first. Otherwise a level word ("bachelor") may select the ONLY offered option that
 * contains it. Zero or several such options means "not available"/"ambiguous", never a nearest guess.
 */
export function pickDegree(options: Opt[], wanted: string): Pick {
  const exact = pickExact(options, wanted);
  if (exact.kind !== "none") return exact;
  const level = DEGREE_LEVELS.find(([, re]) => re.test(wanted))?.[0];
  if (!level) return { kind: "none" };
  // Only a GENERIC option ("Bachelor's Degree") stands for a level. "Master of Arts" is a specific degree: choosing it for a saved
  // "Master of Science" would assert a different qualification, so a specific option is never accepted by level alone.
  const generic = /^(bachelors?|masters?|doctorate|doctoral|associates?)( degree)?$/;
  const hits = options.filter((o) => generic.test(norm(o.label)) && norm(o.label).startsWith(level));
  return hits.length === 1 ? { kind: "one", option: hits[0]! } : hits.length === 0 ? { kind: "none" } : { kind: "ambiguous", count: hits.length };
}

// ---- prompt dropdown (button[aria-haspopup=listbox]) -------------------------------------------
const PLACEHOLDER = /^(select one|select|choose|please select|--)$/i;

export function readPrompt(button: HTMLElement): string {
  const text = (button.getAttribute("data-value") ?? button.textContent ?? "").replace(/\s+/g, " ").trim();
  return PLACEHOLDER.test(text) ? "" : text;
}

export async function setPrompt(button: HTMLElement, wanted: string, picker: (o: Opt[], w: string) => Pick = pickExact): Promise<ControlResult> {
  if ((button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true") return fail("CONTROL_NOT_EDITABLE");
  const doc = button.ownerDocument;
  button.scrollIntoView?.({ block: "center" });
  press(button);
  if (!await until(() => visibleOptions(doc).length > 0, 2500)) return fail("OPTIONS_NOT_FOUND");
  const pick = picker(visibleOptions(doc), wanted);
  if (pick.kind === "none") { closeList(button); return fail("OPTION_NOT_AVAILABLE"); }
  if (pick.kind === "ambiguous") { closeList(button); return fail("OPTION_AMBIGUOUS"); }
  press(pick.option.el);
  const label = pick.option.label;
  if (!await until(() => norm(readPrompt(button)) === norm(label), 2000)) return fail("COMMITTED_VALUE_DIFFERS");
  return OK;
}

function closeList(trigger: HTMLElement): void {
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

// ---- typeahead / multiselect search box --------------------------------------------------------
export function readTypeahead(container: HTMLElement): string[] {
  const chips = Array.from(container.querySelectorAll<HTMLElement>('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] li'));
  const names = chips.map((c) => (c.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (names.length) return names;
  const input = container.querySelector<HTMLInputElement>('input[type="text"]:not([data-automation-id="searchBox"])');
  return input?.value ? [input.value.trim()] : [];
}

export async function setTypeahead(container: HTMLElement, wanted: string, picker: (o: Opt[], w: string) => Pick = pickExact): Promise<ControlResult> {
  const doc = container.ownerDocument;
  const box = container.querySelector<HTMLInputElement>('[data-automation-id="searchBox"], input[role="combobox"], input[type="text"]');
  if (!box) return fail("SEARCH_INPUT_MISSING");
  if (box.disabled) return fail("CONTROL_NOT_EDITABLE");
  box.scrollIntoView?.({ block: "center" });
  typeInto(box, wanted);
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  if (!await until(() => visibleOptions(doc).length > 0, 3000)) return fail("OPTIONS_NOT_FOUND");
  await sleep(120); // let a remote search settle so a stale partial list is not picked from
  const pick = picker(visibleOptions(doc), wanted);
  if (pick.kind === "none") return fail("OPTION_NOT_AVAILABLE");
  if (pick.kind === "ambiguous") return fail("OPTION_AMBIGUOUS");
  const label = pick.option.label;
  press(pick.option.el);
  if (!await until(() => readTypeahead(container).some((n) => norm(n) === norm(label)), 2500)) return fail("COMMITTED_VALUE_DIFFERS");
  return OK;
}

// ---- checkbox ----------------------------------------------------------------------------------
export async function setChecked(box: HTMLInputElement, checked: boolean): Promise<ControlResult> {
  if (box.disabled) return fail("CONTROL_NOT_EDITABLE");
  if (box.checked !== checked) press(box);
  await sleep(40);
  return box.checked === checked ? OK : fail("COMMITTED_VALUE_DIFFERS");
}
