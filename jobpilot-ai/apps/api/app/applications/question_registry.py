"""Versioned canonical application-question registry.

This describes QUESTIONS. It never stores answers — those live in
``ApplicationAnswer`` and are read through the legal gate in
``answer_vault_service``. Keeping the two apart is what stops a registry entry
from quietly becoming a second, weaker source of truth.

The registry is versioned because it participates in cache keys: a changed alias
or sensitivity must invalidate classifications made under the old rules.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from enum import StrEnum

#: Bump on ANY change to keys, aliases, sensitivity or option policy.
REGISTRY_VERSION = "1.0.0"


class Sensitivity(StrEnum):
    ordinary = "ordinary"
    personal = "personal"
    sensitive = "sensitive"
    legal = "legal"
    demographic = "demographic"
    consent = "consent"
    attestation = "attestation"


class AnswerType(StrEnum):
    boolean = "boolean"
    single_select = "single_select"
    multi_select = "multi_select"
    short_text = "short_text"
    long_text = "long_text"
    number = "number"
    date = "date"
    url = "url"


#: Sources that may authoritatively answer a LEGAL question.
EXPLICIT_SOURCES = (
    "explicit_profile",
    "user_confirmed_application",
    "user_confirmed_saved",
    "verified_answer_vault",
)
#: Sources acceptable for ordinary, non-consequential facts.
ORDINARY_SOURCES = (*EXPLICIT_SOURCES, "profile", "deterministic_job_metadata")


@dataclass(frozen=True)
class QuestionSpec:
    key: str
    description: str
    category: str
    sensitivity: Sensitivity
    answer_type: AnswerType
    allowed_sources: tuple[str, ...]
    autofill_allowed: bool
    requires_explicit_confirmation: bool
    #: Exact normalized phrases. Matched first and never fuzzy.
    aliases: tuple[str, ...] = ()
    #: Bounded patterns for wording we accept as unambiguous.
    patterns: tuple[re.Pattern[str], ...] = ()
    #: Canonical keys this question is composed FROM (see combined sponsorship).
    composed_of: tuple[str, ...] = ()
    locale: str = "en-US"
    version: str = REGISTRY_VERSION
    #: Extra option labels that must never be collapsed into a plain yes/no.
    qualified_option_markers: tuple[str, ...] = field(
        default=("with restriction", "but may", "temporarily", "under a", "other", "prefer not")
    )


def _p(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


REGISTRY: dict[str, QuestionSpec] = {
    # ---------------------------------------------------------------- legal --
    "work_authorization_us": QuestionSpec(
        key="work_authorization_us",
        description="Legally authorized to work in the US without restriction",
        category="legal",
        sensitivity=Sensitivity.legal,
        answer_type=AnswerType.boolean,
        allowed_sources=EXPLICIT_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=True,
        aliases=(
            "are you legally authorized to work in the us without restriction",
            "are you legally authorized to work in the united states without restriction",
            "are you authorized to work in the us without restriction",
            "can you legally work in the united states without restrictions",
            "legally authorized to work without restriction",
        ),
        # "without restriction" is REQUIRED. A bare "authorized to work?" is a
        # different question with a potentially different answer, so it must not
        # match here — see UNQUALIFIED_AUTHORIZATION below.
        patterns=(
            _p(r"legally\s+(authori[sz]ed|entitled|eligible)\s+to\s+work.*without\s+restriction"),
            _p(r"authori[sz]ed\s+to\s+work.*without\s+restriction"),
            _p(r"legally\s+work.*without\s+restrictions?"),
        ),
    ),
    "sponsorship_required_now": QuestionSpec(
        key="sponsorship_required_now",
        description="Currently requires employer sponsorship or a visa transfer",
        category="legal",
        sensitivity=Sensitivity.legal,
        answer_type=AnswerType.boolean,
        allowed_sources=EXPLICIT_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=True,
        aliases=(
            "do you currently require employer sponsorship or a visa transfer",
            "do you currently require sponsorship",
            "will you require sponsorship to begin employment",
        ),
        patterns=(_p(r"currently\s+require.*(sponsorship|visa\s+transfer)"),),
    ),
    "sponsorship_required_future": QuestionSpec(
        key="sponsorship_required_future",
        description="Will require employer sponsorship or a visa transfer in the future",
        category="legal",
        sensitivity=Sensitivity.legal,
        answer_type=AnswerType.boolean,
        allowed_sources=EXPLICIT_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=True,
        aliases=(
            "will you require employer sponsorship or a visa transfer in the future",
            "will you require sponsorship in the future",
        ),
        patterns=(
            _p(r"in\s+the\s+future.*require.*(sponsorship|visa\s+transfer)"),
            _p(r"require.*(sponsorship|visa\s+transfer).*in\s+the\s+future"),
        ),
    ),
    "sponsorship_required_now_or_future": QuestionSpec(
        key="sponsorship_required_now_or_future",
        description="Requires sponsorship now or in the future (combined question)",
        category="legal",
        sensitivity=Sensitivity.legal,
        answer_type=AnswerType.boolean,
        allowed_sources=EXPLICIT_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=True,
        aliases=(
            "will you now or in the future require visa sponsorship or a visa transfer",
            "will you now or in the future require sponsorship for employment visa status",
            "will you now or in the future require visa sponsorship",
            "do you now or in the future require sponsorship",
            "do you currently or will you in the future need employer sponsorship",
        ),
        patterns=(
            _p(r"now\s+or\s+in\s+the\s+future.*(sponsorship|visa\s+transfer)"),
            _p(r"(sponsorship|visa\s+transfer).*now\s+or\s+in\s+the\s+future"),
            _p(r"currently\s+or\s+will\s+you.*future.*(sponsorship|visa\s+transfer)"),
        ),
        # Answered ONLY by combining the two explicit components.
        composed_of=("sponsorship_required_now", "sponsorship_required_future"),
    ),
    "minimum_age_requirement": QuestionSpec(
        key="minimum_age_requirement",
        description="Meets the employer's minimum age requirement",
        category="legal",
        sensitivity=Sensitivity.legal,
        answer_type=AnswerType.boolean,
        allowed_sources=EXPLICIT_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=True,
        aliases=("are you at least 18 years of age", "are you 18 years or older"),
        patterns=(_p(r"at\s+least\s+\d{2}\s+years?\s+(of\s+age|old)"),),
    ),
    # --------------------------------------------------------------- source --
    "source_where_heard_about_job": QuestionSpec(
        key="source_where_heard_about_job",
        description="How the candidate heard about this opportunity",
        category="source",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.single_select,
        allowed_sources=(*ORDINARY_SOURCES,),
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=(
            "where did you hear about this opportunity",
            "where did you hear about this job",
            "how did you hear about us",
            "how did you hear about this position",
        ),
        patterns=(_p(r"(where|how)\s+did\s+you\s+(hear|learn)\s+about"),),
    ),
    # --------------------------------------------------------- availability --
    "available_start_date": QuestionSpec(
        key="available_start_date",
        description="Earliest available start date",
        category="availability",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.date,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("when can you start", "earliest start date", "available start date"),
        patterns=(_p(r"(earliest|available).*start\s+date"), _p(r"when\s+can\s+you\s+start")),
    ),
    "notice_period": QuestionSpec(
        key="notice_period",
        description="Notice period required with the current employer",
        category="availability",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.short_text,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("what is your notice period", "notice period"),
        patterns=(_p(r"notice\s+period"),),
    ),
    "willing_to_relocate": QuestionSpec(
        key="willing_to_relocate",
        description="Willing to relocate for the role",
        category="availability",
        sensitivity=Sensitivity.personal,
        answer_type=AnswerType.boolean,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("are you willing to relocate", "willing to relocate"),
        patterns=(_p(r"willing\s+to\s+relocate"),),
    ),
    # ------------------------------------------------------------- profile --
    "preferred_name": QuestionSpec(
        key="preferred_name",
        description="Preferred name",
        category="profile",
        sensitivity=Sensitivity.personal,
        answer_type=AnswerType.short_text,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("preferred name", "what is your preferred name"),
        patterns=(_p(r"preferred\s+(first\s+)?name"),),
    ),
    "current_location": QuestionSpec(
        key="current_location",
        description="Current city or location",
        category="profile",
        sensitivity=Sensitivity.personal,
        answer_type=AnswerType.short_text,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("current location", "where are you located", "city"),
        patterns=(_p(r"current\s+(location|city)"),),
    ),
    # ------------------------------------------------- general application --
    "years_of_experience": QuestionSpec(
        key="years_of_experience",
        description="Total years of relevant professional experience",
        category="experience",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.number,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("years of experience", "how many years of experience do you have"),
        patterns=(_p(r"years?\s+of\s+(relevant\s+)?experience"),),
    ),
    "current_employer": QuestionSpec(
        key="current_employer",
        description="Current employer",
        category="experience",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.short_text,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("current employer", "who is your current employer"),
        patterns=(_p(r"current\s+employer"),),
    ),
    "salary_expectation": QuestionSpec(
        key="salary_expectation",
        description="Expected compensation",
        category="compensation",
        # Consequential and easy to get wrong on the candidate's behalf.
        sensitivity=Sensitivity.sensitive,
        answer_type=AnswerType.short_text,
        allowed_sources=EXPLICIT_SOURCES,
        autofill_allowed=False,
        requires_explicit_confirmation=True,
        aliases=("salary expectation", "expected salary", "desired compensation"),
        patterns=(_p(r"(salary\s+expectation|expected\s+salary|desired\s+compensation)"),),
    ),
    "portfolio_url": QuestionSpec(
        key="portfolio_url",
        description="Portfolio or personal website",
        category="links",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.url,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("portfolio", "portfolio url", "personal website"),
        patterns=(_p(r"portfolio|personal\s+website"),),
    ),
    "linkedin_url": QuestionSpec(
        key="linkedin_url",
        description="LinkedIn profile URL",
        category="links",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.url,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("linkedin", "linkedin profile", "linkedin url"),
        patterns=(_p(r"linked\s?in"),),
    ),
    "github_url": QuestionSpec(
        key="github_url",
        description="GitHub profile URL",
        category="links",
        sensitivity=Sensitivity.ordinary,
        answer_type=AnswerType.url,
        allowed_sources=ORDINARY_SOURCES,
        autofill_allowed=True,
        requires_explicit_confirmation=False,
        aliases=("github", "github profile", "github url"),
        patterns=(_p(r"git\s?hub"),),
    ),
}


# --------------------------------------------------------------------------- #
# Wording that must NEVER be auto-answered
# --------------------------------------------------------------------------- #
#: Authorization questions missing the "without restriction" qualifier. These
#: are legally different from work_authorization_us — someone on OPT may be
#: "authorized to work" today yet not "without restriction" — so they resolve to
#: review rather than to a canonical key.
UNQUALIFIED_AUTHORIZATION = (
    _p(r"currently\s+authori[sz]ed(?!.*without\s+restriction)"),
    _p(r"permanently\s+authori[sz]ed"),
    _p(r"authori[sz]ed\s+for\s+this\s+employer"),
)

# A confirmed "authorized without restriction = Yes" safely implies Yes for
# this broader question. The reverse is not true: a stored No may still mean
# the person is authorized with restrictions, so the answer service refuses
# that direction instead of pretending the questions are equivalent.
US_AUTHORIZATION_IMPLICATION = (
    _p(
        r"authori[sz]ed\s+to\s+work\s+in\s+(?:the\s+)?"
        r"(?:us|u s|united\s+states)(?!.*without\s+restriction)"
    ),
)

#: Consent and attestation wording. Recognised only so it can be refused.
CONSENT_PATTERNS = (
    _p(r"privacy\s+(policy|notice|terms|statement)"),
    _p(r"\bi\s+(agree|consent|acknowledge|certify|attest)\b"),
    _p(r"terms\s+and\s+conditions"),
    _p(r"consent\s+to\s+(the\s+)?(processing|collection)"),
)


def normalize_question(text: str) -> str:
    """Normalize employer wording without changing its meaning.

    Case, whitespace, punctuation and required-markers are noise. Words are NOT
    removed: dropping "without" or "not" would silently turn one legal question
    into its opposite.
    """
    if not text:
        return ""
    value = unicodedata.normalize("NFKC", text)
    # Required markers and numbering, not part of the question.
    value = re.sub(
        r"[\*∗]|\(required\)|\[required\]|\brequired\b\s*$", " ", value, flags=re.IGNORECASE
    )
    value = re.sub(r"^\s*\d+[\.\)]\s*", "", value)
    value = value.replace("’", "'").replace("‘", "'")
    value = re.sub(r"[^\w\s'/-]", " ", value)
    return re.sub(r"\s+", " ", value).strip().lower()


def question_hash(text: str, *, options: tuple[str, ...] = ()) -> str:
    """Stable identity for a question + its option set, for cache keys."""
    payload = "|".join([normalize_question(text), *sorted(normalize_question(o) for o in options)])
    return hashlib.sha256(f"{REGISTRY_VERSION}:{payload}".encode()).hexdigest()[:32]
