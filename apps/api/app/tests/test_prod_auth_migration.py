"""PostgreSQL qualification for the production-lineage auth migration.

Every test uses a fresh scratch database created on an explicitly supplied
qualification server. No existing application database is opened or modified.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from alembic import command
from alembic.config import Config

pytestmark = pytest.mark.migration

BASE_REVISION = "0032_confirmation_contract"
AUTH_REVISION = "0033_prod_auth_identities"


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


_ADMIN_URL = os.environ.get("MIGRATION_TEST_DATABASE_URL")
requires_postgres = pytest.mark.skipif(
    not _ADMIN_URL or not _reachable(_ADMIN_URL),
    reason="Set MIGRATION_TEST_DATABASE_URL to the isolated PostgreSQL qualification server.",
)


@pytest.fixture()
def scratch_database() -> str:
    name = f"jobpilot_prod_auth_{uuid.uuid4().hex[:12]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(_ADMIN_URL).set(database=name).render_as_string(hide_password=False)
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


def _config(url: str) -> Config:
    api_root = Path(__file__).resolve().parents[2]
    config = Config()
    config.set_main_option("script_location", str(api_root / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    return config


@pytest.fixture(autouse=True)
def _pin_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)


def _seed_confirmation_fixture(engine) -> tuple[list[tuple], list[tuple]]:
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, email, hashed_password) VALUES "
                "(101, 'migration-a@example.test', 'synthetic-hash-a'), "
                "(102, 'migration-b@example.test', 'synthetic-hash-b')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO job_sources (id, name, type, base_url, enabled, supports_api) "
                "VALUES (101, 'Synthetic', 'greenhouse', 'https://example.test', true, true)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO job_postings "
                "(id, source_id, external_id, title, company, application_url, source_url, "
                "description_raw, description_clean, required_skills, preferred_skills, "
                "responsibilities, raw_json, hash_for_deduplication, is_active) VALUES "
                "(101, 101, 'synthetic-101', 'Engineer', 'Synthetic', "
                "'https://example.test/apply', 'https://example.test/job', '', '', '[]', '[]', "
                "'[]', '{}', 'synthetic-job-hash', true)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO application_tracker "
                "(id, user_id, job_id, status, confirmation_required_at, "
                "confirmation_prompt_dismissed_at) VALUES "
                "(101, 101, 101, 'saved', '2026-09-20 10:00:00+00', "
                "'2026-09-20 11:00:00+00')"
            )
        )
        users = conn.execute(
            text("SELECT id, hashed_password FROM users ORDER BY id")
        ).all()
        confirmations = conn.execute(
            text(
                "SELECT id, confirmation_required_at, confirmation_prompt_dismissed_at "
                "FROM application_tracker ORDER BY id"
            )
        ).all()
    return users, confirmations


def _current(engine) -> str:
    with engine.connect() as conn:
        return conn.scalar(text("SELECT version_num FROM alembic_version"))


@requires_postgres
def test_upgrade_schema_preservation_and_empty_downgrade(scratch_database: str) -> None:
    config = _config(scratch_database)
    engine = create_engine(scratch_database)
    command.upgrade(config, BASE_REVISION)
    assert _current(engine) == BASE_REVISION
    users_before, confirmations_before = _seed_confirmation_fixture(engine)

    command.upgrade(config, AUTH_REVISION)
    assert _current(engine) == AUTH_REVISION

    with engine.connect() as conn:
        users_after = conn.execute(text("SELECT id, hashed_password FROM users ORDER BY id")).all()
        confirmations_after = conn.execute(
            text(
                "SELECT id, confirmation_required_at, confirmation_prompt_dismissed_at "
                "FROM application_tracker ORDER BY id"
            )
        ).all()
        assert users_after == users_before
        assert confirmations_after == confirmations_before
        assert conn.scalar(
            text(
                "SELECT is_nullable = 'YES' FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='users' "
                "AND column_name='hashed_password'"
            )
        )
        columns = {
            row.column_name: (
                row.data_type,
                row.character_maximum_length,
                row.is_nullable,
                row.column_default,
            )
            for row in conn.execute(
                text(
                    "SELECT column_name, data_type, character_maximum_length, "
                    "is_nullable, column_default FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name='external_identities'"
                )
            )
        }
        assert set(columns) == {
            "id", "user_id", "provider", "subject", "provider_email", "email_verified",
            "display_name", "created_at", "updated_at",
        }
        assert columns["id"][:3] == ("integer", None, "NO")
        assert columns["user_id"][:3] == ("integer", None, "NO")
        assert columns["provider"][:3] == ("character varying", 32, "NO")
        assert columns["subject"][:3] == ("character varying", 255, "NO")
        assert columns["provider_email"][:3] == ("character varying", 320, "YES")
        assert columns["email_verified"][:3] == ("boolean", None, "NO")
        assert columns["display_name"][:3] == ("character varying", 200, "YES")
        assert columns["created_at"][:3] == ("timestamp with time zone", None, "NO")
        assert columns["updated_at"][:3] == ("timestamp with time zone", None, "NO")
        assert columns["id"][3].startswith("nextval(")
        assert columns["email_verified"][3] == "false"
        assert columns["created_at"][3] == "now()"
        assert columns["updated_at"][3] == "now()"
        assert conn.scalar(text("SELECT count(*) FROM external_identities")) == 0
        assert conn.scalar(text("SELECT count(*) FROM users")) == len(users_before)
        assert conn.scalar(text("SELECT count(*) FROM users WHERE hashed_password IS NULL")) == 0
        assert conn.scalar(text("SELECT to_regclass('public.application_snapshots')")) is None
        tracker_columns = {
            row.column_name
            for row in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name='application_tracker'"
                )
            )
        }
        assert "deletion_scheduled_at" not in tracker_columns
        assert "deletion_cancelled_at" not in tracker_columns
        assert {"confirmation_required_at", "confirmation_prompt_dismissed_at"} <= tracker_columns
        constraints = {
            row.constraint_name: (row.constraint_type, row.delete_rule)
            for row in conn.execute(
                text(
                    "SELECT tc.constraint_name, tc.constraint_type, rc.delete_rule "
                    "FROM information_schema.table_constraints tc "
                    "LEFT JOIN information_schema.referential_constraints rc "
                    "ON rc.constraint_schema=tc.constraint_schema "
                    "AND rc.constraint_name=tc.constraint_name "
                    "WHERE tc.table_schema='public' AND tc.table_name='external_identities'"
                )
            )
        }
        assert constraints["external_identities_pkey"][0] == "PRIMARY KEY"
        assert constraints["uq_external_identity_provider_subject"][0] == "UNIQUE"
        assert constraints["uq_external_identity_user_provider"][0] == "UNIQUE"
        foreign_keys = [value for value in constraints.values() if value[0] == "FOREIGN KEY"]
        assert foreign_keys == [("FOREIGN KEY", "CASCADE")]
        assert conn.scalar(
            text(
                "SELECT count(*) FROM pg_indexes WHERE schemaname='public' "
                "AND tablename='external_identities' "
                "AND indexname='ix_external_identities_user_id'"
            )
        ) == 1

    command.downgrade(config, BASE_REVISION)
    assert _current(engine) == BASE_REVISION
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT to_regclass('public.external_identities')")) is None
        assert not conn.scalar(
            text(
                "SELECT is_nullable = 'YES' FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='users' "
                "AND column_name='hashed_password'"
            )
        )
        confirmations_after = conn.execute(
            text(
                "SELECT id, confirmation_required_at, confirmation_prompt_dismissed_at "
                "FROM application_tracker ORDER BY id"
            )
        ).all()
        assert confirmations_after == confirmations_before

    command.upgrade(config, AUTH_REVISION)
    assert _current(engine) == AUTH_REVISION
    engine.dispose()


def _assert_refused_without_partial_change(config: Config, engine) -> None:
    with pytest.raises(RuntimeError, match="Refusing production auth downgrade"):
        command.downgrade(config, BASE_REVISION)
    assert _current(engine) == AUTH_REVISION
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT count(*) FROM external_identities")) == 1
        assert conn.scalar(text("SELECT count(*) FROM users")) == 1


@requires_postgres
def test_downgrade_refuses_linked_password_user(scratch_database: str) -> None:
    config = _config(scratch_database)
    engine = create_engine(scratch_database)
    command.upgrade(config, AUTH_REVISION)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, email, hashed_password) "
                "VALUES (201, 'linked@example.test', 'synthetic-hash')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO external_identities "
                "(user_id, provider, subject, provider_email, email_verified) "
                "VALUES (201, 'google', 'linked-subject', 'linked@example.test', true)"
            )
        )
    _assert_refused_without_partial_change(config, engine)
    engine.dispose()


@requires_postgres
def test_downgrade_refuses_provider_only_user(scratch_database: str) -> None:
    config = _config(scratch_database)
    engine = create_engine(scratch_database)
    command.upgrade(config, AUTH_REVISION)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, email, hashed_password) "
                "VALUES (202, 'provider@example.test', NULL)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO external_identities "
                "(user_id, provider, subject, provider_email, email_verified) "
                "VALUES (202, 'google', 'provider-subject', 'provider@example.test', true)"
            )
        )
    _assert_refused_without_partial_change(config, engine)
    engine.dispose()


@requires_postgres
def test_uniqueness_and_user_delete_cascade(scratch_database: str) -> None:
    config = _config(scratch_database)
    engine = create_engine(scratch_database)
    command.upgrade(config, AUTH_REVISION)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, email, hashed_password) VALUES "
                "(301, 'unique-a@example.test', 'hash-a'), "
                "(302, 'unique-b@example.test', 'hash-b'), "
                "(303, 'unique-c@example.test', 'hash-c')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO external_identities (user_id, provider, subject, email_verified) "
                "VALUES (301, 'google', 'subject-a', true), "
                "(302, 'google', 'subject-b', true)"
            )
        )

    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO external_identities "
                    "(user_id, provider, subject, email_verified) "
                    "VALUES (303, 'google', 'subject-a', true)"
                )
            )
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO external_identities "
                    "(user_id, provider, subject, email_verified) "
                    "VALUES (301, 'google', 'subject-c', true)"
                )
            )

    with engine.begin() as conn:
        assert conn.scalar(text("SELECT count(*) FROM external_identities")) == 2
        conn.execute(text("DELETE FROM users WHERE id=301"))
        assert conn.scalar(text("SELECT count(*) FROM external_identities")) == 1
        assert conn.scalar(
            text("SELECT count(*) FROM external_identities WHERE user_id=301")
        ) == 0
    engine.dispose()
