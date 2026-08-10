/**
 * What the user is asked to do, derived from the authoritative ledger.
 *
 * Previously the review list and the numeric summary came from two different
 * ledgers, so the detail could describe a different set of fields than the
 * counts claimed. Both now read one snapshot: these items and
 * `computeQuestionCounts` are computed from the same entries.
 *
 * Nothing internal leaks into what the user reads. Canonical keys, source
 * enums and reason codes stay on the entry for diagnostics; the title and
 * explanation are written in plain language.
 */

import type { QuestionCounts, QuestionEntry, QuestionState } from "./questionLedger";
import {
  APPLICATION_ANSWERABLE_BOOLEANS,
  type ReviewAction,
  type ReviewAnswerType
} from "./reviewActions";

export type { ReviewAction } from "./reviewActions";

export type ReviewCategoryName =
  | "needs_information"
  | "needs_confirmation"
  | "needs_user_gesture"
  | "technical"
  | "manual_legal"
  | "manual_review";

export interface AuthoritativeReviewItem {
  /** The ledger key — also how the live control is re-resolved for focus. */
  fieldKey: string;
  category: ReviewCategoryName;
  title: string;
  explanation: string;
  actions: ReviewAction[];
  required: boolean;
  state: QuestionState;
  /** Low-cardinality; for diagnostics, never rendered as prose. */
  reasonCode: string;
  /** The canonical key the RESOLVER returned for this field, carried so an
   * action can name it. Never rendered. */
  canonicalKey: string | null;
  /** What the answer UI must present. `null` when no answer action is offered. */
  answerType: ReviewAnswerType | null;
  /** Provenance the user reads. Set only once an answer has actually been
   * applied and verified, so it can never overstate what happened. */
  sourceLabel: string | null;
  /** The user chose to handle this one themselves. */
  deferred: boolean;
  /** TikTok-only assisted action, populated from an authenticated resolver
   * trace in bootstrap; never inferred from the page. */
  assistedAnswer: "Yes" | "No" | null;
  assistedQuestionLabel: string | null;
}

/**
 * Plain-language titles for the legal questions we recognise.
 *
 * Keyed by canonical category so the user sees "Work authorization answer
 * needed" rather than `work_authorization_us`. An unrecognised key falls back
 * to a generic phrasing rather than exposing the key itself.
 */
const LEGAL_TITLES: Record<string, string> = {
  work_authorization_us: "Work authorization answer needed",
  sponsorship_required_now: "Current sponsorship answer needed",
  sponsorship_required_future: "Future sponsorship answer needed",
  sponsorship_required_now_or_future: "Sponsorship answer needed",
  source_where_heard_about_job: "Job-source answer needed"
};

/** Titles for a question that is answered and showing on the employer's page. */
const LEGAL_ANSWERED_TITLES: Record<string, string> = {
  work_authorization_us: "Work authorization answered",
  sponsorship_required_now: "Current sponsorship answered",
  sponsorship_required_future: "Future sponsorship answered",
  sponsorship_required_now_or_future: "Sponsorship answered",
  source_where_heard_about_job: "Job source answered"
};

const LEGAL_CONFIRM_TITLES: Record<string, string> = {
  work_authorization_us: "Confirm your work authorization answer",
  sponsorship_required_now: "Confirm your current sponsorship answer",
  sponsorship_required_future: "Confirm your future sponsorship answer",
  sponsorship_required_now_or_future: "Confirm your sponsorship answer"
};

function titleFor(entry: QuestionEntry): string {
  const key = entry.canonicalCategory ?? "";
  switch (entry.state) {
    case "answer_missing":
      return LEGAL_TITLES[key] ?? "This question needs your answer";
    case "requires_confirmation":
      return LEGAL_CONFIRM_TITLES[key] ?? "Your saved answer needs confirmation";
    case "requires_user_gesture":
      return "Open this question to continue";
    case "interaction_failed":
      return "JobPilot could not keep this selection";
    case "sensitive_manual":
      return "Please review and accept the application privacy terms";
    case "filled_verified":
      return LEGAL_ANSWERED_TITLES[key] ?? "This question is answered";
    default:
      return "This question needs your review";
  }
}

function explanationFor(entry: QuestionEntry): string {
  if (entry.deferred) {
    return entry.required
      ? "You chose to answer this one yourself. It stays here until the employer's form has an answer."
      : "You chose to skip this optional question.";
  }
  switch (entry.state) {
    case "answer_missing":
      return canAnswerForApplication(entry)
        ? "JobPilot only fills legal questions from an answer you have given yourself. You can answer it for this application without changing your saved answers."
        : entry.sensitivity === "legal"
          ? "JobPilot only fills legal questions from an answer you have given yourself. Please answer it on the employer's form."
          : "JobPilot does not have a saved answer for this question.";
    case "requires_confirmation":
      return "You answered this before, and JobPilot will not reuse it until you confirm it is still correct. Set it on the employer's form for now.";
    case "requires_user_gesture":
      return "This employer only opens the menu for a real click. Open it yourself and choose your answer.";
    case "interaction_failed":
      return entry.applicationOverride
        ? "Your answer is saved for this application, but the value did not stay selected on the employer's page. Set it there yourself."
        : "The value did not stay selected on the employer's page. Please set it yourself.";
    case "sensitive_manual":
      return "Accepting terms is your decision to make, so JobPilot leaves it to you.";
    default:
      return "JobPilot could not safely answer this one. Please review it before submitting.";
  }
}

/**
 * Sensitivities that are never answered for the user, whatever the question is.
 *
 * The sensitivity is checked SEPARATELY from the canonical key because the two
 * can disagree: an employer can wrap a recognised eligibility question in an
 * attestation ("I certify that I am authorized to work…"), and the answerable
 * key must not carry an answer action onto the user's signature.
 */
const NEVER_ANSWERABLE_SENSITIVITIES: ReadonlySet<string> = new Set([
  "consent",
  "attestation",
  "demographic"
]);

/**
 * May this question be answered for one application?
 *
 * Three things must hold: the sensitivity has to permit it at all, the question
 * has to be one the server will accept an override for, and the resolver has to
 * have told us WHICH question it is — an unrecognised field has no canonical
 * key, so there is nothing to answer.
 */
function canAnswerForApplication(entry: QuestionEntry): boolean {
  if (entry.sensitivity && NEVER_ANSWERABLE_SENSITIVITIES.has(entry.sensitivity)) return false;
  return Boolean(entry.canonicalCategory && APPLICATION_ANSWERABLE_BOOLEANS.has(entry.canonicalCategory));
}

/**
 * The provenance line.
 *
 * Only ever set for a field that is actually filled and verified. An override
 * that was stored but whose employer control did not keep the value gets no
 * label at all, because there is nothing on the page to attribute.
 */
export function sourceLabelFor(entry: QuestionEntry): string | null {
  if (entry.state !== "filled_verified") return null;
  return entry.applicationOverride ? APPLICATION_SOURCE_LABEL : null;
}

/** The one wording for an answer given for a single application. Matches what
 * the server returns as `source_label`, so the two can never diverge. */
export const APPLICATION_SOURCE_LABEL = "Confirmed for this application";

function categoryFor(state: QuestionState): ReviewCategoryName {
  switch (state) {
    case "answer_missing":
      return "needs_information";
    case "requires_confirmation":
      return "needs_confirmation";
    case "requires_user_gesture":
      return "needs_user_gesture";
    case "interaction_failed":
      return "technical";
    case "sensitive_manual":
      return "manual_legal";
    default:
      return "manual_review";
  }
}

/**
 * Which actions are offered.
 *
 * Every action listed here is wired end to end — an item never advertises
 * something the widget cannot do. That is why there is no "confirm my saved
 * answer" or "retry this field" action yet: the states that would want them
 * fall back to revealing the control, which always works.
 *
 * Consent never gets an "answer it for me" action, and never gets
 * "leave unresolved" either: skipping an attestation on the user's behalf is
 * exactly the silent decision this whole path exists to avoid.
 */
function actionsFor(entry: QuestionEntry): ReviewAction[] {
  if (entry.state === "sensitive_manual") return ["focus_control"];
  if (entry.deferred) return ["focus_control"];

  const actions: ReviewAction[] = [];
  // Offered only where an answer can actually be stored AND applied: a missing
  // answer to a recognised, answerable boolean, or one whose stored answer the
  // employer control refused, which the user may answer again.
  if (
    canAnswerForApplication(entry)
    && (entry.state === "answer_missing" || entry.state === "interaction_failed")
  ) {
    actions.push("answer_for_this_application");
  }
  actions.push("focus_control", "leave_unresolved");
  return actions;
}

function answerTypeFor(entry: QuestionEntry): ReviewAnswerType | null {
  return canAnswerForApplication(entry) ? "boolean" : null;
}

/** States that require the user to do something. Everything else is done or
 * still in flight, and does not belong in the review list. */
const REVIEWABLE: ReadonlySet<QuestionState> = new Set<QuestionState>([
  "answer_missing",
  "requires_confirmation",
  "requires_user_gesture",
  "interaction_failed",
  "sensitive_manual",
  "unsupported"
]);

/** Required items first, then by category severity, so the most consequential
 * thing to fix is at the top of the list. */
const CATEGORY_ORDER: ReviewCategoryName[] = [
  "manual_legal",
  "needs_information",
  "needs_confirmation",
  "needs_user_gesture",
  "technical",
  "manual_review"
];

function toItem(entry: QuestionEntry): AuthoritativeReviewItem {
  return {
    fieldKey: entry.fieldKey,
    category: categoryFor(entry.state),
    title: titleFor(entry),
    explanation: explanationFor(entry),
    actions: actionsFor(entry),
    required: entry.required,
    state: entry.state,
    reasonCode: entry.reasonCode,
    canonicalKey: entry.canonicalCategory,
    answerType: answerTypeFor(entry),
    sourceLabel: sourceLabelFor(entry),
    deferred: entry.deferred,
    assistedAnswer: null,
    assistedQuestionLabel: null
  };
}

export function buildAuthoritativeReviewItems(
  entries: QuestionEntry[]
): AuthoritativeReviewItem[] {
  return entries
    .filter((entry) => REVIEWABLE.has(entry.state))
    .map(toItem)
    .sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    });
}

/**
 * Questions the user answered for THIS application, and that the employer's
 * page now genuinely shows.
 *
 * Kept separate from the review list on purpose. They need nothing further, so
 * they must not be counted as pending — but they must still be READABLE, or the
 * user would press "Yes", watch the card vanish, and have no way to tell whether
 * the answer was recorded for this application or added to their saved profile.
 *
 * `filled_verified` is the only state that qualifies. An override whose employer
 * control refused the value is not here — it is still a review item.
 */
export function buildConfirmedReviewItems(
  entries: QuestionEntry[]
): AuthoritativeReviewItem[] {
  return entries
    .filter((entry) => entry.state === "filled_verified" && entry.applicationOverride)
    .map(toItem);
}

/**
 * The review list and the summary must describe the same thing.
 *
 * Every reviewable state contributes exactly one item, so the number of items
 * equals the sum of the buckets that mean "the user must act".
 */
export function reviewItemsMatchCounts(
  items: AuthoritativeReviewItem[],
  counts: QuestionCounts
): boolean {
  const expected =
    counts.needs_information +
    counts.needs_confirmation +
    counts.needs_user_gesture +
    counts.technical_issues +
    counts.legal_manual_actions +
    counts.unsupported;
  return items.length === expected;
}

/** Controls that must never be focused by a review action. */
const NEVER_FOCUS = 'input[type="password"],input[type="submit"],button[type="submit"],[name*="captcha" i]';

/**
 * Bring the live control for `fieldKey` into view.
 *
 * Re-resolved from the DOM every time rather than held as a stale node, so a
 * React remount between rendering the list and clicking an item is handled.
 * Reveals the control; never changes its value.
 */
export function focusReviewTarget(
  fieldKey: string,
  resolve: (fieldKey: string) => HTMLElement | null
): { ok: boolean; reason: string } {
  const element = resolve(fieldKey);
  if (!element || !element.isConnected) return { ok: false, reason: "control_not_found" };
  if (element.matches(NEVER_FOCUS)) return { ok: false, reason: "control_not_focusable" };

  try {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    // Focus only where it cannot alter state: focusing a native select is
    // safe, but focusing a checkbox risks a stray keypress toggling it.
    if (!(element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type))) {
      element.focus?.({ preventScroll: true });
    }
    return { ok: true, reason: "focused" };
  } catch {
    return { ok: false, reason: "focus_failed" };
  }
}
