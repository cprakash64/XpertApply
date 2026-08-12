"""Why the Referral paths section was empty, pinned against the live evidence.

Diagnosed from discovery run 73 (Samsara) in the local database, not inferred:

    potential_referrer: raw 8, normalized 8, unique 8, accepted 0, displayed 0
    score distribution: all 8 in the 40-59 bucket, maximum 58.9, minimum 45.0
    threshold: people_min_referrer_relevance = 60.0
    rejections: below_relevance_threshold 5, weak_role_similarity 4,
                title_mismatch 4

PDL found real Samsara engineers. Every one was thrown away, and the user was
shown a section with nothing in it.

Two compounding defects, both pinned below.

**1. An unreachable scoring ceiling.** ``WEIGHTS["potential_referrer"]`` puts 25
of its 100 points on ``school`` (15) and ``employer`` (10). Those are only ever
non-zero when the user-relationship comparison runs — and it does not, because
``people_network_matching_enabled`` is off. Counting absent evidence as zero
capped the achievable score at 75 while the threshold stayed at 60, so a
referral candidate had to reach **80% of its possible score** where a recruiter
needed 60%.

**2. The raw posting title used as a team-member title.** ``expand_titles``
computed a cleaned ``base`` and then passed the *raw* title to ``team_titles``,
so "Software Engineering Internship 2027" — with an intake year, and a word no
employee has in their title — became the yardstick every candidate's title was
measured against.

No provider account is contacted and no credit is spent in this file.
"""

from __future__ import annotations

import pytest

from app.people.intelligence import expand_titles
from app.people.scoring import WEIGHTS, score_candidate

# --- Defect 1: the unreachable ceiling ----------------------------------------


def test_only_the_referral_category_reserves_weight_for_relationship_signals() -> None:
    """Names the asymmetry that made referrals uniquely hard to display."""

    for category in ("likely_recruiter", "potential_hiring_manager"):
        weights = WEIGHTS[category]
        assert weights.get("school", 0) == 0
        assert weights.get("employer", 0) == 0

    referrer = WEIGHTS["potential_referrer"]
    assert referrer["school"] + referrer["employer"] == 25


def test_absent_relationship_evidence_does_not_cap_the_achievable_score(
    _profile, _candidate
) -> None:
    """The regression itself.

    A perfect-on-every-available-signal candidate must be able to reach the top
    of the scale. Before the fix its ceiling was 75 against a threshold of 60.
    """

    perfect = _candidate("Machine Learning Engineer")
    unavailable = score_candidate(
        "potential_referrer", perfect, _profile, relationship_signals_available=False
    )
    assert unavailable > 90, "a fully-matching candidate must not be capped at 75"


def test_checked_and_found_nothing_is_not_the_same_as_never_checked(
    _profile, _candidate
) -> None:
    """The distinction the parameter exists to preserve.

    When the comparison *did* run and found no overlap, the zero is real
    evidence and must still count against the candidate.
    """

    person = _candidate("Machine Learning Engineer")
    never_checked = score_candidate(
        "potential_referrer", person, _profile, relationship_signals_available=False
    )
    checked_no_overlap = score_candidate(
        "potential_referrer",
        person,
        _profile,
        relationship_signals_available=True,
        shared_school=False,
        shared_employer=False,
    )
    assert never_checked > checked_no_overlap


def test_a_verified_overlap_still_outranks_everything(_profile, _candidate) -> None:
    person = _candidate("Machine Learning Engineer")
    with_overlap = score_candidate(
        "potential_referrer",
        person,
        _profile,
        relationship_signals_available=True,
        shared_school=True,
        shared_employer=True,
    )
    assert with_overlap >= 95


def test_rescaling_does_not_disturb_the_other_categories(_profile, _candidate) -> None:
    """Recruiters and managers carry no relationship weight, so nothing moves."""

    recruiter = _candidate("Technical Recruiter")
    assert score_candidate(
        "likely_recruiter", recruiter, _profile, relationship_signals_available=True
    ) == score_candidate(
        "likely_recruiter", recruiter, _profile, relationship_signals_available=False
    )


# --- Defect 2: posting artefacts used as employee titles ----------------------


@pytest.mark.parametrize(
    ("posting_title", "forbidden"),
    [
        ("Software Engineering Internship 2027", "2027"),
        ("Software Engineer (Req 12345)", "12345"),
        ("Backend Engineer - Summer 2026 Internship", "2026"),
        ("Data Scientist, New Graduate 2025", "2025"),
    ],
)
def test_posting_artefacts_never_become_team_member_titles(
    posting_title: str, forbidden: str
) -> None:
    """No employee's job title contains an intake year or a requisition id."""

    _, _, team = expand_titles(posting_title, "software_engineering")
    assert team, "a job must still yield team titles"
    joined = " ".join(team).lower()
    assert forbidden not in joined
    assert "internship" not in joined
    assert "new graduate" not in joined


def test_cleaning_keeps_the_meaningful_part_of_the_title() -> None:
    _, _, team = expand_titles("Software Engineering Internship 2027", "machine_learning")
    assert any("software engineering" in title.lower() for title in team)


def test_a_plain_title_is_left_alone() -> None:
    """The cleanup must not damage titles that were already fine."""

    _, _, team = expand_titles("Machine Learning Engineer", "machine_learning")
    assert "Machine Learning Engineer" in team


# --- Fixtures -----------------------------------------------------------------


@pytest.fixture
def _profile():
    from app.people.schemas import JobPeopleSearchProfile

    return JobPeopleSearchProfile(
        company_name="Samsara",
        company_normalized_name="samsara",
        company_domain="samsara.com",
        job_title="Software Engineering Internship 2027",
        role_family="machine_learning",
        department="Engineering",
        location="San Francisco, CA",
        team_member_titles=[
            "Software Engineering",
            "AI Engineer",
            "Machine Learning Engineer",
            "Applied Scientist",
        ],
        recruiter_titles=["Technical Recruiter", "Recruiter"],
        hiring_manager_titles=["Engineering Manager"],
        extraction_confidence=0.9,
    )


@pytest.fixture
def _candidate():
    from datetime import UTC, datetime

    from app.people.schemas import ProviderPerson

    def _build(title: str) -> ProviderPerson:
        now = datetime.now(UTC)
        return ProviderPerson(
            provider="pdl",
            provider_person_id="live-shaped",
            full_name="Sam Engineer",
            current_company_name="Samsara",
            current_company_domain="samsara.com",
            current_title=title,
            location="San Francisco, CA",
            linkedin_url="https://www.linkedin.com/in/sam-engineer",
            provider_record_observed_at=now,
            provider_employment_updated_at=now,
            current_role_indicator=True,
        )

    return _build
