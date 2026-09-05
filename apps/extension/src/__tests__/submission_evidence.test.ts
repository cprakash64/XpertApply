import { describe, expect, it } from "vitest";
import {
  evaluateSubmissionEvidence,
  extractSubmissionReference,
  matchesSuccessMessage,
  matchesSuccessUrl,
  type ObservedSubmissionSignals
} from "../ats/submissionEvidence";

function signals(overrides: Partial<ObservedSubmissionSignals> = {}): ObservedSubmissionSignals {
  return {
    url: "https://careers.example.test/jobs/1/apply",
    visibleText: "",
    formStillPresent: true,
    submitClicked: false,
    submissionResponse: null,
    ...overrides
  };
}

describe("XA-07 submission evidence", () => {
  it("accepts narrowly qualified success URLs and extracts a bounded reference", () => {
    expect(evaluateSubmissionEvidence(signals({
      url: "https://careers.example.test/application-submitted?submitted=true",
      visibleText: "Confirmation number: XA-44821",
      formStillPresent: false
    }))).toEqual({ confirmed: true, evidenceType: "success_page", reference: "XA-44821" });
    expect(matchesSuccessUrl("https://careers.example.test/jobs/1")).toBe(false);
    expect(extractSubmissionReference(`Reference ID: ${"A".repeat(40)}`)).toBe("A".repeat(40));
  });

  it.each([
    "Thank you for applying. We have received your application.",
    "Your application was submitted successfully.",
    "Application submitted — we'll be in touch.",
    "Your application is complete."
  ])("accepts deterministic completed-action copy when the form is gone: %s", (visibleText) => {
    expect(evaluateSubmissionEvidence(signals({ visibleText, formStillPresent: false })))
      .toMatchObject({ confirmed: true, evidenceType: "success_message" });
  });

  it("accepts only explicit successful submission responses", () => {
    expect(evaluateSubmissionEvidence(signals({
      submissionResponse: { ok: true, status: 201, reference: "GH-90210" }
    }))).toEqual({ confirmed: true, evidenceType: "success_response", reference: "GH-90210" });
    for (const status of [302, 400, 500, 503]) {
      expect(evaluateSubmissionEvidence(signals({
        submitClicked: true,
        submissionResponse: { ok: true, status }
      })).confirmed).toBe(false);
    }
  });

  it("refuses clicks, disappearance, ordinary navigation, and ambiguous copy", () => {
    expect(evaluateSubmissionEvidence(signals({ submitClicked: true })))
      .toEqual({ confirmed: false, reason: "SUBMIT_CLICK_ONLY" });
    expect(evaluateSubmissionEvidence(signals({ submitClicked: true, formStillPresent: false })))
      .toEqual({ confirmed: false, reason: "FORM_DISAPPEARED_ONLY" });
    expect(evaluateSubmissionEvidence(signals({
      url: "https://careers.example.test/jobs/1?step=review",
      formStillPresent: false
    }))).toEqual({ confirmed: false, reason: "URL_CHANGED_ONLY" });
    expect(evaluateSubmissionEvidence(signals({
      visibleText: "Your application will be submitted after you review your application.",
      formStillPresent: true
    }))).toEqual({ confirmed: false, reason: "NO_SUCCESS_SIGNAL" });
  });

  it.each([
    "Review your application before you submit.",
    "Your application has not been submitted yet.",
    "We could not submit your application. Please correct the required field.",
    "Error: failed to submit your application."
  ])("vetoes review and error copy: %s", (text) => {
    expect(matchesSuccessMessage(text)).toBe(false);
  });

  it("requires the form to be gone for message-only evidence", () => {
    expect(evaluateSubmissionEvidence(signals({
      visibleText: "Your application has been submitted.",
      formStillPresent: true
    }))).toEqual({ confirmed: false, reason: "AMBIGUOUS_CONFIRMATION" });
  });
});
