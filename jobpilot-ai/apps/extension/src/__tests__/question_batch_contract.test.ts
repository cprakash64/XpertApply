import { describe, expect, it } from "vitest";
import {
  buildQuestionBatch,
  matchResults,
  type ResolutionResult
} from "../content/questionBatch";
import type { DiscoveredField } from "../types";

function closedCombobox(label: string, uid = "legal-1"): DiscoveredField {
  const element = document.createElement("button");
  element.setAttribute("role", "combobox");
  element.setAttribute("aria-expanded", "false");
  return {
    uid,
    frameId: "top",
    control: "combobox",
    inputType: "",
    name: "",
    id: uid,
    autocomplete: "",
    placeholder: "",
    ariaLabel: label,
    label,
    labelSource: "aria_label",
    normalizedLabel: label.toLowerCase(),
    nearbyText: "Eligibility",
    sectionHeading: "Eligibility",
    required: true,
    disabled: false,
    visible: true,
    multiple: false,
    custom: true,
    existingValue: "",
    options: [],
    validationMessage: "",
    step: 1,
    element
  };
}

describe("optionless live question contract", () => {
  it("sends a closed combobox to semantic resolution before options exist", () => {
    const [prepared] = buildQuestionBatch([
      closedCombobox("Will you now or in the future require visa sponsorship or a visa transfer?")
    ]);

    expect(prepared).toBeDefined();
    expect(prepared.question.control_type).toBe("combobox");
    expect(prepared.question.options).toEqual([]);
  });

  it("preserves typed false and maps the backend-approved display answer to No", () => {
    const prepared = buildQuestionBatch([
      closedCombobox("Will you now or in the future require visa sponsorship or a visa transfer?")
    ]);
    const result: ResolutionResult = {
      field_ref: prepared[0].question.field_ref,
      status: "resolved",
      canonical_key: "sponsorship_required_now_or_future",
      answer_type: "boolean",
      selected_option_ref: null,
      safe_source: "saved_profile",
      confidence: 1,
      sensitivity: "legal",
      reason_code: "answer_resolved_options_unavailable",
      resolution_method: "exact_alias:accessible_name",
      transform: "boolean_or",
      required_canonical_keys: ["sponsorship_required_now", "sponsorship_required_future"],
      source_values: [false, false],
      typed_answer: false,
      display_answer: "No"
    };

    const [matched] = matchResults(prepared, [result]);
    expect(matched.result.typed_answer).toBe(false);
    expect(matched.result.source_values).toEqual([false, false]);
    expect(matched.approvedLabel).toBe("No");
  });
});
