"""Deterministic employer-wording → canonical-question resolution.

Runs BEFORE any model call. Everything here is exact-match or a bounded,
reviewed pattern, so the common questions cost nothing and behave identically
every time. A model is only worth asking about wording this cannot recognise.

The bias throughout is toward refusing: an unrecognised or ambiguous legal
question resolves to review, never to a nearby canonical key.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from app.applications.question_registry import (
    CONSENT_PATTERNS,
    REGISTRY,
    REGISTRY_VERSION,
    UNQUALIFIED_AUTHORIZATION,
    US_AUTHORIZATION_IMPLICATION,
    QuestionSpec,
    Sensitivity,
    normalize_question,
)


@dataclass(frozen=True)
class Resolution:
    """What a question was recognised as, and how confident we are that it is
    safe to act on."""

    canonical_key: str | None
    #: exact_alias | pattern | consent | ambiguous_legal | unknown
    method: str
    reason_code: str
    sensitivity: Sensitivity | None = None
    requires_user_action: bool = False
    registry_version: str = REGISTRY_VERSION

    @property
    def resolved(self) -> bool:
        return self.canonical_key is not None


def _spec(key: str) -> QuestionSpec:
    return REGISTRY[key]


def resolve_question(text: str) -> Resolution:
    """Map employer wording to a canonical key, or explain why we won't.

    Order matters: consent and ambiguous-legal checks run BEFORE alias matching
    so no phrasing can reach a canonical key through a side door.
    """
    normalized = normalize_question(text)
    if not normalized:
        return Resolution(None, "unknown", "empty_question")

    # 1. Consent / attestation. Recognised only to be refused — these are the
    #    user's signature, never a field to complete.
    if any(pattern.search(normalized) for pattern in CONSENT_PATTERNS):
        return Resolution(
            None,
            "consent",
            "consent_requires_user",
            sensitivity=Sensitivity.consent,
            requires_user_action=True,
        )

    # 2. Explicitly qualified/permanent/employer-specific authorization remains
    #    distinct and review-only, even when it also mentions the U.S.
    if any(pattern.search(normalized) for pattern in UNQUALIFIED_AUTHORIZATION):
        return Resolution(
            None,
            "ambiguous_legal",
            "authorization_wording_ambiguous",
            sensitivity=Sensitivity.legal,
            requires_user_action=True,
        )

    # 3. A broader U.S.-authorization question can be answered from the
    #    narrower "without restriction" fact only in the safe direction. The
    #    answer service enforces that one-way implication after reading value.
    if any(pattern.search(normalized) for pattern in US_AUTHORIZATION_IMPLICATION):
        return Resolution(
            "work_authorization_us",
            "deterministic_implication",
            "without_restriction_implies_authorized",
            sensitivity=Sensitivity.legal,
        )

    # 4. Exact alias — the cheapest and most certain match.
    for key, spec in REGISTRY.items():
        if normalized in spec.aliases:
            return Resolution(key, "exact_alias", "alias_match", sensitivity=spec.sensitivity)

    # 5. Bounded patterns. Legal keys are checked first so a generic pattern
    #    cannot claim a legal question.
    ordered = sorted(REGISTRY.items(), key=lambda item: item[1].sensitivity != Sensitivity.legal)
    for key, spec in ordered:
        if any(pattern.search(normalized) for pattern in spec.patterns):
            return Resolution(key, "pattern", "pattern_match", sensitivity=spec.sensitivity)

    return Resolution(None, "unknown", "no_deterministic_match")


def resolve_question_descriptor(
    *,
    question: str,
    raw_label: str | None = None,
    accessible_name: str | None = None,
    nearby_text: str | None = None,
    section: str | None = None,
    field_name: str | None = None,
    field_id: str | None = None,
    placeholder: str | None = None,
) -> Resolution:
    """Resolve from the field's accessible descriptor without concatenating it.

    Concatenation destroys provenance and can let unrelated nearby copy claim a
    legal field. Each source is resolved independently; agreeing sources raise
    confidence operationally, while conflicting canonical keys stop the fill.
    Machine-ish name/id and nearby text are considered only when the primary
    label/name sources did not resolve.
    """
    primary = (
        ("question", question),
        ("raw_label", raw_label),
        ("accessible_name", accessible_name),
        ("placeholder", placeholder),
    )
    supporting = (
        ("section", section),
        ("field_name", field_name),
        ("field_id", field_id),
        ("nearby_text", nearby_text),
    )

    def candidates(items):
        return [
            (source, result)
            for source, value in items
            if value and (result := resolve_question(value)).canonical_key is not None
        ]

    matches = candidates(primary)
    if not matches:
        matches = candidates(supporting)
    keys = {result.canonical_key for _, result in matches}
    if len(keys) > 1:
        return Resolution(
            None,
            "conflict",
            "canonical_resolution_conflict",
            sensitivity=Sensitivity.legal
            if any(result.sensitivity == Sensitivity.legal for _, result in matches)
            else None,
            requires_user_action=True,
        )
    if matches:
        source, result = matches[0]
        return replace(result, method=f"{result.method}:{source}")

    # Preserve the strongest refusal from the primary descriptor.
    refusals = [resolve_question(value) for _, value in primary if value]
    consent = next((result for result in refusals if result.method == "consent"), None)
    if consent:
        return consent
    ambiguous = next((result for result in refusals if result.method == "ambiguous_legal"), None)
    if ambiguous:
        return ambiguous
    return resolve_question(question)


# --------------------------------------------------------------------------- #
# Option mapping
# --------------------------------------------------------------------------- #
_AFFIRMATIVE = ("yes", "y", "true")
_NEGATIVE = ("no", "n", "false")


def map_boolean_option(
    value: bool, options: list[str], spec: QuestionSpec
) -> tuple[str | None, str]:
    """Map a yes/no answer onto an option that actually exists.

    Returns ``(option_label, reason_code)``. A qualified option such as
    "Yes, with restrictions" is NOT an acceptable match for a plain yes: the
    qualifier changes what the candidate is stating, so it goes to review.
    """
    if not options:
        return None, "no_options"

    normalized = [(raw, normalize_question(raw)) for raw in options]
    wanted = _AFFIRMATIVE if value else _NEGATIVE

    exact = [raw for raw, norm in normalized if norm in wanted]
    if len(exact) == 1:
        return exact[0], "exact_option"
    if len(exact) > 1:
        return None, "ambiguous_option"

    # Anything qualified is deliberately refused rather than approximated.
    qualified = [
        raw
        for raw, norm in normalized
        if norm.startswith(wanted)
        and any(marker in norm for marker in spec.qualified_option_markers)
    ]
    if qualified:
        return None, "qualified_option_requires_review"

    return None, "option_not_found"


# --------------------------------------------------------------------------- #
# "Where did you hear about this opportunity?"
# --------------------------------------------------------------------------- #
#: Verified job-source category -> option wording, most specific first. Chosen
#: deterministically from OUR metadata, never guessed from the option list.
_SOURCE_PREFERENCES: dict[str, tuple[str, ...]] = {
    "linkedin": ("linkedin", "online job board", "job board", "job search website"),
    "indeed": ("indeed", "online job board", "job board", "job search website"),
    "handshake": ("handshake", "university", "career fair", "job board"),
    "simplifyjobs": ("online job board", "job board", "job search website"),
    # A persisted `job_sources.source_type` value, not a display string. It is
    # matched against rows that already exist in the database, so it keeps the
    # pre-rebrand spelling — renaming the key would silently stop resolving the
    # question for every job ingested under it.
    "jobpilot": ("online job board", "job board", "job search website"),
    "greenhouse": ("company website", "company careers site"),
    "company_site": ("company website", "company careers site", "our website"),
    "referral": ("employee referral", "referral"),
    "recruiter": ("recruiter", "recruiter outreach", "sourced by a recruiter"),
}


def map_job_source_option(
    source_category: str | None, options: list[str]
) -> tuple[str | None, str]:
    """Choose a real visible option for the job-source question.

    "Other" is never a fallback for "we couldn't find a match" — it is only
    correct when the source genuinely is not represented, which is a judgement
    this deterministic layer does not make.
    """
    if not source_category:
        return None, "unknown_job_source"
    if not options:
        return None, "no_options"

    preferences = _SOURCE_PREFERENCES.get(source_category.strip().lower())
    if not preferences:
        return None, "unmapped_job_source"

    normalized = [(raw, normalize_question(raw)) for raw in options]
    for preference in preferences:
        for raw, norm in normalized:
            if norm == preference:
                return raw, "exact_option"
    for preference in preferences:
        for raw, norm in normalized:
            if preference in norm:
                return raw, "contains_option"
    return None, "option_not_found"


# --------------------------------------------------------------------------- #
# Combined sponsorship
# --------------------------------------------------------------------------- #
def combine_sponsorship(now: bool | None, future: bool | None) -> tuple[bool | None, str]:
    """``now OR future`` — but only when BOTH components are known.

    A missing half is not evidence about the whole: someone who needs no
    sponsorship today may still need it later, so "now=No, future=unknown"
    cannot be answered No.
    """
    if now is None or future is None:
        return None, "missing_component"
    return (now or future), "combined"
