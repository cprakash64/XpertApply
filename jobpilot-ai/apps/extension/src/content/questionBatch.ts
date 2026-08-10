/**
 * Turn discovered controls into a bounded question batch for the backend
 * resolver, and match the results back to the live controls.
 *
 * What crosses the wire is deliberately thin: normalized wording, a section
 * label, a control type, and opaque references for the field and each visible
 * option. No DOM nodes, no HTML, no values the user has typed, no identifiers.
 * The server decides everything consequential and answers with an option
 * reference — one of the very options this page reported seeing.
 */

import type { DiscoveredField } from "../types";

/** Mirrors the backend bounds; a batch that would be rejected is never sent. */
export const MAX_QUESTIONS = 60;
export const MAX_QUESTION_LENGTH = 500;
export const MAX_SECTION_LENGTH = 120;
export const MAX_OPTIONS_PER_QUESTION = 60;
export const MAX_OPTION_LABEL_LENGTH = 200;

export interface BatchOption {
  option_ref: string;
  label: string;
}

export interface BatchQuestion {
  field_ref: string;
  question: string;
  raw_label: string | null;
  accessible_name: string | null;
  nearby_text: string | null;
  field_name: string | null;
  field_id: string | null;
  placeholder: string | null;
  aria_role: string | null;
  section: string | null;
  control_type: string;
  required: boolean;
  locale: string;
  options: BatchOption[];
}

export interface ResolutionResult {
  field_ref: string;
  status:
    | "resolved"
    | "missing"
    | "stale"
    | "requires_confirmation"
    | "ambiguous"
    | "unsupported"
    | "manual";
  canonical_key: string | null;
  answer_type: string | null;
  selected_option_ref: string | null;
  safe_source: string;
  confidence: number;
  sensitivity: string | null;
  reason_code: string;
  resolution_method?: string;
  transform?: string;
  required_canonical_keys?: string[];
  /** Semantic answer from the authenticated backend. ``false`` is a real
   * answer and must never be tested by truthiness. */
  typed_answer?: boolean | null;
  display_answer?: string | null;
  source_values?: (boolean | null)[];
}

/**
 * A question paired with the live control it came from.
 *
 * The element is held ONLY on this side of the boundary. It is what lets a
 * result be matched back to the control it was resolved for, and it is never
 * serialized.
 */
export interface PreparedQuestion {
  question: BatchQuestion;
  field: DiscoveredField;
  /** Option label keyed by the reference sent to the server, so an approved
   * reference can be turned back into something findable in the live menu. */
  labelByRef: Map<string, string>;
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Classify the control for the backend.
 *
 * Coarse on purpose: the server uses this to sanity-check that an answer type
 * suits the control, not to decide how to interact with it. That decision stays
 * here, where the live element is.
 */
export function controlTypeOf(field: DiscoveredField): string {
  if (field.control === "select") return field.multiple ? "multi_select" : "native_select";
  if (field.control === "radio") return "radio";
  if (field.control === "checkbox") return "checkbox";
  if (field.custom) return "combobox";
  if (field.control === "textarea") return "long_text";
  return "text";
}

/**
 * A stable, opaque reference for one control.
 *
 * Built from `uid`, which is WeakMap-backed against the live element, so it
 * survives a rescan of the same node. It is opaque to the server — never a
 * selector, and never something the server could use to address the DOM.
 */
export function fieldRef(field: DiscoveredField): string {
  return `f_${field.frameId}_${field.uid}`;
}

/** Option references are positional within the control and carry no page data. */
export function optionRef(field: DiscoveredField, index: number): string {
  return `${fieldRef(field)}_o${index}`;
}

/**
 * Build the batch.
 *
 * Controls with a real question are included even when a closed custom menu has
 * no option DOM yet. Semantic resolution is independent of actuation; dropping
 * an optionless combobox here previously turned a confirmed answer into
 * ``needs_information`` before the actuator had a chance to open it.
 */
export function buildQuestionBatch(
  fields: DiscoveredField[],
  locale = "en-US",
  /** Options read by opening a closed menu, keyed by field_ref. */
  enumerated?: Map<string, string[]>
): PreparedQuestion[] {
  const prepared: PreparedQuestion[] = [];

  for (const field of fields) {
    if (prepared.length >= MAX_QUESTIONS) break;
    if (!field.visible || field.disabled) continue;

    const question = (field.label || field.ariaLabel || "").trim();
    if (!question) continue;

    const controlType = controlTypeOf(field);
    // Options supplied by the caller take precedence: a closed custom dropdown
    // reports none of its own, and they are read separately by enumeration.
    const rawOptions = (
      enumerated?.get(fieldRef(field)) ?? (field.options || [])
    ).filter((label) => label.trim().length > 0);

    const labelByRef = new Map<string, string>();
    const options: BatchOption[] = rawOptions.slice(0, MAX_OPTIONS_PER_QUESTION).map((label, index) => {
      const ref = optionRef(field, index);
      const clamped = clamp(label.trim(), MAX_OPTION_LABEL_LENGTH);
      labelByRef.set(ref, clamped);
      return { option_ref: ref, label: clamped };
    });

    prepared.push({
      field,
      labelByRef,
      question: {
        field_ref: fieldRef(field),
        question: clamp(question, MAX_QUESTION_LENGTH),
        raw_label: field.label ? clamp(field.label, MAX_QUESTION_LENGTH) : null,
        accessible_name: field.ariaLabel ? clamp(field.ariaLabel, MAX_QUESTION_LENGTH) : null,
        nearby_text: field.nearbyText ? clamp(field.nearbyText, MAX_QUESTION_LENGTH) : null,
        field_name: field.name ? clamp(field.name, MAX_SECTION_LENGTH) : null,
        field_id: field.id ? clamp(field.id, MAX_SECTION_LENGTH) : null,
        placeholder: field.placeholder ? clamp(field.placeholder, MAX_QUESTION_LENGTH) : null,
        aria_role: field.element?.getAttribute("role") ?? null,
        section: field.sectionHeading ? clamp(field.sectionHeading, MAX_SECTION_LENGTH) : null,
        control_type: controlType,
        required: Boolean(field.required),
        locale,
        options
      }
    });
  }

  return prepared;
}

/**
 * Pair each result with the question it answers.
 *
 * A result naming a field we did not ask about is dropped rather than guessed
 * at, and an approved option reference must belong to the SAME question's
 * option set — a reference from another field can never be applied here.
 */
export function matchResults(
  prepared: PreparedQuestion[],
  results: ResolutionResult[]
): { prepared: PreparedQuestion; result: ResolutionResult; approvedLabel: string | null }[] {
  const byRef = new Map(prepared.map((entry) => [entry.question.field_ref, entry]));
  const matched: { prepared: PreparedQuestion; result: ResolutionResult; approvedLabel: string | null }[] = [];

  for (const result of results) {
    const entry = byRef.get(result.field_ref);
    if (!entry) continue;
    const approvedLabel = result.selected_option_ref
      ? entry.labelByRef.get(result.selected_option_ref) ?? null
      : result.status === "resolved"
        && typeof result.typed_answer === "boolean"
        && typeof result.display_answer === "string"
          ? result.display_answer
          : null;
    matched.push({ prepared: entry, result, approvedLabel });
  }
  return matched;
}

/**
 * Which visible choice controls have no options while closed?
 *
 * These are the ones that would otherwise be dropped from the batch entirely,
 * so the caller enumerates them before asking the backend.
 */
export function needsEnumeration(fields: DiscoveredField[]): DiscoveredField[] {
  return fields.filter((field) => {
    if (!field.visible || field.disabled) return false;
    // Only custom controls: a native <select> always carries its options, so an
    // empty one genuinely has none and there is nothing to open.
    if (controlTypeOf(field) !== "combobox") return false;
    if (!(field.label || field.ariaLabel || "").trim()) return false;
    return (field.options || []).filter((label) => label.trim().length > 0).length === 0;
  });
}

/**
 * Has the control changed since we asked about it?
 *
 * Resolution is only valid for the option set it was computed against. If the
 * page swapped the options underneath us, acting on the old answer could select
 * something the server never approved, so the caller re-discovers instead.
 */
export function resolutionIsStale(entry: PreparedQuestion, live: DiscoveredField): boolean {
  const previous = entry.question.options.map((option) => option.label);
  const current = (live.options || [])
    .filter((label) => label.trim().length > 0)
    .slice(0, MAX_OPTIONS_PER_QUESTION)
    .map((label) => clamp(label.trim(), MAX_OPTION_LABEL_LENGTH));

  // A control whose menu is built on open reports NO options while closed —
  // which is its normal resting state, not evidence that the page changed.
  // Treating that as stale would reject every closed dropdown we just read.
  // Such a control is re-verified when the menu is reopened for selection,
  // where the approved label must still be present or the transaction fails.
  if (current.length === 0 && controlTypeOf(live) === "combobox") return false;

  if (previous.length !== current.length) return true;
  return previous.some((label, index) => label !== current[index]);
}
