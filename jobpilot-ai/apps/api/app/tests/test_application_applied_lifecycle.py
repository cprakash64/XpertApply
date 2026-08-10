"""The "successful application moves to Tracker" lifecycle.

The property under test throughout: a job leaves the Jobs page and enters the
Tracker if and only if a submission was actually CONFIRMED — by the extension,
by an auto-apply run, or by the user saying so explicitly. Opening the employer
page is not a confirmation, and neither is anything else that happens on the way
to a submission the user may never make.
"""

from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.applications.mark_applied import (
    DISCOVERY_HIDDEN_STATUSES,
    ApplicationJobNotFound,
    AppliedSource,
    mark_application_applied,
)
from app.db.base import Base
from app.main import app
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
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def auth(client: TestClient, email: str = "applied@mailbox.test-domain.co") -> dict[str, str]:
    token = client.post("/auth/signup", json={"email": email, "password": "password123"}).json()
    return {"Authorization": f"Bearer {token['access_token']}"}


def complete_profile(client: TestClient, headers: dict[str, str]) -> None:
    client.put("/profile", headers=headers, json={
        "full_name": "Chandra Pandey", "phone": "602-555-0100",
        "location_city": "Phoenix", "location_state": "AZ", "location_country": "United States",
        "work_authorization": "authorized_us",
        "target_roles": ["Backend Engineer"], "target_levels": ["Junior"],
        "preferred_locations": ["United States"], "remote_preference": "remote",
        "skills": ["Python", "FastAPI", "PostgreSQL"],
    })
    client.put("/profile/career", headers=headers, json={
        "education": [{"school": "Arizona State University", "degree": "BS"}],
        "experience": [{"company": "Cardinal Health", "title": "ML Engineer Intern",
                        "bullets": ["Built Python services"], "technologies": ["Python"],
                        "currently_working": True}],
        "projects": [], "certifications": [], "awards": [],
    })


def seed_job(*, company: str = "Acme", external: str = "be-1", days: int = 1) -> int:
    db = next(app.dependency_overrides[get_db]())
    src = db.scalar(select(E.JobSource).where(E.JobSource.name == company))
    if src is None:
        src = E.JobSource(
            name=company, type="greenhouse", base_url="x", enabled=True, supports_api=True
        )
        db.add(src)
        db.flush()
    url = f"https://boards.greenhouse.io/{company.lower()}/{external}"
    job = E.JobPosting(
        source_id=src.id, external_id=external, title="Backend Engineer", company=company,
        location="Remote, United States", remote_type="remote",
        posted_at=datetime.now(UTC) - timedelta(days=days), discovered_at=datetime.now(UTC),
        application_url=url, source_url=url, description_raw="",
        description_clean="Backend Engineer. Requirements: Python, FastAPI.",
        required_skills=["Python", "FastAPI"], hash_for_deduplication=f"h-{company}-{external}",
    )
    db.add(job)
    db.commit()
    job_id = job.id
    db.close()
    return job_id


def db_session() -> Session:
    return next(app.dependency_overrides[get_db]())


def tracker_rows(user_id: int, job_id: int) -> list[E.ApplicationTracker]:
    db = db_session()
    try:
        return list(db.scalars(
            select(E.ApplicationTracker).where(
                (E.ApplicationTracker.user_id == user_id) & (E.ApplicationTracker.job_id == job_id)
            )
        ).all())
    finally:
        db.close()


def user_id_for(client: TestClient, headers: dict[str, str]) -> int:
    return client.get("/auth/me", headers=headers).json()["id"]


def listed_job_ids(client: TestClient, headers: dict[str, str]) -> set[int]:
    resp = client.get("/jobs?posted_within_days=30", headers=headers)
    assert resp.status_code == 200, resp.text
    return {job["id"] for job in resp.json()["jobs"]}


def confirm_applied(client: TestClient, headers: dict[str, str], job_id: int, **body):
    return client.post(
        f"/jobs/{job_id}/applications/confirm-applied",
        headers=headers,
        json={"confirmed": True, **body},
    )


# --------------------------------------------------------------------------- #
# Opening an application is not applying
# --------------------------------------------------------------------------- #
def test_opening_official_application_does_not_mark_applied(client: TestClient) -> None:
    """The whole point of the feature: clicking through to the employer site
    records that it was opened and nothing more."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()

    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()
    client.post(f"/jobs/{job_id}/save", headers=headers)

    resp = client.patch(
        f"/application-sessions/{session['session_id']}/status",
        headers=headers, json={"status": "opened"},
    )
    assert resp.status_code == 200, resp.text

    rows = tracker_rows(user_id_for(client, headers), job_id)
    assert len(rows) == 1
    assert rows[0].status == E.ApplicationStatus.saved
    assert rows[0].applied_at is None
    assert rows[0].applied_source is None
    # Opening IS recorded — just never as a submission.
    assert rows[0].opened_at is not None
    assert rows[0].last_application_url

    submitted = client.get("/jobs/tracker/submitted", headers=headers).json()["applications"]
    assert submitted == []


def test_saved_job_without_confirmation_stays_in_discovery(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    client.post(f"/jobs/{job_id}/save", headers=headers)
    assert job_id in listed_job_ids(client, headers)


# --------------------------------------------------------------------------- #
# Manual confirmation
# --------------------------------------------------------------------------- #
def test_manual_confirmation_creates_applied_application(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()

    resp = confirm_applied(client, headers, job_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["created"] is True
    assert body["already_applied"] is False
    assert body["job_id"] == job_id
    assert body["application"]["status"] == "applied"
    assert body["application"]["applied_at"] is not None
    assert body["application"]["applied_source"] == "user_confirmed"


def test_manual_confirmation_updates_existing_started_application(client: TestClient) -> None:
    """A record that already exists (saved, or an apply run in progress) is
    UPDATED, never duplicated."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = user_id_for(client, headers)

    client.post(f"/jobs/{job_id}/save", headers=headers)
    db = db_session()
    row = db.scalar(select(E.ApplicationTracker).where(E.ApplicationTracker.job_id == job_id))
    row.status = E.ApplicationStatus.applying
    row.notes = "Half-finished on the employer page"
    db.commit()
    original_id = row.id
    db.close()

    resp = confirm_applied(client, headers, job_id)
    assert resp.status_code == 200
    assert resp.json()["created"] is False

    rows = tracker_rows(user_id, job_id)
    assert len(rows) == 1
    assert rows[0].id == original_id
    assert rows[0].status == E.ApplicationStatus.applied
    # Work the user already did survives the transition.
    assert rows[0].notes == "Half-finished on the employer page"


def test_confirmation_requires_explicit_confirmed_flag(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    resp = client.post(
        f"/jobs/{job_id}/applications/confirm-applied", headers=headers, json={"confirmed": False}
    )
    assert resp.status_code == 422
    assert tracker_rows(user_id_for(client, headers), job_id) == []


def test_manual_confirmation_preserves_tailored_documents(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()
    assert session["resume"]["status"] == "ready"
    assert session["cover_letter"]["status"] == "ready"

    assert confirm_applied(client, headers, job_id).status_code == 200

    entry = next(
        row for row in client.get("/jobs/tracker/submitted", headers=headers).json()["applications"]
        if row["job_id"] == job_id
    )
    assert entry["documents"]["resume"] is not None
    assert entry["documents"]["cover_letter"] is not None


# --------------------------------------------------------------------------- #
# Extension / auto-apply confirmation
# --------------------------------------------------------------------------- #
def confirm_via_session(client: TestClient, headers, session_id: int, **body):
    return client.post(
        f"/application-sessions/{session_id}/submission-confirmed",
        headers=headers,
        json={"evidence_type": "success_page", **body},
    )


def test_extension_confirmation_creates_applied_application(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    resp = confirm_via_session(
        client, headers, session["session_id"],
        submission_reference="GH-55112", ats="greenhouse",
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["application"]["status"] == "applied"
    assert body["application"]["applied_source"] == "extension_confirmed"
    assert body["application"]["submission_reference"] == "GH-55112"
    assert body["already_applied"] is False


def test_auto_apply_confirmation_creates_applied_application(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    resp = confirm_via_session(
        client, headers, session["session_id"],
        confirmation_source="auto_apply_confirmed", evidence_type="success_response",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["application"]["applied_source"] == "auto_apply_confirmed"


@pytest.mark.parametrize(
    "evidence",
    ["submit_clicked", "form_disappeared", "url_changed", "timeout", "button_disabled", ""],
)
def test_weak_evidence_is_refused(client: TestClient, evidence: str) -> None:
    """Everything that merely *correlates* with submission is rejected. These are
    the exact signals that fire on applications the user abandoned."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    resp = client.post(
        f"/application-sessions/{session['session_id']}/submission-confirmed",
        headers=headers, json={"evidence_type": evidence},
    )
    assert resp.status_code == 422
    assert tracker_rows(user_id_for(client, headers), job_id) == []


def test_extension_cannot_name_another_job_or_owner(client: TestClient) -> None:
    """The event body carries no job or user, and extra fields are refused
    outright — so a compromised client cannot redirect the confirmation."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    other_job_id = seed_job(company="Globex", external="be-2")
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    resp = client.post(
        f"/application-sessions/{session['session_id']}/submission-confirmed",
        headers=headers,
        json={
            "evidence_type": "success_page",
            "job_id": other_job_id,
            "user_id": 999,
            "status": "offer",
        },
    )
    assert resp.status_code == 422
    assert tracker_rows(user_id_for(client, headers), job_id) == []
    assert tracker_rows(user_id_for(client, headers), other_job_id) == []


def test_another_users_token_cannot_confirm_this_session(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    intruder = auth(client, email="intruder@mailbox.test-domain.co")
    resp = confirm_via_session(client, intruder, session["session_id"])
    assert resp.status_code == 403
    assert tracker_rows(user_id_for(client, headers), job_id) == []


def test_unauthorized_user_cannot_confirm_another_users_job(client: TestClient) -> None:
    """A confirmation only ever writes the CALLER's ledger — it can never reach
    into someone else's."""
    owner = auth(client)
    complete_profile(client, owner)
    job_id = seed_job()
    assert confirm_applied(client, owner, job_id).status_code == 200

    other = auth(client, email="other@mailbox.test-domain.co")
    complete_profile(client, other)
    other_id = user_id_for(client, other)

    assert client.get("/jobs/tracker/submitted", headers=other).json()["applications"] == []
    assert tracker_rows(other_id, job_id) == []


def test_invalid_job_returns_404(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    resp = confirm_applied(client, headers, 987654)
    assert resp.status_code == 404


def test_unauthenticated_confirmation_is_rejected(client: TestClient) -> None:
    job_id = seed_job()
    resp = client.post(f"/jobs/{job_id}/applications/confirm-applied", json={"confirmed": True})
    assert resp.status_code in (401, 403)


# --------------------------------------------------------------------------- #
# Idempotency and concurrency
# --------------------------------------------------------------------------- #
def test_repeated_confirmation_is_idempotent(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = user_id_for(client, headers)

    first = confirm_applied(client, headers, job_id).json()
    second = confirm_applied(client, headers, job_id).json()
    third = confirm_applied(client, headers, job_id).json()

    assert first["created"] is True and first["already_applied"] is False
    assert second["created"] is False and second["already_applied"] is True
    assert third["already_applied"] is True
    assert second["application"]["id"] == first["application"]["id"]
    assert len(tracker_rows(user_id, job_id)) == 1


def test_duplicate_extension_event_changes_nothing(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    first = confirm_via_session(
        client, headers, session["session_id"], submission_reference="R-1"
    ).json()
    second = confirm_via_session(
        client, headers, session["session_id"], submission_reference="R-1"
    ).json()

    assert second["already_applied"] is True
    assert second["application"]["applied_at"] == first["application"]["applied_at"]
    assert len(tracker_rows(user_id_for(client, headers), job_id)) == 1


def test_extension_and_manual_confirmation_produce_one_record(client: TestClient) -> None:
    """The two paths racing each other must converge, not duplicate."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    assert confirm_via_session(client, headers, session["session_id"]).status_code == 200
    manual = confirm_applied(client, headers, job_id).json()

    assert manual["already_applied"] is True
    # The FIRST (strongest, machine-confirmed) provenance is kept.
    assert manual["application"]["applied_source"] == "extension_confirmed"
    assert len(tracker_rows(user_id_for(client, headers), job_id)) == 1


def test_concurrent_confirmations_create_one_record(client: TestClient) -> None:
    """Two sessions that both miss on SELECT and both INSERT: the unique
    constraint decides, and the loser updates the winner's row."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = user_id_for(client, headers)

    db_a = db_session()
    db_b = db_session()
    try:
        result_a = mark_application_applied(
            db_a, user_id=user_id, job_id=job_id, source=AppliedSource.extension_confirmed
        )
        db_a.commit()
        result_b = mark_application_applied(
            db_b, user_id=user_id, job_id=job_id, source=AppliedSource.user_confirmed
        )
        db_b.commit()
    finally:
        db_a.close()
        db_b.close()

    assert result_a.created is True
    assert result_b.created is False
    assert len(tracker_rows(user_id, job_id)) == 1


def test_applied_at_is_preserved_across_repeated_confirmations(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = user_id_for(client, headers)

    original = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)
    db = db_session()
    mark_application_applied(
        db, user_id=user_id, job_id=job_id,
        source=AppliedSource.extension_confirmed, submitted_at=original,
    )
    db.commit()
    db.close()

    # A later duplicate event must not move the date the user shows employers.
    confirm_applied(client, headers, job_id, submitted_at="2026-07-01T09:00:00Z")

    rows = tracker_rows(user_id, job_id)
    assert rows[0].applied_at.replace(tzinfo=UTC) == original


def test_future_submission_timestamp_is_clamped_to_now(client: TestClient) -> None:
    """A skewed client clock cannot post-date a submission."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    future = (datetime.now(UTC) + timedelta(days=400)).isoformat()

    body = confirm_applied(client, headers, job_id, submitted_at=future).json()
    applied_at = datetime.fromisoformat(body["application"]["applied_at"].replace("Z", "+00:00"))
    # SQLite drops tzinfo on the round-trip; the stored instant is UTC either way.
    if applied_at.tzinfo is None:
        applied_at = applied_at.replace(tzinfo=UTC)
    assert applied_at <= datetime.now(UTC) + timedelta(seconds=5)


def test_confirmation_does_not_drag_a_later_status_backwards(client: TestClient) -> None:
    """A late duplicate arriving after the user recorded an interview must not
    reset them to 'applied'."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = user_id_for(client, headers)

    confirm_applied(client, headers, job_id)
    client.put(f"/jobs/{job_id}/tracker", headers=headers, json={"status": "interview"})

    confirm_applied(client, headers, job_id)
    assert tracker_rows(user_id, job_id)[0].status == E.ApplicationStatus.interview


# --------------------------------------------------------------------------- #
# Discovery filtering
# --------------------------------------------------------------------------- #
def test_applied_job_is_excluded_from_that_users_discovery(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    assert job_id in listed_job_ids(client, headers)

    confirm_applied(client, headers, job_id)
    assert job_id not in listed_job_ids(client, headers)


def test_applied_job_remains_visible_for_another_user(client: TestClient) -> None:
    """Exclusion is per-user. The Job row is shared and must never be hidden
    globally or deleted."""
    owner = auth(client)
    complete_profile(client, owner)
    job_id = seed_job()
    confirm_applied(client, owner, job_id)

    other = auth(client, email="viewer@mailbox.test-domain.co")
    complete_profile(client, other)
    assert job_id in listed_job_ids(client, other)

    db = db_session()
    try:
        assert db.get(E.JobPosting, job_id) is not None  # never deleted
    finally:
        db.close()


@pytest.mark.parametrize("status", ["interview", "offer", "rejected", "withdrawn"])
def test_downstream_lifecycle_statuses_are_excluded(client: TestClient, status: str) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    confirm_applied(client, headers, job_id)
    resp = client.put(f"/jobs/{job_id}/tracker", headers=headers, json={"status": status})
    assert resp.status_code == 200, resp.text
    assert job_id not in listed_job_ids(client, headers)


@pytest.mark.parametrize("status", ["saved", "ready_to_apply"])
def test_pre_submission_statuses_stay_in_discovery(client: TestClient, status: str) -> None:
    """Documented policy: a job the user only saved or prepared is still an open
    opportunity and must remain actionable in discovery."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    client.put(f"/jobs/{job_id}/tracker", headers=headers, json={"status": status})
    assert job_id in listed_job_ids(client, headers)


def test_failed_apply_run_leaves_the_job_retryable(client: TestClient) -> None:
    """Failure lives on the SESSION, not on the application record, so the job
    stays discoverable and the user can try again."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    resp = client.patch(
        f"/application-sessions/{session['session_id']}/status",
        headers=headers, json={"status": "failed"},
    )
    assert resp.status_code == 200
    assert job_id in listed_job_ids(client, headers)


def test_applied_job_stays_hidden_across_sessions_and_rediscovery(client: TestClient) -> None:
    """Refresh, a brand new login, and provider rediscovery that updates the
    canonical job must all leave the application state intact."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    confirm_applied(client, headers, job_id)

    assert job_id not in listed_job_ids(client, headers)  # refresh

    # Provider rediscovery: the canonical job row is updated in place.
    db = db_session()
    job = db.get(E.JobPosting, job_id)
    job.title = "Backend Engineer II"
    job.last_seen_at = datetime.now(UTC)
    job.discovered_at = datetime.now(UTC)
    job.is_active = True
    db.commit()
    db.close()
    assert job_id not in listed_job_ids(client, headers)

    # A fresh login for the same user.
    fresh = client.post(
        "/auth/login",
        json={"email": "applied@mailbox.test-domain.co", "password": "password123"},
    ).json()
    fresh_headers = {"Authorization": f"Bearer {fresh['access_token']}"}
    assert job_id not in listed_job_ids(client, fresh_headers)


def test_discovery_exclusion_does_not_scale_queries_with_job_count(client: TestClient) -> None:
    """Guards the N+1: the exclusion is one set-returning query regardless of how
    many applications the user has, so query count must not grow with them."""
    from sqlalchemy import event

    headers = auth(client)
    complete_profile(client, headers)
    job_ids = [seed_job(company="Acme", external=f"be-{i}") for i in range(12)]
    for job_id in job_ids[:8]:
        confirm_applied(client, headers, job_id)

    db = db_session()
    engine = db.get_bind()
    db.close()

    counter = {"n": 0}

    def count(*_args, **_kwargs) -> None:
        counter["n"] += 1

    event.listen(engine, "before_cursor_execute", count)
    try:
        listed_job_ids(client, headers)
        with_eight = counter["n"]
        counter["n"] = 0
        for job_id in job_ids[8:]:
            confirm_applied(client, headers, job_id)
        counter["n"] = 0
        listed_job_ids(client, headers)
        with_twelve = counter["n"]
    finally:
        event.remove(engine, "before_cursor_execute", count)

    assert with_twelve <= with_eight, (
        f"Jobs list issued {with_twelve} queries with 12 applied jobs vs {with_eight} with 8 — "
        "the applied-job exclusion has become an N+1."
    )


def test_discovery_hidden_statuses_cover_every_submitted_state() -> None:
    """A new submitted-lifecycle status must not silently start leaking back
    into discovery."""
    for status in (
        E.ApplicationStatus.applied,
        E.ApplicationStatus.interview,
        E.ApplicationStatus.offer,
        E.ApplicationStatus.rejected,
        E.ApplicationStatus.withdrawn,
    ):
        assert status in DISCOVERY_HIDDEN_STATUSES
    assert E.ApplicationStatus.saved not in DISCOVERY_HIDDEN_STATUSES
    assert E.ApplicationStatus.ready_to_apply not in DISCOVERY_HIDDEN_STATUSES


# --------------------------------------------------------------------------- #
# Tracker
# --------------------------------------------------------------------------- #
def test_tracker_contains_exactly_one_applied_record(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    confirm_via_session(client, headers, session["session_id"])
    confirm_via_session(client, headers, session["session_id"])
    confirm_applied(client, headers, job_id)

    applications = client.get("/jobs/tracker/submitted", headers=headers).json()["applications"]
    matching = [row for row in applications if row["job_id"] == job_id]
    assert len(matching) == 1
    entry = matching[0]
    assert entry["status"] == "applied"
    assert entry["applied_at"] is not None
    assert entry["applied_source"] == "extension_confirmed"
    assert entry["application_url"]
    assert entry["job"]["company"] == "Acme"
    assert entry["job"]["title"] == "Backend Engineer"


def test_completing_a_session_links_the_same_application_record(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    resp = client.post(
        f"/application-sessions/{session['session_id']}/complete",
        headers=headers, json={"confirmed": True},
    )
    assert resp.status_code == 200

    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session["session_id"])
        tracker = db.get(E.ApplicationTracker, row.tracker_id)
        assert tracker is not None
        assert tracker.status == E.ApplicationStatus.applied
        assert tracker.job_id == job_id
    finally:
        db.close()
    assert len(tracker_rows(user_id_for(client, headers), job_id)) == 1


def test_session_completion_without_confirmation_is_refused(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()

    resp = client.post(
        f"/application-sessions/{session['session_id']}/complete",
        headers=headers, json={"confirmed": False},
    )
    assert resp.status_code == 422
    assert tracker_rows(user_id_for(client, headers), job_id) == []


# --------------------------------------------------------------------------- #
# Service-level behaviour
# --------------------------------------------------------------------------- #
def test_service_raises_for_unknown_job(client: TestClient) -> None:
    headers = auth(client)
    user_id = user_id_for(client, headers)
    db = db_session()
    try:
        with pytest.raises(ApplicationJobNotFound):
            mark_application_applied(
                db, user_id=user_id, job_id=424242, source=AppliedSource.user_confirmed
            )
    finally:
        db.close()


def test_audit_trail_records_the_transition_without_sensitive_content(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    confirm_applied(client, headers, job_id)

    db = db_session()
    try:
        entry = db.scalar(
            select(E.AuditLog).where(E.AuditLog.action == "application.marked_applied")
        )
        assert entry is not None
        payload = entry.metadata_json
        assert payload["job_id"] == job_id
        assert payload["source"] == "user_confirmed"
        assert payload["new_status"] == "applied"
        assert payload["applied_at"]
        # No document contents, and no free-text the user wrote.
        assert "notes" not in payload
        assert "resume" not in payload
        assert "content" not in payload
    finally:
        db.close()
