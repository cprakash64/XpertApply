import { describe, expect, it } from "vitest";
import {
  buildConfirmationEvent,
  evaluateSubmissionEvidence,
  extractSubmissionReference,
  matchesSuccessMessage,
  matchesSuccessUrl,
  type ObservedSignals
} from "../ats/submissionEvidence";

/**
 * The gate on the only automated path to "applied".
 *
 * A false positive here silently removes a job from the user's Jobs page that
 * they never actually applied to. A false negative costs one click. These tests
 * exist to keep that asymmetry enforced, so most of them assert that something
 * plausible-looking is REFUSED.
 *
 * All fixtures are sanitized, hand-written approximations of ATS confirmation
 * copy. Nothing here contacts a real ATS.
 */

function signals(overrides: Partial<ObservedSignals> = {}): ObservedSignals {
  return {
    url: "https://job-boards.greenhouse.io/acme/jobs/1",
    visibleText: "",
    formStillPresent: true,
    submitClicked: false,
    submissionResponse: null,
    ...overrides
  };
}

// --------------------------------------------------------------------------- //
// Accepted evidence
// --------------------------------------------------------------------------- //
describe("confirmed submissions", () => {
  it("confirms on an ATS success page", () => {
    const result = evaluateSubmissionEvidence(
      signals({
        url: "https://job-boards.greenhouse.io/acme/applications/9f2/confirmation",
        formStillPresent: false
      })
    );
    expect(result).toMatchObject({ confirmed: true, evidenceType: "success_page" });
  });

  it("confirms on a successful submission response", () => {
    const result = evaluateSubmissionEvidence(
      signals({ submissionResponse: { ok: true, status: 201, reference: "GH-90210" } })
    );
    expect(result).toMatchObject({
      confirmed: true,
      evidenceType: "success_response",
      reference: "GH-90210"
    });
  });

  it("confirms on a deterministic success message once the form is gone", () => {
    const result = evaluateSubmissionEvidence(
      signals({
        visibleText: "Your application has been submitted. Confirmation number: ACME-44821",
        formStillPresent: false
      })
    );
    expect(result).toMatchObject({ confirmed: true, evidenceType: "success_message" });
  });

  it.each([
    ["greenhouse", "Thank you for applying to Acme. We have received your application."],
    ["lever", "Your application was submitted successfully."],
    ["ashby", "Application submitted — we'll be in touch."],
    ["workday", "Your application is complete."]
  ])("recognizes the %s confirmation copy", (_ats, text) => {
    expect(matchesSuccessMessage(text)).toBe(true);
  });

  it("extracts a confirmation reference when the ATS shows one", () => {
    expect(
      extractSubmissionReference("Application received. Confirmation number: ACME-44821")
    ).toBe("ACME-44821");
    expect(extractSubmissionReference("Reference ID: 7781-AA-2")).toBe("7781-AA-2");
  });

  it("returns a null reference rather than inventing one", () => {
    const result = evaluateSubmissionEvidence(
      signals({
        visibleText: "Thank you for applying to Acme.",
        formStillPresent: false
      })
    );
    expect(result).toMatchObject({ confirmed: true, reference: null });
  });
});

// --------------------------------------------------------------------------- //
// Refused evidence — the important half
// --------------------------------------------------------------------------- //
describe("weak evidence never confirms", () => {
  it("refuses a submit-button click on its own", () => {
    const result = evaluateSubmissionEvidence(signals({ submitClicked: true }));
    expect(result).toEqual({ confirmed: false, reason: "SUBMIT_CLICK_ONLY" });
  });

  it("refuses the form disappearing on its own", () => {
    const result = evaluateSubmissionEvidence(
      signals({ submitClicked: true, formStillPresent: false })
    );
    expect(result).toEqual({ confirmed: false, reason: "FORM_DISAPPEARED_ONLY" });
  });

  it("refuses a bare URL change", () => {
    const result = evaluateSubmissionEvidence(
      signals({ url: "https://job-boards.greenhouse.io/acme/jobs/1?step=3", formStillPresent: false })
    );
    expect(result).toEqual({ confirmed: false, reason: "URL_CHANGED_ONLY" });
  });

  it("refuses when nothing at all was observed", () => {
    expect(evaluateSubmissionEvidence(signals())).toEqual({
      confirmed: false,
      reason: "NO_SUCCESS_SIGNAL"
    });
  });

  it("refuses a failed submission response", () => {
    const result = evaluateSubmissionEvidence(
      signals({ submitClicked: true, submissionResponse: { ok: false, status: 422 } })
    );
    expect(result.confirmed).toBe(false);
  });

  it("refuses a 3xx/5xx submission response", () => {
    for (const status of [302, 400, 500, 503]) {
      const result = evaluateSubmissionEvidence(
        signals({ submissionResponse: { ok: true, status } })
      );
      expect(result.confirmed).toBe(false);
    }
  });

  it("refuses a success phrase while the form is still on the page", () => {
    // A review step that says "your application will be submitted" next to the
    // still-editable form is the classic false positive.
    const result = evaluateSubmissionEvidence(
      signals({
        visibleText: "Application submitted applications appear here",
        formStillPresent: true
      })
    );
    expect(result).toEqual({ confirmed: false, reason: "AMBIGUOUS_CONFIRMATION" });
  });

  it.each([
    "Review your application before you submit.",
    "Your application will be submitted once you click Submit.",
    "Your application has not been submitted yet.",
    "We could not submit your application. Please correct the required field.",
    "Error: failed to submit your application."
  ])("refuses pre-submission or error copy: %s", (text) => {
    expect(matchesSuccessMessage(text)).toBe(false);
  });

  it("does not treat a marketing 'thank you' path as a confirmation", () => {
    expect(matchesSuccessUrl("https://acme.com/careers/thank-you-for-your-interest-in-us")).toBe(
      false
    );
    expect(matchesSuccessUrl("https://acme.com/jobs/senior-thanks-engineer")).toBe(false);
  });

  it("does not treat a job listing URL as a confirmation", () => {
    for (const url of [
      "https://job-boards.greenhouse.io/acme/jobs/1",
      "https://jobs.lever.co/acme/abc-123",
      "https://acme.com/careers/apply?gh_jid=1",
      "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Engineer"
    ]) {
      expect(matchesSuccessUrl(url)).toBe(false);
    }
  });

  it("recognizes real post-submit URLs", () => {
    for (const url of [
      "https://job-boards.greenhouse.io/acme/applications/9f2/confirmation",
      "https://jobs.lever.co/acme/abc-123/thanks",
      "https://acme.com/apply/application-submitted",
      "https://acme.wd1.myworkdayjobs.com/applications/submitted",
      "https://acme.com/apply?submitted=true"
    ]) {
      expect(matchesSuccessUrl(url)).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------- //
// The event that reaches the API
// --------------------------------------------------------------------------- //
describe("confirmation event", () => {
  it("carries evidence and a timestamp, never a job or user identity", () => {
    const evidence = evaluateSubmissionEvidence(
      signals({
        url: "https://job-boards.greenhouse.io/acme/applications/9f2/confirmation",
        visibleText: "Application received. Confirmation number: ACME-1",
        formStillPresent: false
      })
    );
    expect(evidence.confirmed).toBe(true);
    if (!evidence.confirmed) return;

    const event = buildConfirmationEvent(55, "greenhouse", evidence, new Date("2026-08-04T10:00:00Z"));
    expect(event).toEqual({
      event_type: "application_submission_confirmed",
      session_id: 55,
      ats: "greenhouse",
      submission_timestamp: "2026-08-04T10:00:00.000Z",
      submission_reference: "ACME-1",
      evidence_type: "success_page"
    });
    // The trusted job identifier is the session; nothing else is asserted.
    expect(Object.keys(event)).not.toContain("job_id");
    expect(Object.keys(event)).not.toContain("user_id");
    expect(Object.keys(event)).not.toContain("status");
  });

  it("produces the same logical confirmation for a repeated success observation", () => {
    // A mutation observer firing twice on the same success page must describe
    // the same submission — identical evidence and reference.
    const observed = signals({
      url: "https://job-boards.greenhouse.io/acme/applications/9f2/confirmation",
      visibleText: "Application received. Confirmation number: ACME-1",
      formStillPresent: false
    });
    const first = evaluateSubmissionEvidence(observed);
    const second = evaluateSubmissionEvidence(observed);
    expect(first).toEqual(second);

    const at = new Date("2026-08-04T10:00:00Z");
    expect(buildConfirmationEvent(55, "greenhouse", first as never, at)).toEqual(
      buildConfirmationEvent(55, "greenhouse", second as never, at)
    );
  });
});
