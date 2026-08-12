"""Dashboard summary: aggregation, ordering, isolation, caching, empty state."""

import os
from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.dashboard.summary_cache import clear_local_dashboard_cache
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401
from app.models import entities as E


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    clear_local_dashboard_cache()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        clear_local_dashboard_cache()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def auth(client: TestClient, email: str = "dash@mailbox.test-domain.co") -> dict[str, str]:
    token = client.post(
        "/auth/signup", json={"email": email, "password": "password123"}
    ).json()
    return {"Authorization": f"Bearer {token['access_token']}"}


def complete_profile(client: TestClient, headers: dict[str, str]) -> None:
    resp = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "Chandra Pandey",
            "application_email": "chandra@mailbox.test-domain.co",
            "phone": "602-555-0100",
            "location_city": "Phoenix",
            "location_state": "AZ",
            "location_country": "United States",
            "work_authorization": "authorized_us",
            "target_roles": ["Backend Engineer"],
            "target_levels": ["Junior"],
            "preferred_locations": ["United States"],
            "remote_preference": "remote",
            "skills": ["Python", "FastAPI"],
            "linkedin_url": "https://linkedin.com/in/chandra",
        },
    )
    assert resp.status_code == 200, resp.text
    # Completion counts real career sections, not just the profile row, so a
    # fixture that means "this profile is done" has to include them.
    resp = client.put(
        "/profile/career",
        headers=headers,
        json={
            "education": [{"school": "Arizona State University", "degree": "BS"}],
            "experience": [
                {
                    "company": "Cardinal Health",
                    "title": "Software Engineer",
                    "bullets": ["Built Python services"],
                    "technologies": ["Python"],
                    "currently_working": True,
                }
            ],
            "projects": [],
            "certifications": [],
            "awards": [],
        },
    )
    assert resp.status_code == 200, resp.text


def seed_job(*, company: str, days: int = 1, title: str = "Backend Engineer") -> int:
    db = next(app.dependency_overrides[get_db]())
    src = db.scalar(select(E.JobSource).where(E.JobSource.name == company))
    if src is None:
        src = E.JobSource(
            name=company, type="greenhouse", base_url="x", enabled=True, supports_api=True
        )
        db.add(src)
        db.flush()
    url = f"https://boards.greenhouse.io/{company.lower()}/1"
    job = E.JobPosting(
        source_id=src.id,
        external_id=f"ext-{company}",
        title=title,
        company=company,
        location="Remote, United States",
        remote_type="remote",
        posted_at=datetime.now(UTC) - timedelta(days=days),
        discovered_at=datetime.now(UTC),
        application_url=url,
        source_url=url,
        description_raw="",
        description_clean="Backend Engineer. Requirements: Python, FastAPI.",
        required_skills=["Python", "FastAPI"],
        hash_for_deduplication=f"h-{company}",
    )
    db.add(job)
    db.commit()
    job_id = job.id
    db.close()
    return job_id


def track(
    *, user_email: str, job_id: int, status: E.ApplicationStatus, updated_at: datetime | None = None
) -> int:
    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email == user_email))
    row = E.ApplicationTracker(user_id=user.id, job_id=job_id, status=status)
    db.add(row)
    db.commit()
    if updated_at is not None:
        # updated_at carries an onupdate default, so it is set explicitly here
        # rather than by the insert.
        row.updated_at = updated_at
        db.commit()
    row_id = row.id
    db.close()
    return row_id


def summary(client: TestClient, headers: dict[str, str]) -> dict:
    resp = client.get("/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


# --------------------------------------------------------------------------- #
# Authorization
# --------------------------------------------------------------------------- #
def test_summary_requires_authentication(client: TestClient):
    assert client.get("/dashboard/summary").status_code == 401


def test_summary_rejects_invalid_token(client: TestClient):
    resp = client.get(
        "/dashboard/summary", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert resp.status_code == 401


def test_summary_is_isolated_per_user(client: TestClient):
    alice = auth(client, "alice@mailbox.test-domain.co")
    bob = auth(client, "bob@mailbox.test-domain.co")
    job = seed_job(company="Acme")
    track(
        user_email="alice@mailbox.test-domain.co",
        job_id=job,
        status=E.ApplicationStatus.interview,
    )

    assert summary(client, alice)["applications"]["interviews"] == 1
    bob_payload = summary(client, bob)
    # Bob sees none of Alice's ledger, and the job Alice is tracking is still a
    # fresh match for him.
    assert bob_payload["applications"] == {
        "saved": 0,
        "inProgress": 0,
        "interviews": 0,
        "offers": 0,
    }
    assert bob_payload["recentApplications"] == []


# --------------------------------------------------------------------------- #
# Empty state
# --------------------------------------------------------------------------- #
def test_empty_state_returns_zeroes_not_errors(client: TestClient):
    headers = auth(client)
    payload = summary(client, headers)
    assert payload["freshMatches"] == 0
    assert payload["applications"] == {
        "saved": 0,
        "inProgress": 0,
        "interviews": 0,
        "offers": 0,
    }
    assert payload["recentApplications"] == []
    assert payload["nextAction"]["kind"] == "complete_profile"


# --------------------------------------------------------------------------- #
# Status aggregation
# --------------------------------------------------------------------------- #
def test_status_buckets_aggregate_correctly(client: TestClient):
    email = "buckets@mailbox.test-domain.co"
    headers = auth(client, email)
    cases = [
        ("Saved1", E.ApplicationStatus.saved),
        ("Ready1", E.ApplicationStatus.ready_to_apply),
        ("Applying1", E.ApplicationStatus.applying),
        ("Applied1", E.ApplicationStatus.applied),
        ("Interview1", E.ApplicationStatus.interview),
        ("Offer1", E.ApplicationStatus.offer),
    ]
    for company, status in cases:
        track(user_email=email, job_id=seed_job(company=company), status=status)

    counts = summary(client, headers)["applications"]
    assert counts == {"saved": 2, "inProgress": 2, "interviews": 1, "offers": 1}


def test_closed_outcomes_are_excluded_from_active_buckets(client: TestClient):
    email = "closed@mailbox.test-domain.co"
    headers = auth(client, email)
    track(
        user_email=email,
        job_id=seed_job(company="Rejected1"),
        status=E.ApplicationStatus.rejected,
    )
    track(
        user_email=email,
        job_id=seed_job(company="Withdrawn1"),
        status=E.ApplicationStatus.withdrawn,
    )

    assert summary(client, headers)["applications"] == {
        "saved": 0,
        "inProgress": 0,
        "interviews": 0,
        "offers": 0,
    }


# --------------------------------------------------------------------------- #
# Recent applications
# --------------------------------------------------------------------------- #
def test_recent_applications_are_limited_and_newest_first(client: TestClient):
    email = "recent@mailbox.test-domain.co"
    headers = auth(client, email)
    now = datetime.now(UTC)
    for index, company in enumerate(["Oldest", "Middle", "Newer", "Newest"]):
        track(
            user_email=email,
            job_id=seed_job(company=company),
            status=E.ApplicationStatus.applied,
            updated_at=now - timedelta(days=10 - index),
        )

    recent = summary(client, headers)["recentApplications"]
    assert len(recent) == 3
    assert [row["company"] for row in recent] == ["Newest", "Newer", "Middle"]
    assert {"id", "title", "company", "status", "updatedAt", "logoUrl"} <= set(recent[0])
    assert recent[0]["status"] == "applied"


def test_recent_applications_never_include_another_users_rows(client: TestClient):
    mine = auth(client, "mine@mailbox.test-domain.co")
    auth(client, "theirs@mailbox.test-domain.co")
    track(
        user_email="theirs@mailbox.test-domain.co",
        job_id=seed_job(company="TheirCo"),
        status=E.ApplicationStatus.applied,
    )
    track(
        user_email="mine@mailbox.test-domain.co",
        job_id=seed_job(company="MyCo"),
        status=E.ApplicationStatus.applied,
    )

    recent = summary(client, mine)["recentApplications"]
    assert [row["company"] for row in recent] == ["MyCo"]


# --------------------------------------------------------------------------- #
# Fresh matches
# --------------------------------------------------------------------------- #
def test_fresh_matches_counts_eligible_recent_postings(client: TestClient):
    headers = auth(client)
    complete_profile(client, headers)
    seed_job(company="Fresh1")
    seed_job(company="Fresh2")
    seed_job(company="Stale1", days=90)

    assert summary(client, headers)["freshMatches"] == 2


def test_fresh_matches_excludes_jobs_the_user_already_applied_to(client: TestClient):
    email = "applied@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    seed_job(company="Open1")
    taken = seed_job(company="Taken1")

    assert summary(client, headers)["freshMatches"] == 2
    track(user_email=email, job_id=taken, status=E.ApplicationStatus.applied)
    assert summary(client, headers)["freshMatches"] == 1


def test_fresh_matches_excludes_inactive_postings(client: TestClient):
    headers = auth(client, "inactive@mailbox.test-domain.co")
    complete_profile(client, headers)
    job_id = seed_job(company="Deactivated1")
    seed_job(company="Active1")

    db = next(app.dependency_overrides[get_db]())
    db.get(E.JobPosting, job_id).is_active = False
    db.commit()
    db.close()

    assert summary(client, headers)["freshMatches"] == 1


def test_fresh_matches_applies_the_eligibility_gate(client: TestClient):
    """A senior posting is filtered out for a junior-targeting profile, exactly
    as the Jobs list filters it."""
    headers = auth(client, "gate@mailbox.test-domain.co")
    complete_profile(client, headers)
    seed_job(company="Junior1", title="Backend Engineer")
    seed_job(company="Senior1", title="Senior Staff Backend Engineer")

    assert summary(client, headers)["freshMatches"] == 1


def test_years_of_experience_rule_still_applies_after_deferred_fetch(client: TestClient):
    """The description-dependent rule is evaluated in a second pass; deferring it
    must not let a posting through that the single-pass gate would reject."""
    headers = auth(client, "years@mailbox.test-domain.co")
    complete_profile(client, headers)
    seed_job(company="Ok1")
    heavy = seed_job(company="Heavy1")

    db = next(app.dependency_overrides[get_db]())
    db.get(E.JobPosting, heavy).description_clean = (
        "Backend Engineer. Requires 8+ years of experience building services."
    )
    db.commit()
    db.close()
    clear_local_dashboard_cache()

    assert summary(client, headers)["freshMatches"] == 1


# --------------------------------------------------------------------------- #
# Top matches
# --------------------------------------------------------------------------- #
def score(*, user_email: str, job_id: int, fit_score: float | None) -> None:
    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email == user_email))
    db.add(E.JobMatch(user_id=user.id, job_id=job_id, fit_score=fit_score))
    db.commit()
    db.close()


def test_top_matches_are_ranked_by_stored_fit_score(client: TestClient):
    email = "top@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    low = seed_job(company="LowFit")
    high = seed_job(company="HighFit")
    mid = seed_job(company="MidFit")
    score(user_email=email, job_id=low, fit_score=41.0)
    score(user_email=email, job_id=high, fit_score=93.0)
    score(user_email=email, job_id=mid, fit_score=72.0)

    top = summary(client, headers)["topMatches"]
    assert [row["company"] for row in top] == ["HighFit", "MidFit", "LowFit"]
    assert top[0]["fitScore"] == 93.0


def test_top_matches_are_limited_to_three(client: TestClient):
    email = "toplimit@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    for index in range(6):
        score(
            user_email=email,
            job_id=seed_job(company=f"Scored{index}"),
            fit_score=50.0 + index,
        )

    assert len(summary(client, headers)["topMatches"]) == 3


def test_top_matches_never_expose_another_users_scores(client: TestClient):
    mine = auth(client, "topmine@mailbox.test-domain.co")
    auth(client, "topother@mailbox.test-domain.co")
    complete_profile(client, mine)
    shared = seed_job(company="SharedCo")
    score(user_email="topother@mailbox.test-domain.co", job_id=shared, fit_score=99.0)

    # The other user's score must not be borrowed, and must not be duplicated
    # into this user's list by the join.
    assert summary(client, mine)["topMatches"] == []


def test_top_matches_exclude_unscored_postings(client: TestClient):
    headers = auth(client, "unscored@mailbox.test-domain.co")
    complete_profile(client, headers)
    seed_job(company="NeverScored")

    payload = summary(client, headers)
    assert payload["freshMatches"] == 1
    assert payload["topMatches"] == []


def test_summary_never_triggers_rescoring(client: TestClient, monkeypatch):
    """Navigating to the Dashboard must report existing scores, never generate
    them — the old page's cost came partly from scoring work on load."""
    from app.jobs import scoring_service

    def fail(*args, **kwargs):
        raise AssertionError("Dashboard must not rescore during a page load")

    monkeypatch.setattr(scoring_service, "rematch_user", fail, raising=False)

    email = "noscore@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    score(user_email=email, job_id=seed_job(company="Scored1"), fit_score=80.0)

    assert summary(client, headers)["topMatches"][0]["fitScore"] == 80.0


# --------------------------------------------------------------------------- #
# Next action
# --------------------------------------------------------------------------- #
def test_next_action_prompts_profile_completion_first(client: TestClient):
    headers = auth(client, "incomplete@mailbox.test-domain.co")
    action = summary(client, headers)["nextAction"]
    assert action["kind"] == "complete_profile"
    assert action["href"] == "/profile"
    assert action["profileProgress"] < 80


def test_next_action_advances_saved_roles_once_profile_is_complete(client: TestClient):
    email = "saved@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    track(
        user_email=email,
        job_id=seed_job(company="SavedCo"),
        status=E.ApplicationStatus.saved,
    )

    action = summary(client, headers)["nextAction"]
    assert action["kind"] == "advance_saved"
    assert action["href"] == "/tracker"


def test_next_action_falls_back_to_discovery_when_nothing_is_pending(client: TestClient):
    """An unscored fresh posting is not a "strong match" — it is not a claim at all."""
    headers = auth(client, "matches@mailbox.test-domain.co")
    complete_profile(client, headers)
    seed_job(company="Reviewable1")

    action = summary(client, headers)["nextAction"]
    assert action["kind"] == "discover"
    assert action["href"] == "/jobs"
    assert action["title"] == "Discover new opportunities"


def test_next_action_greets_with_the_confirmed_first_name(client: TestClient):
    """The greeting uses the structured name, which is only ever set by an
    explicit confirmation — never split out of ``full_name``."""
    headers = auth(client, "greeting@mailbox.test-domain.co")
    complete_profile(client, headers)

    assert summary(client, headers)["nextAction"]["firstName"] == ""

    resp = client.put(
        "/profile/name",
        headers=headers,
        json={"first_name": "Chandra", "last_name": "Pandey"},
    )
    assert resp.status_code == 200, resp.text
    assert summary(client, headers)["nextAction"]["firstName"] == "Chandra"


# --------------------------------------------------------------------------- #
# Caching and invalidation
# --------------------------------------------------------------------------- #
def test_repeat_request_reuses_the_cached_fresh_match_count(client: TestClient):
    """The second call must not re-scan the postings table."""
    headers = auth(client, "cache@mailbox.test-domain.co")
    complete_profile(client, headers)
    seed_job(company="Cached1")

    db = next(app.dependency_overrides[get_db]())
    statements: list[str] = []

    @event.listens_for(db.get_bind(), "before_cursor_execute")
    def _record(conn, cursor, statement, params, context, executemany):
        statements.append(statement)

    assert summary(client, headers)["freshMatches"] == 1
    first_pass = [s for s in statements if "job_postings" in s]
    assert first_pass, "cold request should read job_postings"

    statements.clear()
    assert summary(client, headers)["freshMatches"] == 1
    assert not [s for s in statements if "FROM job_postings" in s], (
        "warm request must serve the count from cache"
    )
    db.close()


def test_application_mutation_invalidates_the_cached_count(client: TestClient):
    """Applying to a job hides it from discovery, so the cached count must not
    survive the mutation."""
    email = "invalidate@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    seed_job(company="Stays1")
    moving = seed_job(company="Moves1")

    assert summary(client, headers)["freshMatches"] == 2
    track(user_email=email, job_id=moving, status=E.ApplicationStatus.applied)
    assert summary(client, headers)["freshMatches"] == 1


def test_profile_change_invalidates_the_cached_count(client: TestClient):
    """Widening the target roles changes which postings are eligible."""
    headers = auth(client, "profilechange@mailbox.test-domain.co")
    complete_profile(client, headers)
    seed_job(company="Backend1", title="Backend Engineer")
    seed_job(company="Design1", title="Product Designer")

    assert summary(client, headers)["freshMatches"] == 1

    resp = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "Chandra Pandey",
            "application_email": "chandra@mailbox.test-domain.co",
            "phone": "602-555-0100",
            "location_city": "Phoenix",
            "location_state": "AZ",
            "location_country": "United States",
            "work_authorization": "authorized_us",
            "target_roles": ["Backend Engineer", "Product Designer"],
            "target_levels": ["Junior"],
            "preferred_locations": ["United States"],
            "remote_preference": "remote",
            "skills": ["Python", "FastAPI"],
        },
    )
    assert resp.status_code == 200, resp.text
    assert summary(client, headers)["freshMatches"] == 2


# --------------------------------------------------------------------------- #
# Cost
# --------------------------------------------------------------------------- #
def test_summary_issues_a_bounded_number_of_queries(client: TestClient):
    """Guards against a regression into per-row lookups: the query count must not
    grow with the size of the ledger."""
    email = "nplusone@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    for index in range(12):
        track(
            user_email=email,
            job_id=seed_job(company=f"Bulk{index}"),
            status=E.ApplicationStatus.applied,
        )

    db = next(app.dependency_overrides[get_db]())
    statements: list[str] = []

    @event.listens_for(db.get_bind(), "before_cursor_execute")
    def _record(conn, cursor, statement, params, context, executemany):
        statements.append(statement)

    clear_local_dashboard_cache()
    payload = summary(client, headers)
    db.close()

    assert len(payload["recentApplications"]) == 3
    assert len(statements) <= 16, f"unexpected query fan-out: {len(statements)}"


# --------------------------------------------------------------------------- #
# Next-best-action priority chain
# --------------------------------------------------------------------------- #
def paused_session(*, user_email: str, job_id: int, status: E.ApplicationSessionStatus) -> None:
    """An assisted-apply run stopped in a state that is waiting on the user."""
    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email == user_email))
    db.add(
        E.ApplicationSession(
            user_id=user.id,
            job_id=job_id,
            status=status,
            source_url="https://boards.greenhouse.io/x/1",
        )
    )
    db.commit()
    db.close()


def set_follow_up(*, user_email: str, job_id: int, days_ahead: int) -> None:
    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email == user_email))
    row = db.scalar(
        select(E.ApplicationTracker).where(
            (E.ApplicationTracker.user_id == user.id)
            & (E.ApplicationTracker.job_id == job_id)
        )
    )
    row.follow_up_date = (datetime.now(UTC) + timedelta(days=days_ahead)).date()
    db.commit()
    db.close()


def test_incomplete_profile_outranks_everything(client: TestClient):
    """Suggesting matches from a half-built profile wastes the user's time."""
    email = "prio-profile@mailbox.test-domain.co"
    headers = auth(client, email)
    job = seed_job(company="PrioProfile")
    paused_session(
        user_email=email, job_id=job, status=E.ApplicationSessionStatus.review_required
    )

    action = summary(client, headers)["nextAction"]
    assert action["kind"] == "complete_profile"


def test_paused_application_outranks_interviews_and_matches(client: TestClient):
    email = "prio-attention@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    job = seed_job(company="PrioAttention")
    score(user_email=email, job_id=job, fit_score=95.0)
    interview_job = seed_job(company="PrioAttentionIv")
    track(user_email=email, job_id=interview_job, status=E.ApplicationStatus.interview)
    set_follow_up(user_email=email, job_id=interview_job, days_ahead=2)
    paused_session(
        user_email=email, job_id=job, status=E.ApplicationSessionStatus.review_required
    )

    action = summary(client, headers)["nextAction"]
    assert action["kind"] == "needs_attention"
    assert action["eyebrow"] == "1 application needs attention"
    assert action["href"] == "/tracker"


def test_paused_application_count_is_pluralized(client: TestClient):
    email = "prio-plural@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    for index in range(3):
        job = seed_job(company=f"PrioPlural{index}")
        paused_session(
            user_email=email, job_id=job, status=E.ApplicationSessionStatus.review_required
        )

    assert (
        summary(client, headers)["nextAction"]["eyebrow"] == "3 applications need attention"
    )


def test_upcoming_interview_outranks_strong_matches(client: TestClient):
    email = "prio-interview@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    strong = seed_job(company="PrioInterviewStrong")
    score(user_email=email, job_id=strong, fit_score=99.0)
    interview_job = seed_job(company="PrioInterviewIv")
    track(user_email=email, job_id=interview_job, status=E.ApplicationStatus.interview)
    set_follow_up(user_email=email, job_id=interview_job, days_ahead=3)

    action = summary(client, headers)["nextAction"]
    assert action["kind"] == "interview_upcoming"
    assert action["title"] == "Prepare for your interview"
    assert action["dueOn"] is not None


def test_interview_without_a_recorded_date_makes_no_claim(client: TestClient):
    """Status alone is not evidence of an upcoming event."""
    email = "prio-nodate@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    strong = seed_job(company="PrioNoDateStrong")
    score(user_email=email, job_id=strong, fit_score=91.0)
    interview_job = seed_job(company="PrioNoDateIv")
    track(user_email=email, job_id=interview_job, status=E.ApplicationStatus.interview)

    action = summary(client, headers)["nextAction"]
    assert action["kind"] == "strong_matches"


def test_interview_beyond_the_horizon_is_not_upcoming(client: TestClient):
    email = "prio-far@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    strong = seed_job(company="PrioFarStrong")
    score(user_email=email, job_id=strong, fit_score=88.0)
    interview_job = seed_job(company="PrioFarIv")
    track(user_email=email, job_id=interview_job, status=E.ApplicationStatus.interview)
    set_follow_up(user_email=email, job_id=interview_job, days_ahead=60)

    assert summary(client, headers)["nextAction"]["kind"] == "strong_matches"


def test_strong_matches_count_only_scores_at_or_above_the_bar(client: TestClient):
    email = "prio-strong@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    score(user_email=email, job_id=seed_job(company="StrongA"), fit_score=80.0)
    score(user_email=email, job_id=seed_job(company="StrongB"), fit_score=93.0)
    score(user_email=email, job_id=seed_job(company="WeakA"), fit_score=79.9)
    score(user_email=email, job_id=seed_job(company="UnscoredA"), fit_score=None)

    payload = summary(client, headers)
    assert payload["strongMatches"] == 2
    action = payload["nextAction"]
    assert action["kind"] == "strong_matches"
    assert action["eyebrow"] == "2 strong matches"
    assert "80%+ fit" in action["body"]


def test_single_strong_match_is_not_pluralized(client: TestClient):
    email = "prio-one@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    score(user_email=email, job_id=seed_job(company="OnlyStrong"), fit_score=88.0)

    assert summary(client, headers)["nextAction"]["eyebrow"] == "1 strong match"


def test_saved_roles_rank_below_strong_matches(client: TestClient):
    email = "prio-saved@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    track(
        user_email=email,
        job_id=seed_job(company="PrioSavedRole"),
        status=E.ApplicationStatus.saved,
    )

    # No scored matches, so saved roles win.
    assert summary(client, headers)["nextAction"]["kind"] == "advance_saved"


def test_strong_match_count_excludes_already_tracked_jobs(client: TestClient):
    """A job you already applied to is not a fresh match to review."""
    email = "prio-tracked@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    applied = seed_job(company="PrioTracked")
    score(user_email=email, job_id=applied, fit_score=97.0)
    assert summary(client, headers)["strongMatches"] == 1

    track(user_email=email, job_id=applied, status=E.ApplicationStatus.applied)
    assert summary(client, headers)["strongMatches"] == 0


def test_next_action_never_triggers_scoring(client: TestClient, monkeypatch):
    from app.jobs import scoring_service

    def fail(*args, **kwargs):
        raise AssertionError("the Dashboard must not score during a page load")

    monkeypatch.setattr(scoring_service, "rematch_user", fail, raising=False)

    email = "prio-noscore@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    score(user_email=email, job_id=seed_job(company="PrioNoScore"), fit_score=90.0)
    assert summary(client, headers)["nextAction"]["kind"] == "strong_matches"


def test_the_suite_never_shares_a_dashboard_cache_with_a_real_redis(monkeypatch):
    """The cache must be process-local while tests run, whatever APP_ENV says.

    Regression test for the defect that made thirteen tests in this file fail on
    an ordinary developer machine. Each test builds a fresh in-memory database,
    so user ids restart at 1 and the fixture profiles are byte-identical, which
    means every test computes the SAME cache key. When the cache reached the dev
    Redis container, ``clear_local_dashboard_cache`` could not evict those
    entries and each test read the previous test's fresh-match counts — the
    failure looked like a broken eligibility gate rather than shared state.

    The gate keyed on ``app_env == "test"`` alone, which is false in a normal
    local checkout, so this pins the pytest-detection half specifically: with
    APP_ENV set to a non-test value, the client must still be None.
    """
    from app.core.config import running_under_test
    from app.dashboard import summary_cache
    from app.people import circuit, pdl_company

    monkeypatch.setattr(summary_cache.settings, "app_env", "development", raising=False)
    assert "PYTEST_CURRENT_TEST" in os.environ
    assert running_under_test() is True

    # Every process-external cache, not just this one: the People circuit
    # breaker leaking between tests is what produced whole files of
    # ``circuit_open`` failures that moved from run to run.
    assert summary_cache._redis_client() is None
    assert circuit._redis_client() is None
    assert pdl_company._redis_client() is None
