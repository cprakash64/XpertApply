/**
 * One place that decides whether XpertApply is entitled to answer a question.
 *
 * The invariant
 * -------------
 *   XPERTAPPLY MUST NEVER CONVERT "UNKNOWN" INTO A USER ASSERTION.
 *
 * `undefined`, `null`, `""`, "no stored answer", "no option matched" and "the
 * question is ambiguous" are six different states, and none of them is the
 * answer "No". Before this module the pipeline expressed its decision as two
 * loose booleans assembled in six separate branches of `buildMappings`, and
 * three of those branches contained the same escape hatch: a REQUIRED choice
 * control could be filled even with no verified answer, by synthesising an
 * affirmation sentinel. That hatch is how a sworn certification came to be
 * agreed to on the candidate's behalf (XA-02).
 *
 * What changed
 * ------------
 * Authority is now explicit and ranked, and the decision is a single value with
 * a reason attached rather than a pair of booleans. A caller cannot reach
 * `SAFE_TO_FILL` without naming where the authority came from.
 *
 * This module is also where a previously-unreachable safety module becomes
 * load-bearing (XA-05): `sensitivePolicy.mayAutoCheckConsent` now decides
 * consent, having been written for exactly that decision, tested, and absent
 * from the shipped bundle.
 *
 * Its sibling `eeoMapping.ts` is deliberately NOT wired here, and that is a
 * finding rather than an oversight: its matcher takes the backend's internal
 * canonical tokens ("man", "asian"), while the answers endpoint sends the
 * extension DISPLAY LABELS ("Man", "Asian", and a constructed "Two or More
 * Races" that has no token at all). Wiring it against that mismatch would
 * refuse demographic answers the backend deliberately curated. Reconciling the
 * two vocabularies is a backend contract question, not a fill-pipeline one.
 */

import { mayAutoCheckConsent } from "../application/sensitivePolicy";
import {
  checkSemanticCompatibility,
  isConsequentialKey,
  type JurisdictionContext,
  type SemanticRefusal
} from "./answerSemantics";
import type { CanonicalField } from "./taxonomy";
import { CUSTOM_RESPONSE_FIELDS, UPLOAD_FIELDS } from "./taxonomy";
import type { DiscoveredField, SessionAnswer } from "../types";

// --------------------------------------------------------------------------- //
// Authority
// --------------------------------------------------------------------------- //

/**
 * Where the right to state this answer comes from, strongest first.
 *
 * Nothing below `deterministic_transform` may answer a consequential question.
 * A drafted paragraph and a product default are legitimate for prose and for
 * "how did you hear about us", and are never facts about the user.
 */
export type AnswerAuthority =
  /** The user answered this exact question, for this application. */
  | "explicit_user_answer"
  /** A verified answer the user previously gave, stored under this exact key. */
  | "verified_profile_answer"
  /** A meaning-preserving transform of one of the above (phone split, etc.). */
  | "deterministic_transform"
  /** Model-drafted prose the user edits in place. Never a factual assertion. */
  | "generated_draft"
  /** A product default the user approved (employer careers referral source). */
  | "product_default"
  /** No authority at all. */
  | "none";

export type RefusalReason =
  | SemanticRefusal
  | "NO_VERIFIED_ANSWER"
  | "CONSENT_IS_THE_USERS_ACT"
  | "SENSITIVE_WITHOUT_EXPLICIT_CONSENT"
  | "ANSWER_SOURCE_NOT_USER_ASSERTED"
  | "DEMOGRAPHIC_NO_EXACT_OPTION"
  | "DEMOGRAPHIC_AMBIGUOUS_OPTION"
  | "DEMOGRAPHIC_MULTI_VALUE_IN_SINGLE_SELECT"
  | "LOW_CONFIDENCE_CLASSIFICATION"
  | "UPLOAD_UNDER_USER_CONTROL";

export type FillDecision =
  | { status: "SAFE_TO_FILL"; authority: AnswerAuthority; requiresReview: boolean }
  | { status: "REQUIRES_REVIEW"; authority: "none"; reason: RefusalReason }
  | { status: "DO_NOT_FILL"; authority: "none"; reason: RefusalReason };

const review = (reason: RefusalReason): FillDecision => ({
  status: "REQUIRES_REVIEW",
  authority: "none",
  reason
});

const fill = (authority: AnswerAuthority, requiresReview: boolean): FillDecision => ({
  status: "SAFE_TO_FILL",
  authority,
  requiresReview
});

/**
 * Answer sources that mean the USER said it.
 *
 * Taken from the vocabulary the API actually emits, not from an idealised list:
 * a profile field, a vault answer, a per-application confirmation, an approved
 * default. These are assertions the user made.
 */
const USER_ASSERTED_SOURCES = new Set([
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

/**
 * Sources that are DERIVED, not asserted.
 *
 * `resume` is parsed out of a document, `job_description` and `company_context`
 * are read off the posting. Each is a reasonable basis for a draft paragraph and
 * none of them is the user telling an employer something about their
 * immigration status, their criminal history or their protected
 * characteristics. For a consequential key they carry no authority at all.
 */
const DERIVED_SOURCES = new Set(["resume", "job_description", "company_context"]);

/**
 * Does this stored answer carry enough authority to be stated as the user's?
 *
 * `verified` is the backend's assertion that the user supplied it, and
 * `requires_review` is its assertion that they have not settled it. An empty
 * string is the absence of an answer, not the answer "".
 *
 * For a consequential key the SOURCE must additionally be one the user
 * asserted: an unrecognised source fails closed rather than being trusted
 * because it happened to arrive with `verified: true`.
 */
export function answerAuthorityOf(
  answer: SessionAnswer | undefined,
  options: { consequential: boolean } = { consequential: false }
): AnswerAuthority {
  if (!answer) return "none";
  if (typeof answer.value !== "string" || answer.value.trim() === "") return "none";
  if (answer.requires_review) return "none";
  if (!answer.verified) return "none";
  if (!options.consequential) return "verified_profile_answer";
  if (DERIVED_SOURCES.has(answer.source)) return "none";
  if (!USER_ASSERTED_SOURCES.has(answer.source)) return "none";
  return answer.source.startsWith("user_confirmed") || answer.source === "explicit_user_answer"
    ? "explicit_user_answer"
    : "verified_profile_answer";
}

// --------------------------------------------------------------------------- //
// Demographic option safety
//
// This invariant used to live in `fields/eeoMapping.ts`, which never ran: its
// matcher took the backend's internal canonical tokens ("man", "asian") while
// /application-sessions/{id}/answers sends the extension DISPLAY LABELS ("Man",
// "Asian", and a constructed "Two or More Races" with no token at all). The
// module was written against the wrong side of the contract, so the guarantee
// it advertised — fail closed unless exactly one option means the same thing —
// was never actually enforced anywhere.
//
// It is enforced here instead, against the contract the extension really
// receives, on the live path every demographic fill goes through.
// --------------------------------------------------------------------------- //

/** Compare option text without changing its meaning. */
function normalizeOptionLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/[.,;:!?()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Declining to answer, however the employer words it.
 *
 * These carry no factual assertion — they are all the same refusal — so
 * treating them as one meaning cannot misrepresent anyone. Selecting one is
 * only ever transmitting a decline the USER already stored; nothing here lets
 * an unanswered question become a decline.
 */
const DECLINE_TO_ANSWER = new Set([
  "prefer not to answer", "prefer not to say", "decline to self identify",
  "decline to identify", "i dont wish to answer", "i do not wish to answer",
  "i dont want to answer", "i do not want to answer", "not specified",
  "i dont wish to self identify"
]);

/**
 * Gender identity ↔ binary sex terms.
 *
 * "Man" and "Male" are not synonyms in general — one is a gender identity, the
 * other a sex term, and the backend deliberately models them as different
 * questions. They may be equated only when the employer's control makes the
 * question the binary one by offering nothing else, which is the condition
 * `eeoMapping.allowBinarySexMapping` existed to express and which no call site
 * ever supplied. It is supplied here, from the options the control renders.
 */
const BINARY_SEX_EQUIVALENCE: Record<string, string> = {
  man: "male", male: "male", woman: "female", female: "female"
};

const SELF_DESCRIBE = new Set(["non binary", "nonbinary", "genderqueer", "self describe", "prefer to self describe", "other"]);

/** True when the control's substantive choices are exactly the binary pair. */
function offersOnlyBinarySex(options: string[]): boolean {
  const substantive = options
    .map(normalizeOptionLabel)
    .filter((option) => option && !DECLINE_TO_ANSWER.has(option) && !SELF_DESCRIBE.has(option));
  if (substantive.length !== 2) return false;
  return substantive.every((option) => BINARY_SEX_EQUIVALENCE[option] !== undefined)
    && new Set(substantive.map((option) => BINARY_SEX_EQUIVALENCE[option])).size === 2;
}

/**
 * Does this rendered option mean the same thing as the stored answer?
 *
 * Exact first. Then the two closed equivalences above — and nothing else.
 * Notably absent: any similarity or substring matching. "I am not a protected
 * veteran" and "I am not a veteran" are different answers and must never be
 * treated as one, which is exactly the kind of collapse a fuzzy matcher makes.
 */
function optionMeansSame(option: string, stored: string, allOptions: string[]): boolean {
  const a = normalizeOptionLabel(option);
  const b = normalizeOptionLabel(stored);
  if (!a || !b) return false;
  if (a === b) return true;
  if (DECLINE_TO_ANSWER.has(a) && DECLINE_TO_ANSWER.has(b)) return true;
  if (offersOnlyBinarySex(allOptions)) {
    const mappedA = BINARY_SEX_EQUIVALENCE[a];
    const mappedB = BINARY_SEX_EQUIVALENCE[b];
    if (mappedA && mappedB && mappedA === mappedB) return true;
  }
  return false;
}

/**
 * A demographic answer may be applied only when the control offers exactly one
 * option that says the same thing.
 *
 * Several stored values in a single-select cannot be expressed honestly, and
 * picking one would misrepresent the user. Two options matching the same stored
 * value means the employer's vocabulary is finer-grained than ours, and
 * choosing between them is the user's call.
 *
 * A control that has not rendered its options yet (a closed custom dropdown)
 * passes here and is still verified by the dropdown adapter, which refuses
 * unless its own selection reads back.
 */
function checkDemographicOptions(
  answer: SessionAnswer,
  field: DiscoveredField
): { ok: true } | { ok: false; reason: RefusalReason } {
  const stored = answer.value.split("|").map((value) => value.trim()).filter(Boolean);
  if (stored.length > 1 && field.multiple !== true) {
    return { ok: false, reason: "DEMOGRAPHIC_MULTI_VALUE_IN_SINGLE_SELECT" };
  }
  const options = field.options ?? [];
  if (options.length === 0) return { ok: true };

  for (const value of stored) {
    const matches = options.filter((option) => optionMeansSame(option, value, options));
    if (matches.length === 0) return { ok: false, reason: "DEMOGRAPHIC_NO_EXACT_OPTION" };
    if (matches.length > 1) return { ok: false, reason: "DEMOGRAPHIC_AMBIGUOUS_OPTION" };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------- //
// The decision
// --------------------------------------------------------------------------- //

export interface FillDecisionInput {
  field: DiscoveredField;
  canonicalKey: CanonicalField;
  /** Classifier confidence for this key. */
  confidence: number;
  /** True when the classifier put this in a sensitive category. */
  sensitive: boolean;
  /** The stored answer for this key, if the session has one. */
  answer: SessionAnswer | undefined;
  /** The question as the employer rendered it, for the semantic gate. */
  questionText: string;
  /** Auto-fill / review confidence thresholds (owned by mapping.ts). */
  autoFillThreshold: number;
  reviewThreshold: number;
  /** Keys the product answers from an approved default rather than a fact. */
  productDefaultKeys: ReadonlySet<CanonicalField>;
  /** Trusted context for establishing the question's jurisdiction — currently
   * the posting's own recorded location. Absent means nothing can be
   * established from it, which refuses rather than assumes. */
  jurisdiction?: JurisdictionContext;
}

/**
 * The single gate. Everything downstream reads `status` and does not
 * re-derive policy.
 */
export function decideFill(input: FillDecisionInput): FillDecision {
  const { canonicalKey: key, answer, questionText } = input;

  // Documents are attached, not asserted; the upload path verifies acceptance.
  if (UPLOAD_FIELDS.has(key)) return fill("verified_profile_answer", false);

  // A drafted paragraph is the user's to edit in place, and is never treated as
  // a verified fact about them.
  if (CUSTOM_RESPONSE_FIELDS.has(key)) {
    return answer?.value ? fill("generated_draft", true) : review("NO_VERIFIED_ANSWER");
  }

  const consequential = isConsequentialKey(key) || input.sensitive;

  if (consequential) {
    // 1. An attestation is a statement the candidate makes, and each one says
    //    something different. It may be transmitted only when the user answered
    //    THIS application's question — never from a reusable profile or vault
    //    answer, which attested to some other employer's wording. With no such
    //    answer, `mayAutoCheckConsent()` settles it: there is no confidence
    //    level and no "they asked us to apply for them" that makes agreeing on
    //    someone's behalf acceptable, including when the employer offers
    //    exactly one substantive option — which is what made it look safe
    //    before (XA-02).
    if (key === "legal_attestation") {
      const attested = answerAuthorityOf(answer, { consequential: true });
      // Only the user's answer to THIS attestation may be transmitted. A
      // reusable profile or vault answer attested to some other employer's
      // wording and says nothing about this one. With no such answer the
      // policy module decides, and it always refuses: nothing makes agreeing
      // on someone's behalf acceptable, including the employer offering
      // exactly one substantive option — which is what made it look safe
      // before (XA-02).
      if (attested !== "explicit_user_answer" && !mayAutoCheckConsent()) {
        return review("CONSENT_IS_THE_USERS_ACT");
      }
      if (attested === "none") return review("NO_VERIFIED_ANSWER");
      return fill(attested, true);
    }

    // 2. The question must be asking what the stored answer answers: same
    //    jurisdiction (XA-03), same polarity (XA-04).
    const compatible = checkSemanticCompatibility(key, questionText, input.jurisdiction ?? {});
    if (!compatible.ok) return review(compatible.reason);

    // 3. Authority is required. No verified answer means the user has not told
    //    us — which is never "No", and never a reason to synthesise one.
    const authority = answerAuthorityOf(answer, { consequential: true });
    if (authority === "none") {
      return review(
        answer && DERIVED_SOURCES.has(answer.source)
          ? "ANSWER_SOURCE_NOT_USER_ASSERTED"
          : "NO_VERIFIED_ANSWER"
      );
    }

    // 4. A sensitive category additionally requires the vault's explicit
    //    consent marking for this exact key.
    if (input.sensitive) {
      const consented = Boolean(answer!.sensitive && answer!.verified && !answer!.requires_review);
      if (!consented) return review("SENSITIVE_WITHOUT_EXPLICIT_CONSENT");
      const optionSafety = checkDemographicOptions(answer!, input.field);
      if (!optionSafety.ok) return review(optionSafety.reason);
      return fill(authority, false);
    }

    // A consequential but non-sensitive answer (work authorization,
    // sponsorship, signature) that survived the semantic gate and carries user
    // authority. Review flagging follows the same confidence policy as any
    // other field — the safety gain here is in the refusals above.
    return confidencePolicy(input, authority);
  }

  // ------------------------------------------------------------------------- //
  // Ordinary fields: the pre-existing confidence policy, unchanged.
  // ------------------------------------------------------------------------- //
  if (answerAuthorityOf(answer) === "none") {
    // A product default the user approved, for a question that asserts nothing
    // about them. Never reached for a consequential key.
    if (input.productDefaultKeys.has(key)) return fill("product_default", false);
    return review("NO_VERIFIED_ANSWER");
  }
  return confidencePolicy(input, "verified_profile_answer");
}

function confidencePolicy(input: FillDecisionInput, authority: AnswerAuthority): FillDecision {
  const answer = input.answer!;
  if (input.confidence >= input.autoFillThreshold && !answer.requires_review) {
    return fill(authority, false);
  }
  if (input.confidence >= input.reviewThreshold) return fill(authority, true);
  return review("LOW_CONFIDENCE_CLASSIFICATION");
}
