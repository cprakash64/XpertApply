/**
 * Answer-integrity regression suite — XA-02, XA-03, XA-04, XA-05.
 *
 * The invariant under test:
 *
 *   XPERTAPPLY MUST NEVER CONVERT "UNKNOWN" INTO A USER ASSERTION.
 *
 * `undefined`, `null`, `""`, "no stored answer", "the question names another
 * country", "the question asks the opposite" and "no option matched" are all
 * distinct states, and none of them is the answer "No" — or "Yes".
 *
 * Every case here reproduces something the audit observed on the real build, or
 * an adjacent case with the same root cause. A test in this file is only
 * meaningful if it FAILS against the pre-fix pipeline; the negative control run
 * is recorded in the Stage 3B report.
 */

import { describe, expect, it } from "vitest";
import { discoverFields } from "../fields/discovery";
import { buildMappings } from "../fields/mapping";
import { applyFill } from "../fields/runner";
import {
  checkSemanticCompatibility,
  readJurisdiction,
  detectPolarity,
  isConsequentialKey
} from "../fields/answerSemantics";
import { answerAuthorityOf, decideFill } from "../fields/answerAuthority";
import type { ApplicationSessionData, DiscoveredField, SessionAnswer } from "../types";

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

/** Profile truth: authorized in the US; does NOT require sponsorship. */
function answer(canonical_key: string, value: string, extra: Partial<SessionAnswer> = {}): SessionAnswer {
  return {
    canonical_key, value, display_value: value, source: "profile",
    confidence: 1, sensitive: false, requires_review: false, verified: true, ...extra
  };
}

function session(answers: SessionAnswer[] = []): ApplicationSessionData {
  return {
    sessionId: 1,
    atsType: null,
    officialUrl: "https://boards.greenhouse.io/acme/1",
    jobTitle: "Backend Engineer",
    jobLocation: "San Francisco, CA",
    company: "Acme",
    unresolvedQuestions: [],
    answers: [
      answer("work_authorization_us", "Yes"),
      answer("sponsorship_required_now", "No"),
      answer("sponsorship_required_future", "No"),
      ...answers
    ]
  };
}

/**
 * Mount one question as a labelled required <select> — the shape most ATS
 * forms use, and the one where the control's own accessible name IS the
 * question. Radio groups carry the question in a <legend> instead, which is
 * covered separately below.
 */
function askSelect(question: string, options: string[], data = session()) {
  document.body.innerHTML = `<form id="app"><label for="q">${question}</label>` +
    `<select id="q" name="q" required><option value="">Select…</option>` +
    options.map((o) => `<option>${o}</option>`).join("") + `</select></form>`;
  const fields = discoverFields(document.querySelector("#app")!);
  const { mappings } = buildMappings(fields, data);
  return { fields, mappings, mapping: mappings[0] };
}

async function fillSelect(question: string, options: string[], data = session()) {
  const { fields, mappings } = askSelect(question, options, data);
  const summary = await applyFill(fields, mappings, data);
  const value = (document.getElementById("q") as HTMLSelectElement).value;
  return { selected: value === "" ? null : value, summary, mapping: mappings[0] };
}

/** Mount one question as a required radio group and return its mapping. */
function askRadio(question: string, options: string[], data = session()) {
  document.body.innerHTML = `<form id="app"><fieldset><legend>${question}</legend>${options
    .map((o, i) => `<label><input type="radio" name="q" id="q_${i}" value="${o}" required> ${o}</label>`)
    .join("")}</fieldset></form>`;
  const fields = discoverFields(document.querySelector("#app")!);
  const { mappings } = buildMappings(fields, data);
  return { fields, mappings, mapping: mappings[0] };
}

/** Mount, map and actually run the fill, returning the selected radio value. */
async function fillRadio(question: string, options: string[], data = session()) {
  const { fields, mappings } = askRadio(question, options, data);
  const summary = await applyFill(fields, mappings, data);
  const checked = document.querySelector<HTMLInputElement>('input[name="q"]:checked');
  return { selected: checked?.value ?? null, summary, mapping: mappings[0] };
}

// --------------------------------------------------------------------------- //
// XA-02 — legal attestations are auto-affirmed on the candidate's behalf
// --------------------------------------------------------------------------- //

describe("XA-02 · a legal attestation is never agreed to for the user", () => {
  const ATTESTATIONS = [
    "I certify that the information provided is true and complete.",
    "I acknowledge that any false statement may result in dismissal.",
    "I certify that the facts set forth in this application are true.",
    "Candidate AI Usage Attestation:"
  ];

  for (const question of ATTESTATIONS) {
    it(`leaves "${question.slice(0, 44)}…" unanswered even as the only option`, async () => {
      // The original defect: a REQUIRED control offering exactly one
      // substantive affirmative option was treated as having nothing to decide,
      // and an affirmation was synthesised.
      const { selected, mapping } = await fillRadio(question, ["I agree"]);
      expect(selected).toBeNull();
      expect(mapping.safeToAutoFill).toBe(false);
      expect(mapping.decision?.status).not.toBe("SAFE_TO_FILL");
    });
  }

  it("raises the refused attestation for review rather than dropping it", () => {
    const { mapping } = askRadio("I certify that the information provided is true and complete.", ["I agree"]);
    expect(mapping.requiresReview).toBe(true);
    expect(mapping.decision).toMatchObject({ status: "REQUIRES_REVIEW", reason: "CONSENT_IS_THE_USERS_ACT" });
  });

  it("still refuses when the affirmative is worded as Yes", async () => {
    const { selected } = await fillRadio("I acknowledge the terms of this application.", ["Yes"]);
    expect(selected).toBeNull();
  });

  it("fills an attestation the user actually answered", async () => {
    // Authority exists → the field is answerable. Refusing here would be a
    // different failure: silently withholding the user's own answer.
    const data = session([
      answer("legal_attestation", "I agree", { sensitive: true, source: "user_confirmed_application" })
    ]);
    const { selected } = await fillSelect("I certify that the information provided is true.", ["I agree"], data);
    expect(selected).toBe("I agree");
  });

  it("does not reuse a saved attestation from another employer's wording", async () => {
    // A vault answer attested to a DIFFERENT statement. Same canonical key,
    // different assertion — it is not an answer to this question.
    const data = session([
      answer("legal_attestation", "I agree", { sensitive: true, source: "vault" })
    ]);
    const { selected, mapping } = await fillSelect(
      "I certify that the information provided is true.", ["I agree"], data
    );
    expect(selected).toBeNull();
    expect(mapping.decision).toMatchObject({ reason: "CONSENT_IS_THE_USERS_ACT" });
  });

  it("does not treat an unclassified required single-option control as agreement", async () => {
    // Same escape hatch, reached through the `unknown` branch instead.
    const { selected } = await fillRadio("Please confirm the statement above.", ["I agree"]);
    expect(selected).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// XA-03 — a US work-authorization answer applied to non-US questions
// --------------------------------------------------------------------------- //

describe("XA-03 · a US answer never answers another country's question", () => {
  const FOREIGN = [
    "Are you legally authorised to work in the UK?",
    "Do you have the legal right to work in the United Kingdom?",
    "Are you legally authorized to work in Germany?",
    "Do you have the right to work in Canada without sponsorship?",
    "Are you legally authorized to work in Australia?",
    "Do you have the right to work in Ireland?",
    "Are you authorised to work in Singapore?",
    "Do you hold the right to work in the European Union?"
  ];

  for (const question of FOREIGN) {
    it(`refuses "${question.slice(0, 46)}…"`, async () => {
      const { selected, mapping } = await fillRadio(question, ["Yes", "No"]);
      expect(selected).toBeNull();
      expect(mapping.decision).toMatchObject({ status: "REQUIRES_REVIEW" });
      expect(["JURISDICTION_MISMATCH", "JURISDICTION_AMBIGUOUS", "JURISDICTION_UNKNOWN"])
        .toContain((mapping.decision as { reason: string }).reason);
    });
  }

  it("refuses a foreign sponsorship question too", async () => {
    const { selected } = await fillRadio(
      "Do you now, or will you in the future, require immigration sponsorship to work in Australia?",
      ["Yes", "No"]
    );
    expect(selected).toBeNull();
  });

  it("still answers the US question the stored answer is actually about", async () => {
    const { selected } = await fillRadio(
      "Are you legally authorized to work in the United States?",
      ["Yes", "No"]
    );
    expect(selected).toBe("Yes");
  });

  it("still answers a question that defers to the posting's own country", async () => {
    // The common Greenhouse/Ashby wording. Refusing here would break a
    // legitimate flow for no safety gain.
    const { selected } = await fillSelect(
      "Are you legally authorized to work in the country where the job is located?",
      ["Yes", "No"]
    );
    expect(selected).toBe("Yes");
  });

  it("still answers a US question that also mentions sponsorship", async () => {
    const { selected } = await fillRadio(
      "Are you legally authorized to work in the United States without sponsorship?",
      ["Yes", "No"]
    );
    expect(selected).toBe("Yes");
  });

  it("refuses when the question names the US and another country together", () => {
    expect(checkSemanticCompatibility("work_authorization_us", "Are you authorized to work in the US or Canada?"))
      .toEqual({ ok: false, reason: "JURISDICTION_AMBIGUOUS" });
  });

  it("does not mistake ordinary words for a country", () => {
    for (const text of ["Employment STATUS", "Tell us about yourself", "On campus recruiting", "Business unit"]) {
      expect(readJurisdiction(text).named).toEqual([]);
    }
  });
});

// --------------------------------------------------------------------------- //
// XA-04 — negated wording answered inverted
// --------------------------------------------------------------------------- //

describe("XA-04 · a negated question never inherits the affirmative answer", () => {
  const NEGATED = [
    "I do not now, nor in the future, will require sponsorship to work in the United States.",
    "Do you NOT require sponsorship now or in the future?",
    "Do you not require visa sponsorship to work in the United States?",
    "Confirm that you will not require sponsorship now or in the future."
  ];

  for (const question of NEGATED) {
    it(`refuses "${question.slice(0, 46)}…"`, async () => {
      // Answering "No" here asserts the OPPOSITE of the stored answer: the
      // candidate does not require sponsorship, so the truthful answer to the
      // negated form is Yes. The extension declines rather than inverting.
      const { selected, mapping } = await fillRadio(question, ["Yes", "No"]);
      expect(selected).toBeNull();
      expect(mapping.decision).toMatchObject({
        status: "REQUIRES_REVIEW",
        reason: "POLARITY_INCOMPATIBLE"
      });
    });
  }

  it("refuses a negated work-authorization question", async () => {
    const { selected } = await fillRadio(
      "Are you unauthorized to work in the United States?",
      ["Yes", "No"]
    );
    expect(selected).toBeNull();
  });

  it("still answers the affirmative form of the same question", async () => {
    const { selected } = await fillRadio(
      "Will you now or in the future require sponsorship for employment visa status?",
      ["Yes", "No"]
    );
    expect(selected).toBe("No");
  });

  it("reads polarity against the key's own predicate, not any negative word", () => {
    // "without sponsorship" negates the sponsorship clause, not the
    // authorization predicate — this question is answerable.
    expect(detectPolarity("work_authorization_us", "Are you legally authorized to work in the US without sponsorship?"))
      .toBe("affirmative");
    expect(detectPolarity("sponsorship_required_future", "Will you now or in the future require sponsorship?"))
      .toBe("affirmative");
    expect(detectPolarity("sponsorship_required_future", "I will not require sponsorship."))
      .toBe("negative");
  });

  it("does not let a negation in a previous sentence reach the predicate", () => {
    expect(detectPolarity(
      "work_authorization_us",
      "We do not discriminate. Are you legally authorized to work in the United States?"
    )).toBe("affirmative");
  });
});

// --------------------------------------------------------------------------- //
// The state machine — unknown is not false, and not "No"
// --------------------------------------------------------------------------- //

describe("answer states never collapse into one another", () => {
  const base: Parameters<typeof decideFill>[0] = {
    field: { control: "radio", required: true, options: ["Yes", "No"] } as unknown as DiscoveredField,
    canonicalKey: "work_authorization_us",
    confidence: 0.98,
    sensitive: false,
    answer: undefined,
    questionText: "Are you legally authorized to work in the United States?",
    autoFillThreshold: 0.95,
    reviewThreshold: 0.8,
    productDefaultKeys: new Set()
  };

  it("treats missing, empty, whitespace and unverified as UNKNOWN — never as an answer", () => {
    const cases: (SessionAnswer | undefined)[] = [
      undefined,
      answer("work_authorization_us", ""),
      answer("work_authorization_us", "   "),
      answer("work_authorization_us", "Yes", { verified: false }),
      answer("work_authorization_us", "Yes", { requires_review: true })
    ];
    for (const candidate of cases) {
      expect(answerAuthorityOf(candidate, { consequential: true })).toBe("none");
      expect(decideFill({ ...base, answer: candidate }).status).toBe("REQUIRES_REVIEW");
    }
  });

  it("does not accept a derived answer as the user's assertion on a consequential question", () => {
    for (const source of ["resume", "job_description", "company_context"]) {
      const derived = answer("work_authorization_us", "Yes", { source });
      expect(answerAuthorityOf(derived, { consequential: true })).toBe("none");
      expect(decideFill({ ...base, answer: derived })).toMatchObject({
        status: "REQUIRES_REVIEW",
        reason: "ANSWER_SOURCE_NOT_USER_ASSERTED"
      });
    }
  });

  it("fails closed on a source it does not recognise", () => {
    const unknownSource = answer("work_authorization_us", "Yes", { source: "some_new_pipeline" });
    expect(answerAuthorityOf(unknownSource, { consequential: true })).toBe("none");
  });

  it("accepts the user-asserted sources the API actually emits", () => {
    for (const source of ["profile", "confirmed_profile", "vault", "user_confirmed", "user_default", "profile_eeo"]) {
      expect(answerAuthorityOf(answer("work_authorization_us", "Yes", { source }), { consequential: true }))
        .not.toBe("none");
    }
  });

  it("names every consequential key the audit called out", () => {
    for (const key of [
      "work_authorization_us", "sponsorship_required_now", "sponsorship_required_future",
      "legal_attestation", "criminal_history", "gender", "race", "ethnicity",
      "disability_status", "veteran_status", "security_clearance", "electronic_signature"
    ] as const) {
      expect(isConsequentialKey(key)).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------- //
// Option matching fails closed
// --------------------------------------------------------------------------- //

describe("option matching never settles for the nearest thing", () => {
  it("does not select index 0 when nothing matches", async () => {
    const { selected } = await fillRadio(
      "Are you legally authorized to work in the United States?",
      ["Please select", "Authorized with restrictions", "Prefer not to answer"]
    );
    expect(selected).toBeNull();
  });

  it("never maps a missing demographic answer onto Decline to self-identify", async () => {
    const { selected } = await fillRadio(
      "What is your gender?",
      ["Male", "Female", "Non-binary", "Decline to self identify"]
    );
    expect(selected).toBeNull();
  });

  it("never maps unknown onto No", async () => {
    const data = session([]);
    data.answers = data.answers.filter((a) => !a.canonical_key.startsWith("sponsorship"));
    const { selected } = await fillRadio(
      "Will you now or in the future require sponsorship?",
      ["Yes", "No"],
      data
    );
    expect(selected).toBeNull();
  });

  it("never maps unknown onto Not applicable", async () => {
    const data = session([]);
    data.answers = [];
    const { selected } = await fillRadio(
      "Do you hold an active security clearance?",
      ["Yes", "No", "Not applicable"],
      data
    );
    expect(selected).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Do-no-harm cases that must survive the change
// --------------------------------------------------------------------------- //

describe("legitimate answers still fill", () => {
  it("fills ordinary identity fields untouched by the authority gate", async () => {
    document.body.innerHTML = `<form id="app">
      <label for="first_name">First name</label><input id="first_name" name="first_name" required>
      <label for="email">Email</label><input id="email" name="email" type="email" required>
    </form>`;
    const data = session([answer("first_name", "Aisha"), answer("email", "a@example.test")]);
    const fields = discoverFields(document.querySelector("#app")!);
    const { mappings } = buildMappings(fields, data);
    await applyFill(fields, mappings, data);
    expect((document.getElementById("first_name") as HTMLInputElement).value).toBe("Aisha");
    expect((document.getElementById("email") as HTMLInputElement).value).toBe("a@example.test");
  });

  it("does not overwrite a value the user already typed", async () => {
    document.body.innerHTML = `<form id="app">
      <label for="first_name">First name</label><input id="first_name" name="first_name" value="TYPED-BY-USER" required>
    </form>`;
    const data = session([answer("first_name", "Aisha")]);
    const fields = discoverFields(document.querySelector("#app")!);
    const { mappings } = buildMappings(fields, data);
    await applyFill(fields, mappings, data);
    expect((document.getElementById("first_name") as HTMLInputElement).value).toBe("TYPED-BY-USER");
  });

  it("records an authority for every answer it does fill", () => {
    document.body.innerHTML = `<form id="app">
      <label for="first_name">First name</label><input id="first_name" name="first_name" required>
    </form>`;
    const data = session([answer("first_name", "Aisha")]);
    const fields = discoverFields(document.querySelector("#app")!);
    const { mappings } = buildMappings(fields, data);
    const filled = mappings.filter((m) => m.safeToAutoFill);
    expect(filled.length).toBeGreaterThan(0);
    for (const m of filled) {
      expect(m.decision?.status).toBe("SAFE_TO_FILL");
      expect(m.decision?.authority).not.toBe("none");
    }
  });
});
