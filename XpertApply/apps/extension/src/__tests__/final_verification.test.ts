import { beforeEach, describe, expect, it } from "vitest";
import { discoverFields } from "../fields/discovery";
import { buildLedger } from "../fields/ledger";
import { fieldFingerprint } from "../content/fieldIdentity";
import { verifyFinalLiveDom } from "../content/finalVerification";
import type { QuestionExecutionTrace } from "../content/diagnostics";
import type { ApplicationSessionData } from "../types";

const session: ApplicationSessionData = {
  sessionId: 77,
  atsType: "generic",
  officialUrl: "https://careers.example.test/apply",
  jobTitle: "Engineer",
  company: "Example",
  profileData: {},
  answers: [],
  unresolvedQuestions: []
};

beforeEach(() => { document.body.innerHTML = ""; });

function verify(root: ParentNode, overrides: Partial<Parameters<typeof verifyFinalLiveDom>[0]> = {}) {
  return verifyFinalLiveDom({
    root,
    session,
    domGeneration: 1,
    lifecycleIsCurrent: true,
    ledger: [],
    questionEntries: [],
    questionTraces: [],
    repeatableSections: [],
    ...overrides
  });
}

function trace(fieldId: string, canonicalKey: string, typedAnswer: boolean, verified = false): QuestionExecutionTrace {
  return {
    fieldId, frameId: "top", rawLabel: canonicalKey, accessibleName: canonicalKey,
    sectionHeading: "Eligibility", fieldType: "combobox", ariaRole: "combobox", options: ["Yes", "No"],
    canonicalKey, resolutionMethod: "registry", resolutionConfidence: 1,
    transform: canonicalKey.includes("sponsorship") ? "boolean_or" : "none",
    requiredCanonicalKeys: [], answerSource: "saved_profile", sourceValues: typedAnswer ? [true] : [false, false],
    typedAnswer, displayAnswer: typedAnswer ? "Yes" : "No", profileRevision: "r1",
    domGeneration: 1, actuator: "aria_listbox", actuatorReached: false,
    transactionStates: ["DISCOVERED", "RESOLVER_REQUESTED", "SEMANTICALLY_RESOLVED"],
    attemptedValue: null, displayedValueAfterFill: "[empty]", backingValueAfterFill: "[empty]",
    verified, failureCode: null
  };
}

describe("final live-DOM completion gate", () => {
  it("rejects the authenticated false-ready shape and synthesizes missing-ledger failures", () => {
    document.body.innerHTML = `
      <form id="application">
        <section aria-label="Legal eligibility">
          <div role="combobox" aria-label="Are you legally authorized to work in the US without restriction?"></div>
          <div role="combobox" aria-label="Will you now or in the future require visa sponsorship or a visa transfer?"></div>
          <label><input type="checkbox" required> I have read and agreed to the Privacy Policy</label>
        </section>
      </form>`;
    const result = verify(document.querySelector("form")!);
    expect(result.canEnterReviewReady).toBe(false);
    expect(result.requiredLiveControlCount).toBe(2);
    expect(result.requiredRemaining).toBe(2);
    expect(result.manualConsentActions).toBe(1);
    expect(result.controls.filter((item) => !item.consent).map((item) => item.failureCode))
      .toEqual(["REQUIRED_FIELD_MISSING_FROM_LEDGER", "REQUIRED_FIELD_MISSING_FROM_LEDGER"]);
    expect(result.ledger.filter((item) => item.reasonCode === "REQUIRED_FIELD_MISSING_FROM_LEDGER")).toHaveLength(2);
  });

  it("rejects a known answer that was resolved but never queued for actuation", () => {
    document.body.innerHTML = '<form><div role="combobox" aria-label="Are you legally authorized to work in the US without restriction?"></div></form>';
    const field = discoverFields(document.querySelector("form")!)[0];
    const ledger = buildLedger([field], [], () => ({ canonicalKey: "work_authorization_us", sensitive: false, reusable: true, fillSource: null }));
    const result = verify(document.querySelector("form")!, {
      ledger,
      questionTraces: [trace(`f_${field.frameId}_${field.uid}`, "work_authorization_us", true)]
    });
    expect(result.controls[0].failureCode).toBe("INTERNAL_HANDOFF_FAILURE");
    expect(result.canEnterReviewReady).toBe(false);
  });

  it("rejects visible selection text when a custom control's backing value is empty", () => {
    document.body.innerHTML = `
      <form><div class="field"><div role="combobox" aria-label="Work authorization">
        <span aria-selected="true">Yes</span><input type="hidden" value="">
      </div></div></form>`;
    const field = discoverFields(document.querySelector("form")!)[0];
    const ledger = buildLedger([field], [], () => ({ canonicalKey: "work_authorization_us", sensitive: false, reusable: true, fillSource: null }));
    const t = trace(`f_${field.frameId}_${field.uid}`, "work_authorization_us", true, true);
    t.actuatorReached = true;
    t.transactionStates!.push("QUEUED_FOR_ACTUATION");
    const result = verify(document.querySelector("form")!, { ledger, questionTraces: [t] });
    expect(result.controls[0]).toMatchObject({ displayValuePresent: true, backingValuePresent: false });
    expect(result.controls[0].failureCode).toBe("CONTROL_VALUE_VERIFICATION_FAILED");
    expect(result.canEnterReviewReady).toBe(false);
  });

  it("honors native, ARIA, marker, and known-eligibility required evidence", () => {
    document.body.innerHTML = `<form>
      <label>Native<input required></label>
      <div role="combobox" aria-label="ARIA" aria-required="true"></div>
      <label>Marked *<input></label>
      <div role="combobox" aria-label="Will you require visa sponsorship?"></div>
    </form>`;
    const result = verify(document.querySelector("form")!);
    expect(result.controls.map((control) => control.required)).toEqual([true, true, true, true]);
    expect(result.controls[3].requiredEvidence).toContain("known_eligibility_question");
  });

  it("rejects an unselected required radio group and application validation errors", () => {
    document.body.innerHTML = `<form>
      <fieldset><legend>Are you authorized? *</legend>
        <label><input type="radio" name="auth" value="yes" required>Yes</label>
        <label><input type="radio" name="auth" value="no">No</label>
      </fieldset>
      <label>Required name<input required aria-invalid="true" value="Present but invalid"></label>
    </form>`;
    const root = document.querySelector("form")!;
    const fields = discoverFields(root);
    const ledger = buildLedger(fields, [], () => ({ canonicalKey: null, sensitive: false, reusable: false, fillSource: null }));
    const result = verify(root, { ledger });
    expect(result.controls[0]).toMatchObject({ controlType: "radio", displayValuePresent: false });
    expect(result.controls[0].failureCode).toBe("APPLICATION_VALIDATION_ERROR");
    expect(result.controls[1].failureCode).toBe("APPLICATION_VALIDATION_ERROR");
    expect(result.canEnterReviewReady).toBe(false);
  });

  it("ignores detached old controls and inventories the current replacement", () => {
    const form = document.createElement("form");
    form.innerHTML = '<div role="combobox" aria-label="Old authorization"></div>';
    document.body.appendChild(form);
    const old = discoverFields(form)[0];
    const oldLedger = buildLedger([old], [], () => ({ canonicalKey: "work_authorization_us", sensitive: false, reusable: true, fillSource: null }));
    form.innerHTML = '<div role="combobox" aria-label="Are you legally authorized to work in the US without restriction?"></div>';
    const result = verify(form, { ledger: oldLedger });
    expect(old.element?.isConnected).toBe(false);
    expect(result.controls).toHaveLength(1);
    expect(result.controls[0].uid).not.toBe(old.uid);
    expect(result.ledger.some((entry) => entry.uid === old.uid)).toBe(false);
  });

  it("keeps consent manual without creating an actuator technical issue", () => {
    document.body.innerHTML = '<form><label><input type="checkbox" required> Privacy consent</label></form>';
    const result = verify(document.querySelector("form")!);
    expect(result.controls[0]).toMatchObject({ consent: true, failureCode: null, verified: false });
    expect(result.manualConsentActions).toBe(1);
    expect(result.technicalIssues).toBe(0);
    expect(result.ledger[0]).toMatchObject({ status: "needs_confirmation", reasonCode: "CONSENT_REQUIRES_USER" });
  });

  it("allows review readiness only after both legal controls verify, with consent separate", () => {
    document.body.innerHTML = `<form>
      <label>Are you legally authorized to work in the US without restriction?
        <select required><option value="true" selected>Yes</option><option value="false">No</option></select>
      </label>
      <label>Will you now or in the future require visa sponsorship or a visa transfer?
        <select required><option value="true">Yes</option><option value="false" selected>No</option></select>
      </label>
      <label><input type="checkbox" required> Privacy consent</label>
    </form>`;
    const root = document.querySelector("form")!;
    const fields = discoverFields(root);
    const ledger = buildLedger(fields, [], (field) => ({
      canonicalKey: field.control === "checkbox" ? "privacy_policy_acknowledgement" : null,
      sensitive: field.control === "checkbox", reusable: false, fillSource: "fixture"
    }));
    const legal = fields.filter((field) => field.control === "select");
    const auth = trace(`f_${legal[0].frameId}_${legal[0].uid}`, "work_authorization_us", true, true);
    const sponsor = trace(`f_${legal[1].frameId}_${legal[1].uid}`, "sponsorship_required_now_or_future", false, true);
    for (const item of [auth, sponsor]) {
      item.actuatorReached = true;
      item.transactionStates!.push("QUEUED_FOR_ACTUATION");
    }
    const result = verify(root, { ledger, questionTraces: [auth, sponsor] });
    expect(result).toMatchObject({
      requiredLiveControlCount: 2,
      requiredVerified: 2,
      requiredRemaining: 0,
      manualConsentActions: 1,
      technicalIssues: 0,
      canEnterReviewReady: true
    });
  });
});

describe("generation-scoped field identity and deduplication", () => {
  it("keeps two empty comboboxes distinct from each other and privacy consent", () => {
    document.body.innerHTML = `<form><section class="ats-control-shell"><h2>Eligibility</h2>
      <div role="combobox" aria-label="Work authorization"></div>
      <div role="combobox" aria-label="Visa sponsorship"></div>
      <label><input type="checkbox">Privacy</label>
    </section></form>`;
    const fields = discoverFields(document.querySelector("form")!);
    expect(fields.map((field) => field.control)).toEqual(expect.arrayContaining(["combobox", "combobox", "checkbox"]));
    expect(new Set(fields.map((field) => field.uid)).size).toBe(3);
    const fingerprints = fields.map((field) => fieldFingerprint(field, { applicationSessionId: 77, domGeneration: 1 }));
    expect(new Set(fingerprints).size).toBe(3);
  });

  it("includes section identity and DOM generation in the fingerprint", () => {
    document.body.innerHTML = `<form>
      <section><h2>Eligibility A</h2><div role="combobox" aria-label="Answer"></div></section>
      <section><h2>Eligibility B</h2><div role="combobox" aria-label="Answer"></div></section>
    </form>`;
    const fields = discoverFields(document.querySelector("form")!);
    const gen1 = fields.map((field) => fieldFingerprint(field, { applicationSessionId: 77, domGeneration: 1 }));
    const gen2 = fields.map((field) => fieldFingerprint(field, { applicationSessionId: 77, domGeneration: 2 }));
    expect(gen1[0]).not.toBe(gen1[1]);
    expect(gen1[0]).not.toBe(gen2[0]);
  });
});
