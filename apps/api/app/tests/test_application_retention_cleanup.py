from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.applications.retention_cleanup import cleanup_due_application_trackers
from app.applications.session_service import SessionError, complete_session
from app.applications.tracker_lifecycle import (
    cancel_application_deletion,
    schedule_application_deletion,
    update_application_status,
)
from app.db.base import Base
from app.main import app
from app.models import entities as E

NOW = datetime(2026, 9, 11, 12, tzinfo=UTC)


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


def tracker(
    db: Session,
    suffix: str,
    *,
    status: E.ApplicationStatus,
    deadline: datetime | None,
) -> tuple[E.User, E.JobPosting, E.ApplicationTracker]:
    user = E.User(email=f"retention-{suffix}@example.test", hashed_password="x")
    source = E.JobSource(name=f"source-{suffix}", type="api", base_url="https://example.test")
    db.add_all([user, source])
    db.flush()
    job = E.JobPosting(
        source_id=source.id,
        external_id=f"job-{suffix}",
        title="Engineer",
        company="Acme",
        application_url="https://example.test/apply",
        source_url="https://example.test/job",
        description_raw="Engineer",
        description_clean="Engineer",
        hash_for_deduplication=f"hash-{suffix}",
    )
    db.add(job)
    db.flush()
    row = E.ApplicationTracker(
        user_id=user.id,
        job_id=job.id,
        status=status,
        deletion_scheduled_at=deadline,
    )
    db.add(row)
    db.commit()
    return user, job, row


@pytest.mark.parametrize("status", [E.ApplicationStatus.rejected, E.ApplicationStatus.withdrawn])
@pytest.mark.parametrize("offset", [timedelta(0), -timedelta(seconds=1)])
def test_due_terminal_tracker_is_deleted_at_or_before_boundary(db: Session, status, offset) -> None:
    _, _, row = tracker(db, f"{status}-{offset}", status=status, deadline=NOW + offset)
    row_id = row.id

    result = cleanup_due_application_trackers(db, now=NOW)

    assert result.as_dict() == {"selected": 1, "deleted": 1, "skipped": 0, "failed": 0}
    assert db.get(E.ApplicationTracker, row_id) is None
    assert cleanup_due_application_trackers(db, now=NOW).deleted == 0


@pytest.mark.parametrize(
    ("status", "deadline"),
    [
        (E.ApplicationStatus.rejected, None),
        (E.ApplicationStatus.withdrawn, NOW + timedelta(seconds=1)),
        (E.ApplicationStatus.applied, NOW - timedelta(days=1)),
        (E.ApplicationStatus.interview, NOW - timedelta(days=1)),
        (E.ApplicationStatus.saved, NOW - timedelta(days=1)),
        (E.ApplicationStatus.ready_to_apply, NOW - timedelta(days=1)),
        (E.ApplicationStatus.applying, NOW - timedelta(days=1)),
        (E.ApplicationStatus.offer, NOW - timedelta(days=1)),
    ],
)
def test_ineligible_tracker_is_retained(db: Session, status, deadline) -> None:
    _, _, row = tracker(db, str(status), status=status, deadline=deadline)
    row_id = row.id
    result = cleanup_due_application_trackers(db, now=NOW)
    assert result.selected == result.deleted == 0
    assert db.get(E.ApplicationTracker, row_id) is not None


def test_cancel_marker_with_stale_deadline_fails_closed(db: Session) -> None:
    _, _, row = tracker(
        db, "cancelled-stale-deadline", status=E.ApplicationStatus.rejected,
        deadline=NOW - timedelta(days=1),
    )
    row.deletion_cancelled_at = NOW - timedelta(days=2)
    db.commit()
    assert cleanup_due_application_trackers(db, now=NOW).deleted == 0
    assert db.get(E.ApplicationTracker, row.id) is not None


def test_undo_status_change_and_same_terminal_after_undo_are_retained(db: Session) -> None:
    _, _, undone = tracker(
        db, "undone", status=E.ApplicationStatus.rejected, deadline=NOW - timedelta(days=1)
    )
    cancel_application_deletion(undone, now=NOW - timedelta(hours=1))
    update_application_status(undone, E.ApplicationStatus.rejected, now=NOW)
    db.commit()
    assert cleanup_due_application_trackers(db, now=NOW).deleted == 0
    assert db.get(E.ApplicationTracker, undone.id) is not None

    _, _, restored = tracker(
        db, "restored", status=E.ApplicationStatus.rejected, deadline=NOW - timedelta(days=1)
    )
    update_application_status(restored, E.ApplicationStatus.interview, now=NOW)
    db.commit()
    assert cleanup_due_application_trackers(db, now=NOW).deleted == 0
    assert db.get(E.ApplicationTracker, restored.id) is not None


def test_explicit_reschedule_deletes_only_at_the_new_deadline(db: Session) -> None:
    _, _, row = tracker(db, "rescheduled", status=E.ApplicationStatus.rejected, deadline=NOW)
    cancel_application_deletion(row, now=NOW)
    schedule_application_deletion(row, now=NOW)
    db.commit()
    new_deadline = NOW + timedelta(days=7)
    assert cleanup_due_application_trackers(db, now=new_deadline - timedelta(microseconds=1)).deleted == 0
    assert cleanup_due_application_trackers(db, now=new_deadline).deleted == 1


def test_batch_is_bounded_and_progresses_in_deadline_then_id_order(db: Session) -> None:
    ids = []
    for index in range(5):
        _, _, row = tracker(
            db,
            f"batch-{index}",
            status=E.ApplicationStatus.rejected,
            deadline=NOW - timedelta(days=5 - index),
        )
        ids.append(row.id)

    first = cleanup_due_application_trackers(db, now=NOW, batch_size=2)
    remaining = list(db.scalars(select(E.ApplicationTracker.id).order_by(E.ApplicationTracker.id)))
    assert first.deleted == 2
    assert remaining == ids[2:]
    assert cleanup_due_application_trackers(db, now=NOW, batch_size=2).deleted == 2
    assert cleanup_due_application_trackers(db, now=NOW, batch_size=2).deleted == 1


def test_default_batch_processes_at_most_one_hundred_then_progresses(db: Session) -> None:
    ids = []
    for index in range(103):
        _, _, row = tracker(
            db, f"default-bound-{index}", status=E.ApplicationStatus.withdrawn,
            deadline=NOW - timedelta(days=2),
        )
        ids.append(row.id)

    first = cleanup_due_application_trackers(db, now=NOW)
    remaining = list(db.scalars(select(E.ApplicationTracker.id).order_by(E.ApplicationTracker.id)))
    assert first.selected == first.deleted == 100
    assert remaining == ids[100:]
    second = cleanup_due_application_trackers(db, now=NOW)
    assert second.selected == second.deleted == 3


def test_one_row_failure_isolated_and_logs_no_private_content(
    db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _, _, first = tracker(
        db, "failure-first", status=E.ApplicationStatus.rejected,
        deadline=NOW - timedelta(days=2),
    )
    _, _, second = tracker(
        db, "failure-second", status=E.ApplicationStatus.rejected,
        deadline=NOW - timedelta(days=1),
    )
    original_delete = db.delete

    def fail_first(instance) -> None:
        if isinstance(instance, E.ApplicationTracker) and instance.id == first.id:
            raise RuntimeError("controlled database failure")
        original_delete(instance)

    monkeypatch.setattr(db, "delete", fail_first)
    with caplog.at_level(logging.INFO, logger="jobpilot.worker"):
        result = cleanup_due_application_trackers(db, now=NOW)

    assert result.as_dict() == {"selected": 2, "deleted": 1, "skipped": 0, "failed": 1}
    assert db.get(E.ApplicationTracker, first.id) is not None
    assert db.get(E.ApplicationTracker, second.id) is None
    assert "@example.test" not in caplog.text
    assert "Engineer" not in caplog.text


def test_tracker_delete_cascades_snapshots_but_retains_sessions_documents_job_and_lineage(db: Session) -> None:
    user, job, row = tracker(
        db, "graph", status=E.ApplicationStatus.withdrawn, deadline=NOW - timedelta(days=1)
    )
    source_doc = E.GeneratedDocument(
        user_id=user.id, job_id=job.id, type=E.DocumentType.resume, format=E.DocumentFormat.pdf,
        title="Source", content={}, quality={}, source_profile_snapshot={}, job_snapshot={},
    )
    db.add(source_doc)
    db.flush()
    child_doc = E.GeneratedDocument(
        user_id=user.id, job_id=job.id, type=E.DocumentType.resume, format=E.DocumentFormat.pdf,
        title="Child", content={}, quality={}, source_profile_snapshot={}, job_snapshot={},
        source_document_id=source_doc.id,
    )
    db.add(child_doc)
    db.flush()
    session = E.ApplicationSession(
        user_id=user.id, job_id=job.id, status=E.ApplicationSessionStatus.completed,
        source_url="https://example.test/apply", tracker_id=row.id,
        tailored_resume_id=child_doc.id, profile_snapshot={}, job_snapshot={}, generated_answers=[],
        application_overrides={}, unresolved_questions=[], warnings=[],
    )
    db.add(session)
    db.flush()
    snapshots = [
        E.ApplicationSnapshot(
            application_tracker_id=row.id, user_id=user.id, job_id=job.id,
            source_session_id=100 + attempt, attempt_number=attempt,
            confirmation_source=E.SnapshotConfirmationSource.user_confirmed,
            submission_evidence_metadata={}, job_title=job.title, company_name=job.company,
            resume_document_id=child_doc.id, cover_letter_used=False, answers_snapshot=[], applied_at=NOW,
        )
        for attempt in (1, 2)
    ]
    db.add_all(snapshots)
    db.commit()
    ids = (row.id, session.id, source_doc.id, child_doc.id, job.id)

    assert cleanup_due_application_trackers(db, now=NOW).deleted == 1
    db.expire_all()
    assert db.get(E.ApplicationTracker, ids[0]) is None
    assert db.get(E.ApplicationSession, ids[1]).tracker_id is None
    assert db.get(E.GeneratedDocument, ids[2]) is not None
    assert db.get(E.GeneratedDocument, ids[3]).source_document_id == ids[2]
    assert db.get(E.JobPosting, ids[4]) is not None
    assert list(db.scalars(select(E.ApplicationSnapshot))) == []


def test_stale_confirmation_cannot_resurrect_retention_deleted_history(db: Session) -> None:
    user, job, row = tracker(
        db, "stale-confirmation", status=E.ApplicationStatus.rejected,
        deadline=NOW - timedelta(days=1),
    )
    session = E.ApplicationSession(
        user_id=user.id, job_id=job.id, status=E.ApplicationSessionStatus.completed,
        source_url="https://example.test/apply", tracker_id=row.id,
        profile_snapshot={}, job_snapshot={}, generated_answers=[], application_overrides={},
        unresolved_questions=[], warnings=[], completed_at=NOW,
    )
    db.add(session)
    db.commit()
    session_id = session.id

    assert cleanup_due_application_trackers(db, now=NOW).deleted == 1
    db.expire_all()
    retained = db.get(E.ApplicationSession, session_id)
    assert retained is not None and retained.tracker_id is None
    with pytest.raises(SessionError, match="removed by retention cleanup"):
        complete_session(db, retained, confirmed=True, source="extension")
    db.rollback()
    assert db.scalar(select(E.ApplicationTracker).where(
        E.ApplicationTracker.user_id == user.id, E.ApplicationTracker.job_id == job.id
    )) is None
    assert db.scalar(select(E.ApplicationSnapshot.id).where(
        E.ApplicationSnapshot.source_session_id == session_id
    )) is None


def test_task_and_hourly_schedule_are_registered_once() -> None:
    from app.workers.tasks import celery_app

    entries = [
        entry for entry in celery_app.conf.beat_schedule.values()
        if entry["task"] == "cleanup_due_application_trackers"
    ]
    assert len(entries) == 1
    assert "cleanup_due_application_trackers" in celery_app.tasks
    task = celery_app.tasks["cleanup_due_application_trackers"]
    assert task.max_retries == 3
    assert task.acks_late is True


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    event.listen(engine, "connect", lambda conn, _: conn.execute("PRAGMA foreign_keys=ON"))
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(engine)

    def override():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override
    app.state.stage2e_session_factory = factory
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        del app.state.stage2e_session_factory
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_deleted_tracker_and_snapshot_are_absent_from_owner_http_surfaces(client) -> None:
    email = "stage2e-http@mailbox.test-domain.co"
    auth = client.post(
        "/auth/signup", json={"email": email, "password": "password123"}
    ).json()
    headers = {"Authorization": f"Bearer {auth['access_token']}"}
    factory = app.state.stage2e_session_factory
    with factory() as db:
        user = db.scalar(select(E.User).where(E.User.email == email))
        source = E.JobSource(name="stage2e-http", type="api", base_url="https://example.test")
        db.add(source)
        db.flush()
        job = E.JobPosting(
            source_id=source.id, external_id="stage2e-http", title="Engineer", company="Acme",
            application_url="https://example.test/apply", source_url="https://example.test/job",
            description_raw="Engineer", description_clean="Engineer",
            hash_for_deduplication="stage2e-http",
        )
        db.add(job)
        db.flush()
        row = E.ApplicationTracker(
            user_id=user.id, job_id=job.id, status=E.ApplicationStatus.rejected,
            deletion_scheduled_at=NOW - timedelta(days=1),
        )
        db.add(row)
        db.flush()
        session = E.ApplicationSession(
            user_id=user.id, job_id=job.id, status=E.ApplicationSessionStatus.completed,
            source_url="https://example.test/apply", tracker_id=row.id,
            profile_snapshot={}, job_snapshot={}, generated_answers=[], application_overrides={},
            unresolved_questions=[], warnings=[], completed_at=NOW,
        )
        db.add(session)
        db.flush()
        snap = E.ApplicationSnapshot(
            application_tracker_id=row.id, user_id=user.id, job_id=job.id,
            source_session_id=session.id, attempt_number=1,
            confirmation_source=E.SnapshotConfirmationSource.user_confirmed,
            submission_evidence_metadata={}, job_title=job.title, company_name=job.company,
            cover_letter_used=False, answers_snapshot=[], applied_at=NOW,
        )
        db.add(snap)
        db.commit()
        tracker_id, snapshot_id, session_id = row.id, snap.id, session.id
        assert cleanup_due_application_trackers(db, now=NOW).deleted == 1

    listed = client.get("/jobs/tracker/all", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["applications"] == []
    assert client.get(f"/jobs/tracker/{tracker_id}/snapshots", headers=headers).status_code == 404
    assert client.get(
        f"/jobs/tracker/{tracker_id}/snapshots/{snapshot_id}", headers=headers
    ).status_code == 404
    assert client.post(
        f"/application-sessions/{session_id}/confirmation-required", headers=headers
    ).status_code == 409
    assert client.post(
        f"/application-sessions/{session_id}/complete", headers=headers, json={"confirmed": True}
    ).status_code == 422
    assert client.get("/jobs/tracker/all", headers=headers).json()["applications"] == []
