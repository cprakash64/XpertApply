"""Additive 0035 from 0034; bounded discovery indexes and reversible empty schema."""

import pytest
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.tests.test_prod_auth_migration import _config, requires_postgres, scratch_database  # noqa: F401

pytestmark = [pytest.mark.migration, requires_postgres]


def test_runtime_indexes_upgrade_and_downgrade_preserve_existing_rows(scratch_database):  # noqa: F811
    cfg = _config(scratch_database)
    command.upgrade(cfg, "0034_durable_scoring")
    engine = create_engine(scratch_database)
    with engine.begin() as db:
        db.execute(text("INSERT INTO users(email,hashed_password) VALUES('synthetic@example.test','synthetic')"))
    command.upgrade(cfg, "head")
    names = {
        index["name"] for table in ("scoring_intents", "scoring_jobs") for index in inspect(engine).get_indexes(table)
    }
    assert {
        "ix_scoring_recovery_active",
        "ix_scoring_user_recent",
        "ix_scoring_user_generation_recent",
        "ix_intent_user_recent",
        "ix_intent_retention",
        "ix_intent_reconcile",
    } <= names
    with engine.connect() as db:
        assert db.execute(text("SELECT count(*) FROM scoring_intents")).scalar() == 0
        assert db.execute(text("SELECT count(*) FROM scoring_jobs")).scalar() == 0
        assert db.execute(text("SELECT scoring_generation FROM users")).scalar() == 0
    command.downgrade(cfg, "0034_durable_scoring")
    assert "ix_scoring_recovery_active" not in {row["name"] for row in inspect(engine).get_indexes("scoring_jobs")}
    with engine.connect() as db:
        assert db.execute(text("SELECT count(*) FROM users")).scalar() == 1
    command.upgrade(cfg, "head")
    engine.dispose()
