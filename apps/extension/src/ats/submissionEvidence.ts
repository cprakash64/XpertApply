/**
 * Fail-closed evaluation of evidence produced by an ATS after the user submits.
 *
 * A false positive silently removes a job the user still needs to apply to; a
 * false negative leaves the existing explicit “Mark as applied” fallback. For
 * that reason clicks, disabled controls, form disappearance, ordinary URL
 * changes, and timeouts are never confirmations by themselves.
 */

export type EvidenceType = "success_page" | "success_response" | "success_message";

export type WeakEvidenceReason =
  | "NO_SUCCESS_SIGNAL"
  | "SUBMIT_CLICK_ONLY"
  | "FORM_DISAPPEARED_ONLY"
  | "URL_CHANGED_ONLY"
  | "AMBIGUOUS_CONFIRMATION";

export type SubmissionEvidence =
  | { confirmed: true; evidenceType: EvidenceType; reference: string | null }
  | { confirmed: false; reason: WeakEvidenceReason };

export interface ObservedSubmissionSignals {
  url: string;
  visibleText: string;
  formStillPresent: boolean;
  submitClicked: boolean;
  submissionResponse?: { ok: boolean; status: number; reference?: string | null } | null;
}

const MAX_TEXT = 20_000;

const SUCCESS_URL_PATTERNS = [
  /\/application[_-]?(?:submitted|complete|confirmation)(?:\/|$|\?)/i,
  /\/applications\/[^/]+\/(?:confirmation|submitted)(?:\/|$|\?)/i,
  /\/confirmation\/application(?:\/|$|\?)/i,
  /\/applications\/submitted(?:\/|$|\?)/i,
  /[?&](?:application_?submitted|submitted)=(?:1|true)(?:&|$)/i
] as const;

const SUCCESS_MESSAGE_PATTERNS = [
  /\byour application (?:has been|was) (?:successfully )?(?:submitted|received|sent)\b/i,
  /\bapplication (?:successfully )?(?:submitted|received)\b/i,
  /\bthank(?:s| you) for (?:applying|your application)\b/i,
  /\bwe(?:'ve| have) received your application\b/i,
  /\byour application is complete\b/i,
  /\bsubmission (?:was )?successful\b/i
] as const;

const NEGATIVE_MESSAGE_PATTERNS = [
  /\bbefore (?:you )?submit\b/i,
  /\breview your application\b/i,
  /\bwill be submitted\b/i,
  /\bnot been submitted\b/i,
  /\bcould not (?:be )?(?:submit|complete)/i,
  /\bfailed to submit\b/i,
  /\bplease (?:correct|fix|complete)\b/i,
  /\berror\b/i,
  /\brequired field\b/i
] as const;

const REFERENCE_PATTERNS = [
  /\b(?:confirmation|reference|application)\s*(?:number|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,40})\b/i,
  /\bapplication\s+([A-Z]{2,}-\d{3,})\b/i
] as const;

export function matchesSuccessUrl(url: string): boolean {
  return SUCCESS_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export function matchesSuccessMessage(text: string): boolean {
  const sample = text.slice(0, MAX_TEXT);
  if (NEGATIVE_MESSAGE_PATTERNS.some((pattern) => pattern.test(sample))) return false;
  return SUCCESS_MESSAGE_PATTERNS.some((pattern) => pattern.test(sample));
}

export function extractSubmissionReference(text: string): string | null {
  const sample = text.slice(0, MAX_TEXT);
  for (const pattern of REFERENCE_PATTERNS) {
    const match = sample.match(pattern);
    if (match?.[1]) return match[1].slice(0, 200);
  }
  return null;
}

export function evaluateSubmissionEvidence(
  signals: ObservedSubmissionSignals
): SubmissionEvidence {
  const response = signals.submissionResponse;
  if (response?.ok && response.status >= 200 && response.status < 300) {
    return {
      confirmed: true,
      evidenceType: "success_response",
      reference: response.reference?.slice(0, 200) ?? extractSubmissionReference(signals.visibleText)
    };
  }

  if (matchesSuccessUrl(signals.url)) {
    return {
      confirmed: true,
      evidenceType: "success_page",
      reference: extractSubmissionReference(signals.visibleText)
    };
  }

  if (matchesSuccessMessage(signals.visibleText)) {
    if (signals.formStillPresent) return { confirmed: false, reason: "AMBIGUOUS_CONFIRMATION" };
    return {
      confirmed: true,
      evidenceType: "success_message",
      reference: extractSubmissionReference(signals.visibleText)
    };
  }

  if (signals.submitClicked && !signals.formStillPresent) {
    return { confirmed: false, reason: "FORM_DISAPPEARED_ONLY" };
  }
  if (signals.submitClicked) return { confirmed: false, reason: "SUBMIT_CLICK_ONLY" };
  if (!signals.formStillPresent) return { confirmed: false, reason: "URL_CHANGED_ONLY" };
  return { confirmed: false, reason: "NO_SUCCESS_SIGNAL" };
}
