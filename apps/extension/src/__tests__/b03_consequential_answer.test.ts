/**
 * B-03 — a provider may not authorize a consequential employer answer.
 *
 * The finding, stated exactly:
 *
 *   A consequential custom dropdown could receive a provider recommendation for
 *   the wrong exact offered option, and every gate passed. The question's
 *   jurisdiction and polarity were fine — it is the ANSWER that was inverted.
 *   `matchOption` took the exact label ahead of the canonical boolean, and
 *   `committedValueMatches` returned true on `shown === wanted` before it ever
 *   consulted `typedAnswer`. "Yes" was clicked, and the ledger recorded it
 *   verified, because the provider said so with confidence 1.0.
 *
 * Every case below is written to FAIL against the pre-Stage-2F pipeline. The
 * decisive assertions are the DOM ones: a refusal must cost zero employer-
 * visible mutation, not merely a different status string.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkConsequentialOption,
  optionPolarity,
  storedCanonicalBoolean
} from "../fields/consequentialAnswer";
import { committedValueMatches, selectApprovedOption } from "../content/dropdownTransaction";
import type { DiscoveredField, SessionAnswer } from "../types";

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

const OFFERED = ["Yes", "No"];

function storedAnswer(key: string, value: string, extra: Partial<SessionAnswer> = {}): SessionAnswer {
  return {
    canonical_key: key, value, display_value: value, source: "profile",
    confidence: 1, sensitive: false, requires_review: false, verified: true, ...extra
  };
}

/** The B-03 shape: a consequential key, an explicit canonical boolean, and an
 * offered set the provider picks from. */
function check(overrides: Partial<Parameters<typeof checkConsequentialOption>[0]> = {}) {
  return checkConsequentialOption({
    canonicalKey: "sponsorship_required_future",
    typedAnswer: false,
    approvedLabel: "No",
    offeredLabels: OFFERED,
    safeSource: "saved_profile",
    storedAnswer: storedAnswer("sponsorship_required_future", "No"),
    ...overrides
  });
}

function installGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ x: 10, y: 10, top: 10, left: 10, right: 210, bottom: 50, width: 200, height: 40, toJSON: () => ({}) }) as DOMRect
  );
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.activeElement });
}

function field(id: string, options: string[] = OFFERED): DiscoveredField {
  return {
    uid: id, frameId: "top", control: "combobox", inputType: "", name: "", id,
    autocomplete: "", placeholder: "", ariaLabel: "", label: id, labelSource: "aria_label",
    normalizedLabel: id, nearbyText: "", sectionHeading: "", required: true, disabled: false,
    visible: true, multiple: false, custom: true, existingValue: "", options,
    validationMessage: "", step: 0, element: document.getElementById(id)!
  };
}

/** A live ARIA combobox whose menu commits the clicked option into the trigger. */
function mountCombobox(id: string, labels: string[]): void {
  document.body.innerHTML += `<div id="${id}" role="combobox" aria-haspopup="listbox" tabindex="0">Select</div>`;
  const trigger = document.getElementById(id)!;
  trigger.addEventListener("click", () => {
    if (document.querySelector(`[data-owner="${id}"]`)) return;
    const menu = document.createElement("div");
    menu.setAttribute("role", "listbox");
    menu.dataset.owner = id;
    for (const label of labels) {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = label;
      option.addEventListener("click", () => {
        document.getElementById(id)!.textContent = label;
        menu.remove();
      });
      menu.appendChild(option);
    }
    document.body.appendChild(menu);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  if (typeof PointerEvent === "undefined") vi.stubGlobal("PointerEvent", MouseEvent);
  document.body.innerHTML = "";
  installGeometry();
});

// --------------------------------------------------------------------------- //
// A. The definitive B-03 closure case
// --------------------------------------------------------------------------- //
describe("A · high confidence never overrides a semantic mismatch", () => {
  it("refuses the exactly-offered WRONG option for future sponsorship", () => {
    // canonical: future sponsorship = false. Provider: "Yes", confidence 1.0.
    const verdict = check({ approvedLabel: "Yes" });
    expect(verdict).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER" });
  });

  it("performs ZERO mutation on the employer control when it refuses", async () => {
    mountCombobox("sponsorship", OFFERED);
    // The gate refuses before anything is opened, so the transaction is never
    // started. Proven here at the actuator too: even driven directly with the
    // contradictory pair, nothing is committed.
    const result = await selectApprovedOption(field("sponsorship"), "Yes", { typedAnswer: false });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("option_contradicts_answer");
    // THE assertion. The employer's control still shows nothing.
    expect(document.getElementById("sponsorship")!.textContent).toBe("Select");
  });

  it("does not verify a control that committed the contradicting option", () => {
    // Belt and braces: even if something else set the control to "Yes", the
    // verification step may not report it as the answer "No".
    expect(committedValueMatches("Yes", "Yes", false, OFFERED)).toBe(false);
    expect(committedValueMatches("No", "No", true, OFFERED)).toBe(false);
  });

  it("is unmoved by confidence — the input carries none at all", () => {
    // Confidence is deliberately not a parameter of the gate. A provider's
    // opinion of its own output cannot be the reason a fact is stated.
    expect(Object.keys(check({ approvedLabel: "Yes" }))).not.toContain("confidence");
  });
});

// --------------------------------------------------------------------------- //
// B. The correct option still fills
// --------------------------------------------------------------------------- //
describe("B · a semantically correct recommendation is still applied", () => {
  it("accepts the option that agrees with the canonical answer", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("commits and verifies it on a live control", async () => {
    mountCombobox("sponsorship", OFFERED);
    const result = await selectApprovedOption(field("sponsorship"), "No", { typedAnswer: false });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("verified");
    expect(document.getElementById("sponsorship")!.textContent).toBe("No");
  });
});

// --------------------------------------------------------------------------- //
// C. Work authorization, the opposite polarity
// --------------------------------------------------------------------------- //
describe("C · work authorization", () => {
  it("refuses 'No' when the canonical answer is authorized = true", () => {
    expect(check({
      canonicalKey: "work_authorization_us",
      typedAnswer: true,
      approvedLabel: "No",
      storedAnswer: storedAnswer("work_authorization_us", "Yes")
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER" });
  });

  it("accepts 'Yes'", () => {
    expect(check({
      canonicalKey: "work_authorization_us",
      typedAnswer: true,
      approvedLabel: "Yes",
      storedAnswer: storedAnswer("work_authorization_us", "Yes")
    })).toEqual({ ok: true });
  });

  it("does not care where the option sits in the list", async () => {
    // Selection is semantic, never positional: a control offering No before Yes
    // must still receive the right answer.
    mountCombobox("auth", ["No", "Yes"]);
    const result = await selectApprovedOption(field("auth", ["No", "Yes"]), "Yes", { typedAnswer: true });
    expect(result.ok).toBe(true);
    expect(document.getElementById("auth")!.textContent).toBe("Yes");
  });
});

// --------------------------------------------------------------------------- //
// D. The provider disagrees with what we independently hold
// --------------------------------------------------------------------------- //
describe("D · the stored canonical answer outranks the provider", () => {
  it("refuses a self-consistent provider that contradicts the profile", () => {
    // The adversary's best move: return typed_answer TRUE *and* point at "Yes",
    // so nothing about the response is internally inconsistent. The extension's
    // own verified answer says otherwise, and that check does not depend on the
    // provider at all.
    expect(check({
      typedAnswer: true,
      approvedLabel: "Yes",
      storedAnswer: storedAnswer("sponsorship_required_future", "No")
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_ANSWER_CONTRADICTS_PROFILE" });
  });

  it("holds nothing comparable when the stored answer is unverified", () => {
    // "We hold nothing" is not a contradiction. The other four checks still run.
    expect(storedCanonicalBoolean(storedAnswer("k", "No", { verified: false }))).toBeNull();
    expect(storedCanonicalBoolean(storedAnswer("k", "No", { requires_review: true }))).toBeNull();
    expect(storedCanonicalBoolean(undefined)).toBeNull();
    expect(check({
      typedAnswer: true,
      approvedLabel: "Yes",
      storedAnswer: storedAnswer("sponsorship_required_future", "No", { verified: false })
    })).toEqual({ ok: true });
  });
});

// --------------------------------------------------------------------------- //
// E. Provenance
// --------------------------------------------------------------------------- //
describe("E · a derived source cannot state a consequential fact", () => {
  it.each(["resume", "job_description", "company_context", "model_inference", ""])(
    "refuses safe_source %s",
    (safeSource) => {
      expect(check({ safeSource })).toEqual({ ok: false, reason: "CONSEQUENTIAL_SOURCE_NOT_USER_ASSERTED" });
    }
  );

  it.each(["saved_profile", "application_override"])("accepts the user-asserted source %s", (safeSource) => {
    expect(check({ safeSource })).toEqual({ ok: true });
  });
});

// --------------------------------------------------------------------------- //
// F. Membership, ambiguity, unknown references
// --------------------------------------------------------------------------- //
describe("F · the option must belong to the current offered set", () => {
  it("refuses a label this field does not offer", () => {
    expect(check({ approvedLabel: "Maybe" }))
      .toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_NOT_OFFERED" });
  });

  it("refuses a stale option after the generation changed", () => {
    // Generation G1 offered A/B/C and the provider chose B; G2 offers A/C/D.
    expect(checkConsequentialOption({
      canonicalKey: "criminal_history", typedAnswer: null, approvedLabel: "B",
      offeredLabels: ["A", "C", "D"], safeSource: "saved_profile"
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_NOT_OFFERED" });
  });

  it("fails closed on duplicate labels instead of taking the first", () => {
    expect(check({ offeredLabels: ["Yes", "No", "No"] }))
      .toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_AMBIGUOUS" });
    // Including labels that differ only by decoration.
    expect(check({ offeredLabels: ["Yes", "No", " no "] }))
      .toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_AMBIGUOUS" });
  });

  it("refuses an empty or unknown reference", () => {
    expect(check({ approvedLabel: "" }))
      .toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_NOT_OFFERED" });
  });

  it("refuses duplicates at the actuator too", async () => {
    mountCombobox("dupe", ["No", "No"]);
    const result = await selectApprovedOption(field("dupe", ["No", "No"]), "No", { typedAnswer: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ambiguous_option");
    expect(document.getElementById("dupe")!.textContent).toBe("Select");
  });
});

// --------------------------------------------------------------------------- //
// G. Non-boolean option wording
// --------------------------------------------------------------------------- //
describe("G · wording with no readable polarity fails closed", () => {
  it.each([
    "Authorized without sponsorship",
    "Authorized with sponsorship",
    "Prefer not to say",
    "It depends"
  ])("refuses %s for an explicit boolean answer", (label) => {
    expect(optionPolarity(label)).toBe("unknown");
    expect(check({ approvedLabel: label, offeredLabels: [label, "Not authorized"] }))
      .toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_POLARITY_UNKNOWN" });
  });

  it("still reads the sentence forms employers actually write", () => {
    expect(optionPolarity("I do not require sponsorship")).toBe("negative");
    expect(optionPolarity("I will require sponsorship")).toBe("affirmative");
    expect(optionPolarity("Not authorized")).toBe("negative");
    // …and never mistakes a substring for an answer.
    expect(optionPolarity("Nothing selected")).toBe("unknown");
    expect(optionPolarity("November")).toBe("unknown");
  });
});

// --------------------------------------------------------------------------- //
// H. Scope — ordinary fields are not made to fail closed
// --------------------------------------------------------------------------- //
describe("H · non-consequential fields keep their existing behaviour", () => {
  it("passes a low-risk field straight through", () => {
    expect(checkConsequentialOption({
      canonicalKey: "referral_source", typedAnswer: null, approvedLabel: "Company website",
      offeredLabels: ["LinkedIn", "Company website"], safeSource: "saved_profile"
    })).toEqual({ ok: true });
    // Even from a source that would be refused for a consequential key: how the
    // candidate heard about a job asserts nothing about them.
    expect(checkConsequentialOption({
      canonicalKey: "referral_source", typedAnswer: null, approvedLabel: "Company website",
      offeredLabels: ["LinkedIn", "Company website"], safeSource: "job_description"
    })).toEqual({ ok: true });
  });

  it("passes an unclassified field through", () => {
    expect(checkConsequentialOption({
      canonicalKey: null, typedAnswer: null, approvedLabel: "anything",
      offeredLabels: [], safeSource: "none"
    })).toEqual({ ok: true });
  });

  it("leaves a non-boolean consequential answer to the demographic rules", () => {
    // gender/race carry no polarity; membership and uniqueness still apply.
    expect(checkConsequentialOption({
      canonicalKey: "gender", typedAnswer: null, approvedLabel: "Woman",
      offeredLabels: ["Man", "Woman", "Prefer not to say"], safeSource: "profile_eeo"
    })).toEqual({ ok: true });
    expect(checkConsequentialOption({
      canonicalKey: "gender", typedAnswer: null, approvedLabel: "Woman",
      offeredLabels: ["Man", "Woman", "Woman"], safeSource: "profile_eeo"
    })).toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_AMBIGUOUS" });
  });

  it("defers to the actuator when a closed menu offers nothing yet", () => {
    // A combobox that builds its menu on open reports no options while closed.
    // That is its resting state, not evidence — the same rule runs again in the
    // menu, where the options are real.
    expect(check({ offeredLabels: [] })).toEqual({ ok: true });
    expect(check({ offeredLabels: [], approvedLabel: "Yes" }))
      .toEqual({ ok: false, reason: "CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER" });
  });
});
