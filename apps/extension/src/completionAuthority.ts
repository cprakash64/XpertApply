import type { LaunchViewState } from "./messages";

export type CompletionFailure = "REQUIRED_REVIEW_REMAINING" | "COMPLETION_STATE_UNAVAILABLE";
export class CompletionPrerequisiteError extends Error {
  constructor(readonly code: CompletionFailure) { super(code); }
}

/** A stored, current worker view is the prerequisite, never completion payload
 * counts or visible copy. Older/missing projections remain fail closed. */
export function completionFailure(view: LaunchViewState | null | undefined): CompletionFailure | null {
  if (!view || view.running || !view.packageLoaded || !view.contentReady
    || !["completed", "completed_with_review"].includes(view.state)
    || !Number.isSafeInteger(view.requiredReviewRemaining) || view.requiredReviewRemaining! < 0) return "COMPLETION_STATE_UNAVAILABLE";
  return view.requiredReviewRemaining! > 0 ? "REQUIRED_REVIEW_REMAINING" : null;
}

export function requireCompletionReady(view: LaunchViewState | null | undefined): void {
  const failure = completionFailure(view);
  if (failure) throw new CompletionPrerequisiteError(failure);
}
