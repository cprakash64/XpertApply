/**
 * The contract for what a review item may ASK THE BROWSER TO DO.
 *
 * Two rules shape this file, and every export exists to enforce one of them.
 *
 * 1. An action is only real if a handler exists. The review list previously
 *    described actions ("confirm this answer", "retry this field") that nothing
 *    implemented, so the widget rendered text the user could not act on. The
 *    action union here is exactly the set that is wired end to end.
 *
 * 2. The browser states only what the user CHOSE. Source, verification, scope
 *    and confirmation time are consequences the server derives from an
 *    authenticated action. A content script that could name them could mint a
 *    trusted legal answer, so they are rejected — not ignored — at every
 *    boundary the request crosses.
 */

/** Actions a review item may offer. The widget renders only these. */
export type ReviewAction =
  | "focus_control"
  | "answer_for_this_application"
  | "apply_approved_answer"
  | "leave_unresolved";

export const REVIEW_ACTIONS: readonly ReviewAction[] = [
  "focus_control",
  "answer_for_this_application",
  "apply_approved_answer",
  "leave_unresolved"
];

/**
 * Answer types the application-only answer UI can present.
 *
 * Boolean only, deliberately. A yes/no question has a bounded, enumerable set
 * of user choices, so "the user picked one of two things" is verifiable. Free
 * text is not, and is not offered here.
 */
export type ReviewAnswerType = "boolean";

/**
 * Canonical questions that may be answered for one application.
 *
 * A subset of the registry, not a mirror of it: consent, attestations and
 * demographics are the user's signature and are excluded server-side too. This
 * list is the client-side half of that agreement, so an unanswerable question
 * never even renders a button.
 */
export const APPLICATION_ANSWERABLE_BOOLEANS: ReadonlySet<string> = new Set([
  "work_authorization_us",
  "sponsorship_required_now",
  "sponsorship_required_future",
  "sponsorship_required_now_or_future"
]);

/**
 * Which OTHER employer questions an answer changes the resolution of.
 *
 * "Do you require sponsorship now?" and "…in the future?" are the components of
 * the combined question many employers actually ask. Answering a component
 * changes what the combined question resolves to, so its control must be
 * re-resolved as well or the page would show two answers that disagree.
 *
 * The reverse does not hold: a direct answer to the combined question says
 * nothing about either component, and must not be decomposed into them.
 */
export const OVERRIDE_DEPENDENTS: Readonly<Record<string, readonly string[]>> = {
  sponsorship_required_now: ["sponsorship_required_now_or_future"],
  sponsorship_required_future: ["sponsorship_required_now_or_future"],
  sponsorship_required_now_or_future: []
};

/** Every canonical key whose employer control must be re-resolved. */
export function affectedCanonicalKeys(canonicalKey: string): string[] {
  return [canonicalKey, ...(OVERRIDE_DEPENDENTS[canonicalKey] ?? [])];
}

/**
 * A user's explicit answer for one application, on its way to the server.
 *
 * `sessionId` is context the extension already holds, not a claim: the server
 * authenticates the session token and derives the user and the job from it, so
 * naming the wrong session gets a 403/404 rather than someone else's answer.
 */
export interface OverrideRequest {
  action: "answer_for_this_application";
  /** The ledger key, so the outcome updates the entry it came from. */
  fieldKey: string;
  /** A canonical key the resolver itself returned for this field. */
  canonicalKey: string;
  answerType: ReviewAnswerType;
  /** The bounded choice the user made. Never a default. */
  value: boolean;
  sessionId: number;
}

export interface LeaveUnresolvedRequest {
  action: "leave_unresolved";
  fieldKey: string;
}

/**
 * Fields that would let a caller assert provenance.
 *
 * Checked by name rather than by shape: a request carrying `verified: false` is
 * as much a policy violation as one carrying `verified: true`, because the next
 * version of the caller could flip it.
 */
export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = [
  "user_id",
  "userId",
  "job_id",
  "jobId",
  "source",
  "safe_source",
  "safeSource",
  "trusted_source",
  "trustedSource",
  "verified",
  "verification",
  "reusable",
  "scope",
  "confirmed_at",
  "confirmedAt",
  "confirmation_timestamp",
  "version",
  "answer_contract_version",
  "id",
  "answer_id",
  "answerId",
  "sensitivity",
  "sensitivity_override",
  "sensitivityOverride"
];

export type ValidationFailure = { ok: false; reason: string };
export type ValidationSuccess<T> = { ok: true; request: T };
export type Validation<T> = ValidationSuccess<T> | ValidationFailure;

function hasForbiddenField(raw: Record<string, unknown>): string | null {
  for (const field of FORBIDDEN_REQUEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) return field;
  }
  return null;
}

/**
 * Validate an override request at a boundary.
 *
 * Called at all four: the widget that builds it, the content script that acts
 * on it, the background message handler that receives it, and the API client
 * that serializes it. Repeating the check is the point — each boundary is
 * reachable from a different attacker position, and none of them may assume an
 * earlier one ran.
 */
export function validateOverrideRequest(raw: unknown): Validation<OverrideRequest> {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "malformed_request" };
  const candidate = raw as Record<string, unknown>;

  const forbidden = hasForbiddenField(candidate);
  if (forbidden) return { ok: false, reason: "provenance_not_accepted" };

  if (candidate.action !== "answer_for_this_application") {
    return { ok: false, reason: "unknown_action" };
  }
  if (typeof candidate.fieldKey !== "string" || !candidate.fieldKey) {
    return { ok: false, reason: "field_key_missing" };
  }
  if (typeof candidate.canonicalKey !== "string" || !candidate.canonicalKey) {
    return { ok: false, reason: "canonical_key_missing" };
  }
  if (!APPLICATION_ANSWERABLE_BOOLEANS.has(candidate.canonicalKey)) {
    return { ok: false, reason: "canonical_key_not_answerable" };
  }
  if (candidate.answerType !== "boolean") {
    return { ok: false, reason: "answer_type_not_supported" };
  }
  // Strictly a boolean. A truthy string would be an inferred answer, and the
  // one thing a legal answer may never be is inferred.
  if (typeof candidate.value !== "boolean") {
    return { ok: false, reason: "explicit_choice_required" };
  }
  if (typeof candidate.sessionId !== "number" || !Number.isInteger(candidate.sessionId)) {
    return { ok: false, reason: "session_context_missing" };
  }

  return {
    ok: true,
    // Rebuilt rather than passed through, so an unrecognised extra property
    // cannot ride along to the network layer.
    request: {
      action: "answer_for_this_application",
      fieldKey: candidate.fieldKey,
      canonicalKey: candidate.canonicalKey,
      answerType: "boolean",
      value: candidate.value,
      sessionId: candidate.sessionId
    }
  };
}

/**
 * The request body for the override endpoint.
 *
 * One key. Everything else about the answer — that it is user-confirmed, that
 * it is scoped to this application, when it was confirmed — is the server's to
 * decide, and this is where that guarantee is made structural.
 */
export function overrideRequestBody(request: OverrideRequest): { value: boolean } {
  return { value: request.value };
}

// --------------------------------------------------------------------------- //
// What the user reads before choosing
// --------------------------------------------------------------------------- //
/** Said on every application-only answer, so the scope is never a surprise. */
export const APPLICATION_ONLY_NOTE = "Use this answer only for this application.";

/**
 * Said additionally on the combined question.
 *
 * The combined answer is not a statement about either component, and the user
 * has to know that before choosing — otherwise "yes, I need sponsorship" here
 * would read as an edit to the two saved answers it deliberately does not touch.
 */
export const COMBINED_SPONSORSHIP_NOTE =
  "This does not update your saved current or future sponsorship answers.";

export function answerNotesFor(canonicalKey: string): string[] {
  const notes = [APPLICATION_ONLY_NOTE];
  if (canonicalKey === "sponsorship_required_now_or_future") notes.push(COMBINED_SPONSORSHIP_NOTE);
  return notes;
}

/** Why an override attempt failed, in words that assume nothing about it. */
export const OVERRIDE_FAILURE_COPY: Readonly<Record<string, string>> = {
  SESSION_UNAUTHORIZED: "EZJobFind lost access to this application. Reopen it from EZJobFind and try again.",
  SESSION_FORBIDDEN: "EZJobFind lost access to this application. Reopen it from EZJobFind and try again.",
  SESSION_NOT_FOUND: "EZJobFind could not find this application session. Reopen it from EZJobFind.",
  SESSION_EXPIRED: "This application session has expired. Reopen the application from EZJobFind to answer it here.",
  ANSWER_NOT_PERMITTED: "EZJobFind cannot answer this question for you. Please answer it on the employer's form.",
  NETWORK_UNAVAILABLE: "EZJobFind could not reach the server. Check your connection and try again.",
  TIMEOUT: "EZJobFind could not reach the server in time. Try again.",
  SELECTION_FAILED: "Your answer was saved for this application, but the employer's control did not keep it. Use \"Jump to question\" and set it there.",
  CONTROL_NOT_FOUND: "Your answer was saved for this application, but EZJobFind can no longer find that question on the page.",
  UNKNOWN: "EZJobFind could not complete that. Nothing was changed on the employer's form."
};

export function overrideFailureMessage(code: string): string {
  return OVERRIDE_FAILURE_COPY[code] ?? OVERRIDE_FAILURE_COPY.UNKNOWN;
}
