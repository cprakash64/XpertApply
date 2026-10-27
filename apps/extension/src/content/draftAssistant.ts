/**
 * "Suggest answers" for open-ended employer questions, as a decision procedure.
 *
 * The backend (`POST /application-sessions/{id}/draft-answers`) does the drafting and is gated by
 * APPLICATION_ANSWER_DRAFTING_ENABLED. This module is the part that must stay honest on the page:
 *
 *  - only EMPTY, visible, enabled free-text boxes with a real question are offered;
 *  - sensitive / legal / self-identification questions are never sent (the server refuses them too);
 *  - a draft is a PROPOSAL the user reviews and edits; nothing is written to the employer's page
 *    until the user presses Apply, and a box the user has typed in since is never overwritten;
 *  - nothing here can submit the application.
 *
 * It is kept free of the DOM and the network so the rules can be tested without a page or a worker.
 */

import { detectSensitive } from "../fields/sensitive";
import type { DiscoveredField } from "../types";

/** Same bound as the server (`DraftAnswersIn.questions`). */
export const MAX_DRAFT_QUESTIONS = 8;
const MIN_QUESTION_LENGTH = 12;
/** Server: `DraftQuestionIn.question` max_length. */
const MAX_QUESTION_LENGTH = 600;
const MAX_FIELD_REF = 128;

export interface DraftCandidate {
  fieldKey: string;
  question: string;
  required: boolean;
  /** The employer's own character limit, when the control declares one. */
  maxLength: number | null;
}

/** The wire shape of one question, exactly as the server schema accepts it. */
export interface DraftQuestionRequest {
  field_identifier: string;
  question: string;
  control_type: "textarea";
  max_length?: number;
  required: boolean;
}

export type DraftStatus =
  | "drafted"
  | "partial"
  | "insufficient_evidence"
  | "needs_user_answer"
  | "not_drafted"
  | "invalid_response"
  | "unavailable";

export interface DraftSuggestion {
  fieldKey: string;
  status: DraftStatus;
  /** Empty unless status is drafted or partial. */
  text: string;
  /** What the applicant must supply, in plain words from the server. */
  missing: string[];
}

const STATUSES: ReadonlySet<string> = new Set<DraftStatus>([
  "drafted",
  "partial",
  "insufficient_evidence",
  "needs_user_answer",
  "not_drafted",
  "invalid_response",
  "unavailable"
]);

/**
 * Wording the applicant alone answers (authorization, sponsorship, pay, availability,
 * demographics, legal attestations). Mirrors the server's refusal list so such a question
 * is not even sent; the server still enforces it independently.
 */
const USER_ONLY_QUESTION =
  /sponsor|visa|work(?:ing)?\s+authori[sz]|authori[sz]ed\s+to\s+work|right\s+to\s+work|salary|compensation|pay\s+expect|expected\s+pay|desired\s+pay|relocat|notice\s+period|start\s+date|when\s+can\s+you\s+start|availab|gender|race|ethnic|veteran|disabilit|pronoun|sexual|religio|criminal|convict|felony|background\s+check|consent|agree|acknowledg|certify|attest|declar|privacy|terms|citizen|nationalit|date\s+of\s+birth|social\s+security|non-?compete|conflict\s+of\s+interest|previously\s+(?:worked|employed|applied)/i;

function questionText(field: DiscoveredField): string {
  return (field.label || field.ariaLabel || "").replace(/\s+/g, " ").trim();
}

/** Free-text boxes worth offering a draft for. */
export function collectDraftCandidates(fields: DiscoveredField[]): DraftCandidate[] {
  const seen = new Set<string>();
  const out: DraftCandidate[] = [];
  for (const field of fields) {
    if (out.length >= MAX_DRAFT_QUESTIONS) break;
    if (field.control !== "textarea" || !field.visible || field.disabled) continue;
    if (field.uid.length === 0 || field.uid.length > MAX_FIELD_REF || seen.has(field.uid)) continue;
    // Never overwrite or "improve" something the applicant (or autofill) already wrote.
    if (field.existingValue.trim() !== "") continue;
    const question = questionText(field);
    if (question.length < MIN_QUESTION_LENGTH) continue;
    // Sensitive / self-identification wording is the applicant's to answer, never drafted.
    if (USER_ONLY_QUESTION.test(question) || detectSensitive(`${question} ${field.sectionHeading}`).sensitive) continue;
    const declared = field.element instanceof HTMLTextAreaElement ? field.element.maxLength : -1;
    seen.add(field.uid);
    out.push({
      fieldKey: field.uid,
      question: question.slice(0, MAX_QUESTION_LENGTH),
      required: field.required,
      maxLength: declared > 0 ? declared : null
    });
  }
  return out;
}

export function buildDraftRequest(candidates: DraftCandidate[]): DraftQuestionRequest[] {
  return candidates.slice(0, MAX_DRAFT_QUESTIONS).map((candidate) => ({
    field_identifier: candidate.fieldKey,
    question: candidate.question,
    control_type: "textarea" as const,
    ...(candidate.maxLength !== null ? { max_length: Math.min(candidate.maxLength, 10000) } : {}),
    required: candidate.required
  }));
}

/**
 * Parse the server's response defensively. Anything that is not exactly the documented shape is
 * dropped: an unknown status or a text on a non-drafted result must never reach a text box.
 */
export function parseDraftResponse(raw: unknown, asked: DraftCandidate[]): DraftSuggestion[] {
  if (!raw || typeof raw !== "object") return [];
  const drafts = (raw as { drafts?: unknown }).drafts;
  if (!Array.isArray(drafts)) return [];
  const known = new Map(asked.map((candidate) => [candidate.fieldKey, candidate]));
  const out: DraftSuggestion[] = [];
  for (const item of drafts) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const fieldKey = typeof record.field_identifier === "string" ? record.field_identifier : "";
    const candidate = known.get(fieldKey);
    if (!candidate || typeof record.generation_status !== "string" || !STATUSES.has(record.generation_status)) continue;
    const status = record.generation_status as DraftStatus;
    const proposed = typeof record.proposed_answer === "string" ? record.proposed_answer.trim() : "";
    const usable = (status === "drafted" || status === "partial") && proposed !== "";
    // The employer's own limit is enforced again here: a server bug must not overflow a box.
    const text = usable && (candidate.maxLength === null || proposed.length <= candidate.maxLength) ? proposed : "";
    const missing = Array.isArray(record.missing_information)
      ? record.missing_information.filter((entry): entry is string => typeof entry === "string").slice(0, 6)
      : [];
    out.push({
      fieldKey,
      status: usable && text === "" ? "invalid_response" : status,
      text,
      missing
    });
  }
  return out;
}

/** What the box says about a suggestion that has no text. */
export function describeNoDraft(status: DraftStatus): string {
  switch (status) {
    case "needs_user_answer":
      return "This question needs your own answer. XpertApply doesn’t draft it.";
    case "insufficient_evidence":
      return "Your saved profile doesn’t have enough to answer this honestly. Add details, or write it yourself.";
    case "not_drafted":
      return "XpertApply doesn’t draft this kind of field.";
    default:
      return "No usable suggestion for this question. You can write it yourself.";
  }
}

/** Map a failed request to wording for the applicant; never shows server detail. */
export function describeDraftError(code: string | undefined): string {
  switch (code) {
    case "DRAFTING_DISABLED":
      return "Answer suggestions aren’t available right now.";
    case "RATE_LIMITED":
      return "Too many suggestion requests. Please wait a moment and try again.";
    case "SESSION_UNAUTHORIZED":
    case "SESSION_NOT_FOUND":
    case "HANDOFF_EXPIRED":
      return "This application session has ended. Reopen the application from XpertApply to continue.";
    default:
      return "Couldn’t get suggestions. You can still write your answers yourself.";
  }
}

/** Why Apply may not write into a box right now. `null` means it may. */
export function applyBlockedReason(currentValue: string): string | null {
  return currentValue.trim() === "" ? null : "This box already has text. Clear it first if you want to use the suggestion.";
}
