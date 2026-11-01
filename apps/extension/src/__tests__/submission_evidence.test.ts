import { describe, expect, it } from "vitest";
import {
  evaluateSubmissionEvidence,
  extractSubmissionReference,
  isLikelyFinalSubmitLabel,
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
  it("recognizes only conservative final-submit labels", () => {
    for (const label of ["Submit", "Submit application", "Send application", "Finish application", "Apply"]) {
      expect(isLikelyFinalSubmitLabel(label)).toBe(true);
    }
    for (const label of ["Continue", "Next", "Review application", "Save", "Submit answer", "Apply filter", ""]) {
      expect(isLikelyFinalSubmitLabel(label)).toBe(false);
    }
  });

  it("accepts narrowly qualified success URLs and extracts a bounded reference", () => {
    expect(evaluateSubmissionEvidence(signals({
      url: "https://careers.example.test/application-submitted?submitted=true",
      visibleText: "Confirmation number: XA-44821",
      formStillPresent: false,
      submitClicked: true
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
    expect(evaluateSubmissionEvidence(signals({ visibleText, formStillPresent: false, submitClicked: true })))
      .toMatchObject({ confirmed: true, evidenceType: "success_message" });
  });

  it("accepts only explicit successful submission responses", () => {
    expect(evaluateSubmissionEvidence(signals({
      submitClicked: true,
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
    }))).toEqual({ confirmed: false, reason: "VALIDATION_FAILED" });
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
      formStillPresent: true,
      submitClicked: true
    }))).toEqual({ confirmed: false, reason: "AMBIGUOUS_CONFIRMATION" });
  });

  it("refuses success-looking state without a correlated user submit", () => {
    expect(evaluateSubmissionEvidence(signals({
      url: "https://careers.example.test/application-submitted",
      visibleText: "Thank you for applying",
      formStillPresent: false
    })).confirmed).toBe(false);
  });

  it("refuses a success signal that existed before the current attempt", () => {
    expect(evaluateSubmissionEvidence(signals({
      visibleText: "Thank you for applying",
      formStillPresent: false,
      submitClicked: true,
      successSignalWasPresentBeforeSubmit: true
    })).confirmed).toBe(false);
  });
});
