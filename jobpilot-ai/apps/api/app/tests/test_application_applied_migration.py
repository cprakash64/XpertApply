"""Migration 0027 against a POPULATED PostgreSQL database.

The SQLite unit suite cannot see this class of failure at all: SQLAlchemy renders
``Enum`` as VARCHAR + CHECK there, derived from the *Python* enum, so a missing
``ALTER TYPE ... ADD VALUE`` is invisible until production rejects the label.
That is exactly the bug migration 0008 exists to fix, and this test makes the
same mistake impossible for ``withdrawn``.

Everything runs in a throwaway database created and dropped by this module. It
never connects to the developer's or CI's real database, and never runs
``downgrade`` against one.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

pytestmark = pytest.mark.migration

def _reachable(url: str) -> bool:
    engine = None
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 3})
        with engine.connect():
            return True
    except Exception:
        return False
    finally:
        if engine is not None:
            engine.dispose()


def _discover_admin_url() -> str | None:
    """Find a PostgreSQL server this machine can create a scratch database on.

    Set ``MIGRATION_TEST_DATABASE_URL`` to pin one explicitly (what CI should
    do). Otherwise try the compose credentials, then a local server owned by the
    current OS user — a developer machine commonly has BOTH a host PostgreSQL
    and the compose one, with the host install shadowing ``localhost:5432``, so
    testing only the compose URL silently skips the whole file.

    Only the maintenance database ``postgres`` is ever connected to here; the
    application database is never opened, let alone written.
    """
    pinned = os.environ.get("MIGRATION_TEST_DATABASE_URL")
    if pinned:
        return pinned if _reachable(pinned) else None

    user = os.environ.get("USER") or "postgres"
    candidates = [
        "postgresql+psycopg://jobpilot:jobpilot_dev_password@localhost:5432/postgres",
        f"postgresql+psycopg://{user}@localhost:5432/postgres",
        "postgresql+psycopg://postgres@localhost:5432/postgres",
    ]
    return next((url for url in candidates if _reachable(url)), None)


_ADMIN_URL = _discover_admin_url()

requires_postgres = pytest.mark.skipif(
    _ADMIN_URL is None,
    reason=(
        "No reachable PostgreSQL server. Start one (docker compose up postgres) or set "
        "MIGRATION_TEST_DATABASE_URL to run the populated-database migration tests."
    ),
)


@pytest.fixture()
def scratch_database() -> str:
    """A fresh, uniquely-named database, dropped on the way out."""
    name = f"jobpilot_migtest_{uuid.uuid4().hex[:12]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = str(make_url(_ADMIN_URL).set(database=name))
    try:
        yield url
    finally:
        with admin.connect() as conn:
            conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :name AND pid <> pg_backend_pid()"
                ),
                {"name": name},
            )
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


def _alembic_config(url: str):
    """An Alembic config that is deliberately NOT backed by ``alembic.ini``.

    ``alembic/env.py`` calls ``fileConfig(config.config_file_name)`` whenever a
    config file is present, and ``fileConfig`` defaults to
    ``disable_existing_loggers=True`` — which silences every logger the rest of
    the test session has already created. That turned unrelated log-assertion
    tests red purely because this file ran before them. Building the config in
    memory means ``config_file_name`` stays ``None``, so ``env.py`` skips
    logging configuration entirely and no global state is touched.
    """
    from pathlib import Path

    from alembic.config import Config

    api_root = Path(__file__).resolve().parents[2]
    config = Config()
    config.set_main_option("script_location", str(api_root / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    return config


@pytest.fixture(autouse=True)
def _pin_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """``alembic/env.py`` prefers ``DATABASE_URL`` over the config's URL.

    A developer or CI runner with that variable exported would otherwise have
    these migrations run against their REAL database instead of the scratch one.
    Clearing it makes the scratch URL the only possible target; each test then
    sets it to its own scratch database explicitly.
    """
    monkeypatch.delenv("DATABASE_URL", raising=False)


@requires_postgres
def test_migration_upgrades_populated_database(scratch_database: str) -> None:
    from alembic import command

    config = _alembic_config(scratch_database)
    engine = create_engine(scratch_database)

    # 1. Bring the schema to the revision immediately BEFORE this change.
    command.upgrade(config, "0026_people_user_discovery_quota")

    # 2. Populate it the way production is populated: real users, real jobs, and
    #    application records in a mix of statuses — including rows that already
    #    have an applied_at, which the new columns must not disturb.
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO users (id, email, hashed_password) VALUES "
            "(1, 'a@example.test', 'x'), (2, 'b@example.test', 'x')"
        ))
        conn.execute(text(
            "INSERT INTO job_sources (id, name, type, base_url, enabled, supports_api) "
            "VALUES (1, 'Acme', 'greenhouse', 'https://x.test', true, true)"
        ))
        for job_id in (1, 2, 3):
            conn.execute(
                text(
                    "INSERT INTO job_postings "
                    "(id, source_id, external_id, title, company, application_url, source_url, "
                    " description_raw, description_clean, required_skills, preferred_skills, "
                    " responsibilities, raw_json, hash_for_deduplication, is_active) "
                    "VALUES (:id, 1, :ext, 'Backend Engineer', 'Acme', 'https://x.test/a', "
                    "'https://x.test/a', '', '', '[]', '[]', '[]', '{}', :h, true)"
                ),
                {"id": job_id, "ext": f"ext-{job_id}", "h": f"hash-{job_id}"},
            )
        conn.execute(text(
            "INSERT INTO application_tracker "
            "(id, user_id, job_id, status, applied_at, notes) VALUES "
            "(1, 1, 1, 'applied', '2026-01-15 10:00:00+00', 'submitted via greenhouse'), "
            "(2, 1, 2, 'saved', NULL, NULL), "
            "(3, 2, 3, 'interview', '2026-02-20 08:30:00+00', NULL)"
        ))

    # 3. The migration under test, against that populated data.
    command.upgrade(config, "0027_applied_lifecycle")

    with engine.begin() as conn:
        columns = {
            row[0] for row in conn.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'application_tracker'"
            ))
        }
        assert {
            "applied_source", "submission_reference", "opened_at", "last_application_url"
        } <= columns

        # Existing rows survive untouched. New columns read NULL — an honest
        # "provenance unknown" rather than a fabricated one.
        rows = conn.execute(text(
            "SELECT id, status, applied_at, notes, applied_source, submission_reference, "
            "opened_at, last_application_url FROM application_tracker ORDER BY id"
        )).all()
        assert len(rows) == 3
        assert rows[0].status == "applied"
        assert rows[0].applied_at is not None
        assert rows[0].notes == "submitted via greenhouse"
        assert rows[0].applied_source is None
        assert rows[0].submission_reference is None
        assert rows[0].opened_at is None
        assert rows[0].last_application_url is None
        assert rows[1].status == "saved" and rows[1].applied_at is None
        assert rows[2].status == "interview"

        indexes = {
            row[0] for row in conn.execute(text(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'application_tracker'"
            ))
        }
        assert "ix_tracker_user_status" in indexes

        # The enum label the ORM now writes must be accepted by PostgreSQL.
        labels = {
            row[0] for row in conn.execute(text(
                "SELECT unnest(enum_range(NULL::applicationstatus))::text"
            ))
        }
        assert "withdrawn" in labels
        assert "applying" in labels

        # And it must actually be insertable/updatable on a populated table.
        conn.execute(text("UPDATE application_tracker SET status = 'withdrawn' WHERE id = 3"))
        conn.execute(text(
            "UPDATE application_tracker SET applied_source = 'extension_confirmed', "
            "submission_reference = 'GH-1', opened_at = now(), "
            "last_application_url = 'https://x.test/a' WHERE id = 1"
        ))

    engine.dispose()


@requires_postgres
def test_migration_is_reversible_and_rerunnable(scratch_database: str) -> None:
    """Downgrade drops only what 0027 added, and a re-upgrade succeeds — so a
    half-applied rollout can be rolled forward again without manual repair."""
    from alembic import command

    config = _alembic_config(scratch_database)
    engine = create_engine(scratch_database)

    command.upgrade(config, "0027_applied_lifecycle")
    command.downgrade(config, "0026_people_user_discovery_quota")

    with engine.begin() as conn:
        columns = {
            row[0] for row in conn.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'application_tracker'"
            ))
        }
        assert not ({"applied_source", "submission_reference", "opened_at",
                     "last_application_url"} & columns)
        # The pre-existing columns are untouched by the downgrade.
        assert {"id", "user_id", "job_id", "status", "applied_at", "notes"} <= columns

    command.upgrade(config, "0027_applied_lifecycle")
    with engine.begin() as conn:
        columns = {
            row[0] for row in conn.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'application_tracker'"
            ))
        }
        assert "applied_source" in columns
    engine.dispose()


def test_withdrawn_enum_label_is_added_by_a_migration() -> None:
    """Backend-agnostic guard, so this cannot regress even where no PostgreSQL
    server is available to run the migration test above."""
    import pathlib

    versions = pathlib.Path(__file__).resolve().parents[2] / "alembic" / "versions"
    text_all = "\n".join(path.read_text() for path in versions.glob("*.py"))
    assert "ALTER TYPE applicationstatus ADD VALUE IF NOT EXISTS 'withdrawn'" in text_all
