import { describe, expect, it } from "vitest";
import { requiredReviewRemaining, type QuestionEntry, type QuestionState } from "../content/questionLedger";
import { completionFailure } from "../completionAuthority";
import type { LaunchViewState } from "../messages";

const entry = (state: QuestionState, required: boolean) => ({ state, required }) as QuestionEntry;
describe("required completion review", () => {
  it.each(["answer_missing", "requires_confirmation", "requires_user_gesture", "interaction_failed", "sensitive_manual", "unsupported", "discovered", "selecting"] as const)("preserves requiredness in %s", state => {
    expect(requiredReviewRemaining([entry(state, true), entry(state, false)])).toBe(1);
  });
  it("excludes optional skips and verified required fields", () => {
    expect(requiredReviewRemaining([entry("optional_skipped", false), entry("filled_verified", true)])).toBe(0);
    expect(requiredReviewRemaining([entry("optional_skipped", true)])).toBe(1);
  });
  it.each([undefined, -1, NaN, 0.5])("fails closed on unavailable or invalid projection %s", count => {
    expect(completionFailure({ state: "completed", packageLoaded: true, contentReady: true, requiredReviewRemaining: count } as LaunchViewState)).toBe("COMPLETION_STATE_UNAVAILABLE");
  });
});
