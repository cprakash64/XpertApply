/**
 * The deterministic semantic boundary for a CONSEQUENTIAL employer answer.
 *
 * B-03
 * ----
 * The resolver runs on the backend and answers with an option reference this
 * page reported seeing. That already stops a model inventing a value, and
 * `questionBatch.matchResults` already refuses a reference belonging to another
 * field. What none of it establishes is that the referenced option MEANS what
 * the canonical answer says.
 *
 * The hole this module closes, exactly:
 *
 *   canonical      future sponsorship = false
 *   offered        option-1 "Yes", option-2 "No"
 *   resolver       selected_option_ref = option-1, typed_answer = false,
 *                  confidence = 1.0
 *
 * Every pre-existing gate passed. `resolvedAnswerAllowed` reads the QUESTION's
 * jurisdiction and polarity, and the question is fine — it is the ANSWER that is
 * inverted. `matchOption` then took the exact label match ("Yes") ahead of the
 * boolean polarity fallback, and `committedValueMatches` returned true on
 * `shown === wanted` before it ever consulted `typedAnswer`. A wrong
 * immigration answer was written to a real employer form and recorded verified,
 * on the provider's word alone.
 *
 * The rule
 * --------
 * For a consequential key, a provider recommendation is ADVISORY. Before any
 * DOM interaction it must survive checks the client makes for itself:
 *
 *   1. the answer's source is one the USER asserted — a derived reading of a
 *      resume or a job description carries no authority to state a fact about
 *      someone's immigration status or criminal history;
 *   2. the option is offered by THIS field in the CURRENT generation (enforced
 *      by the caller, which resolves the reference through that field's own
 *      `labelByRef` and re-checks staleness);
 *   3. the offered set names it unambiguously — two options normalizing to the
 *      same label is a fail-closed, never a pick-the-first;
 *   4. where the canonical answer is an explicit boolean, the option's own
 *      wording must carry the MATCHING polarity. An option whose wording has no
 *      readable polarity ("Authorized without sponsorship") is refused rather
 *      than approximated;
 *   5. where the extension independently holds a verified canonical boolean for
 *      the same key, the provider's typed answer must AGREE with it. This is the
 *      check that does not depend on the provider being honest about anything.
 *
 * Confidence is deliberately absent from all five. It is a provider's opinion
 * of its own output and can never be the reason a consequential answer is
 * stated on the user's behalf.
 *
 * Non-consequential fields are not this module's business and pass straight
 * through: the existing membership, uniqueness and post-commit verification
 * rules continue to govern them.
 */

import { isConsequentialKey } from "./answerSemantics";
import type { CanonicalField } from "./taxonomy";
import type { SessionAnswer } from "../types";

// --------------------------------------------------------------------------- //
// Option-label polarity — ONE engine
// --------------------------------------------------------------------------- //

export type OptionPolarity = "affirmative" | "negative" | "unknown";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Read the polarity of one rendered OPTION LABEL.
 *
 * Distinct from `answerSemantics.detectPolarity`, which reads the polarity of a
 * QUESTION against a canonical key's own assertion. These are two different
 * measurements and neither substitutes for the other; running both is what
 * separates "the employer asked the opposite question" (XA-04) from "the
 * provider pointed at the opposite answer" (B-03).
 *
 * Negated forms are tested before positive ones, and wording it does not
 * recognise never receives a polarity — so an unreadable label refuses rather
 * than being guessed at.
 *
 * This is the single definition; `content/dropdownTransaction` re-exports it as
 * `booleanPolarity` so selection and verification cannot drift apart.
 */
export function optionPolarity(value: string): OptionPolarity {
  const normalized = normalize(value).replace(/[.!]$/g, "");
  if (/^(?:no|n|false|0|off)$/.test(normalized)) return "negative";
  if (/^(?:yes|y|true|1|on)$/.test(normalized)) return "affirmative";
  if (/\b(?:not authorized|not authorised|do not require|don't require|will not require|no sponsorship)\b/.test(normalized)) {
    return "negative";
  }
  if (/^(?:authorized|authorised)$/.test(normalized)) return "affirmative";
  if (/\b(?:i require sponsorship|will require sponsorship)\b/.test(normalized)) return "affirmative";
  return "unknown";
}

// --------------------------------------------------------------------------- //
// Provider authority
// --------------------------------------------------------------------------- //

/**
 * Resolver `safe_source` values that mean the USER asserted it.
 *
 * Taken from the vocabulary the answers service actually emits for a
 * consequential boolean — the reusable vault answer, or this application's own
 * override — plus the explicit per-application confirmations. Anything else,
 * including a source this client has never heard of, carries no authority and
 * fails closed rather than being trusted because it arrived with confidence 1.
 *
 * Mirrors `answerAuthority.USER_ASSERTED_SOURCES` for the resolver's own
 * vocabulary, so there is one answer to "did the user say this", not one per
 * code path.
 */
const USER_ASSERTED_RESOLVER_SOURCES: ReadonlySet<string> = new Set([
  "saved_profile",
  "application_override",
  "explicit_user_answer",
  "user_confirmed",
  "user_confirmed_saved",
  "user_confirmed_application",
  "confirmed_profile",
  "profile",
  "profile_eeo",
  "user_default",
  "vault",
  "answer_vault",
  "answer_vault_verified"
]);

export type ConsequentialRefusal =
  /** The resolver's source is derived or unrecognised, not a user assertion. */
  | "CONSEQUENTIAL_SOURCE_NOT_USER_ASSERTED"
  /** The approved label is not among the options this field currently offers. */
  | "CONSEQUENTIAL_OPTION_NOT_OFFERED"
  /** Two offered options mean the same thing; choosing is the user's call. */
  | "CONSEQUENTIAL_OPTION_AMBIGUOUS"
  /** The canonical answer is boolean but the option's wording carries no
   * readable polarity — "Authorized without sponsorship" and the like. */
  | "CONSEQUENTIAL_OPTION_POLARITY_UNKNOWN"
  /** THE B-03 case: the option says the opposite of the canonical answer. */
  | "CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER"
  /** The provider's typed answer disagrees with the verified answer this
   * extension independently holds for the same key. */
  | "CONSEQUENTIAL_ANSWER_CONTRADICTS_PROFILE";

export type ConsequentialVerdict = { ok: true } | { ok: false; reason: ConsequentialRefusal };

const refuse = (reason: ConsequentialRefusal): ConsequentialVerdict => ({ ok: false, reason });
const ALLOW: ConsequentialVerdict = { ok: true };

/**
 * The verified canonical boolean this extension holds for a key, if any.
 *
 * Independent of the provider: it comes from the session's own answer set,
 * which the extension fetched under the user's authentication. An unverified
 * answer, one flagged for review, and wording that is not an explicit yes/no
 * all yield `null` — "we hold nothing comparable", which is never itself a
 * contradiction.
 */
export function storedCanonicalBoolean(answer: SessionAnswer | undefined): boolean | null {
  if (!answer) return null;
  if (!answer.verified || answer.requires_review) return null;
  if (typeof answer.value !== "string") return null;
  switch (optionPolarity(answer.value)) {
    case "affirmative": return true;
    case "negative": return false;
    default: return null;
  }
}

export interface ConsequentialCheckInput {
  /** The canonical key the resolver says it answered. */
  canonicalKey: string | null;
  /** The resolver's canonical boolean, when the answer is an explicit one. */
  typedAnswer: boolean | null;
  /** The label the resolver's option reference resolved to, in this field's
   * own current offered set. */
  approvedLabel: string;
  /** Every option this field offers in the CURRENT interaction generation. */
  offeredLabels: string[];
  /** The resolver's declared provenance for the answer. */
  safeSource: string;
  /** The session's own verified answer for the same key, when it holds one. */
  storedAnswer?: SessionAnswer;
}

/**
 * May this provider recommendation be actuated on a consequential control?
 *
 * Called BEFORE any DOM interaction, so a refusal costs zero employer-visible
 * mutation — the control is never opened, nothing is clicked, and the field is
 * surfaced for the user to answer instead.
 */
export function checkConsequentialOption(input: ConsequentialCheckInput): ConsequentialVerdict {
  const { canonicalKey, approvedLabel, offeredLabels, typedAnswer, safeSource } = input;
  if (!canonicalKey) return ALLOW;
  if (!isConsequentialKey(canonicalKey as CanonicalField)) return ALLOW;

  // 1. Authority. A resume reading is a fine basis for a drafted paragraph and
  //    is never the user telling an employer about their immigration status.
  if (!USER_ASSERTED_RESOLVER_SOURCES.has(safeSource)) {
    return refuse("CONSEQUENTIAL_SOURCE_NOT_USER_ASSERTED");
  }

  const wanted = normalize(approvedLabel);
  if (!wanted) return refuse("CONSEQUENTIAL_OPTION_NOT_OFFERED");

  // 2/3. Membership in the CURRENT offered set, named unambiguously. An empty
  //      set is a control whose menu is built on open; the caller re-reads the
  //      real options at actuation time and this check runs again there.
  if (offeredLabels.length > 0) {
    const matches = offeredLabels.filter((label) => normalize(label) === wanted);
    if (matches.length === 0) return refuse("CONSEQUENTIAL_OPTION_NOT_OFFERED");
    if (matches.length > 1) return refuse("CONSEQUENTIAL_OPTION_AMBIGUOUS");
  }

  // Non-boolean consequential answers (a demographic selection) are governed by
  // the exact-option rules in `answerAuthority.checkDemographicOptions` and by
  // post-commit verification. There is no polarity to compare here.
  if (typeof typedAnswer !== "boolean") return ALLOW;

  // 4. The option must SAY what the canonical answer means. This is the check
  //    the exact-label match used to run ahead of.
  const polarity = optionPolarity(approvedLabel);
  if (polarity === "unknown") return refuse("CONSEQUENTIAL_OPTION_POLARITY_UNKNOWN");
  if (polarity !== (typedAnswer ? "affirmative" : "negative")) {
    return refuse("CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER");
  }

  // 5. And the canonical answer must agree with what this extension already
  //    holds. Nothing in steps 1-4 depends on the provider being wrong in a
  //    self-inconsistent way; this one does not depend on the provider at all.
  const stored = storedCanonicalBoolean(input.storedAnswer);
  if (stored !== null && stored !== typedAnswer) {
    return refuse("CONSEQUENTIAL_ANSWER_CONTRADICTS_PROFILE");
  }

  return ALLOW;
}
