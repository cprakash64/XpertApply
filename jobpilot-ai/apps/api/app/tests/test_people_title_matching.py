"""Professional title matching: morphology, and the false positives it must not create.

This is the gate that had to be cleared before provider limits could be cut,
because the pipeline was paying PDL for records and then discarding them on a
local string comparison.

Measured before the fix — every one of these scored an **identical 0.425**:

    software engineer   vs software engineering   0.425   <- genuine match
    civil engineer      vs software engineer      0.425   <- false positive
    product manager     vs product engineer       0.425   <- false positive
    data engineer       vs data analyst           0.425   <- false positive
    security engineer   vs security recruiter     0.425   <- false positive

The referral floor is 0.42, so the genuine match and all four false positives
were on the same side of it. The comparison carried no usable signal at all: it
rejected real Samsara engineers *and* would have admitted a civil engineer.

Two changes: curated morphology (``engineering`` ≡ ``engineer``), and a guard
that damps a score when the domain qualifiers conflict ("civil" vs "software")
or the role nouns conflict ("manager" vs "engineer").

Deliberately **not** a stemmer. A general stemmer collapses tokens that mean
different things in job titles, which is why "analytics"→"analyst" and
"development"→"engineer" are excluded by name.

No provider account is contacted and no credit is spent in this file.
"""

from __future__ import annotations

import pytest

from app.people.title_ontology import (
    TITLE_ONTOLOGY_VERSION,
    normalize_title,
    title_similarity,
)

# The floors the pipeline actually applies (scoring.candidate_rejection_reasons).
REFERRAL_FLOOR = 0.42
MANAGER_FLOOR = 0.50


@pytest.mark.parametrize(
    ("candidate", "target"),
    [
        # The exact live rejection: real Samsara engineers vs the job's team titles.
        ("senior software engineer", "Software Engineering"),
        ("senior embedded software engineer", "Software Engineering"),
        ("senior software engineer - machine learning", "Machine Learning Engineer"),
        # Morphology in both directions.
        ("software engineer", "Software Engineering"),
        ("engineering manager", "Engineering Management"),
        ("software developer", "Software Engineer"),
        # Recruiting vocabulary.
        ("technical recruiter", "Recruiter"),
        ("technical recruiter", "Technical Recruiter"),
        ("university recruiter", "Campus Recruiter"),
        ("talent acquisition partner", "Talent Acquisition"),
    ],
)
def test_genuine_matches_clear_the_referral_floor(candidate: str, target: str) -> None:
    score = title_similarity(candidate, [target])
    assert score >= REFERRAL_FLOOR, f"{candidate!r} vs {target!r} scored {score}"


@pytest.mark.parametrize(
    ("candidate", "target"),
    [
        # A shared head noun is not a shared role.
        ("civil engineer", "software engineer"),
        ("mechanical engineer", "machine learning engineer"),
        # A shared domain with conflicting role nouns is not a shared role.
        ("product manager", "product engineer"),
        ("data engineer", "data analyst"),
        ("security engineer", "security recruiter"),
        # Unrelated functions.
        ("business development manager", "engineering manager"),
        ("accountant", "software engineer"),
    ],
)
def test_false_positives_stay_below_the_referral_floor(
    candidate: str, target: str
) -> None:
    score = title_similarity(candidate, [target])
    assert score < REFERRAL_FLOOR, f"{candidate!r} vs {target!r} scored {score}"


def test_a_genuine_match_now_outscores_every_false_positive() -> None:
    """The property that was missing entirely: separation.

    Before, both sides of this assertion were 0.425.
    """

    genuine = title_similarity("senior software engineer", ["Software Engineering"])
    worst_false_positive = max(
        title_similarity(candidate, [target])
        for candidate, target in (
            ("civil engineer", "software engineer"),
            ("product manager", "product engineer"),
            ("data engineer", "data analyst"),
            ("security engineer", "security recruiter"),
        )
    )
    assert genuine > worst_false_positive * 2


def test_a_cross_function_manager_is_kept_out_of_the_manager_category() -> None:
    """A residual weakness, pinned honestly rather than left unstated.

    "Sales Manager" vs "Engineering Manager" scores just above the referral
    floor, because folding "engineering"→"engineer" leaves "Engineering
    Manager" with no distinct domain token. The manager category applies a
    higher floor, which is what actually excludes it.
    """

    score = title_similarity("sales manager", ["engineering manager"])
    assert score < MANAGER_FLOOR


@pytest.mark.parametrize(
    ("raw", "expected_token"),
    [
        ("Software Engineering", "engineer"),
        ("Recruiting Coordinator", "recruiter"),
        ("Talent Recruitment Lead", "recruiter"),
        ("Engineering Management", "manager"),
    ],
)
def test_curated_morphology_reaches_one_comparison_key(
    raw: str, expected_token: str
) -> None:
    assert expected_token in normalize_title(raw).split()


@pytest.mark.parametrize(
    ("raw", "forbidden_token"),
    [
        # "Business Development" is a sales function; folding it onto engineer
        # would make a Business Development Manager match an Engineering Manager.
        ("Business Development", "engineer"),
        # A Data Analytics Engineer is not a Data Analyst.
        ("Data Analytics", "analyst"),
    ],
)
def test_dangerous_foldings_are_deliberately_absent(
    raw: str, forbidden_token: str
) -> None:
    assert forbidden_token not in normalize_title(raw).split()


def test_ontology_version_retires_results_scored_under_the_old_rules() -> None:
    """Acceptance changed, so stored runs must not be replayed as comparable."""

    from app.people.service import PEOPLE_SEARCH_CONTRACT_VERSION

    assert TITLE_ONTOLOGY_VERSION == "people-title-v3"
    assert TITLE_ONTOLOGY_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION


def test_the_per_discovery_record_budget_is_capped() -> None:
    """PDL bills per profile returned, so this ceiling is the bill."""

    from app.core.config import settings

    per_category = (
        settings.people_pdl_recruiter_results
        + settings.people_pdl_manager_results
        + settings.people_pdl_referral_results
    )
    assert per_category <= settings.people_pdl_max_results_per_discovery
    assert settings.people_pdl_max_results_per_discovery <= 10
