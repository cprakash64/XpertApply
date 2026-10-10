"""Pure dormant contracts: exact ordered identity, no scoring/activation."""

from dataclasses import fields, replace
from datetime import date

import pytest

from app.core.config import Settings
from app.jobs.job_matching_service import JobView, ProfileView
from app.jobs.job_search_criteria_service import SearchCriteria, build_search_criteria
from app.jobs.scoring_intents import Limits, SyntheticResult, transition
from app.jobs.scoring_service import compute_scoring_input_digest
from app.models.entities import Experience, ScoringJob, UserProfile

REF = date(2026, 1, 1)


def digest(p=None, j=None, c=None):
    return compute_scoring_input_digest(
        p or ProfileView(skills=["Python", "SQL"]),
        j or JobView(title="Engineer"),
        c or SearchCriteria(role_queries=["Engineer"]),
        reference_date=REF,
    )


def test_ordered_digest_stable_and_relevant_changes():
    assert digest() == digest()
    assert digest(j=JobView(title="Engineer", work_authorization_notes="No sponsorship")) != digest()
    assert digest(p=ProfileView(skills=["SQL", "Python"])) != digest()
    assert digest(c=SearchCriteria(role_queries=["Scientist"])) != digest()
    assert len(digest()) == 64


@pytest.mark.parametrize("field", [f.name for f in fields(ProfileView)])
def test_every_profile_view_field_participates(field):
    profile = ProfileView()
    current = getattr(profile, field)
    value = ["different"] if isinstance(current, list) else not current if isinstance(current, bool) else "changed"
    assert digest(p=profile) != digest(p=replace(profile, **{field: value}))


@pytest.mark.parametrize("field", [f.name for f in fields(JobView)])
def test_every_job_view_field_participates(field):
    job = JobView(title="Engineer")
    value = ["different"] if isinstance(getattr(job, field), list) else "changed"
    assert digest(j=job) != digest(j=replace(job, **{field: value}))


def test_frozen_experience_criteria():
    p = UserProfile(target_roles=["Engineer"], skills=[], target_levels=[], preferred_locations=[])
    exp = Experience(start_date=date(2020, 1, 1), end_date=None)
    first = build_search_criteria(p, [exp], reference_date=date(2020, 6, 1))
    later = build_search_criteria(p, [exp], reference_date=date(2026, 6, 1))
    assert first.seniority_targets != later.seniority_targets
    assert build_search_criteria(p, [exp], reference_date=date(2020, 6, 1)) == first


def test_invalid_size_result_policy_and_terminal_transition():
    with pytest.raises(ValueError, match="INPUT_TOO_LARGE"):
        digest(j=JobView(description="x" * 262145))
    for kwargs in (
        {"fit_score": -1},
        {"fit_score": float("nan")},
        {"fit_score": 50, "confidence": 2},
        {"fit_score": 50, "fit_label": "x" * 41},
        {"fit_score": 50, "risks": ("x",) * 21},
    ):
        with pytest.raises(ValueError):
            SyntheticResult(**kwargs)
    with pytest.raises(ValueError):
        Limits(running=3)
    with pytest.raises(ValueError):
        transition(ScoringJob(status="SUCCEEDED"), "PENDING", __import__("datetime").datetime.now())


def test_default_off():
    assert Settings(_env_file=None).durable_scoring_enabled is False
