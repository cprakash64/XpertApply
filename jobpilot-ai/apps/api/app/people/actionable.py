"""The one gate that decides whether a person may be shown to a user.

JobPilot's product rule is deliberately lopsided: **show fewer people, but make
every displayed person actionable.** A contact the user cannot open, cannot
name, or cannot trust is worse than an empty state, because it costs the user
attention and returns nothing.

The live failure this module exists to end: Apollo returned records like
``"Priya R███████"`` with no LinkedIn URL, and they rendered as contact cards.
There *was* a masked-name check in the codebase — but it had exactly one call
site, inside the Apollo waterfall step. PDL candidates, public-web candidates,
the persistence path, the cached-read path, the GET endpoint and the frontend
all bypassed it. A policy with one call site is not a policy.

So this module is the single definition, and it is applied at four independent
layers (defence in depth, because each one has been the leak at some point):

1. **Discovery** — a provider's candidate is evaluated before it is accepted.
2. **Persistence** — a non-actionable candidate is never written as a visible
   recommendation.
3. **Read** — ``recommendations_payload`` re-checks every stored row, so legacy
   data written under an older contract cannot be served.
4. **Frontend** — refuses to render a masked or linkless card even if one
   somehow reaches it.

Non-actionable candidates are not *discarded*: they stay as bounded internal
hints for identity resolution (a masked surname plus a title and a company is a
perfectly good search hint). They simply never become contacts.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.core.config import settings
from app.people.finalization import (
    PEOPLE_DISPLAY_POLICY_VERSION,
    display_policy_rejection,
)
from app.people.schemas import JobPeopleSearchProfile, PeopleCategory, ProviderPerson
from app.people.scoring import company_match_strength, confidence
from app.people.security import safe_profile_url
from app.people.title_ontology import normalize_title, title_similarity

__all__ = [
    "ACTIONABLE_CONTACT_POLICY_VERSION",
    "PEOPLE_DISPLAY_POLICY_VERSION",
    "ActionableDecision",
    "REJECTION_REASONS",
    "company_key",
    "evaluate_actionable_contact",
    "is_displayable_record",
    "name_rejection",
]

# Legal-form suffixes that carry no identity. "Acme, Inc." and "Acme" are the
# same employer; "Acme Health" and "Acme" are not, and nothing here conflates
# them.
_COMPANY_SUFFIXES = frozenset(
    {
        "inc",
        "incorporated",
        "llc",
        "llp",
        "ltd",
        "limited",
        "plc",
        "corp",
        "corporation",
        "co",
        "company",
        "gmbh",
        "sa",
        "sas",
        "bv",
        "nv",
        "ab",
        "ag",
        "pte",
        "pty",
        "srl",
        "spa",
        "oy",
        "as",
        "kk",
    }
)


def company_key(value: str | None) -> str:
    """Strict comparison form for an employer name.

    Deliberately *not* fuzzy. It lowercases, strips punctuation and drops legal
    suffixes — and nothing else. Two names that differ by a real word are two
    different employers, because treating "Vanderbilt University" as
    "Vanderbilt University Medical Center" is how a contact at the wrong
    organization reaches a user.
    """

    import re as _re

    text = _re.sub(r"[^a-z0-9 ]+", " ", (value or "").lower())
    tokens = [token for token in text.split() if token and token not in _COMPANY_SUFFIXES]
    return " ".join(tokens)

# Bump when acceptance changes what a user can see. Part of the cache contract:
# a stored "no strong contacts" produced under a laxer rule is not the same
# answer as one produced under this rule.
ACTIONABLE_CONTACT_POLICY_VERSION = "people-actionable-v1"

# Every typed reason acceptance can fail. Low-cardinality on purpose: these are
# logged and counted, and a free-text reason would be neither aggregatable nor
# safe.
REJECTION_REASONS = (
    "masked_name",
    "incomplete_name",
    "missing_name",
    "missing_linkedin_url",
    "invalid_linkedin_url",
    "company_mismatch",
    "past_employment_only",
    "conflicting_employment",
    "unverified_employment",
    "title_not_relevant_to_category",
    "low_confidence",
    "ambiguous_identity",
)

# Employment validation outcomes that count as credible current employment at
# the exact hiring company. Anything else is either the wrong company, the past,
# or a guess.
_CURRENT_EMPLOYMENT_STATUSES = frozenset(
    {
        "confirmed_exact_company_verified",
        "exact_company_current_but_unverified_freshness",
    }
)
_PAST_EMPLOYMENT_STATUSES = frozenset({"former_employee"})
_CONFLICTING_EMPLOYMENT_STATUSES = frozenset({"conflicting_current_employment"})

# How close a title must sit to the category's own vocabulary. A referral
# candidate is judged loosely — being a peer is the point — while a recruiter or
# a manager claim is a specific assertion and is held to a higher bar.
_TITLE_THRESHOLDS: dict[PeopleCategory, float] = {
    "likely_recruiter": 0.5,
    "potential_hiring_manager": 0.42,
    "potential_referrer": 0.3,
}

_MANAGER_TOKENS = frozenset(
    {"manager", "director", "head", "vp", "lead", "chief", "principal"}
)


def _category_titles(
    category: PeopleCategory, job_context: JobPeopleSearchProfile
) -> list[str]:
    if category == "likely_recruiter":
        return list(job_context.recruiter_titles)
    if category == "potential_hiring_manager":
        return list(job_context.hiring_manager_titles)
    return [*job_context.team_member_titles, job_context.role_family or ""]


def name_rejection(full_name: str) -> str | None:
    """Why this name cannot be shown, or ``None`` when it may be.

    Delegates the shared masked/incomplete rules to the display policy so the
    waterfall's funnel counters and this gate can never disagree about what a
    usable name is.
    """

    return display_policy_rejection(full_name)


@dataclass(frozen=True)
class ActionableDecision:
    """The verdict, plus everything needed to explain or count it."""

    accepted: bool
    candidate: ProviderPerson | None = None
    rejection_reasons: list[str] = field(default_factory=list)
    confidence: float = 0.0
    # Structural, non-personal summary of *why* — booleans and typed tokens
    # only, safe to log and safe to persist alongside the run.
    evidence: dict[str, object] = field(default_factory=dict)

    @property
    def primary_reason(self) -> str | None:
        return self.rejection_reasons[0] if self.rejection_reasons else None


def _require_linkedin(override: bool | None) -> bool:
    if override is not None:
        return override
    return bool(getattr(settings, "people_require_linkedin_for_display", True))


def evaluate_actionable_contact(
    candidate: ProviderPerson,
    job_context: JobPeopleSearchProfile,
    *,
    category: PeopleCategory,
    employment_status: str | None = None,
    require_linkedin: bool | None = None,
    min_confidence: float | None = None,
) -> ActionableDecision:
    """Decide whether one candidate may be shown to a user as a contact.

    Every rule is checked — the decision carries *all* failing reasons rather
    than short-circuiting on the first, because "masked name AND no LinkedIn" is
    a different operational signal from either alone, and an operator reading
    the funnel needs to see both.
    """

    reasons: list[str] = []
    evidence: dict[str, object] = {
        "policy_version": ACTIONABLE_CONTACT_POLICY_VERSION,
        "display_policy_version": PEOPLE_DISPLAY_POLICY_VERSION,
        "category": category,
        "provider": candidate.provider,
    }

    # 1. A complete, unmasked name.
    name_problem = name_rejection(candidate.full_name)
    if name_problem is not None:
        reasons.append(
            "masked_name"
            if name_problem == "obfuscated_surname"
            else "missing_name"
            if name_problem == "missing_name"
            else "incomplete_name"
        )
    evidence["name_usable"] = name_problem is None

    # 2. A validated LinkedIn /in/ profile URL. Never constructed, never a
    #    company page, never a search result — safe_profile_url enforces scheme,
    #    host and the /in/ path, and returns None for everything else.
    safe_url = safe_profile_url(candidate.linkedin_url)
    if not (candidate.linkedin_url or "").strip():
        if _require_linkedin(require_linkedin):
            reasons.append("missing_linkedin_url")
    elif safe_url is None:
        reasons.append("invalid_linkedin_url")
    evidence["linkedin_validated"] = safe_url is not None

    # 3. Credible current employment at the exact hiring company.
    strength, company_kind = company_match_strength(candidate, job_context)
    exact_company = company_kind == "canonical_domain"
    if not exact_company:
        # A parent or subsidiary domain is a different employer. Alias-only
        # matches are name coincidences and are not evidence.
        reasons.append("company_mismatch")
    evidence["company_match_kind"] = company_kind
    evidence["company_match_strength"] = round(float(strength), 3)

    if employment_status is not None:
        if employment_status in _PAST_EMPLOYMENT_STATUSES:
            reasons.append("past_employment_only")
        elif employment_status in _CONFLICTING_EMPLOYMENT_STATUSES:
            reasons.append("conflicting_employment")
        elif employment_status not in _CURRENT_EMPLOYMENT_STATUSES:
            reasons.append("unverified_employment")
        evidence["employment_validation_status"] = employment_status
    if candidate.current_role_indicator is False:
        reasons.append("past_employment_only")

    # 4. A current title that actually supports the category it was filed under.
    title_score = title_similarity(
        candidate.current_title, _category_titles(category, job_context)
    )
    threshold = _TITLE_THRESHOLDS[category]
    title_ok = title_score >= threshold
    if category == "potential_hiring_manager" and not title_ok:
        # A manager claim can also be carried by an unambiguous seniority token
        # even when the exact title vocabulary differs by company.
        title_ok = bool(
            _MANAGER_TOKENS & set(normalize_title(candidate.current_title).split())
        )
    if not title_ok:
        reasons.append("title_not_relevant_to_category")
    evidence["title_similarity"] = round(float(title_score), 3)

    # 5. Sufficient confidence, and no conflicting evidence.
    score = confidence(candidate)
    floor = (
        float(min_confidence)
        if min_confidence is not None
        else float(settings.people_min_data_confidence)
    )
    if score < floor:
        reasons.append("low_confidence")
    evidence["confidence"] = score

    if candidate.evidence.get("ambiguous_identity"):
        reasons.append("ambiguous_identity")

    ordered = list(dict.fromkeys(reasons))
    if ordered:
        return ActionableDecision(
            accepted=False,
            candidate=None,
            rejection_reasons=ordered,
            confidence=score,
            evidence=evidence,
        )

    # Accepted candidates carry the *validated* URL, never the raw one, so no
    # downstream layer can be handed something safe_profile_url would reject.
    normalized = candidate.model_copy(deep=True)
    normalized.linkedin_url = safe_url
    return ActionableDecision(
        accepted=True,
        candidate=normalized,
        rejection_reasons=[],
        confidence=score,
        evidence=evidence,
    )


def is_displayable_record(
    *,
    full_name: str,
    linkedin_url: str | None,
    employment_validation_status: str,
    require_linkedin: bool | None = None,
) -> tuple[bool, list[str]]:
    """The read-path guard, applied to a row already in the database.

    Deliberately narrower than :func:`evaluate_actionable_contact`: the stored
    row no longer carries the job context that produced it, so this re-checks
    only the properties that are true of the record itself. Its job is to stop
    rows written under an older, laxer contract from being served — which is
    exactly how masked contacts survived a policy change once already.
    """

    reasons: list[str] = []
    name_problem = name_rejection(full_name)
    if name_problem is not None:
        reasons.append(
            "masked_name" if name_problem == "obfuscated_surname" else "incomplete_name"
        )
    if _require_linkedin(require_linkedin) and safe_profile_url(linkedin_url) is None:
        reasons.append(
            "missing_linkedin_url"
            if not (linkedin_url or "").strip()
            else "invalid_linkedin_url"
        )
    if employment_validation_status not in _CURRENT_EMPLOYMENT_STATUSES:
        reasons.append("unverified_employment")
    return (not reasons), reasons
