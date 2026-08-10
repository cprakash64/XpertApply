/**
 * Field discovery: scan a form for fillable fields and collect the accessible
 * metadata used for mapping. Prefers semantic attributes (label, aria, name)
 * over visual position. Skips hidden honeypots, disabled fields, and fields
 * outside the active application form.
 *
 * Every actionable control — native OR custom (ARIA combobox/listbox, React
 * Select) — is discovered. Controls that are deliberately excluded (honeypots,
 * hidden, disabled, navigation) are RECORDED with a reason rather than silently
 * dropped, so nothing disappears from reporting merely because JobPilot cannot
 * fill it. See `discoverAll` for the exclusion ledger.
 *
 * uids are STABLE across rescans of the same live element (WeakMap-backed): the
 * field ledger merges on rescan instead of churning, and duplicate wrappers for
 * one control collapse to a single uid.
 */

import type { DiscoveredField, ExcludedControl, FieldControl } from "../types";
import {
  deepClosest,
  deepContains,
  deepParentElement,
  deepQuery,
  deepQueryAll,
  rootNodeOf,
  scopedElementById,
  scopedQuery
} from "../dom/deepDom";

const NATIVE_SELECTOR = [
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image])",
  "textarea",
  "select",
  "[contenteditable=true]"
].join(",");

// Custom (non-native) controls: an ARIA combobox/listbox, a menu-button that
// opens a listbox, or a React-Select style container. These carry NO native
// <select>/<input> value, so ordinary discovery never sees them.
const CUSTOM_SELECTOR = [
  '[role="combobox"]',
  '[role="listbox"]',
  '[aria-haspopup="listbox"]',
  '[class*="-control"]',
  '[class*="__control"]'
].join(",");

// A per-page-session, monotonically increasing counter. Unlike the old
// per-scan reset, uids never collide across rescans, so `jp-7` always names the
// same element for the lifetime of this content-script context.
let uidSeq = 0;
const uidCache = new WeakMap<HTMLElement, string>();
function uidFor(el: HTMLElement): string {
  let uid = uidCache.get(el);
  if (!uid) {
    uid = `jp-${uidSeq++}`;
    uidCache.set(el, uid);
  }
  return uid;
}

let frameId = "";
function currentFrameId(): string {
  if (frameId) return frameId;
  try {
    frameId = window.top === window ? "top" : `frame-${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    frameId = `frame-${Math.random().toString(36).slice(2, 8)}`;
  }
  return frameId;
}

export interface DiscoveryResult {
  fields: DiscoveredField[];
  excluded: ExcludedControl[];
}

/** Full discovery with the exclusion ledger — the canonical entry point. */
export function discoverAll(root: ParentNode = document, step = 0): DiscoveryResult {
  const fields: DiscoveredField[] = [];
  const excluded: ExcludedControl[] = [];
  const seenElements = new Set<HTMLElement>();
  const seenRadioGroups = new Set<string>();

  const consider = (el: HTMLElement, custom: boolean): void => {
    if (seenElements.has(el)) {
      // Same live element reached twice (native + custom wrapper, or nested
      // matches) collapses to one ledger item.
      return;
    }
    seenElements.add(el);

    const excl = exclusionReason(el);
    if (excl) {
      excluded.push({ reason: excl, control: controlOf(el, custom), label: labelFor(el) || ariaLabelledBy(el) });
      return;
    }

    const input = el as HTMLInputElement;
    if (input.type === "radio") {
      // Represent a radio group once, keyed by name.
      const groupKey = input.name || input.id;
      if (groupKey && seenRadioGroups.has(groupKey)) return;
      if (groupKey) seenRadioGroups.add(groupKey);
    }
    fields.push(describe(el, custom, step));
  };

  // A React-Select style control renders a real <input> INSIDE its wrapper. The
  // wrapper is the semantic control (it carries role=combobox and the label);
  // the inner input is only its search box. Discover the wrapper, not the input,
  // or the field would surface as an unlabelled text box.
  //
  // Both passes are shadow-piercing. On SmartRecruiters "Easy Apply" (the live
  // ServiceNow destination) EVERY control is inside an open shadow root, so a
  // light-DOM-only `querySelectorAll` returned zero fields on a fully rendered
  // application form.
  const customWrappers = collapseCustomWrappers(deepQueryAll<HTMLElement>(root, CUSTOM_SELECTOR));
  const insideCustomControl = (el: HTMLElement): boolean =>
    customWrappers.some((wrapper) => wrapper !== el && deepContains(wrapper, el));

  for (const el of deepQueryAll<HTMLElement>(root, NATIVE_SELECTOR)) {
    if (insideCustomControl(el)) {
      excluded.push({ reason: "duplicate", control: controlOf(el, false), label: labelFor(el) });
      seenElements.add(el);
      continue;
    }
    consider(el, false);
  }
  // A combobox's popup listbox (its aria-controls/aria-owns target) is that
  // combobox's option menu, NOT a separate field — never discover it on its own.
  const ownedListboxIds = comboboxOwnedListboxIds(root);
  for (const el of customWrappers) {
    // A wrapper around a native <select> (some ATSs decorate one) is the select's
    // own control — keep the native field discovered above, not the wrapper.
    if (containsSeenNativeSelect(el, seenElements)) continue;
    if (el.id && ownedListboxIds.has(el.id)) continue;
    consider(el, true);
  }
  return { fields, excluded };
}

export function discoverFields(root: ParentNode = document, step = 0): DiscoveredField[] {
  return discoverAll(root, step).fields;
}

/** React-Select renders `.xxx__control` inside `.xxx__value-container` inside an
 * outer container; keep only the OUTERMOST matched wrapper per stack. */
function collapseCustomWrappers(elements: HTMLElement[]): HTMLElement[] {
  const semantic = (element: HTMLElement) =>
    element.matches('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]');
  const semanticDescendants = (element: HTMLElement) =>
    deepQueryAll<HTMLElement>(element, '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]');
  const classWrapper = (element: HTMLElement) =>
    !semantic(element) && element.matches('[class*="__control"], [class*="-control"]');

  const selected = new Set<HTMLElement>();
  for (const element of elements) {
    if (!semantic(element)) continue;
    // React Select needs its visual wrapper for committed-value verification.
    // Pick only the NEAREST wrapper that represents this one semantic control.
    // The previous outermost-wrapper rule could select an ATS section container
    // whose generated class happened to contain "-control"; that collapsed two
    // unrelated blank eligibility comboboxes into one descriptor.
    const wrapper = elements
      .filter((candidate) =>
        classWrapper(candidate)
        && deepContains(candidate, element)
        && semanticDescendants(candidate).length === 1
      )
      .sort((a, b) => structuralDepth(b) - structuralDepth(a))[0];
    selected.add(wrapper ?? element);
  }

  // Keep class-only custom widgets, but never a broad wrapper containing more
  // than one semantic control. Empty id/name/value cannot make fields collide.
  for (const element of elements) {
    if (!classWrapper(element) || semanticDescendants(element).length > 0) continue;
    const nestedClassWidget = elements.some((candidate) =>
      candidate !== element && classWrapper(candidate) && deepContains(element, candidate)
    );
    if (!nestedClassWidget) selected.add(element);
  }
  return Array.from(selected);
}

function structuralDepth(element: HTMLElement): number {
  let depth = 0;
  for (let node: HTMLElement | null = element; node; node = deepParentElement(node)) depth += 1;
  return depth;
}

function comboboxOwnedListboxIds(root: ParentNode): Set<string> {
  const ids = new Set<string>();
  for (const combo of deepQueryAll(root, '[role="combobox"], [aria-haspopup="listbox"]')) {
    for (const attr of ["aria-controls", "aria-owns"]) {
      for (const id of (combo.getAttribute(attr) || "").split(/\s+/).filter(Boolean)) ids.add(id);
    }
  }
  return ids;
}

function containsSeenNativeSelect(el: HTMLElement, seen: Set<HTMLElement>): boolean {
  for (const n of deepQueryAll<HTMLElement>(el, "select")) {
    if (seen.has(n)) return true;
  }
  return false;
}

export function isFillable(el: HTMLElement): boolean {
  return exclusionReason(el) === null;
}

/** Why a control is NOT an application field, or null if it is one. */
function exclusionReason(el: HTMLElement): ExcludedControl["reason"] | null {
  const input = el as HTMLInputElement;
  if (isNavigation(el)) return "navigation";
  if (isHoneypot(el)) return "honeypot";
  if (input.disabled) return "disabled";
  if (!isVisible(el)) return "hidden";
  return null;
}

function isNavigation(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "button") {
    // A <button> with no `type` attribute reports `type === "submit"`, so the
    // submit test below used to exclude EVERY bare button — including the ones
    // the next line was written to keep, i.e. dropdown triggers that open a
    // listbox. The popup semantics decide here, never the implicit default.
    // (SmartRecruiters' phone-country picker and many React selects are exactly
    // this shape: `<button aria-haspopup="listbox">` with no type attribute.)
    const role = (el.getAttribute("role") || "").toLowerCase();
    return !(el.hasAttribute("aria-haspopup") || role === "combobox" || role === "listbox");
  }
  const type = ((el as HTMLInputElement).type || "").toLowerCase();
  if (type === "submit" || type === "reset" || type === "button" || type === "image" || type === "search") return true;
  return false;
}

function describe(el: HTMLElement, custom: boolean, step: number): DiscoveredField {
  // React Select (including Greenhouse's current application form) puts the
  // accessible identity on the inner input but the committed value on the
  // surrounding `__control`. Keep the wrapper as `element` so selection can be
  // read/verified, while deriving the field metadata from the semantic input.
  //
  // Without this split every Greenhouse dropdown in one question section was
  // labelled from that section's FIRST field (for Airbnb: "LinkedIn Profile"),
  // so the mapper tried the same answer on unrelated controls and no option
  // could be selected.
  const metadataEl = custom ? semanticControlInside(el) ?? el : el;
  const input = metadataEl as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
  const control = controlOf(el, custom);
  const resolved = resolveQuestion(metadataEl);
  const label = resolved.label;
  const ariaLabel = input.getAttribute("aria-label") || ariaLabelledBy(metadataEl) || "";
  const nearby = nearbyText(metadataEl);
  const section = sectionHeading(metadataEl);
  return {
    uid: uidFor(el),
    frameId: currentFrameId(),
    control,
    inputType: (input.type || el.tagName.toLowerCase()).toLowerCase(),
    name: input.name || "",
    id: input.id || el.id || "",
    autocomplete: (input.getAttribute("autocomplete") || "").toLowerCase(),
    placeholder: input.getAttribute("placeholder") || "",
    ariaLabel,
    label,
    labelSource: resolved.source,
    normalizedLabel: normalizeLabel(label || ariaLabel || nearbyText(metadataEl)),
    nearbyText: nearby,
    sectionHeading: section,
    required: isRequired(metadataEl, { label, ariaLabel, nearbyText: nearby, sectionHeading: section }),
    disabled: input.disabled,
    visible: true,
    multiple: isMultiple(el, control),
    custom,
    existingValue: existingValue(el, control),
    options: optionsOf(el, control),
    validationMessage: (input as HTMLInputElement).validationMessage || "",
    step,
    element: el
  };
}

/** Return the one semantic combobox/menu-button represented by a visual custom
 * control wrapper. More than one descendant is ambiguous, so keep the wrapper
 * metadata in that rare case instead of guessing. */
function semanticControlInside(el: HTMLElement): HTMLElement | null {
  if (
    el.matches('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]')
  ) return el;
  const candidates = deepQueryAll<HTMLElement>(
    el, '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]'
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export type RequiredEvidence =
  | "native_required"
  | "aria_required"
  | "ats_required_metadata"
  | "visible_required_marker"
  | "native_validation"
  | "known_eligibility_question"
  | "tiktok_application_adapter";

/** Required detection uses independent evidence, not just a native attribute. */
export function requiredEvidence(
  el: HTMLElement,
  descriptor: { label?: string; ariaLabel?: string; nearbyText?: string; sectionHeading?: string } = {}
): RequiredEvidence[] {
  const evidence = new Set<RequiredEvidence>();
  const input = el as HTMLInputElement;
  if (input.required) evidence.add("native_required");
  if (el.getAttribute("aria-required") === "true") evidence.add("aria_required");
  // A web-component field puts `required`/`aria-required` on the real control
  // inside its shadow root, so a host-only check reported every one of them as
  // optional — and an optional field is never chased or counted.
  const innerControl = el.tagName.includes("-")
    ? deepQuery<HTMLInputElement>(el, "input:not([type=hidden]),select,textarea")
    : null;
  if (innerControl) {
    if (innerControl.required) evidence.add("native_required");
    if (innerControl.getAttribute("aria-required") === "true") evidence.add("aria_required");
  }
  const wrapper = deepClosest<HTMLElement>(
    el,
    "[data-required], [data-is-required], [data-validation-required], .field, fieldset, .form-group, [class*='field']"
  );
  if (
    wrapper?.getAttribute("data-required") === "true"
    || wrapper?.getAttribute("data-is-required") === "true"
    || wrapper?.getAttribute("data-validation-required") === "true"
  ) evidence.add("ats_required_metadata");

  const describedByText = (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => scopedElementById(el, id)?.textContent ?? "")
    .join(" ");
  const labelText = [
    descriptor.label,
    descriptor.ariaLabel,
    labelFor(el),
    ariaLabelledBy(el),
    legendText(el),
    describedByText
  ].filter(Boolean).join(" ");
  if (/[\*✱]\s*(?:$|\n)|\brequired\b/i.test(labelText)) {
    evidence.add("visible_required_marker");
  }
  if (input.validity?.valueMissing || Boolean(input.validationMessage)) {
    evidence.add("native_validation");
  }
  const semanticText = [
    descriptor.label,
    descriptor.ariaLabel,
    descriptor.nearbyText,
    descriptor.sectionHeading,
    labelText
  ].filter(Boolean).join(" ");
  if (
    /legally authori[sz]ed to work|work authori[sz]ation|require (?:visa |employer )?sponsorship|visa sponsorship|visa transfer/i.test(semanticText)
  ) evidence.add("known_eligibility_question");
  return Array.from(evidence);
}

function isRequired(
  el: HTMLElement,
  descriptor: { label?: string; ariaLabel?: string; nearbyText?: string; sectionHeading?: string } = {}
): boolean {
  return requiredEvidence(el, descriptor).length > 0;
}

function legendText(el: HTMLElement): string {
  const legend = deepClosest(el, "fieldset")?.querySelector("legend");
  return legend?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function controlOf(el: HTMLElement, custom = false): FieldControl {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (el.getAttribute("contenteditable") === "true") return "contenteditable";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    if (type === "file") return "file";
    if ((el.getAttribute("role") || "").toLowerCase() === "combobox") return "combobox";
    return "text";
  }
  if (custom) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "listbox" || el.getAttribute("aria-multiselectable") === "true") return "listbox";
    return "combobox";
  }
  return "unknown";
}

function isMultiple(el: HTMLElement, control: FieldControl): boolean {
  if (control === "select") return (el as HTMLSelectElement).multiple;
  if (control === "listbox") return true;
  if (el.getAttribute("aria-multiselectable") === "true") return true;
  return false;
}

function existingValue(el: HTMLElement, control: FieldControl): string {
  const input = el as HTMLInputElement;
  if (control === "checkbox" || control === "radio") {
    return input.checked ? "checked" : "";
  }
  if (control === "file") {
    return input.files && input.files.length ? input.files[0].name : "";
  }
  if (control === "contenteditable") return el.textContent || "";
  if (control === "combobox" || control === "listbox") {
    // A custom control's "value" is whatever selected text it renders, NOT a
    // placeholder like "Select…". `currentValuePresent` derives from this.
    if (input.value) return input.value;
    return customSelectionText(el);
  }
  return (el as HTMLInputElement).value || "";
}

/** The visible selected-option text of a custom control (empty when it still
 * shows only a placeholder such as "Select..."). */
function customSelectionText(el: HTMLElement): string {
  const selected = deepQuery(el, '[aria-selected="true"], [class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]');
  const text = clean(selected?.textContent || "");
  if (text && !isPlaceholderText(text)) return text;
  return "";
}

export function isPlaceholderText(text: string): boolean {
  return /^(select|choose|please select|pick one|--|—|\.\.\.)/i.test(clean(text)) || /^select\b/i.test(clean(text));
}

function optionsOf(el: HTMLElement, control: FieldControl): string[] {
  if (control === "select") {
    return Array.from((el as HTMLSelectElement).options)
      .map((o) => o.textContent?.trim() || o.value)
      .filter((t) => t && !isPlaceholderText(t));
  }
  if (control === "radio") {
    const name = (el as HTMLInputElement).name;
    if (!name) return [];
    // A radio group is scoped to its own tree: two components can legitimately
    // reuse a group name inside their own shadow roots.
    const root = rootNodeOf(el) as ParentNode;
    return Array.from(root.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${cssEscape(name)}"]`))
      .map((r) => labelFor(r) || r.value)
      .filter(Boolean);
  }
  if (control === "combobox" || control === "listbox") {
    return customOptions(el).filter((t) => t && !isPlaceholderText(t));
  }
  return [];
}

/** Collect the option labels a custom control exposes: an aria-controls/owns
 * listbox, a nested role=listbox, or role=option descendants. Never invents
 * options — only what the ATS actually renders (may be empty until opened). */
function customOptions(el: HTMLElement): string[] {
  const listboxId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  const scopes: ParentNode[] = [];
  if (listboxId) {
    const lb = scopedElementById(el, listboxId);
    if (lb) scopes.push(lb);
  }
  const ownRole = (el.getAttribute("role") || "").toLowerCase();
  if (ownRole === "listbox") scopes.push(el);
  const nested = deepQuery(el, '[role="listbox"]');
  if (nested) scopes.push(nested);
  if (scopes.length === 0) scopes.push(el);

  const labels = new Set<string>();
  for (const scope of scopes) {
    for (const opt of deepQueryAll(scope, '[role="option"]')) {
      const text = clean(opt.textContent || "");
      if (text) labels.add(text);
    }
  }
  return Array.from(labels);
}

function isHoneypot(el: HTMLElement): boolean {
  const style = (el.getAttribute("style") || "").toLowerCase();
  const name = ((el as HTMLInputElement).name || el.id || "").toLowerCase();
  if (/honeypot|leave.?blank|do.?not.?fill|bot.?field|_hp_|antispam|anti.?bot/.test(name)) return true;
  if (el.getAttribute("tabindex") === "-1" && /honeypot|bot|trap/.test(name)) return true;
  // Off-screen positioning is a classic honeypot hide.
  if (/(?:left|top)\s*:\s*-\d{3,}px/.test(style)) return true;
  return false;
}

function isVisible(el: HTMLElement): boolean {
  // We rely on explicit hiding signals (robust and layout-free) rather than
  // getClientRects/offsetParent, which are unavailable under jsdom and flaky.
  if (el.getAttribute("type") === "hidden") return false;
  // Walk a bounded number of ancestors: a conditional follow-up is commonly
  // hidden by a `display:none` on its WRAPPER, not the control itself, so an
  // element-only check would wrongly treat it as an active field (see J).
  // The walk crosses shadow boundaries: a web component's host is where the page
  // hides a conditional field, and stopping at the shadow root would treat a
  // hidden control as active.
  let node: HTMLElement | null = el;
  for (let depth = 0; node && depth < 12; depth += 1) {
    const style = (node.getAttribute("style") || "").toLowerCase();
    if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)/.test(style)) return false;
    if (node.hidden) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    // Production ATS widgets often hide their search/listbox internals through
    // a stylesheet class (Greenhouse's phone picker uses `.iti__hide`) rather
    // than inline attributes. Real browsers can resolve that computed state;
    // jsdom safely falls back to the explicit checks above.
    const view = node.ownerDocument.defaultView;
    if (view?.getComputedStyle) {
      const computed = view.getComputedStyle(node);
      if (computed.display === "none" || computed.visibility === "hidden") return false;
    }
    node = deepParentElement(node);
  }
  return true;
}

/** Where a field's question text came from — recorded for diagnostics so a
 * mislabelled field can be traced to the wrapper rule that produced it. */
export type LabelSource =
  | "label_for" | "wrapping_label" | "aria_labelledby" | "fieldset_legend"
  | "ats_question_wrapper" | "aria_label" | "placeholder" | "field_container_text"
  | "host_label_attribute" | "none";

/**
 * Resolve a control's QUESTION in strict priority order (section B). Arbitrary
 * nearby page text is never used — only text inside the control's own labelling
 * structure or its immediate field container. This is what stopped MongoDB's
 * global search input from being read as an application question, and what
 * replaces the useless "This question" fallback.
 */
export function resolveQuestion(el: HTMLElement): { label: string; source: LabelSource } {
  // 1. Explicit label[for], resolved in the control's OWN tree first.
  //
  // SmartRecruiters reuses one id (`first-name-input`) for both the `spl-input`
  // host and the real input inside its shadow root, and the matching
  // `<label for>` lives in that shadow root. A document-scoped lookup finds the
  // host, not the label, so the field arrived at the mapper unlabelled.
  if (el.id) {
    const explicit = scopedQuery(el, `label[for="${cssEscape(el.id)}"]`);
    const text = clean(explicit?.textContent);
    if (text) return { label: text, source: "label_for" };
  }

  // 1b. The host element's own `label` attribute. Web-component form fields
  // (`<spl-input label="First name">`) carry the question there and nowhere the
  // ARIA rules would look.
  const hostLabel = clean(hostLabelAttribute(el));
  if (hostLabel) return { label: hostLabel, source: "host_label_attribute" };

  // 2. Wrapping <label> — minus the control's own rendered text.
  const wrapping = deepClosest(el, "label");
  if (wrapping) {
    const text = textWithout(wrapping, el);
    if (text) return { label: text, source: "wrapping_label" };
  }

  // 3. aria-labelledby.
  const labelled = ariaLabelledBy(el);
  if (labelled) return { label: labelled, source: "aria_labelledby" };

  // 4. The legend of the nearest fieldset (a grouped question).
  const legend = clean(deepClosest(el, "fieldset")?.querySelector("legend")?.textContent);
  if (legend) return { label: legend, source: "fieldset_legend" };

  // 5. An ATS question wrapper's own label/legend element.
  const wrapper = deepClosest<HTMLElement>(el, '[data-field], .field, [class*="question"], [class*="field-entry"], [class*="_fieldEntry"]');
  const wrapperLabel = clean(wrapper ? deepQuery(wrapper, "label,legend,.label,[class*='label']")?.textContent : "");
  if (wrapperLabel) return { label: wrapperLabel, source: "ats_question_wrapper" };

  // 6/7. The control's own accessible name / placeholder.
  const ariaLabel = clean(el.getAttribute("aria-label"));
  if (ariaLabel) return { label: ariaLabel, source: "aria_label" };
  const placeholder = clean(el.getAttribute("placeholder"));
  if (placeholder) return { label: placeholder, source: "placeholder" };

  // 8. Help text inside the SAME field container — never arbitrary page text,
  // and only when that container holds this one control.
  if (wrapper && deepQueryAll(wrapper, NATIVE_SELECTOR).length <= 1) {
    const text = textWithout(wrapper, el);
    if (text) return { label: text.slice(0, 160), source: "field_container_text" };
  }
  return { label: "", source: "none" };
}

/**
 * The `label` attribute of the web component this control belongs to.
 *
 * Only the immediate host chain is consulted, and only an element that actually
 * declares a `label` attribute — so this can never borrow a section title or a
 * neighbouring field's question.
 */
function hostLabelAttribute(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  for (let hops = 0; node && hops < 4; hops += 1) {
    const value = node.getAttribute("label");
    if (value && value.trim()) return value;
    const root = rootNodeOf(node);
    node = root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
  }
  return "";
}

/** Text of `container` with `exclude` (and option/script/style noise) removed. */
function textWithout(container: HTMLElement, exclude: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const node of Array.from(clone.querySelectorAll("input,textarea,select,option,script,style,[role=option],[role=listbox]"))) {
    node.remove();
  }
  void exclude;
  return clean(clone.textContent);
}

function labelFor(el: HTMLElement): string {
  const id = el.id;
  if (id) {
    const label = scopedQuery(el, `label[for="${cssEscape(id)}"]`);
    if (label?.textContent) return clean(label.textContent);
  }
  const wrapping = deepClosest(el, "label");
  if (wrapping?.textContent) return clean(wrapping.textContent);
  return "";
}

function ariaLabelledBy(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  const texts = ids.map((id) => scopedElementById(el, id)?.textContent || "").filter(Boolean);
  return clean(texts.join(" "));
}

function nearbyText(el: HTMLElement): string {
  const container = deepClosest(el, "div,fieldset,section,li,p");
  // Only use a container that is specific to this field. A container holding
  // multiple controls (or the whole form) would leak other fields' labels —
  // e.g. a sensitive "Gender" label bleeding onto an unrelated text input.
  if (!container || deepQueryAll(container, "input,textarea,select").length > 1) {
    return "";
  }
  const clone = container.cloneNode(true) as HTMLElement;
  // Remove native controls AND custom option/listbox contents — otherwise a
  // custom multi-select's own option labels ("LinkedIn", "Instagram", …) leak
  // into the field text and misclassify the question (e.g. as a LinkedIn URL).
  clone
    .querySelectorAll('input,textarea,select,option,script,style,[role="option"],[role="listbox"],[role="combobox"]')
    .forEach((n) => n.remove());
  return clean(clone.textContent || "").slice(0, 200);
}

function sectionHeading(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  for (let hops = 0; node && hops < 12; hops += 1) {
    const section = deepClosest<HTMLElement>(node, "section,fieldset");
    if (!section) break;
    const heading = deepQuery(section, "legend,h1,h2,h3,h4");
    if (heading?.textContent) return clean(heading.textContent);
    node = deepParentElement(section);
  }
  return "";
}

/** Lower-case, collapse whitespace, strip trailing required asterisks and
 * "(optional)" decoration — the ledger's join key. */
export function normalizeLabel(text: string): string {
  return clean(text)
    .toLowerCase()
    .replace(/\*+/g, "")
    .replace(/\(\s*(optional|required)\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
