"""Profile completion and autofill readiness — the single definition of both.

Two different questions, deliberately kept apart:

* **Completion** answers "how much of my career profile have I filled in?" It is
  what the Profile overview and the Dashboard's next-action hint report, and it
  weighs the things that make matching and document generation good.
* **Autofill readiness** answers "can XpertApply fill in an employer's application
  form on my behalf?" That needs the canonical *identity* facts an ATS asks for
  — legal name, an application email, a phone, a location, and the work
  authorization answers — which is a different and stricter set.

A profile can be 100% complete and not autofill-ready (no phone), or
autofill-ready with a thin career history. Collapsing them into one number would
hide whichever problem the user actually has.

**Autofill readiness never consults EEO/demographic answers.** Those are
voluntary, they are not required to submit an application, and counting them
would pressure the user into answering them. The three *legal* answers
(authorization, sponsorship now, sponsorship future) are a separate thing: they
are asked by essentially every application, so they are requirements here.

This module is pure apart from the queries in :func:`build_profile_signals`, so
the scoring rules can be unit-tested without a database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.applications.eligibility_service import read_eligibility
from app.models.entities import (
    Award,
    Certification,
    Education,
    Experience,
    Project,
    Publication,
    UserProfile,
)


@dataclass
class ProfileSignals:
    """Everything the two scores read, gathered once.

    Career sections are counts rather than rows: neither score cares what the
    third job was, only whether there is one.
    """

    profile: UserProfile | None
    education_count: int = 0
    experience_count: int = 0
    project_count: int = 0
    #: Gathered for reporting only. Optional enrichment sections never appear in
    #: COMPLETION_SECTIONS or AUTOFILL_REQUIREMENTS — see the module docstring.
    certification_count: int = 0
    award_count: int = 0
    publication_count: int = 0
    skills: list[str] = field(default_factory=list)
    #: Canonical legal answers that were explicitly answered Yes/No.
    answered_legal_fields: set[str] = field(default_factory=set)
    #: Legal answers the user deliberately routed to "answer during each
    #: application". A real choice, not an omission — see `_score`.
    ask_each_time_fields: set[str] = field(default_factory=set)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _has_name(profile: UserProfile) -> bool:
    """A usable legal name.

    The structured parts are preferred, but a legacy profile that only ever
    stored ``full_name`` still has a name — it just has not confirmed the split.
    """
    if _text(profile.first_name) and _text(profile.last_name):
        return True
    return bool(_text(profile.full_name))


def _has_location(profile: UserProfile) -> bool:
    """Enough of an address for an application form.

    City plus country is the minimum an ATS will accept; state is not required
    because much of the world does not have one.
    """
    return bool(_text(profile.location_city) and _text(profile.location_country))


#: Completion sections, in the order the Profile overview presents them. Each
#: entry is (key, label, predicate over the gathered signals).
COMPLETION_SECTIONS: list[tuple[str, str, Any]] = [
    ("identity", "Name", lambda s: _has_name(s.profile)),
    ("contact", "Contact details", lambda s: bool(_text(s.profile.application_email))),
    ("location", "Location", lambda s: _has_location(s.profile)),
    ("targets", "Job targets", lambda s: bool(s.profile.target_roles)),
    ("preferences", "Location preferences", lambda s: bool(s.profile.preferred_locations)),
    ("experience", "Experience", lambda s: s.experience_count > 0),
    ("education", "Education", lambda s: s.education_count > 0),
    ("skills", "Skills", lambda s: len(s.skills) > 0),
    (
        "links",
        "Professional links",
        lambda s: any(
            _text(getattr(s.profile, column))
            for column in ("linkedin_url", "github_url", "portfolio_url")
        ),
    ),
]

#: What an employer application form actually needs filled in. Ordered by how
#: universally forms ask for it, so the "missing" list reads as a to-do.
AUTOFILL_REQUIREMENTS: list[tuple[str, str, Any]] = [
    ("identity", "Legal name", lambda s: _has_name(s.profile)),
    (
        "application_email",
        "Application email",
        lambda s: bool(_text(s.profile.application_email)),
    ),
    ("phone", "Phone number", lambda s: bool(_text(s.profile.phone))),
    ("location", "City and country", lambda s: _has_location(s.profile)),
    (
        "work_authorization",
        "Work authorization answer",
        lambda s: "work_authorization_us" in s.answered_legal_fields,
    ),
    (
        "sponsorship",
        "Sponsorship answers",
        lambda s: {"sponsorship_required_now", "sponsorship_required_future"}
        <= s.answered_legal_fields,
    ),
    ("experience", "At least one role", lambda s: s.experience_count > 0),
    ("education", "At least one school", lambda s: s.education_count > 0),
    (
        "preferences",
        "Application preferences",
        lambda s: bool(s.profile.target_roles) and bool(s.profile.preferred_locations),
    ),
]


def _score(signals: ProfileSignals, rules: list[tuple[str, str, Any]]) -> dict:
    """Percent complete plus the satisfied/missing breakdown.

    A profile row that does not exist yet scores zero rather than raising: a
    freshly signed-up user has no profile and must still be able to load the
    page that tells them so.
    """
    if signals.profile is None:
        return {
            "percent": 0,
            "satisfied": [],
            "missing": [{"key": key, "label": label} for key, label, _ in rules],
        }

    satisfied: list[str] = []
    missing: list[dict[str, str]] = []
    for key, label, predicate in rules:
        if predicate(signals):
            satisfied.append(key)
            continue
        entry = {"key": key, "label": label}
        # "Answer during each application" is a decision, not a gap. It still
        # cannot be autofilled — so it is not "satisfied" — but reporting it as
        # a missing answer would nag the user about a choice they already made.
        if key in _ASK_EACH_TIME_KEYS and _is_ask_each_time(signals, key):
            entry["reason"] = "ask_each_time"
            entry["label"] = f"{label} — you chose to answer this per application"
        missing.append(entry)
    return {
        "percent": round(len(satisfied) / len(rules) * 100),
        "satisfied": satisfied,
        "missing": missing,
    }


#: Readiness keys backed by the legal answers, and the canonical fields behind
#: each. Used only to explain *why* a requirement is unmet.
_ASK_EACH_TIME_KEYS: dict[str, tuple[str, ...]] = {
    "work_authorization": ("work_authorization_us",),
    "sponsorship": ("sponsorship_required_now", "sponsorship_required_future"),
}


def _is_ask_each_time(signals: ProfileSignals, key: str) -> bool:
    """True when every unanswered field behind `key` was deliberately deferred."""
    fields = _ASK_EACH_TIME_KEYS[key]
    outstanding = [f for f in fields if f not in signals.answered_legal_fields]
    return bool(outstanding) and all(f in signals.ask_each_time_fields for f in outstanding)


def build_profile_signals(db: Session, user_id: int) -> ProfileSignals:
    """Gather the inputs for both scores.

    Career sections are counted in the database rather than loaded — the scores
    only need to know whether each section is non-empty.
    """
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user_id))
    if profile is None:
        return ProfileSignals(profile=None)

    # One round trip for all three section counts. This runs on the Dashboard's
    # per-request path, so it stays a single scalar-subquery SELECT rather than
    # three separate COUNTs.
    def section_count(model):
        return (
            select(func.count())
            .select_from(model)
            .where(model.user_id == user_id)
            .scalar_subquery()
        )

    counts = db.execute(
        select(
            section_count(Education),
            section_count(Experience),
            section_count(Project),
            section_count(Certification),
            section_count(Award),
            section_count(Publication),
        )
    ).one()

    eligibility_rows = read_eligibility(db, user_id)
    answered = {row["field"] for row in eligibility_rows if row.get("answered")}
    # An eligibility row that exists but is neither answered nor reusable is the
    # shape `set_eligibility_answer` writes for "answer during each application".
    ask_each_time = {
        row["field"]
        for row in eligibility_rows
        if not row.get("answered") and row.get("version", 0) > 0
    }
    return ProfileSignals(
        profile=profile,
        education_count=counts[0] or 0,
        experience_count=counts[1] or 0,
        project_count=counts[2] or 0,
        certification_count=counts[3] or 0,
        award_count=counts[4] or 0,
        publication_count=counts[5] or 0,
        skills=[s for s in (profile.skills or []) if isinstance(s, str) and s.strip()],
        answered_legal_fields=answered,
        ask_each_time_fields=ask_each_time,
    )


def profile_completion(signals: ProfileSignals) -> dict:
    """How much of the career profile is filled in."""
    return _score(signals, COMPLETION_SECTIONS)


def autofill_readiness(signals: ProfileSignals) -> dict:
    """Whether XpertApply holds the canonical facts an application form needs."""
    return _score(signals, AUTOFILL_REQUIREMENTS)


def enrichment(signals: ProfileSignals) -> dict:
    """Optional sections the user *has*, reported without scoring them.

    Certifications, awards and publications make a profile richer, but a
    candidate who has none is not incomplete — so they are counted here and
    deliberately kept out of both scores. The UI can celebrate them; nothing
    may penalize their absence.
    """
    return {
        "certifications": signals.certification_count,
        "awards": signals.award_count,
        "publications": signals.publication_count,
        "projects": signals.project_count,
    }


def build_completeness(db: Session, user_id: int) -> dict:
    """Both scores for one user — what ``GET /profile/completeness`` returns."""
    signals = build_profile_signals(db, user_id)
    return {
        "completion": profile_completion(signals),
        "autofillReadiness": autofill_readiness(signals),
        "enrichment": enrichment(signals),
    }
