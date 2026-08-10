/**
 * Deciding whether an ATS actually accepted a submission.
 *
 * This module is the gate on the only automated path that can move a job into
 * the user's Tracker, so it is written to be *hard to satisfy*. A false positive
 * silently removes a job from discovery that the user still needs to apply to,
 * and they will never find out until the role is filled. A false negative costs
 * one click on "Mark as applied". The asymmetry is the whole design.
 *
 * ACCEPTED evidence — all describe something the ATS did AFTER taking the
 * application:
 *   • success_page     the ATS navigated to a confirmation URL it only serves
 *                      post-submission;
 *   • success_response a submission XHR/fetch returned an explicit success;
 *   • success_message  the application frame renders a deterministic
 *                      confirmation phrase, and the form is gone.
 *
 * REJECTED — every one of these fires routinely on applications that were never
 * submitted, so none of them may confirm on its own:
 *   • the submit button being clicked;
 *   • the submit button becoming disabled (fires on validation failures too);
 *   • the form disappearing (fires on multi-step navigation and on re-render);
 *   • a URL change (fires on every step of a paginated application);
 *   • a timeout after clicking (fires whenever the ATS is merely slow).
 */

export type EvidenceType = "success_page" | "success_response" | "success_message";

export type SubmissionEvidence =
  | { confirmed: true; evidenceType: EvidenceType; reference: string | null }
  | { confirmed: false; reason: WeakEvidenceReason };

/** Why the extension declined to confirm. Machine codes, never free text. */
export type WeakEvidenceReason =
  | "NO_SUCCESS_SIGNAL"
  | "SUBMIT_CLICK_ONLY"
  | "FORM_DISAPPEARED_ONLY"
  | "URL_CHANGED_ONLY"
  | "AMBIGUOUS_CONFIRMATION";

/** Signals the caller observed. Deliberately includes the weak ones so this
 * module — not the call site — decides what they are worth. */
export interface ObservedSignals {
  url: string;
  /** Visible text of the application frame, already trimmed by the caller. */
  visibleText: string;
  /** Whether an application form is still present in the frame. */
  formStillPresent: boolean;
  /** Whether the user clicked the ATS submit button in this run. */
  submitClicked: boolean;
  /** Explicit success reported by an observed submission request, when the
   * adapter is able to see one. */
  submissionResponse?: { ok: boolean; status: number; reference?: string | null } | null;
}

/**
 * URL patterns an ATS only serves AFTER a completed submission.
 *
 * Each is anchored to a path segment rather than a substring, so a job listing
 * at `/careers/thank-you-for-your-interest-in-us` cannot masquerade as a
 * confirmation. `/confirmation` is included only with an explicit application
 * or submitted qualifier for the same reason.
 */
const SUCCESS_URL_PATTERNS: RegExp[] = [
  // Greenhouse / Lever / Ashby style post-submit landings.
  /\/application[_-]?(?:submitted|complete|confirmation)(?:\/|$|\?)/i,
  /\/(?:thanks|thank[_-]you)(?:\/|$|\?)/i,
  /\/applications\/[^/]+\/(?:confirmation|submitted)(?:\/|$|\?)/i,
  /\/confirmation\/application(?:\/|$|\?)/i,
  // Workday's post-submit task page.
  /\/applications\/submitted(?:\/|$|\?)/i,
  // Explicit query flag some boards set on the confirmation render.
  /[?&](?:application_?submitted|submitted)=(?:1|true)(?:&|$)/i
];

/**
 * Phrases that only appear once an application has been accepted.
 *
 * Every entry asserts a COMPLETED action in the past tense. Forward-looking
 * copy that appears before submitting ("review your application then submit",
 * "your application will be sent") is intentionally absent, and so is bare
 * "thank you", which appears on plenty of pre-submission pages.
 */
const SUCCESS_MESSAGE_PATTERNS: RegExp[] = [
  /\byour application (?:has been|was) (?:successfully )?(?:submitted|received|sent)\b/i,
  /\bapplication (?:successfully )?(?:submitted|received)\b/i,
  /\bthank(?:s| you) for (?:applying|your application)\b/i,
  /\bwe(?:'ve| have) received your application\b/i,
  /\byour application is complete\b/i,
  /\bsubmission (?:was )?successful\b/i
];

/**
 * Copy that LOOKS like success but is shown before or instead of one. Matching
 * any of these vetoes a message-based confirmation outright, because these
 * phrases co-occur with the success wording on review and error screens.
 */
const NEGATIVE_MESSAGE_PATTERNS: RegExp[] = [
  /\bbefore (?:you )?submit\b/i,
  /\breview your application\b/i,
  /\bwill be submitted\b/i,
  /\bnot been submitted\b/i,
  /\bcould not (?:be )?(?:submit|complete)/i,
  /\bfailed to submit\b/i,
  /\bplease (?:correct|fix|complete)\b/i,
  /\berror\b/i,
  /\brequired field\b/i
];

/** Confirmation/reference numbers an ATS shows on its success screen. */
const REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:confirmation|reference|application)\s*(?:number|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,40})\b/i,
  /\bapplication\s+([A-Z]{2,}-\d{3,})\b/i
];

const MAX_TEXT = 20_000;

export function matchesSuccessUrl(url: string): boolean {
  return SUCCESS_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export function matchesSuccessMessage(text: string): boolean {
  const sample = text.slice(0, MAX_TEXT);
  if (NEGATIVE_MESSAGE_PATTERNS.some((pattern) => pattern.test(sample))) {
    return false;
  }
  return SUCCESS_MESSAGE_PATTERNS.some((pattern) => pattern.test(sample));
}

export function extractSubmissionReference(text: string): string | null {
  const sample = text.slice(0, MAX_TEXT);
  for (const pattern of REFERENCE_PATTERNS) {
    const match = sample.match(pattern);
    if (match?.[1]) {
      return match[1].slice(0, 200);
    }
  }
  return null;
}

/**
 * The single decision point. Returns a confirmation only for evidence the ATS
 * itself produced; everything else returns the specific reason it was refused
 * so the side panel can ask the user instead.
 */
export function evaluateSubmissionEvidence(signals: ObservedSignals): SubmissionEvidence {
  // 1. Strongest: the submission request itself came back successful.
  const response = signals.submissionResponse;
  if (response && response.ok && response.status >= 200 && response.status < 300) {
    return {
      confirmed: true,
      evidenceType: "success_response",
      reference: response.reference?.slice(0, 200) ?? extractSubmissionReference(signals.visibleText)
    };
  }

  // 2. The ATS navigated to a page it only serves after accepting an application.
  if (matchesSuccessUrl(signals.url)) {
    return {
      confirmed: true,
      evidenceType: "success_page",
      reference: extractSubmissionReference(signals.visibleText)
    };
  }

  // 3. A deterministic confirmation message. Requires the form to be GONE as
  //    well: an ATS that still renders the application form alongside the words
  //    "application submitted" is a review screen, not a receipt.
  if (matchesSuccessMessage(signals.visibleText)) {
    if (signals.formStillPresent) {
      return { confirmed: false, reason: "AMBIGUOUS_CONFIRMATION" };
    }
    return {
      confirmed: true,
      evidenceType: "success_message",
      reference: extractSubmissionReference(signals.visibleText)
    };
  }

  // Everything below is a NON-confirmation, reported with the reason it failed
  // so the UI can explain itself and offer manual confirmation.
  if (signals.submitClicked && !signals.formStillPresent) {
    return { confirmed: false, reason: "FORM_DISAPPEARED_ONLY" };
  }
  if (signals.submitClicked) {
    return { confirmed: false, reason: "SUBMIT_CLICK_ONLY" };
  }
  if (!signals.formStillPresent) {
    return { confirmed: false, reason: "URL_CHANGED_ONLY" };
  }
  return { confirmed: false, reason: "NO_SUCCESS_SIGNAL" };
}

/** The typed event posted to the API when — and only when — evidence is strong. */
export interface SubmissionConfirmedEvent {
  event_type: "application_submission_confirmed";
  /** Server-derived in practice: the session id is the trusted job identifier.
   * The extension never sends a job id, user id, or status of its own. */
  session_id: number;
  ats: string | null;
  submission_timestamp: string;
  submission_reference: string | null;
  evidence_type: EvidenceType;
}

export function buildConfirmationEvent(
  sessionId: number,
  ats: string | null,
  evidence: Extract<SubmissionEvidence, { confirmed: true }>,
  now: Date = new Date()
): SubmissionConfirmedEvent {
  return {
    event_type: "application_submission_confirmed",
    session_id: sessionId,
    ats,
    submission_timestamp: now.toISOString(),
    submission_reference: evidence.reference,
    evidence_type: evidence.evidenceType
  };
}
