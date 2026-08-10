import { describe, expect, it } from "vitest";
import { equivalentValue, reconcileAtsValues } from "../content/reconciliation";
import type { ApplicationSessionData, DiscoveredField, FieldMapping } from "../types";

const session = {
  sessionId: 66, atsType: "generic", officialUrl: "https://example.test/app", jobTitle: null, company: null,
  answers: [{ canonical_key: "phone", value: "+1 602-555-0100", display_value: "", source: "profile", confidence: 1, sensitive: false, requires_review: false, verified: true }],
  unresolvedQuestions: []
} as ApplicationSessionData;

function field(existingValue: string): DiscoveredField {
  return { uid: "f1", frameId: "top", control: "text", inputType: "text", name: "phone", id: "", autocomplete: "", placeholder: "", ariaLabel: "Phone", label: "Phone", labelSource: "label", normalizedLabel: "phone", nearbyText: "", sectionHeading: "", required: true, disabled: false, visible: true, multiple: false, custom: false, existingValue, options: [], validationMessage: "", step: 0 };
}
const mapping = { uid: "f1", canonicalKey: "phone", confidence: 1, mappingSource: "label", safeToAutoFill: true, requiresReview: false, sensitive: false, explanation: "" } as FieldMapping;

describe("ATS-populated reconciliation", () => {
  it("keeps formatting-equivalent ATS phone values", () => {
    expect(reconcileAtsValues([field("(602) 555-0100")], [mapping], session)[0].classification).toBe("ATS_POPULATED_MATCH");
  });
  it("sends a genuine ATS/profile conflict to review and never overwrites", () => {
    const result = reconcileAtsValues([field("480-555-0100")], [mapping], session)[0];
    expect(result.classification).toBe("ATS_POPULATED_CONFLICT");
    expect(result.mayFill).toBe(false);
  });
  it("allows only an empty resolvable field into takeover", () => {
    const result = reconcileAtsValues([field("")], [mapping], session)[0];
    expect(result.classification).toBe("EMPTY_AND_RESOLVABLE");
    expect(result.mayFill).toBe(true);
  });
  it("normalizes country, URL, whitespace and dates conservatively", () => {
    expect(equivalentValue("country", "US", "United States")).toBe(true);
    expect(equivalentValue("portfolio_url", "https://www.example.com/work/", "example.com/work")).toBe(true);
    expect(equivalentValue("name", "  Ada   Lovelace ", "ada lovelace")).toBe(true);
    expect(equivalentValue("start_date", "2024-01", "2024/1")).toBe(true);
  });
});
