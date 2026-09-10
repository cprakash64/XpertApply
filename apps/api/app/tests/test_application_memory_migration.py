"""Stage 2A migration checks against a disposable PostgreSQL database."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from alembic import command
from app.tests.test_application_applied_migration import (
    _ADMIN_URL,
    _alembic_config,
    requires_postgres,
)


@pytest.fixture()
def stage2a_database() -> str:
    name = f"jobpilot_stage2a_{uuid.uuid4().hex[:12]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(_ADMIN_URL).set(database=name).render_as_string(hide_password=False)
    try:
        yield url
    finally:
        with admin.connect() as connection:
            connection.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :name AND pid <> pg_backend_pid()"
                ),
                {"name": name},
            )
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


@requires_postgres
def test_application_memory_upgrade_preserves_existing_history(stage2a_database: str) -> None:
    config = _alembic_config(stage2a_database)
    engine = create_engine(stage2a_database)
    command.upgrade(config, "0031_publications")

    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO users (id, email, hashed_password) " "VALUES (1, 'memory@example.test', 'x')")
        )
        connection.execute(
            text(
                "INSERT INTO job_sources "
                "(id, name, type, base_url, enabled, supports_api) "
                "VALUES (1, 'Acme', 'greenhouse', 'https://x.test', true, true)"
            )
        )
        for job_id, status in enumerate(("saved", "applied", "rejected", "withdrawn"), 1):
            connection.execute(
                text(
                    "INSERT INTO job_postings "
                    "(id, source_id, external_id, title, company, application_url, source_url, "
                    "description_raw, description_clean, required_skills, preferred_skills, "
                    "responsibilities, raw_json, hash_for_deduplication, is_active) "
                    "VALUES (:id, 1, :external, 'Engineer', 'Acme', 'https://x.test/a', "
                    "'https://x.test/a', '', '', '[]', '[]', '[]', '{}', :hash, true)"
                ),
                {"id": job_id, "external": f"ext-{job_id}", "hash": f"hash-{job_id}"},
            )
            connection.execute(
                text("INSERT INTO application_tracker (id, user_id, job_id, status) " "VALUES (:id, 1, :id, :status)"),
                {"id": job_id, "status": status},
            )

    command.upgrade(config, "0032_application_memory")
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                "SELECT status, deletion_scheduled_at, deletion_cancelled_at, "
                "confirmation_required_at, confirmation_prompt_dismissed_at "
                "FROM application_tracker ORDER BY id"
            )
        ).all()
        assert [row.status for row in rows] == ["saved", "applied", "rejected", "withdrawn"]
        assert all(all(value is None for value in row[1:]) for row in rows)
        assert connection.scalar(text("SELECT count(*) FROM application_snapshots")) == 0

        inspector = inspect(connection)
        indexes = {index["name"] for index in inspector.get_indexes("application_snapshots")}
        assert {"ix_snapshot_user_created", "ix_snapshot_tracker_applied"} <= indexes
        uniques = {constraint["name"] for constraint in inspector.get_unique_constraints("application_snapshots")}
        assert {"uq_snapshot_tracker_attempt", "uq_snapshot_source_session"} <= uniques
    engine.dispose()


@requires_postgres
def test_application_memory_downgrade_is_reversible(stage2a_database: str) -> None:
    config = _alembic_config(stage2a_database)
    engine = create_engine(stage2a_database)
    command.upgrade(config, "0032_application_memory")
    command.downgrade(config, "0031_publications")

    with engine.begin() as connection:
        inspector = inspect(connection)
        assert "application_snapshots" not in inspector.get_table_names()
        columns = {column["name"] for column in inspector.get_columns("application_tracker")}
        assert (
            not {
                "deletion_scheduled_at",
                "deletion_cancelled_at",
                "confirmation_required_at",
                "confirmation_prompt_dismissed_at",
            }
            & columns
        )

    command.upgrade(config, "0032_application_memory")
    assert "application_snapshots" in inspect(engine).get_table_names()
    engine.dispose()
