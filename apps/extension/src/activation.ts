import type { LaunchViewState } from "./messages";

/**
 * One name for "where is this tab in the activation lifecycle", derived from the stored view and
 * never invented by the UI. It keeps apart things that used to blur into "Detecting…": Chrome's site
 * access, the script being present, an application being recognised, and the fill engine's progress.
 */
export type ActivationState =
  | "SITE_ACCESS_UNKNOWN"
  | "SITE_ACCESS_REQUIRED"
  | "SITE_ACCESS_REQUESTED"
  | "SITE_ACCESS_GRANTED"
  | "SITE_ACCESS_DENIED"
  | "SITE_ACCESS_REVOKED"
  | "CONTENT_SCRIPT_READY"
  | "APPLICATION_DETECTED"
  | "AUTOFILL_READY"
  | "AUTOFILL_RUNNING"
  | "REVIEW_REQUIRED"
  | "ERROR";

type ViewFacts = Pick<LaunchViewState,
  "siteAccess" | "siteAccessRequestedAt" | "contentReady" | "packageLoaded" | "running" | "state" |
  "failureCode" | "failureRecoverable" | "atsId" | "sessionId" | "reviewRequired" | "fieldsDiscovered">;

/** Failures that are an honest "nothing to fill yet", not a malfunction. */
const NOT_AN_ERROR = new Set(["DIRECT_VISIT_NO_SESSION", "HANDOFF_NOT_FOUND"]);

export function deriveActivationState(view: ViewFacts): ActivationState {
  switch (view.siteAccess) {
    case "site_access_required": return view.siteAccessRequestedAt ? "SITE_ACCESS_REQUESTED" : "SITE_ACCESS_REQUIRED";
    case "site_access_denied": return "SITE_ACCESS_DENIED";
    case "site_access_revoked": return "SITE_ACCESS_REVOKED";
    default: break;
  }
  if (view.failureCode && !NOT_AN_ERROR.has(view.failureCode)) return "ERROR";
  if (view.running) return "AUTOFILL_RUNNING";
  if (view.state === "completed_with_review" || (view.state === "completed" && view.reviewRequired > 0)) return "REVIEW_REQUIRED";
  if (view.state === "completed") return "AUTOFILL_READY";
  if (view.sessionId != null && view.packageLoaded) return view.fieldsDiscovered > 0 ? "AUTOFILL_READY" : "APPLICATION_DETECTED";
  if (view.atsId || (view.failureCode && NOT_AN_ERROR.has(view.failureCode))) return "APPLICATION_DETECTED";
  if (view.contentReady) return "CONTENT_SCRIPT_READY";
  return view.siteAccess === "site_access_granted" ? "SITE_ACCESS_GRANTED" : "SITE_ACCESS_UNKNOWN";
}

/** The line the assistant shows for a state, or null to keep the workflow engine's own wording (filling, reading, ...). */
export function activationLabel(state: ActivationState, site: string | null): string | null {
  const where = site ? ` for ${site}` : "";
  switch (state) {
    case "SITE_ACCESS_REQUIRED": return `Permission required${where}`;
    case "SITE_ACCESS_REQUESTED": return "Waiting for your approval in Chrome";
    case "SITE_ACCESS_DENIED": return `Access declined${where}`;
    case "SITE_ACCESS_REVOKED": return `Access was removed${where}`;
    case "APPLICATION_DETECTED": return "Application recognized";
    case "CONTENT_SCRIPT_READY": return "Connected — loading your application";
    default: return null;
  }
}
