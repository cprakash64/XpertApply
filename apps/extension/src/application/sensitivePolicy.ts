/**
 * Legal and sensitive application answers.
 *
 * Work authorization, visa sponsorship and privacy attestations are legal
 * statements made by the candidate. Getting one wrong is not a filling bug — it
 * is a false statement on a job application, and on an immigration-adjacent
 * question it can be seriously damaging.
 *
 * So this module is deliberately incapable of producing an answer. It can only
 * pass through an explicit, verified answer the user already gave, or report
 * that the answer is unknown. There is no heuristic, no default, and no
 * inference path — not from nationality, school, employer, current location,
 * visa documents, resume text, or what the user answered on a different
 * application.
 */

/** A tri-state answer. `null` means "the user has not told us" and must never
 * be collapsed into false. */
export type ExplicitBoolean = {
  value: boolean | null;
  source: string;
  verified: boolean;
};

export type SensitiveResolution =
  | { status: "resolved"; value: boolean; source: string }
  | { status: "requires_review"; reason: SensitiveReviewReason };

export type SensitiveReviewReason =
  | "missing_explicit_answer"
  | "unverified_answer"
  | "untrusted_source";

/**
 * Sources that count as the user actually answering the question.
 *
 * Anything else — a resume parse, a profile field inferred from documents, a
 * previous employer's form — is not the user answering THIS question, and is
 * rejected even when it carries a confident-looking value.
 */
const EXPLICIT_SOURCES = new Set([
  "explicit_user_answer",
  "user_confirmed",
  "user_confirmed_saved",
  "answer_vault_verified"
]);

/**
 * Resolve a legal yes/no answer, or refuse.
 *
 * Refusing is a normal outcome here, not a failure: the field is left blank and
 * added to the review list so the user answers it themselves.
 */
export function resolveLegalAnswer(answer: ExplicitBoolean | null | undefined): SensitiveResolution {
  if (!answer || answer.value === null || answer.value === undefined) {
    return { status: "requires_review", reason: "missing_explicit_answer" };
  }
  if (!EXPLICIT_SOURCES.has(answer.source)) {
    return { status: "requires_review", reason: "untrusted_source" };
  }
  if (!answer.verified) {
    return { status: "requires_review", reason: "unverified_answer" };
  }
  return { status: "resolved", value: answer.value, source: answer.source };
}

/**
 * Questions this policy governs. Matched on the question text so a form that
 * words it differently is still caught.
 */
const LEGAL_QUESTION_PATTERNS: { key: LegalQuestionKey; patterns: RegExp[] }[] = [
  {
    key: "work_authorization",
    patterns: [
      /legally (authori[sz]ed|entitled|eligible) to work/i,
      /authori[sz]ed to work .*(without restriction|in the us|in the united states)/i,
      /right to work/i
    ]
  },
  {
    key: "visa_sponsorship",
    patterns: [
      /require .*(visa )?sponsorship/i,
      /need .*sponsorship/i,
      /visa transfer/i,
      /sponsorship .*(now or in the future)/i
    ]
  },
  {
    key: "privacy_consent",
    patterns: [
      /privacy (policy|notice|terms|statement)/i,
      /consent to .*(processing|collection)/i,
      /i (agree|consent|acknowledge)/i,
      /terms and conditions/i
    ]
  }
];

export type LegalQuestionKey = "work_authorization" | "visa_sponsorship" | "privacy_consent";

export function classifyLegalQuestion(questionText: string): LegalQuestionKey | null {
  const text = (questionText || "").trim();
  if (!text) return null;
  for (const entry of LEGAL_QUESTION_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) return entry.key;
  }
  return null;
}

/**
 * A legal attestation is the user's signature, not a field to complete.
 *
 * Always false — there is no configuration, no "the user enabled autofill"
 * escape hatch, and no confidence threshold that makes checking a consent box
 * on someone's behalf acceptable.
 */
export function mayAutoCheckConsent(): false {
  return false;
}

/** Copy shown when a consent control is found. */
export const CONSENT_REVIEW_MESSAGE = "Please review and accept the application privacy terms.";

/**
 * Map a semantic yes/no onto whichever labels the form actually offers.
 *
 * Only exact-ish affirmative/negative labels are accepted. A form offering
 * "Yes, with restrictions" is NOT a match for a plain yes, because the
 * difference is legally meaningful — that case returns null and goes to review.
 */
export function mapYesNoOption(value: boolean, options: string[]): string | null {
  const normalized = options.map((option) => ({ raw: option, text: option.trim().toLowerCase() }));
  const affirmative = [/^yes$/, /^y$/, /^true$/, /^i am$/, /^authorized$/];
  const negative = [/^no$/, /^n$/, /^false$/, /^i am not$/, /^not authorized$/];
  const wanted = value ? affirmative : negative;
  const match = normalized.find((option) => wanted.some((pattern) => pattern.test(option.text)));
  return match ? match.raw : null;
}
