import { describe, expect, it } from "vitest";
import { computeCounts, statusFromResult, type LedgerEntry } from "../fields/ledger";
import type { DiscoveredField } from "../types";

function field(required: boolean): DiscoveredField {
  return { uid: "f", frameId: "top", control: "text", inputType: "text", name: "", id: "", autocomplete: "", placeholder: "", ariaLabel: "", label: "Referral code", labelSource: "label", normalizedLabel: "referral code", nearbyText: "", sectionHeading: "", required, disabled: false, visible: true, multiple: false, custom: false, existingValue: "", options: [], validationMessage: "", step: 0 };
}

describe("required versus optional ledger classification", () => {
  it("classifies an optional unanswered field as optional skipped", () => {
    expect(statusFromResult(field(false), { fieldKey: "referral", question: "Referral", status: "review", confidence: 1, reasonCode: "NO_VERIFIED_ANSWER" }).status)
      .toBe("intentionally_skipped_optional");
  });
  it("keeps a required unanswered field in needs information", () => {
    expect(statusFromResult(field(true), { fieldKey: "authorization", question: "Authorization", status: "review", confidence: 1, reasonCode: "NO_VERIFIED_ANSWER" }).status)
      .toBe("missing_information");
  });
  it("does not inflate pending or needs-information counts for optional skips", () => {
    const entry = { uid: "f", frameId: "top", label: "Referral", normalizedLabel: "referral", controlType: "text", canonicalKey: null, required: false, sensitive: false, options: [], multiple: false, currentValuePresent: false, status: "intentionally_skipped_optional", reasonCode: "NO_VERIFIED_ANSWER", fillSource: null, verified: false, question: "Referral", reusable: false } as LedgerEntry;
    expect(computeCounts([entry])).toMatchObject({ needsInformation: 0, pending: 0, optionalSkipped: 1 });
  });

  it("counts a successful low-confidence fill as filled and needing confirmation", () => {
    const source = field(true);
    const terminal = statusFromResult(source, {
      uid: source.uid,
      fieldKey: "first_name",
      question: "First name",
      status: "filled",
      confidence: 0.93,
      reasonCode: "LOW_CONFIDENCE"
    });
    const entry = {
      uid: source.uid, frameId: source.frameId, label: "First name", normalizedLabel: "first name",
      controlType: source.control, canonicalKey: "first_name", required: true, sensitive: false,
      options: [], multiple: false, currentValuePresent: true, status: terminal.status,
      reasonCode: terminal.reasonCode, fillSource: "profile", verified: terminal.verified,
      question: "First name", reusable: true
    } as LedgerEntry;

    expect(terminal).toEqual({ status: "filled_needs_review", reasonCode: "LOW_CONFIDENCE", verified: false });
    expect(computeCounts([entry])).toMatchObject({
      filled: 1,
      needsConfirmation: 1,
      pending: 1,
      requiredBlank: 0
    });
  });

  it("keeps a successful high-confidence fill verified without confirmation", () => {
    const source = field(true);
    const terminal = statusFromResult(source, {
      uid: source.uid,
      fieldKey: "email",
      question: "Email",
      status: "filled",
      confidence: 0.99
    });
    const entry = {
      uid: source.uid, frameId: source.frameId, label: "Email", normalizedLabel: "email",
      controlType: source.control, canonicalKey: "email", required: true, sensitive: false,
      options: [], multiple: false, currentValuePresent: true, status: terminal.status,
      reasonCode: terminal.reasonCode, fillSource: "profile", verified: terminal.verified,
      question: "Email", reusable: true
    } as LedgerEntry;

    expect(terminal).toEqual({ status: "filled_verified", reasonCode: "", verified: true });
    expect(computeCounts([entry])).toMatchObject({
      filled: 1,
      needsConfirmation: 0,
      pending: 0,
      requiredBlank: 0
    });
  });
});
