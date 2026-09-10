from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.applications.snapshots import get_owned_snapshot, list_owned_snapshots
from app.applications.tracker_lifecycle import (
    APPLICATION_RETENTION_GRACE_PERIOD,
    cancel_application_deletion,
    clear_lifecycle_after_confirmation,
    dismiss_submission_confirmation,
    require_submission_confirmation,
    schedule_application_deletion,
    update_application_status,
)
from app.db.base import Base
from app.models import entities as E


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    event.listen(engine, "connect", lambda conn, _: conn.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(engine)
    session = Session(engine)
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def seed(db: Session, *, email: str = "owner@example.test") -> tuple[E.User, E.JobPosting, E.ApplicationTracker]:
    user = E.User(email=email, hashed_password="x")
    source = E.JobSource(name=f"source-{email}", type="api", base_url="https://example.test")
    db.add_all([user, source])
    db.flush()
    job = E.JobPosting(
        source_id=source.id,
        external_id=f"job-{email}",
        title="Engineer",
        company="Acme",
        application_url="https://example.test/apply",
        source_url="https://example.test/job",
        description_raw="Engineer",
        description_clean="Engineer",
        hash_for_deduplication=f"hash-{email}",
    )
    db.add(job)
    db.flush()
    tracker = E.ApplicationTracker(user_id=user.id, job_id=job.id, status=E.ApplicationStatus.saved)
    db.add(tracker)
    db.commit()
    return user, job, tracker


def snapshot(
    db: Session,
    user: E.User,
    job: E.JobPosting,
    tracker: E.ApplicationTracker,
    *,
    attempt: int,
    session_id: int,
) -> E.ApplicationSnapshot:
    row = E.ApplicationSnapshot(
        application_tracker_id=tracker.id,
        user_id=user.id,
        job_id=job.id,
        source_session_id=session_id,
        attempt_number=attempt,
        confirmation_source=E.SnapshotConfirmationSource.user_confirmed,
        submission_evidence_metadata={},
        job_title=job.title,
        company_name=job.company,
        cover_letter_used=False,
        answers_snapshot=[],
        applied_at=datetime.now(UTC),
    )
    db.add(row)
    db.commit()
    return row


@pytest.mark.parametrize(
    ("initial", "terminal"),
    [
        (E.ApplicationStatus.saved, E.ApplicationStatus.rejected),
        (E.ApplicationStatus.applied, E.ApplicationStatus.rejected),
        (E.ApplicationStatus.interview, E.ApplicationStatus.rejected),
        (E.ApplicationStatus.applied, E.ApplicationStatus.withdrawn),
    ],
)
def test_entering_terminal_status_schedules_seven_days(db: Session, initial, terminal) -> None:
    _, _, tracker = seed(db)
    tracker.status = initial
    now = datetime(2026, 9, 9, 12, tzinfo=UTC)
    update_application_status(tracker, terminal, now=now)
    assert tracker.deletion_scheduled_at == now + APPLICATION_RETENTION_GRACE_PERIOD


def test_terminal_repeats_and_switches_preserve_clock(db: Session) -> None:
    _, _, tracker = seed(db)
    first = datetime(2026, 9, 9, 12, tzinfo=UTC)
    update_application_status(tracker, E.ApplicationStatus.rejected, now=first)
    deadline = tracker.deletion_scheduled_at
    update_application_status(tracker, E.ApplicationStatus.rejected, now=first + timedelta(days=1))
    update_application_status(tracker, E.ApplicationStatus.withdrawn, now=first + timedelta(days=2))
    assert tracker.deletion_scheduled_at == deadline


@pytest.mark.parametrize("restored", [E.ApplicationStatus.interview, E.ApplicationStatus.applied])
def test_leaving_terminal_clears_retention_state(db: Session, restored) -> None:
    _, _, tracker = seed(db)
    update_application_status(tracker, E.ApplicationStatus.rejected)
    cancel_application_deletion(tracker)
    update_application_status(tracker, restored)
    assert tracker.deletion_scheduled_at is None
    assert tracker.deletion_cancelled_at is None


def test_undo_is_idempotent_and_same_status_does_not_reschedule(db: Session) -> None:
    _, _, tracker = seed(db)
    now = datetime(2026, 9, 9, 12, tzinfo=UTC)
    update_application_status(tracker, E.ApplicationStatus.rejected, now=now)
    cancel_application_deletion(tracker, now=now + timedelta(hours=1))
    cancelled = tracker.deletion_cancelled_at
    cancel_application_deletion(tracker, now=now + timedelta(hours=2))
    update_application_status(tracker, E.ApplicationStatus.rejected, now=now + timedelta(days=1))
    assert tracker.status == E.ApplicationStatus.rejected
    assert tracker.deletion_scheduled_at is None
    assert tracker.deletion_cancelled_at == cancelled
    schedule_application_deletion(tracker, now=now + timedelta(days=2))
    assert tracker.deletion_scheduled_at == now + timedelta(days=9)
    assert tracker.deletion_cancelled_at is None


def test_confirmation_requirement_and_dismissal_do_not_mark_applied(db: Session) -> None:
    _, _, tracker = seed(db)
    required = datetime(2026, 9, 9, 12, tzinfo=UTC)
    dismissed = required + timedelta(hours=1)
    require_submission_confirmation(tracker, now=required)
    dismiss_submission_confirmation(tracker, now=dismissed)
    assert tracker.status == E.ApplicationStatus.saved
    assert tracker.applied_at is None
    assert tracker.confirmation_required_at == required
    assert tracker.confirmation_prompt_dismissed_at == dismissed

    tracker.status = E.ApplicationStatus.applied
    tracker.deletion_scheduled_at = required + timedelta(days=7)
    clear_lifecycle_after_confirmation(tracker)
    assert tracker.confirmation_required_at is None
    assert tracker.confirmation_prompt_dismissed_at == dismissed
    assert tracker.deletion_scheduled_at is None


def test_multiple_snapshots_and_ownership_boundaries(db: Session) -> None:
    owner, job, tracker = seed(db)
    other, _, _ = seed(db, email="other@example.test")
    first = snapshot(db, owner, job, tracker, attempt=1, session_id=101)
    second = snapshot(db, owner, job, tracker, attempt=2, session_id=102)
    assert [row.id for row in list_owned_snapshots(db, user_id=owner.id, tracker_id=tracker.id)] == [
        first.id,
        second.id,
    ]
    assert list_owned_snapshots(db, user_id=other.id, tracker_id=tracker.id) == []
    assert get_owned_snapshot(db, user_id=owner.id, snapshot_id=first.id) is first
    assert get_owned_snapshot(db, user_id=other.id, snapshot_id=first.id) is None


@pytest.mark.parametrize("duplicate", ["attempt", "session"])
def test_snapshot_uniqueness_is_database_enforced(db: Session, duplicate: str) -> None:
    owner, job, tracker = seed(db)
    snapshot(db, owner, job, tracker, attempt=1, session_id=101)
    db.add(
        E.ApplicationSnapshot(
            application_tracker_id=tracker.id,
            user_id=owner.id,
            job_id=job.id,
            source_session_id=101 if duplicate == "session" else 102,
            attempt_number=2 if duplicate == "session" else 1,
            confirmation_source=E.SnapshotConfirmationSource.user_confirmed,
            submission_evidence_metadata={},
            job_title="Engineer",
            company_name="Acme",
            cover_letter_used=False,
            answers_snapshot=[],
            applied_at=datetime.now(UTC),
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()


def test_tracker_and_current_job_cleanup_cascade_snapshot(db: Session) -> None:
    owner, job, tracker = seed(db)
    row = snapshot(db, owner, job, tracker, attempt=1, session_id=101)
    snapshot_id = row.id
    db.delete(job)
    db.commit()
    # Existing JobPosting -> ApplicationTracker is CASCADE, and Tracker ->
    # Snapshot intentionally follows it. Stage 2A does not rewrite that older
    # product-wide cleanup contract.
    assert db.get(E.ApplicationSnapshot, snapshot_id) is None


def test_cancel_route_is_owned_and_idempotent(client) -> None:
    owner_headers = _auth(client, "retention-owner@mailbox.test-domain.co")
    other_headers = _auth(client, "retention-other@mailbox.test-domain.co")
    job_id = _seed_http_job()

    scheduled = client.put(f"/jobs/{job_id}/tracker", headers=owner_headers, json={"status": "rejected"})
    assert scheduled.status_code == 200, scheduled.text
    tracker = scheduled.json()["tracker"]
    assert tracker["deletion_scheduled_at"] is not None

    denied = client.post(f"/jobs/tracker/{tracker['id']}/cancel-deletion", headers=other_headers)
    assert denied.status_code == 404

    cancelled = client.post(f"/jobs/tracker/{tracker['id']}/cancel-deletion", headers=owner_headers)
    assert cancelled.status_code == 200
    assert cancelled.json()["tracker"]["status"] == "rejected"
    assert cancelled.json()["tracker"]["deletion_scheduled_at"] is None
    repeated = client.post(f"/jobs/tracker/{tracker['id']}/cancel-deletion", headers=owner_headers)
    assert repeated.status_code == 200
    assert repeated.json()["tracker"]["deletion_scheduled_at"] is None


# This module uses the repository-wide HTTP fixture for the route boundary.
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.api.deps import get_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(engine)

    def override():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override
    app.state.stage2a_session_factory = factory
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        del app.state.stage2a_session_factory
        Base.metadata.drop_all(engine)
        engine.dispose()


def _auth(client: TestClient, email: str) -> dict[str, str]:
    payload = client.post("/auth/signup", json={"email": email, "password": "password123"}).json()
    return {"Authorization": f"Bearer {payload['access_token']}"}


def _seed_http_job() -> int:
    session = app.state.stage2a_session_factory()
    try:
        source = E.JobSource(name="stage-2a", type="api", base_url="https://example.test")
        session.add(source)
        session.flush()
        job = E.JobPosting(
            source_id=source.id,
            external_id="stage-2a-job",
            title="Engineer",
            company="Acme",
            application_url="https://example.test/apply",
            source_url="https://example.test/job",
            description_raw="Engineer",
            description_clean="Engineer",
            hash_for_deduplication="stage-2a-hash",
        )
        session.add(job)
        session.commit()
        return job.id
    finally:
        session.close()
