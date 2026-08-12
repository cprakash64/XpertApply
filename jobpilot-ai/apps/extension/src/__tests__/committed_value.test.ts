/**
 * Did the control actually keep the answer?
 *
 * The live TikTok defect: work authorization visibly displayed "Yes" and
 * XpertApply still reported "XpertApply could not keep this selection", offering to
 * re-select an answer that was already correct. The comparison was an exact
 * string equality against the trigger's whole `textContent`, and a real widget's
 * trigger is never a bare text node — it carries a caret glyph, a clear
 * affordance, or a visually hidden label.
 *
 * These tests pin BOTH directions: decorated markup showing the right answer
 * must verify, and anything showing the wrong answer must not.
 */
import { describe, expect, it } from "vitest";
import { booleanPolarity, committedValueMatches } from "../content/dropdownTransaction";

const YES_NO = ["Yes", "No"];

describe("committed value verification", () => {
  it("accepts an exact match", () => {
    expect(committedValueMatches("Yes", "Yes", true, YES_NO)).toBe(true);
    expect(committedValueMatches("No", "No", false, YES_NO)).toBe(true);
  });

  it.each([
    ["a caret glyph", "Yes ▾"],
    ["a clear affordance", "Yes ×"],
    ["surrounding whitespace and newlines", "\n  Yes\n "],
    ["a visually hidden label", "Work authorization Yes"],
    ["a selected-value prefix", "Selected: Yes"]
  ])("verifies a correctly filled control decorated with %s", (_label, displayed) => {
    // Every one of these returned "could not keep this selection" before.
    expect(committedValueMatches(displayed, "Yes", true, YES_NO)).toBe(true);
  });

  it("rejects the opposite answer even when the approved label appears nearby", () => {
    // The safety property. "No" is showing; "Yes" was approved.
    expect(committedValueMatches("No", "Yes", true, YES_NO)).toBe(false);
    expect(committedValueMatches("Yes", "No", false, YES_NO)).toBe(false);
    // A trigger whose markup names both options has NOT committed either.
    expect(committedValueMatches("Yes No", "Yes", true, YES_NO)).toBe(false);
  });

  it("never mistakes a substring for an answer", () => {
    // Token matching, not substring: the "no" inside these words is not the
    // option "No", and none of them carries a boolean polarity either.
    for (const displayed of ["Nothing selected", "Not yet answered", "November"]) {
      expect(committedValueMatches(displayed, "No", false, YES_NO), displayed).toBe(false);
      expect(booleanPolarity(displayed), displayed).toBe("unknown");
    }
    // "Not authorized" is different in kind: it is a real negative answer, and
    // accepting it is correct rather than a substring accident.
    expect(booleanPolarity("Not authorized")).toBe("negative");
    expect(committedValueMatches("Not authorized", "No", false)).toBe(true);
    expect(committedValueMatches("Not authorized", "Yes", true)).toBe(false);
  });

  it("treats a blank or placeholder control as unfilled", () => {
    for (const blank of ["", "   ", "Select", "Please select", "—"]) {
      expect(committedValueMatches(blank, "Yes", true, YES_NO), blank).toBe(false);
      expect(committedValueMatches(blank, "No", false, YES_NO), blank).toBe(false);
    }
  });

  it("accepts employer wording that differs from the literal option label", () => {
    // The backend approved "No"; the employer renders the full sentence.
    expect(committedValueMatches("I do not require sponsorship", "No", false)).toBe(true);
    expect(committedValueMatches("Authorized", "Yes", true)).toBe(true);
    // …but the opposite sentence is still rejected.
    expect(committedValueMatches("I will require sponsorship", "No", false)).toBe(false);
  });

  it("stays strict when the answer is not boolean", () => {
    const options = ["Bachelor's degree", "Master's degree"];
    expect(committedValueMatches("Master's degree ▾", "Master's degree", null, options)).toBe(true);
    expect(committedValueMatches("Bachelor's degree", "Master's degree", null, options)).toBe(false);
  });
});
