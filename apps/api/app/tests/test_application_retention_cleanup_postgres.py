"""Stage 2E locking and FK behavior against a disposable PostgreSQL database."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.applications.retention_cleanup import cleanup_due_application_trackers
from app.models import entities as E
from app.tests.test_application_applied_migration import (
    _alembic_config,
    requires_postgres,
    scratch_database,  # noqa: F401 - imported pytest fixture
)

pytestmark = pytest.mark.migration
NOW = datetime(2026, 9, 11, 12, tzinfo=UTC)


@pytest.fixture()
def pg_engine(scratch_database: str):  # noqa: F811 - pytest fixture parameter
    from alembic import command

    command.upgrade(_alembic_config(scratch_database), "head")
    engine = create_engine(scratch_database, pool_size=5)
    try:
        yield engine
    finally:
        engine.dispose()


def seed(session: Session, suffix: str, *, status=E.ApplicationStatus.rejected):
    user = E.User(email=f"stage2e-{suffix}@example.test", hashed_password="x")
    source = E.JobSource(name=f"stage2e-source-{suffix}", type="api", base_url="https://example.test")
    session.add_all([user, source])
    session.flush()
    job = E.JobPosting(
        source_id=source.id, external_id=f"stage2e-job-{suffix}", title="Engineer", company="Acme",
        application_url="https://example.test/apply", source_url="https://example.test/job",
        description_raw="Engineer", description_clean="Engineer", required_skills=[], preferred_skills=[],
        responsibilities=[], raw_json={}, hash_for_deduplication=f"stage2e-hash-{suffix}",
    )
    session.add(job)
    session.flush()
    tracker = E.ApplicationTracker(
        user_id=user.id, job_id=job.id, status=status,
        deletion_scheduled_at=NOW - timedelta(days=1),
    )
    session.add(tracker)
    session.commit()
    return user.id, job.id, tracker.id


@requires_postgres
def test_concurrent_workers_delete_a_due_tracker_once(pg_engine) -> None:
    with Session(pg_engine) as setup:
        _, _, tracker_id = seed(setup, "workers")
    barrier = Barrier(2)

    def run_worker() -> dict[str, int]:
        with Session(pg_engine) as worker:
            barrier.wait()
            return cleanup_due_application_trackers(worker, now=NOW).as_dict()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run_worker(), range(2)))

    assert sum(result["deleted"] for result in results) == 1
    assert sum(result["failed"] for result in results) == 0
    with Session(pg_engine) as verify:
        assert verify.get(E.ApplicationTracker, tracker_id) is None


@requires_postgres
@pytest.mark.parametrize(
    ("change", "expected_status"),
    [("undo", E.ApplicationStatus.rejected), ("status", E.ApplicationStatus.interview)],
)
def test_committed_lifecycle_change_wins_before_cleanup_revalidation(
    pg_engine, change: str, expected_status: E.ApplicationStatus
) -> None:
    with Session(pg_engine) as setup:
        _, _, tracker_id = seed(setup, f"race-{change}")
    with Session(pg_engine) as lifecycle:
        row = lifecycle.scalar(
            select(E.ApplicationTracker).where(E.ApplicationTracker.id == tracker_id).with_for_update()
        )
        assert row is not None
        if change == "undo":
            row.deletion_scheduled_at = None
            row.deletion_cancelled_at = NOW
        else:
            row.status = E.ApplicationStatus.interview
            row.deletion_scheduled_at = None
            row.deletion_cancelled_at = None
        lifecycle.commit()

    with Session(pg_engine) as cleanup:
        assert cleanup_due_application_trackers(cleanup, now=NOW).deleted == 0
    with Session(pg_engine) as verify:
        retained = verify.get(E.ApplicationTracker, tracker_id)
        assert retained is not None
        assert retained.status == expected_status


@requires_postgres
def test_locked_undo_candidate_is_skipped_by_cleanup_worker(pg_engine) -> None:
    with Session(pg_engine) as setup:
        _, _, tracker_id = seed(setup, "locked-undo")

    with Session(pg_engine) as undo, Session(pg_engine) as cleanup:
        row = undo.scalar(
            select(E.ApplicationTracker).where(E.ApplicationTracker.id == tracker_id).with_for_update()
        )
        assert row is not None
        row.deletion_scheduled_at = None
        row.deletion_cancelled_at = NOW
        result = cleanup_due_application_trackers(cleanup, now=NOW)
        assert result.selected == result.deleted == 0
        undo.commit()

    with Session(pg_engine) as verify:
        assert verify.get(E.ApplicationTracker, tracker_id) is not None


@requires_postgres
def test_postgres_cascade_retains_session_documents_job_and_lineage(pg_engine) -> None:
    with Session(pg_engine) as db:
        user_id, job_id, tracker_id = seed(db, "graph")
        source_doc = E.GeneratedDocument(
            user_id=user_id, job_id=job_id, type=E.DocumentType.resume, format=E.DocumentFormat.pdf,
            title="Source", content={}, quality={}, source_profile_snapshot={}, job_snapshot={},
        )
        db.add(source_doc)
        db.flush()
        child_doc = E.GeneratedDocument(
            user_id=user_id, job_id=job_id, type=E.DocumentType.resume, format=E.DocumentFormat.pdf,
            title="Child", content={}, quality={}, source_profile_snapshot={}, job_snapshot={},
            source_document_id=source_doc.id,
        )
        db.add(child_doc)
        db.flush()
        session = E.ApplicationSession(
            user_id=user_id, job_id=job_id, status=E.ApplicationSessionStatus.completed,
            source_url="https://example.test/apply", tracker_id=tracker_id,
            tailored_resume_id=child_doc.id, profile_snapshot={}, job_snapshot={}, generated_answers=[],
            application_overrides={}, unresolved_questions=[], warnings=[],
        )
        db.add(session)
        db.flush()
        db.add(E.ApplicationSnapshot(
            application_tracker_id=tracker_id, user_id=user_id, job_id=job_id,
            source_session_id=session.id, attempt_number=1,
            confirmation_source=E.SnapshotConfirmationSource.user_confirmed,
            submission_evidence_metadata={}, job_title="Engineer", company_name="Acme",
            resume_document_id=child_doc.id, cover_letter_used=False, answers_snapshot=[], applied_at=NOW,
        ))
        db.commit()
        ids = (session.id, source_doc.id, child_doc.id)

        assert cleanup_due_application_trackers(db, now=NOW).deleted == 1
        db.expire_all()
        assert db.get(E.ApplicationSession, ids[0]).tracker_id is None
        assert db.get(E.GeneratedDocument, ids[1]) is not None
        assert db.get(E.GeneratedDocument, ids[2]).source_document_id == ids[1]
        assert db.get(E.JobPosting, job_id) is not None
        assert db.scalar(select(E.ApplicationSnapshot.id)) is None


@requires_postgres
def test_existing_deadline_index_supports_due_scan(pg_engine) -> None:
    with pg_engine.connect() as conn:
        indexes = {
            row[0] for row in conn.exec_driver_sql(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'application_tracker'"
            )
        }
    assert "ix_application_tracker_deletion_scheduled_at" in indexes
