"""0033->0034 qualification on disposable PostgreSQL, never production."""

import pytest
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.tests.test_prod_auth_migration import _config, requires_postgres, scratch_database  # noqa: F401

pytestmark = [pytest.mark.migration, requires_postgres]


def test_upgrade_preserves_existing_rows_and_empty_downgrade(scratch_database):  # noqa: F811
    cfg = _config(scratch_database)
    command.upgrade(cfg, "0033_prod_auth_identities")
    engine = create_engine(scratch_database)
    with engine.begin() as db:
        db.execute(text("INSERT INTO users(id,email,hashed_password) VALUES(1,'synthetic@example.test','synthetic')"))
        db.execute(
            text(
                "INSERT INTO job_postings(id,external_id,title,company,is_active,application_url,source_url"
                ",description_raw,description_clean,required_skills,preferred_skills,responsibilities,raw_j"
                "son,hash_for_deduplication) VALUES(1,'synthetic-1','Engineer','Synthetic',true,'https://ex"
                "ample.test/apply','https://example.test/job','','','[]','[]','[]','{}','synthetic-1')"
            )
        )
        db.execute(
            text(
                "INSERT INTO job_matches(user_id,job_id,fit_score,fit_summary,score_state,score_version) "
                "VALUES(1,1,73,'legacy synthetic score','scored',2)"
            )
        )
    command.upgrade(cfg, "head")
    command.upgrade(cfg, "head")
    with engine.connect() as db:
        assert db.execute(text("SELECT fit_score,fit_summary,score_state,score_version FROM job_matches")).one() == (
            73,
            "legacy synthetic score",
            "scored",
            2,
        )
        assert db.execute(text("SELECT scoring_generation FROM users")).scalar() == 0
        assert db.execute(text("SELECT count(*) FROM scoring_intents")).scalar() == 0
        assert db.execute(
            text("SELECT convalidated FROM pg_constraint WHERE conname='fk_match_scoring_job'")
        ).scalar() is False
        assert db.execute(text("SELECT count(*) FROM scoring_jobs")).scalar() == 0
        assert db.execute(text("SELECT live_intents,reserved_units FROM scoring_capacity")).one() == (0, 0)
    command.downgrade(cfg, "0033_prod_auth_identities")
    assert "scoring_jobs" not in inspect(engine).get_table_names()
    command.upgrade(cfg, "head")
    engine.dispose()


def test_fresh_head_and_downgrade_refuses_accepted_work(scratch_database):  # noqa: F811
    from sqlalchemy.orm import sessionmaker

    from app.jobs.scoring_intents import DurableScoring
    from app.models.entities import User

    cfg = _config(scratch_database)
    command.upgrade(cfg, "head")
    engine = create_engine(scratch_database)
    sessions = sessionmaker(engine)
    with sessions.begin() as db:
        db.add(User(email="synthetic@example.test", hashed_password="synthetic"))
    DurableScoring(sessions).accept("USER_REFRESH", user_id=1)
    with pytest.raises(RuntimeError, match="preserved"):
        command.downgrade(cfg, "0033_prod_auth_identities")
    with engine.connect() as db:
        assert db.execute(text("SELECT count(*) FROM scoring_intents")).scalar() == 1
        assert db.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0034_durable_scoring"
    engine.dispose()
