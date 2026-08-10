import { api } from "@/lib/api";
import { invalidateDashboardSummary } from "@/lib/dashboardSummary";

/**
 * The client half of the "successful application moves to Tracker" flow.
 *
 * There is exactly one endpoint that can move a job into the Tracker, and this
 * is the only place the web app calls it. Opening the employer site goes
 * nowhere near here — that path only opens a URL and records that the page was
 * opened.
 */

export type AppliedSource = "extension_confirmed" | "auto_apply_confirmed" | "user_confirmed";

export type ConfirmedApplication = {
  id: number;
  job_id: number;
  status: string;
  applied_at: string | null;
  applied_source: AppliedSource | null;
  submission_reference: string | null;
  opened_at: string | null;
  application_url: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type ConfirmAppliedResult = {
  application: ConfirmedApplication;
  /** Whether the backend created the record or updated an existing one. */
  created: boolean;
  /** True when this job was already applied — a repeated confirmation. */
  already_applied: boolean;
  job_id: number;
};

/**
 * Explicit user confirmation that they submitted this application.
 *
 * ``confirmed: true`` is required by the server, so this cannot fire by
 * accident. The job comes from the path and the user from the session cookie's
 * bearer token; the body never carries an owner, a status, or a job identity.
 */
export function confirmApplied(jobId: number): Promise<ConfirmAppliedResult> {
  return api<ConfirmAppliedResult>(`/jobs/${jobId}/applications/confirm-applied`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true })
  }).then((result) => {
    // This moves a job out of discovery and into the tracker, so both the
    // fresh-match count and the pipeline counts change. Dropping the cached
    // summary here means the Dashboard shows the new numbers on the next visit
    // instead of the pre-application ones.
    invalidateDashboardSummary();
    return result;
  });
}

/** Shown only after the backend transaction has actually succeeded. */
export const APPLIED_TOAST = "Application marked as applied and moved to Tracker.";

/**
 * Which job to open once the applied one is removed from the list.
 *
 * Rule: the next visible job, otherwise the previous visible job, otherwise no
 * selection at all (an intentional empty state). Returning `null` is a real
 * answer here, not a failure — the caller must clear `?job=` rather than leave
 * the detail pane rendering a job that is no longer in the list.
 */
export function nextSelectionAfterRemoval<T extends { id: number }>(
  visible: T[],
  removedId: number
): number | null {
  const index = visible.findIndex((item) => item.id === removedId);
  if (index === -1) {
    return null;
  }
  const next = visible[index + 1];
  if (next) {
    return next.id;
  }
  const previous = visible[index - 1];
  return previous ? previous.id : null;
}
