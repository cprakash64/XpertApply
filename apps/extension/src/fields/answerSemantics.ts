/**
 * Does the stored answer actually answer THIS question?
 *
 * The failures this exists to fix
 * ------------------------------
 * A canonical key is a claim about meaning, and the classifier reaches it from
 * wording alone. Two ways that went wrong on real forms:
 *
 *   XA-03  "Are you legally authorised to work in the UK?" matched the
 *          `work_authorization_us` keyword rule, because the rule carries no
 *          country constraint while the key it produces is US-scoped.
 *
 *   XA-04  "I do not now, nor in the future, will require sponsorship" matched
 *          the sponsorship rule, which tests only for the word `sponsorship`
 *          plus a temporal token, and the stored boolean was applied literally.
 *
 * Why the first correction was not enough
 * ---------------------------------------
 * Stage 3B answered both by looking for CONTRADICTIONS: a foreign country name,
 * an English negation token. Finding none, it filled. That is the wrong shape of
 * proof, and it left two holes big enough to drive the original findings back
 * through:
 *
 *   • a country not in the list — "Are you authorised to work in Kenya?" — was
 *     indistinguishable from a question that named no country at all, so it
 *     received the US answer;
 *   • a question in a language the patterns do not cover contains no English
 *     negation and no listed country, so it looked perfectly compatible.
 *
 * Absence of contradictory evidence is not proof of compatibility.
 *
 * The rule now
 * ------------
 * A jurisdiction- or polarity-scoped answer may be used only when the system can
 * POSITIVELY establish that the question asks the matching thing:
 *
 *   jurisdiction  the question names the key's own country; or the question
 *                 names none and the POSTING's recorded location resolves to
 *                 that country. Anything else — an unrecognised country, two
 *                 countries at once, no location on record — is UNKNOWN and
 *                 refuses. The question always outranks the posting.
 *
 *   polarity      the question matches a known template for the key's assertion,
 *                 in the affirmative. A negated template refuses; no template
 *                 match at all is UNKNOWN and refuses.
 *
 * The recognisers are finite, and that is sound here in a way it was not before:
 * they are used to GRANT, so anything they fail to recognise — including every
 * language they do not cover — falls through to a refusal rather than a fill.
 */

import type { CanonicalField } from "./taxonomy";

// --------------------------------------------------------------------------- //
// Which answers are consequential
// --------------------------------------------------------------------------- //

/**
 * Keys where a fabricated or mismatched answer misrepresents the user on the
 * application itself — immigration status, protected characteristics, criminal
 * history, clearances, and statements the candidate signs.
 */
export const CONSEQUENTIAL_KEYS: ReadonlySet<CanonicalField> = new Set<CanonicalField>([
  "work_authorization_us",
  "sponsorship_required_now",
  "sponsorship_required_future",
  "gender",
  "race",
  "ethnicity",
  "disability_status",
  "veteran_status",
  "sexual_orientation",
  "religion",
  "criminal_history",
  "legal_attestation",
  "security_clearance",
  "export_control",
  "salary_history",
  "government_demographic",
  "voluntary_eeo",
  "electronic_signature"
]);

export function isConsequentialKey(key: CanonicalField): boolean {
  return CONSEQUENTIAL_KEYS.has(key);
}

/**
 * Keys whose stored answer only means something inside one jurisdiction.
 *
 * All three are US-scoped in the backend answer vault. Until per-jurisdiction
 * keys exist there (a backend contract change, out of scope), a question can be
 * answered from them only when it is positively established as a US question.
 */
const KEY_JURISDICTION: Partial<Record<CanonicalField, string>> = {
  work_authorization_us: "US",
  sponsorship_required_now: "US",
  sponsorship_required_future: "US"
};

export function jurisdictionScopeOf(key: CanonicalField): string | null {
  return KEY_JURISDICTION[key] ?? null;
}

// --------------------------------------------------------------------------- //
// Jurisdiction — established, never assumed
// --------------------------------------------------------------------------- //

/**
 * Country recognisers.
 *
 * Used only to establish a POSITIVE reading. A string these do not match yields
 * no country, which refuses — so the list being incomplete costs autofill
 * coverage, never correctness.
 */
const COUNTRY_PATTERNS: { code: string; patterns: RegExp[] }[] = [
  {
    code: "US",
    patterns: [
      /\bunited states(?: of america)?\b/i,
      /\bu\.?s\.?a\b/i,
      /\bu\.s\.?\b/i,
      // Bare "US" only as an uppercase token: lower-case "us" is the pronoun,
      // and the letter guards stop it matching inside STATUS or CAMPUS.
      /(?<![A-Za-z])US(?![A-Za-z])/,
      /\bamerica\b/i
    ]
  },
  {
    code: "GB",
    patterns: [
      /\bunited kingdom\b/i, /\bu\.?k\.?\b/i, /\bgreat britain\b/i, /\bbritain\b/i,
      /\bengland\b/i, /\bscotland\b/i, /\bwales\b/i, /\bnorthern ireland\b/i
    ]
  },
  { code: "CA", patterns: [/\bcanada\b/i, /\bcanadian\b/i] },
  { code: "AU", patterns: [/\baustralia\b/i, /\baustralian\b/i] },
  { code: "NZ", patterns: [/\bnew zealand\b/i] },
  { code: "DE", patterns: [/\bgermany\b/i, /\bgerman\b/i, /\bdeutschland\b/i] },
  { code: "FR", patterns: [/\bfrance\b/i] },
  { code: "IE", patterns: [/\bireland\b/i, /\birish\b/i] },
  { code: "NL", patterns: [/\bnetherlands\b/i, /\bholland\b/i] },
  { code: "ES", patterns: [/\bspain\b/i] },
  { code: "IT", patterns: [/\bitaly\b/i] },
  { code: "CH", patterns: [/\bswitzerland\b/i] },
  { code: "SE", patterns: [/\bsweden\b/i] },
  { code: "PL", patterns: [/\bpoland\b/i] },
  { code: "IN", patterns: [/\bindia\b/i] },
  { code: "SG", patterns: [/\bsingapore\b/i] },
  { code: "JP", patterns: [/\bjapan\b/i] },
  { code: "CN", patterns: [/\bchina\b/i] },
  { code: "BR", patterns: [/\bbrazil\b/i] },
  { code: "MX", patterns: [/\bmexico\b/i] },
  { code: "AE", patterns: [/\bunited arab emirates\b/i, /\bu\.?a\.?e\.?\b/i] },
  { code: "ZA", patterns: [/\bsouth africa\b/i] },
  { code: "KE", patterns: [/\bkenya\b/i] },
  { code: "NG", patterns: [/\bnigeria\b/i] },
  { code: "EU", patterns: [/\beuropean union\b/i, /\bthe eu\b/i, /\beea\b/i, /\bschengen\b/i] }
];

/**
 * Places the question points at, whether or not we can name them.
 *
 * "…to work in Uruguay?" names a jurisdiction; the recogniser simply cannot
 * read it. That is NOT the same as a question that names nowhere, and it must
 * not fall through to the posting's location — the employer asked about
 * somewhere specific, and we did not understand which. Distinguishing the two
 * is what stops an unlisted country from being answered as if it were silence.
 */
const PLACE_REFERENCE = [
  /\b(?:work|working|employed|employment|reside|residing|live|living)\s+in\s+([^.?!,;]{1,40})/i,
  /\bauthori[sz]\w*\s+(?:to work\s+)?in\s+([^.?!,;]{1,40})/i,
  /\bright to work\s+in\s+([^.?!,;]{1,40})/i
];

/** "in the future" is a time, not a place. Captures like these name no
 * jurisdiction and must not be mistaken for one we failed to read. */
const NOT_A_PLACE = /^(?:the\s+)?(?:future|past|present|near future|long[- ]term|short[- ]term|coming (?:months|years)|next \w+|perpetuity|general|question|role|position|company)\b/i;

/** True when the question points at a place none of the recognisers resolve. */
function referencesUnresolvedPlace(text: string): boolean {
  for (const pattern of PLACE_REFERENCE) {
    const match = pattern.exec(text);
    if (!match) continue;
    const phrase = match[1].trim();
    if (!phrase) continue;
    if (countriesIn(phrase).length > 0) continue;
    if (NOT_A_PLACE.test(phrase)) continue;
    // "the country where the job is located" points at the posting, not at an
    // unreadable place.
    if (DEFERS_TO_POSTING.some((deferral) => deferral.test(text))) continue;
    return true;
  }
  return false;
}

/** Countries named anywhere in `text`, de-duplicated. */
function countriesIn(text: string): string[] {
  const found = new Set<string>();
  for (const entry of COUNTRY_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) found.add(entry.code);
  }
  return [...found];
}

/**
 * Wordings that deliberately leave the country to the posting.
 *
 * These do NOT establish a jurisdiction on their own — they delegate to one.
 * The posting's own recorded location has to supply it.
 */
const DEFERS_TO_POSTING = [
  /\bcountry (?:in )?which (?:the|this) (?:job|role|position) is (?:located|based)\b/i,
  /\bcountry where (?:the|this) (?:job|role|position) is (?:located|based)\b/i,
  /\bcountry of (?:employment|hire|the position|this position)\b/i,
  /\bthis country\b/i,
  /\bthe hiring country\b/i,
  /\bcountry listed (?:in|on) (?:the|this) (?:job|posting)\b/i
];

/** US state names and postal codes, for reading a posting's location line. */
const US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
  "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"
]);

/**
 * Which country does a posting's location line name?
 *
 * Free text written by whoever published the job ("San Francisco, CA",
 * "Remote — US", "London, United Kingdom", "Multiple locations"). Returns a
 * country only when exactly one is established; "Remote" alone, an unrecognised
 * place, and a list of several countries all return null, which refuses.
 */
export function countryFromJobLocation(location: string | null | undefined): string | null {
  const text = (location ?? "").trim();
  if (!text) return null;

  const named = countriesIn(text);
  if (named.length === 1) return named[0];
  if (named.length > 1) return null;

  // No country word. A "City, ST" tail is a US posting; a bare two-letter token
  // is not enough on its own (CA is also Canada's ISO code).
  const stateTail = /,\s*([A-Z]{2})(?:\s|$|,)/.exec(text);
  if (stateTail && US_STATE_CODES.has(stateTail[1])) return "US";
  return null;
}

export type JurisdictionSource = "question" | "job_location" | "none";

export interface JurisdictionReading {
  /** The single country established, or null when nothing was established. */
  country: string | null;
  source: JurisdictionSource;
  /** Countries the question named, for diagnostics and the ambiguity rule. */
  named: string[];
  /** The question delegates its jurisdiction to the posting. */
  defersToPosting: boolean;
}

export interface JurisdictionContext {
  /** The posting's location as XpertApply recorded it. */
  jobLocation?: string | null;
}

/**
 * Establish the jurisdiction a question is asking about.
 *
 * Order of authority:
 *   1. the question itself — what the employer actually asked wins over any
 *      metadata about the posting;
 *   2. the posting's recorded location, but ONLY when the question explicitly
 *      defers to it. A question that simply never mentions a country is not
 *      delegating; it is silent, and silence is not evidence.
 */
export function readJurisdiction(
  questionText: string,
  context: JurisdictionContext = {}
): JurisdictionReading {
  const text = questionText || "";
  const named = countriesIn(text);
  const defersToPosting = DEFERS_TO_POSTING.some((pattern) => pattern.test(text));

  // The question outranks everything: what the employer asked is the question.
  if (named.length === 1) return { country: named[0], source: "question", named, defersToPosting };
  // Two countries in one question is genuinely unclear, and the posting cannot
  // break the tie — it does not know which half is being asked about.
  if (named.length > 1) return { country: null, source: "none", named, defersToPosting };

  // The question points somewhere we cannot read. Not silence — an unanswered
  // question about a specific place. The posting cannot speak for it.
  if (referencesUnresolvedPlace(text)) {
    return { country: null, source: "none", named, defersToPosting };
  }

  // The question names nowhere at all. That is silence, not permission — so it
  // is the POSTING that has to establish it. A job recorded as being in one
  // country is positive evidence about where the employer is hiring; a posting
  // with no usable location establishes nothing and refuses.
  const fromPosting = countryFromJobLocation(context.jobLocation);
  return fromPosting
    ? { country: fromPosting, source: "job_location", named, defersToPosting }
    : { country: null, source: "none", named, defersToPosting };
}

// --------------------------------------------------------------------------- //
// Polarity — established, never assumed
// --------------------------------------------------------------------------- //

export type Polarity = "affirmative" | "negative" | "ambiguous" | "unknown";

/**
 * Templates for each polarity-sensitive key's own assertion.
 *
 * `affirmative` matches the question asked straight; `negative` matches its
 * opposite. A question matching NEITHER is `unknown` — which includes every
 * question in a language these patterns do not cover, and that is the point:
 * the gate cannot be walked past by wording it has never seen.
 */
const POLARITY_TEMPLATES: Partial<Record<CanonicalField, { affirmative: RegExp[]; negative: RegExp[] }>> = {
  work_authorization_us: {
    affirmative: [
      /\b(?:are|is)\s+you\b[^.?!]{0,40}\b(?:legally\s+)?authori[sz](?:ed|ation)\b/i,
      /\bare you\b[^.?!]{0,40}\b(?:legally\s+)?(?:eligible|entitled)\s+to work\b/i,
      /\bdo you (?:have|hold|possess)\b[^.?!]{0,40}\bright to work\b/i,
      /\bwork authori[sz](?:ation|ed)\b/i,
      /\bright to work\b/i,
      /\bauthori[sz](?:ed|ation) to work\b/i
    ],
    negative: [
      /\bun-?authori[sz](?:ed|ation)\b/i,
      /\bin-?eligible to work\b/i,
      /\b(?:are|is) you not\b[^.?!]{0,30}\bauthori[sz]/i,
      /\bnot\b[^.?!]{0,20}\b(?:legally\s+)?authori[sz](?:ed)\b/i,
      /\bdo you not (?:have|hold)\b[^.?!]{0,30}\bright to work\b/i
    ]
  },
  sponsorship_required_now: {
    affirmative: [
      /\b(?:will|do|would|are)\s+you\b[^.?!]{0,60}?\b(?:requir\w*|need\w*)\b[^.?!]{0,40}?\bsponsorship\b/i,
      /\b(?:requir\w*|need\w*)\b[^.?!]{0,30}?\b(?:visa |immigration |employment |company )?sponsorship\b/i,
      /\bsponsorship\b[^.?!]{0,30}?\b(?:requir\w*|need\w*)\b/i
    ],
    negative: [
      /\bnot\b[^.?!]{0,40}?\b(?:requir\w*|need\w*)\b[^.?!]{0,40}?\bsponsorship\b/i,
      /\bnor\b[^.?!]{0,60}?\bsponsorship\b/i,
      /\bwithout\b[^.?!]{0,20}?\bsponsorship\b[^.?!]{0,40}?\b(?:requir\w*|need\w*)\b/i,
      /\bdo you NOT\b/,
      /\bunless\b[^.?!]{0,40}?\bsponsorship\b/i
    ]
  }
};
POLARITY_TEMPLATES.sponsorship_required_future = POLARITY_TEMPLATES.sponsorship_required_now;

/** Keys whose answer flips meaning with the question's polarity. */
export function isPolaritySensitive(key: CanonicalField): boolean {
  return POLARITY_TEMPLATES[key] !== undefined;
}

/**
 * Read the polarity of `questionText` against `key`'s own assertion.
 *
 * Evaluated CLAUSE BY CLAUSE, for two reasons. Within a clause the negative
 * templates win over the affirmative ones, because they are the specific
 * reading: "I will not require sponsorship" matches the general
 * `require … sponsorship` shape too, and treating that collision as ambiguity
 * would mislabel an ordinary negation. Across clauses, disagreement is real
 * ambiguity — a prompt that asserts the thing in one breath and its opposite in
 * the next is exactly the one not to guess at.
 *
 * A clause that matches nothing contributes nothing, so a preamble
 * ("We do not discriminate.") cannot flip the question that follows it. When no
 * clause matches at all the result is `unknown`, which includes every wording —
 * and every language — these templates do not cover.
 */
export function detectPolarity(key: CanonicalField, questionText: string): Polarity {
  const templates = POLARITY_TEMPLATES[key];
  const text = (questionText || "").trim();
  if (!templates) return "affirmative"; // not polarity-sensitive
  if (!text) return "unknown";

  const readings = text
    .split(/[.?!;]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .map((clause): Polarity | null => {
      if (templates.negative.some((pattern) => pattern.test(clause))) return "negative";
      if (templates.affirmative.some((pattern) => pattern.test(clause))) return "affirmative";
      return null;
    })
    .filter((reading): reading is Polarity => reading !== null);

  if (readings.length === 0) return "unknown";
  const distinct = new Set(readings);
  if (distinct.size > 1) return "ambiguous";
  return readings[0];
}

// --------------------------------------------------------------------------- //
// The compatibility gate
// --------------------------------------------------------------------------- //

export type SemanticRefusal =
  | "JURISDICTION_MISMATCH"
  | "JURISDICTION_UNKNOWN"
  | "JURISDICTION_AMBIGUOUS"
  | "POLARITY_INCOMPATIBLE"
  | "POLARITY_UNKNOWN"
  | "POLARITY_AMBIGUOUS";

export type SemanticCheck = { ok: true } | { ok: false; reason: SemanticRefusal };

/**
 * May a stored answer for `key` be applied to the question the employer
 * rendered? Keys that are neither jurisdiction- nor polarity-scoped pass
 * through; the rest must be positively established.
 */
export function checkSemanticCompatibility(
  key: CanonicalField,
  questionText: string,
  context: JurisdictionContext = {}
): SemanticCheck {
  if (isPolaritySensitive(key)) {
    switch (detectPolarity(key, questionText)) {
      case "negative":
        return { ok: false, reason: "POLARITY_INCOMPATIBLE" };
      case "ambiguous":
        return { ok: false, reason: "POLARITY_AMBIGUOUS" };
      case "unknown":
        // Includes every wording — and every language — these templates do not
        // recognise. Not understanding the question is not permission.
        return { ok: false, reason: "POLARITY_UNKNOWN" };
      case "affirmative":
        break;
    }
  }

  const scope = jurisdictionScopeOf(key);
  if (!scope) return { ok: true };

  const reading = readJurisdiction(questionText, context);
  if (reading.country === scope) return { ok: true };
  if (reading.country) return { ok: false, reason: "JURISDICTION_MISMATCH" };
  if (reading.named.length > 1) return { ok: false, reason: "JURISDICTION_AMBIGUOUS" };
  // Nothing established it. Silence, an unrecognised country, a posting with no
  // usable location — all the same answer: we do not know, so we do not fill.
  return { ok: false, reason: "JURISDICTION_UNKNOWN" };
}
