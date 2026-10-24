"""Tracker snapshots on REAL PostgreSQL (XA-RC-06-B-R1).

Nothing here is evidence from SQLite. Every test builds its own throwaway database on the server named by MIGRATION_TEST_DATABASE_URL
(see test_application_applied_migration.py), migrates it with Alembic, and drops it. No other database is ever opened.

* the migration, from a populated 0035 schema, up, down and up again;
* the constraints, indexes and foreign-key delete rules that the model only describes;
* every test of test_tracker_document_downloads.py, re-run against the Alembic-built PostgreSQL schema;
* concurrent Applied transitions, and a snapshot failure inside a real PostgreSQL savepoint.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.api.deps import get_db
from app.main import app
from app.models import entities as E
from app.tests.test_application_applied_migration import (  # noqa: F401  (fixtures and helpers)
    _ADMIN_URL,
    _alembic_config,
    _pin_database_url,
    requires_postgres,
    scratch_database,
)
from app.tests import test_tracker_document_downloads as downloads
from app.tests.test_tracker_document_downloads import *  # noqa: F401,F403  (re-run the whole download suite on PostgreSQL)
from app.tests.test_application_applied_lifecycle import auth, complete_profile, confirm_applied, db_session, seed_job, user_id_for

pytestmark = [pytest.mark.migration, requires_postgres]


def _migrate(url: str, revision: str, monkeypatch=None) -> None:
    import os

    from alembic import command

    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(_alembic_config(url), revision)
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old


def _downgrade(url: str, revision: str) -> None:
    import os

    from alembic import command

    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.downgrade(_alembic_config(url), revision)
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old


# --------------------------------------------------------------------------- #
# The whole download suite, on an Alembic-built PostgreSQL schema
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def migrated_template() -> Generator[str, None, None]:
    name = f"xa_tpl_{uuid.uuid4().hex[:10]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = str(make_url(_ADMIN_URL).set(database=name))
    try:
        _migrate(url, "head")
        yield name
    finally:
        with admin.connect() as conn:
            conn.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


@pytest.fixture()
def client(migrated_template: str) -> Generator[TestClient, None, None]:  # noqa: F811  (deliberately shadows the SQLite fixture)
    name = f"xa_t_{uuid.uuid4().hex[:10]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}" TEMPLATE "{migrated_template}"'))
    engine = create_engine(str(make_url(_ADMIN_URL).set(database=name)), pool_size=20, max_overflow=20)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_get_db() -> Generator[Session, None, None]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


# --------------------------------------------------------------------------- #
# Migration 0035 -> 0036 -> 0035 on a populated schema
# --------------------------------------------------------------------------- #
def _populate_at_0035(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO users (id, email, hashed_password) VALUES (1, 'a@example.test', 'x'), (2, 'b@example.test', 'x')"))
        conn.execute(text("INSERT INTO job_sources (id, name, type, base_url, enabled, supports_api) VALUES (1, 'Acme', 'greenhouse', 'https://x.test', true, true)"))
        for job_id in range(1, 8):
            conn.execute(text(
                "INSERT INTO job_postings (id, source_id, external_id, title, company, application_url, source_url, description_raw, description_clean, "
                "required_skills, preferred_skills, responsibilities, raw_json, hash_for_deduplication, is_active) "
                "VALUES (:id, 1, :e, 'Backend Engineer', 'Acme', 'https://x.test/a', 'https://x.test/a', '', '', '[]', '[]', '[]', '{}', :h, true)"
            ), {"id": job_id, "e": f"e{job_id}", "h": f"h{job_id}"})
        statuses = ["saved", "ready_to_apply", "applying", "applied", "interview", "offer", "rejected"]
        for i, status in enumerate(statuses, start=1):
            conn.execute(text(
                "INSERT INTO application_tracker (id, user_id, job_id, status, applied_at) VALUES (:i, :u, :i, :s, "
                + ("'2026-03-01 10:00:00+00'" if status not in ("saved", "ready_to_apply", "applying") else "NULL") + ")"
            ), {"i": i, "u": 1 if i % 2 else 2, "s": status})
        conn.execute(text(
            "INSERT INTO generated_documents (id, user_id, job_id, type, format, title, content, quality, source_profile_snapshot, job_snapshot, format_version, prompt_version) "
            "VALUES (1, 1, 1, 'resume', 'json', 'Resume', '{\"summary\": \"S\"}', '{}', '{}', '{}', 'v2', 'v1')"
        ))
        conn.execute(text(
            "INSERT INTO application_sessions (id, user_id, job_id, status, source_url, profile_snapshot, job_snapshot, tailored_resume_id, generated_answers, "
            "application_overrides, unresolved_questions, warnings, launch_token_used) VALUES (1, 1, 1, 'completed', 'https://x.test/a', '{}', '{}', 1, '[]', '{}', '[]', '[]', false)"
        ))
    engine.dispose()


def _counts(url: str) -> dict[str, int]:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            return {t: conn.execute(text(f"SELECT count(*) FROM {t}")).scalar_one()
                    for t in ("users", "job_postings", "application_tracker", "generated_documents", "application_sessions")}
    finally:
        engine.dispose()


def test_upgrade_from_a_populated_0035_schema_keeps_every_row_and_creates_a_correct_table(scratch_database: str) -> None:
    _migrate(scratch_database, "0035_extension_auth")
    _populate_at_0035(scratch_database)
    before = _counts(scratch_database)
    engine = create_engine(scratch_database)
    with engine.connect() as conn:
        before_rows = conn.execute(text("SELECT id, user_id, job_id, status, applied_at FROM application_tracker ORDER BY id")).all()
        assert conn.execute(text("SELECT to_regclass('public.application_document_snapshots')")).scalar_one() is None

    _migrate(scratch_database, "0036_application_doc_snapshots")

    assert _counts(scratch_database) == before                                    # nothing lost, nothing added
    with engine.connect() as conn:
        assert conn.execute(text("SELECT id, user_id, job_id, status, applied_at FROM application_tracker ORDER BY id")).all() == before_rows
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0036_application_doc_snapshots"
        assert conn.execute(text("SELECT count(*) FROM application_document_snapshots")).scalar_one() == 0   # no invented associations
        cols = {r.column_name: r for r in conn.execute(text(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'application_document_snapshots'"))}
        assert set(cols) == {c.name for c in E.ApplicationDocumentSnapshot.__table__.columns}
        assert cols["content"].data_type in ("json", "jsonb") and cols["content"].is_nullable == "NO"
        assert cols["association_basis"].is_nullable == "NO" and "sole_session" in cols["association_basis"].column_default
        assert cols["attached_by_extension"].is_nullable == "NO" and "false" in cols["attached_by_extension"].column_default
        # foreign keys and their delete rules, from the PostgreSQL catalog
        rules = {r.col: r.rule for r in conn.execute(text(
            "SELECT a.attname AS col, c.confdeltype AS rule FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) "
            "WHERE c.contype = 'f' AND c.conrelid = 'application_document_snapshots'::regclass"))}
        assert rules == {"user_id": "c", "tracker_id": "c", "source_document_id": "n"}      # cascade, cascade, set null
        uniques = {r.conname for r in conn.execute(text("SELECT conname FROM pg_constraint WHERE contype = 'u' AND conrelid = 'application_document_snapshots'::regclass"))}
        assert uniques == {"uq_doc_snapshot_tracker_kind"}
        indexes = {r.indexname for r in conn.execute(text("SELECT indexname FROM pg_indexes WHERE tablename = 'application_document_snapshots'"))}
        assert {"ix_application_document_snapshots_user_id", "ix_application_document_snapshots_tracker_id", "application_document_snapshots_pkey"} <= indexes
    engine.dispose()


def test_constraints_hold_on_postgres(scratch_database: str) -> None:
    _migrate(scratch_database, "0036_application_doc_snapshots")
    _populate_at_0035(scratch_database)
    engine = create_engine(scratch_database)
    insert = text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content) VALUES (:u, :t, :k, '{\"summary\": \"S\"}')")
    with engine.begin() as conn:
        conn.execute(insert, {"u": 1, "t": 1, "k": "resume"})
    with pytest.raises(IntegrityError):                                               # one snapshot per application and kind
        with engine.begin() as conn:
            conn.execute(insert, {"u": 1, "t": 1, "k": "resume"})
    with pytest.raises(IntegrityError):                                               # the application must exist
        with engine.begin() as conn:
            conn.execute(insert, {"u": 1, "t": 999, "k": "resume"})
    with pytest.raises(IntegrityError):                                               # and so must the user
        with engine.begin() as conn:
            conn.execute(insert, {"u": 999, "t": 2, "k": "resume"})
    with engine.begin() as conn:                                                      # defaults apply
        row = conn.execute(text("SELECT association_basis, attached_by_extension, created_at IS NOT NULL AS stamped FROM application_document_snapshots")).one()
        assert (row.association_basis, row.attached_by_extension, row.stamped) == ("sole_session", False, True)
    engine.dispose()


def test_delete_rules_cascade_and_set_null_on_postgres(scratch_database: str) -> None:
    _migrate(scratch_database, "0036_application_doc_snapshots")
    _populate_at_0035(scratch_database)
    engine = create_engine(scratch_database)
    with engine.begin() as conn:
        for tracker in (1, 3):
            conn.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content, source_document_id) VALUES (1, :t, 'resume', '{\"s\": 1}', 1)"), {"t": tracker})
    with engine.begin() as conn:                                                      # deleting the source document keeps the archived copy
        conn.execute(text("UPDATE application_sessions SET tailored_resume_id = NULL"))
        conn.execute(text("DELETE FROM generated_documents WHERE id = 1"))
        rows = conn.execute(text("SELECT tracker_id, source_document_id FROM application_document_snapshots ORDER BY tracker_id")).all()
        assert [(r.tracker_id, r.source_document_id) for r in rows] == [(1, None), (3, None)]
    with engine.begin() as conn:                                                      # deleting an application deletes its copy
        conn.execute(text("DELETE FROM application_tracker WHERE id = 1"))
        assert conn.execute(text("SELECT tracker_id FROM application_document_snapshots")).scalars().all() == [3]
    with engine.begin() as conn:                                                      # deleting the account deletes the rest
        conn.execute(text("DELETE FROM users WHERE id = 1"))
        assert conn.execute(text("SELECT count(*) FROM application_document_snapshots")).scalar_one() == 0
    engine.dispose()


def test_downgrade_on_a_disposable_copy_preserves_other_data_and_roundtrips(scratch_database: str) -> None:
    _migrate(scratch_database, "0036_application_doc_snapshots")
    _populate_at_0035(scratch_database)
    engine = create_engine(scratch_database)
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content) VALUES (1, 1, 'resume', '{\"s\": 1}')"))
    base = _counts(scratch_database)
    engine.dispose()                                                                   # a template copy needs the source to be idle

    name = f"xa_copy_{uuid.uuid4().hex[:10]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:                                                      # downgrade a COPY, never the source
        conn.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": make_url(scratch_database).database})
        conn.execute(text(f'CREATE DATABASE "{name}" TEMPLATE "{make_url(scratch_database).database}"'))
    copy_url = str(make_url(_ADMIN_URL).set(database=name))
    try:
        _downgrade(copy_url, "0035_extension_auth")
        copy = create_engine(copy_url)
        with copy.connect() as conn:
            assert conn.execute(text("SELECT to_regclass('public.application_document_snapshots')")).scalar_one() is None
            assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0035_extension_auth"
        assert _counts(copy_url) == base                                               # every other table is exactly as it was
        copy.dispose()
        _migrate(copy_url, "0036_application_doc_snapshots")                           # and it can go forward again
        copy = create_engine(copy_url)
        with copy.connect() as conn:
            assert conn.execute(text("SELECT count(*) FROM application_document_snapshots")).scalar_one() == 0   # the archive is the one thing a downgrade discards
        copy.dispose()
    finally:
        with admin.connect() as conn:
            conn.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()
    # the source database was never downgraded
    engine = create_engine(scratch_database)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0036_application_doc_snapshots"
        assert conn.execute(text("SELECT count(*) FROM application_document_snapshots")).scalar_one() == 1
    engine.dispose()


def test_the_full_chain_reaches_0036_as_the_single_head(scratch_database: str) -> None:
    from alembic.script import ScriptDirectory

    _migrate(scratch_database, "head")
    script = ScriptDirectory.from_config(_alembic_config(scratch_database))
    assert script.get_heads() == ["0036_application_doc_snapshots"]
    engine = create_engine(scratch_database)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0036_application_doc_snapshots"
    engine.dispose()


# --------------------------------------------------------------------------- #
# Transactions: concurrency and a failure inside a real savepoint
# --------------------------------------------------------------------------- #
def test_concurrent_applied_transitions_produce_one_application_and_one_snapshot_set(client: TestClient) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    downloads._prepare(client, headers, job_id)
    results: list[int] = []
    errors: list[BaseException] = []
    gate = threading.Barrier(8)

    def worker() -> None:
        try:
            local = TestClient(app)
            gate.wait(timeout=20)
            results.append(confirm_applied(local, headers, job_id).status_code)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors
    assert results == [200] * 8                                                       # no 500 from the race on either unique key
    db = db_session()
    try:
        trackers = db.query(E.ApplicationTracker).all()
        assert len(trackers) == 1 and trackers[0].status == E.ApplicationStatus.applied
        snaps = db.query(E.ApplicationDocumentSnapshot).all()
        assert sorted(s.kind for s in snaps) == ["cover_letter", "resume"]            # exactly one of each, whoever won
    finally:
        db.close()
    entry = downloads._tracker_entry(client, headers, job_id)
    assert entry["documents_availability"] == "frozen"
    assert client.get(f"/jobs/tracker/{entry['id']}/documents/resume", headers=headers).status_code == 200


def test_a_database_error_inside_the_snapshot_savepoint_leaves_applied_committed(client: TestClient, monkeypatch) -> None:
    """A REAL PostgreSQL error (unique violation) inside the savepoint aborts only the savepoint; the confirmation commits."""
    from app.applications import document_association as da

    real = da.freeze_application_documents

    def conflicting(db, tracker, session_id=None):
        db.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content) VALUES (:u, :t, 'resume', '{}')"), {"u": tracker.user_id, "t": tracker.id})
        db.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content) VALUES (:u, :t, 'resume', '{}')"), {"u": tracker.user_id, "t": tracker.id})
        return real(db, tracker, session_id)

    monkeypatch.setattr(da, "freeze_application_documents", conflicting)
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    downloads._prepare(client, headers, job_id)
    assert confirm_applied(client, headers, job_id).status_code == 200
    db = db_session()
    try:
        tracker = db.query(E.ApplicationTracker).one()
        assert tracker.status == E.ApplicationStatus.applied and tracker.applied_at is not None
        assert db.query(E.ApplicationDocumentSnapshot).count() == 0                   # the savepoint rolled the partial copy back
        assert db.query(E.AuditLog).filter(E.AuditLog.action == "document_snapshot_failed").count() == 1
    finally:
        db.close()
    entry = downloads._tracker_entry(client, headers, job_id)
    assert entry["documents_availability"] == "historical" and entry["documents"]["resume"]["frozen"] is False


def test_account_deletion_removes_snapshots_on_postgres(client: TestClient) -> None:
    headers, job_id, tracker_id = downloads._setup(client)
    assert client.delete("/privacy/account", headers=headers).status_code == 204
    db = db_session()
    try:
        assert db.query(E.ApplicationDocumentSnapshot).count() == 0
        assert db.query(E.ApplicationTracker).count() == 0
    finally:
        db.close()
