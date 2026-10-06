import type { LaunchViewState, ProgressPayload } from "../messages";
import { requiredReviewRemaining, type QuestionCounts, type QuestionEntry } from "./questionLedger";

/** Project the same ledger buckets used by the review facade into worker state.
 * Keep document outcomes and workflow authority from the accepted Fill result.
 * In-flight questions are not completed review outcomes; optional skips are
 * separate from review, and each terminal unresolved question counts once.
 */
export function projectWorkflowProgress(base: ProgressPayload, counts: QuestionCounts, entries?: readonly QuestionEntry[]): ProgressPayload {
  const reviewRequired = counts.needs_information + counts.needs_confirmation
    + counts.needs_user_gesture + counts.technical_issues
    + counts.legal_manual_actions + counts.unsupported;
  return {
    ...base,
    fieldsDiscovered: counts.discovered,
    filled: counts.filled_and_verified,
    skipped: counts.optional_skipped,
    reviewRequired,
    requiredReviewRemaining: entries ? requiredReviewRemaining(entries) : undefined,
    state: base.state === "completed" && reviewRequired > 0 ? "completed_with_review" : base.state
  };
}

/** Readiness re-registers a document; it does not restart an accepted workflow.
 * Initial package loading still owns fetching_package. Evaluate this inside
 * the worker's serialized view mutation so a newer Fill cannot be overwritten.
 */
export function contentReadyViewPatch(view: LaunchViewState): Partial<LaunchViewState> {
  return { contentReady: true, state: view.packageLoaded ? view.state : "fetching_package" };
}
