# ruff: noqa: F401, F811
"""Stage 2B migration checks against disposable PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session

from alembic import command
from app.applications.snapshots import create_snapshot_from_confirmed_session
from app.models import entities as E
from app.tests.test_application_applied_migration import _alembic_config, requires_postgres
from app.tests.test_application_memory_migration import stage2a_database


@requires_postgres
def test_stage2b_provenance_upgrade_and_downgrade(stage2a_database: str) -> None:
    config = _alembic_config(stage2a_database)
    engine = create_engine(stage2a_database)
    command.upgrade(config, "0033_snapshot_provenance")
    with engine.begin() as connection:
        document_columns = {column["name"] for column in inspect(connection).get_columns("generated_documents")}
        snapshot_columns = {column["name"] for column in inspect(connection).get_columns("application_snapshots")}
        assert {"content_hash", "immutable_at", "source_document_id"} <= document_columns
        assert {"resume_used", "resume_provenance", "cover_letter_mode"} <= snapshot_columns

    command.downgrade(config, "0032_application_memory")
    with engine.begin() as connection:
        document_columns = {column["name"] for column in inspect(connection).get_columns("generated_documents")}
        snapshot_columns = {column["name"] for column in inspect(connection).get_columns("application_snapshots")}
        assert not {"content_hash", "immutable_at", "source_document_id"} & document_columns
        assert not {"resume_used", "resume_provenance", "cover_letter_mode"} & snapshot_columns

    command.upgrade(config, "head")
    assert "immutable_at" in {
        column["name"] for column in inspect(engine).get_columns("generated_documents")
    }
    engine.dispose()


@requires_postgres
def test_concurrent_sessions_allocate_unique_attempts(stage2a_database: str) -> None:
    config = _alembic_config(stage2a_database)
    command.upgrade(config, "head")
    engine = create_engine(stage2a_database)
    with Session(engine) as db:
        user = E.User(email="concurrent@example.test", hashed_password="x")
        source = E.JobSource(name="concurrent", type="api", base_url="https://example.test")
        db.add_all([user, source])
        db.flush()
        job = E.JobPosting(
            source_id=source.id, external_id="concurrent-job", title="Engineer", company="Acme",
            application_url="https://example.test/apply", source_url="https://example.test/job",
            description_raw="Engineer", description_clean="Engineer", hash_for_deduplication="concurrent",
        )
        db.add(job)
        db.flush()
        tracker = E.ApplicationTracker(
            user_id=user.id, job_id=job.id, status=E.ApplicationStatus.applied,
            applied_at=datetime.now(UTC),
        )
        db.add(tracker)
        db.flush()
        sessions = [E.ApplicationSession(
            user_id=user.id, job_id=job.id, status=E.ApplicationSessionStatus.opened,
            source_url=job.application_url, job_snapshot={"title": job.title, "company": job.company},
            profile_snapshot={}, tracker_id=tracker.id,
        ) for _ in range(2)]
        db.add_all(sessions)
        db.commit()
        session_ids = [row.id for row in sessions]
        tracker_id = tracker.id

    def confirm(session_id: int) -> int:
        with Session(engine) as db:
            snapshot = create_snapshot_from_confirmed_session(
                db,
                session=db.get(E.ApplicationSession, session_id),
                tracker=db.get(E.ApplicationTracker, tracker_id),
                confirmation_source=E.SnapshotConfirmationSource.user_confirmed,
                evidence_type=None,
                evidence_metadata=None,
            )
            db.commit()
            return snapshot.attempt_number

    with ThreadPoolExecutor(max_workers=2) as pool:
        attempts = sorted(pool.map(confirm, session_ids))
    assert attempts == [1, 2]
    with Session(engine) as db:
        rows = list(db.scalars(select(E.ApplicationSnapshot).order_by(E.ApplicationSnapshot.attempt_number)))
        assert [row.attempt_number for row in rows] == [1, 2]
        assert len({row.source_session_id for row in rows}) == 2
    engine.dispose()
