"""Isolated real PostgreSQL producer/runtime contracts; synthetic records only."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.base import Base
from app.jobs.scoring_intents import DurableScoring
from app.models.entities import JobPosting, ScoringCapacity, User, UserProfile
from app.tests.test_prod_auth_migration import requires_postgres, scratch_database  # noqa: F401

pytestmark = [pytest.mark.migration, requires_postgres]


@pytest.fixture
def runtime(scratch_database, monkeypatch):  # noqa: F811
    engine = create_engine(scratch_database)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False, autoflush=False)
    now = datetime.now(UTC)
    with sessions.begin() as db:
        db.add(ScoringCapacity(id=1))
        for i in (1, 2):
            db.add(User(id=i, email=f"synthetic-{i}@example.test", hashed_password="synthetic"))
        db.flush()
        for i in (1, 2):
            db.add(UserProfile(user_id=i, target_roles=["Engineer"], skills=["Python"]))
            db.add(
                JobPosting(
                    id=i,
                    external_id=f"synthetic-{i}",
                    title="Engineer",
                    company="Synthetic",
                    description_clean="Python",
                    required_skills=["Python"],
                    posted_at=now,
                    is_active=True,
                    application_url="https://example.test/apply",
                    source_url="https://example.test/job",
                    hash_for_deduplication=f"synthetic-{i}",
                )
            )
    with engine.begin() as db:
        for table in ("users", "job_postings"):
            db.execute(text("SELECT setval(pg_get_serial_sequence(:table,'id'),2)"), {"table": table})
    monkeypatch.setattr(settings, "durable_scoring_enabled", True)
    try:
        yield DurableScoring(sessions), sessions
    finally:
        engine.dispose()


def test_actual_compute_result_commit_and_stale_replay(runtime):
    from sqlalchemy import select

    from app.jobs.durable_compute import compute
    from app.jobs.durable_runner import validated_result
    from app.jobs.scoring_service import _compute_match, build_profile_view
    from app.models.entities import JobMatch

    durable, sessions = runtime
    receipt = durable.accept("PAIR_REFRESH", user_id=1, job_id=1, actor_user_id=1)
    token = durable.claim_expansion(receipt.id)
    child_ids = durable.expand(receipt.id, token)
    assert len(child_ids) == 1
    claim = durable.claim(child_ids[0])
    payload = durable.load_claim(claim)
    result = validated_result(compute(payload))
    with sessions() as db:
        view, criteria = build_profile_view(db, 1, reference_date=datetime.now(UTC).date())
        legacy = _compute_match(view, db.get(JobPosting, 1), criteria)
    assert result.fit_score == legacy.fit_score
    assert result.reasons == tuple(legacy.match_reasons)
    assert result.gaps == tuple(legacy.missing_skills)
    assert result.risks == tuple(legacy.risk_factors)
    assert result.confidence == legacy.confidence
    assert result.resume_angle == legacy.recommended_resume_angle
    assert durable.complete(claim, result) == "SUCCEEDED"
    assert durable.complete(claim, result) == "STALE_WORKER"
    with sessions() as db:
        match = db.scalar(select(JobMatch).where(JobMatch.user_id == 1, JobMatch.job_id == 1))
        assert match.fit_score == result.fit_score
        assert match.scoring_attempts == 1
        assert match.scoring_job_id == child_ids[0]
        assert match.job_content_hash and match.profile_version


def test_relevant_writer_fences_claim_and_recovers_new_generation(runtime):
    from sqlalchemy import select

    from app.jobs.durable_producer import begin_user_update, finish_user_update
    from app.jobs.scoring_intents import SyntheticResult
    from app.models.entities import ScoringJob

    durable, sessions = runtime
    old = durable.accept("USER_REFRESH", user_id=1, actor_user_id=1)
    token = durable.claim_expansion(old.id)
    ids = durable.expand(old.id, token)
    claim = durable.claim(ids[0])
    with sessions.begin() as db:
        update = begin_user_update(db, 1)
        profile = db.scalar(select(UserProfile).where(UserProfile.user_id == 1))
        profile.skills = ["Rust"]
        new = finish_user_update(update)
    assert new.id != old.id
    assert durable.complete(claim, SyntheticResult(99)) == "STALE_WORKER"
    with sessions() as db:
        assert db.get(ScoringJob, ids[0]).status == "SUPERSEDED"
        cap = db.get(ScoringCapacity, 1)
        assert cap.running_pairs == 0
        assert cap.live_children == 0
        assert cap.live_intents == 1


def test_manual_retention_preserves_current_result_identity_and_budget(runtime):
    from datetime import timedelta

    from sqlalchemy import select

    from app.jobs.scoring_intents import SyntheticResult
    from app.models.entities import JobMatch, ScoringIntent, ScoringJob

    durable, sessions = runtime
    root = durable.accept("PAIR_REFRESH", user_id=1, job_id=1, actor_user_id=1)
    pair = durable.expand(root.id, durable.claim_expansion(root.id))[0]
    assert durable.complete(durable.claim(pair), SyntheticResult(80)) == "SUCCEEDED"
    assert durable.retire_terminal() == 0
    with sessions.begin() as db:
        db.get(ScoringIntent, root.id).completed_at = datetime.now(UTC) - timedelta(days=31)
    assert durable.retire_terminal(batch_size=1) == 0  # One child consumes this call's row budget.
    assert durable.retire_terminal(batch_size=1) == 1
    with sessions() as db:
        assert db.get(ScoringIntent, root.id) is None and db.get(ScoringJob, pair) is None
        match = db.scalar(select(JobMatch).where(JobMatch.user_id == 1, JobMatch.job_id == 1))
        assert match.scoring_job_id is None
        assert match.completed_input_digest and match.current_operation_digest
        assert match.operation_attempt_count == 1 and match.fit_score == 80


def test_oversized_consumed_input_terminalizes_before_materialization(runtime):
    from app.models.entities import ScoringIntent

    durable, sessions = runtime
    with sessions.begin() as db:
        db.get(JobPosting, 1).description_clean = "x" * 262145
    root = durable.accept("PAIR_REFRESH", user_id=1, job_id=1, actor_user_id=1)
    children = durable.expand(root.id, durable.claim_expansion(root.id))
    assert len(children) == 1
    with sessions() as db:
        assert db.get(ScoringIntent, root.id).status == "TERMINAL_FAILED"
        cap = db.get(ScoringCapacity, 1)
        assert (cap.live_intents, cap.live_children, cap.reserved_units) == (0, 0, 0)


def test_invalid_actor_input_does_not_cancel_other_actors_fanout(runtime):
    from app.jobs.scoring_intents import SyntheticResult
    from app.models.entities import ScoringJob

    durable, sessions = runtime
    with sessions.begin() as db:
        db.query(UserProfile).filter(UserProfile.user_id == 1).one().skills = ["x" * 262145]
    root = durable.accept("JOB_FANOUT", job_id=1)
    children = durable.expand(root.id, durable.claim_expansion(root.id))
    assert len(children) == 2
    with sessions() as db:
        assert db.get(ScoringJob, children[0]).status == "TERMINAL_FAILED"
        assert db.get(ScoringJob, children[1]).status == "PENDING"
    assert durable.complete(durable.claim(children[1]), SyntheticResult(80)) == "SUCCEEDED"
    with sessions() as db:
        cap = db.get(ScoringCapacity, 1)
        assert (cap.live_intents, cap.live_children, cap.reserved_units) == (0, 0, 0)


def test_abandoned_ingestion_markers_recover_without_fabricated_success(runtime):
    from datetime import timedelta

    from app.jobs.scheduled_ingestion import recover_abandoned_runs
    from app.models.entities import IngestionRun

    durable, sessions = runtime
    with sessions.begin() as db:
        db.add(
            IngestionRun(
                id=1,
                trigger="scheduled",
                status="running",
                started_at=datetime.now(UTC) - timedelta(hours=2),
                jobs_inserted=0,
            )
        )
        db.add(IngestionRun(id=2, trigger="scheduled", status="running", started_at=datetime.now(UTC)))
    assert recover_abandoned_runs(sessions, batch_size=1) == 1
    assert recover_abandoned_runs(sessions, batch_size=1) == 0
    with sessions() as db:
        old = db.get(IngestionRun, 1)
        assert old.status == "failed" and old.jobs_inserted == 0 and old.scoring_tasks_queued == 0
        assert old.detail["recovery"] == "orphaned_run"
        assert db.get(IngestionRun, 2).status == "running"


def test_actual_job_writer_relevant_and_irrelevant_changes_atomic(runtime):
    from dataclasses import replace

    from sqlalchemy import select

    from app.job_sources.base import NormalizedJob
    from app.jobs.job_ingestion_service import _persist_job
    from app.models.entities import ScoringIntent

    durable, sessions = runtime
    normalized = NormalizedJob(
        external_id="new-synthetic",
        title="Engineer",
        company="Synthetic Board",
        location="Remote",
        remote_type="remote",
        employment_type="full_time",
        seniority_level="mid",
        posted_at=datetime.now(UTC),
        application_url="https://synthetic.test/apply",
        source_url="https://synthetic.test/job",
        description_raw="Python",
        description_clean="Python",
        source="greenhouse",
    )
    with sessions.begin() as db:
        row, new, changed = _persist_job(db, normalized)
        jid = row.id
        assert new and changed and row.scoring_generation == 1
    with sessions.begin() as db:
        row, new, changed = _persist_job(db, replace(normalized, raw={"irrelevant": "synthetic"}))
        assert not new and not changed and row.scoring_generation == 1
    with sessions.begin() as db:
        row, new, changed = _persist_job(db, replace(normalized, description_clean="Python SQL"))
        assert not new and changed and row.scoring_generation == 2
    with sessions() as db:
        roots = db.scalars(select(ScoringIntent).where(ScoringIntent.job_id == jid).order_by(ScoringIntent.id)).all()
        assert len(roots) == 2 and roots[0].status == "SUPERSEDED" and roots[1].status == "PENDING"


def test_scheduled_job_roots_and_outcome_commit_together(runtime, monkeypatch):
    from sqlalchemy import event, func, select

    from app.job_sources.base import NormalizedJob
    from app.jobs import scheduled_ingestion
    from app.models.entities import IngestionRun, ScoringIntent

    durable, sessions = runtime
    job = NormalizedJob(
        external_id="scheduled-synthetic",
        title="Engineer",
        company="Synthetic Scheduled",
        location="Remote",
        remote_type="remote",
        employment_type="full_time",
        seniority_level="mid",
        posted_at=datetime.now(UTC),
        application_url="https://synthetic.test/apply",
        source_url="https://synthetic.test/job",
        description_raw="Python",
        description_clean="Python",
        source="greenhouse",
    )

    async def fetch(*args):
        return [job], [], {"sources_searched": 1, "sources_succeeded": 1, "sources_failed": 0}

    monkeypatch.setattr(scheduled_ingestion, "_fetch_all_with_timeout", fetch)
    monkeypatch.setattr(scheduled_ingestion, "build_adapters", lambda *_: [])
    with sessions() as db:
        commits = []

        def inspect_commit(_db):
            with sessions() as read:
                runs = read.scalars(select(IngestionRun).order_by(IngestionRun.id)).all()
                roots = read.scalar(select(func.count()).select_from(ScoringIntent))
                commits.append(([r.status for r in runs], roots))

        event.listen(db, "after_commit", inspect_commit)
        result = scheduled_ingestion._run_locked(db, trigger="scheduled", days=7, max_companies=None)
    assert result.scoring_tasks_queued == 1
    assert commits == [(["running"], 0), (["succeeded"], 1)]


def test_before_commit_fault_rolls_back_actual_profile_and_intent(runtime):
    from sqlalchemy import event, func, select

    from app.jobs.durable_producer import begin_user_update, finish_user_update
    from app.models.entities import ScoringIntent

    durable, sessions = runtime
    with sessions() as db:
        update = begin_user_update(db, 1)
        db.scalar(select(UserProfile).where(UserProfile.user_id == 1)).skills = ["Rust"]
        finish_user_update(update)

        def fail(_db):
            raise RuntimeError("synthetic before commit failure")

        event.listen(db, "before_commit", fail, once=True)
        with pytest.raises(RuntimeError, match="synthetic"):
            db.commit()
        db.rollback()
    with sessions() as db:
        assert db.get(User, 1).scoring_generation == 0
        assert db.scalar(select(UserProfile).where(UserProfile.user_id == 1)).skills == ["Python"]
        assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 0
        cap = db.get(ScoringCapacity, 1)
        assert (cap.live_intents, cap.live_children, cap.reserved_units) == (0, 0, 0)


def test_full_persisted_legacy_durable_corpus_and_ordering(runtime, monkeypatch):
    from sqlalchemy import select

    from app.jobs.durable_compute import compute
    from app.jobs.durable_runner import validated_result
    from app.jobs.scoring_service import score_jobs_for_user
    from app.models.entities import JobMatch

    durable, sessions = runtime
    cases = [
        ("Engineer", "Remote", "remote", "junior", ["Python"], "Python APIs"),
        ("Senior Engineer", "New York, NY", "onsite", "senior", ["Python", "SQL"], "Lead Python teams"),
        ("Data Scientist", "Remote", "remote", "mid", ["Python", "SQL"], "Machine learning statistics"),
        ("Retail Associate", "Phoenix, AZ", "onsite", None, ["Forklift"], "Stock inventory"),
        ("Engineering Intern", None, "unknown", "intern", ["Rust"], "Systems and Python"),
        ("Engineer", "Toronto, Canada", "hybrid", "mid", [], "No sponsorship available"),
    ]
    with sessions.begin() as db:
        for i, (title, location, remote, seniority, skills, description) in enumerate(cases, 3):
            db.add(
                JobPosting(
                    id=i,
                    external_id=f"corpus-{i}",
                    title=title,
                    company="Synthetic Corpus",
                    location=location,
                    remote_type=remote,
                    seniority_level=seniority,
                    required_skills=skills,
                    description_clean=description,
                    preferred_skills=["Python"],
                    posted_at=datetime.now(UTC),
                    application_url="https://synthetic.test/apply",
                    source_url="https://synthetic.test/job",
                    hash_for_deduplication=f"corpus-{i}",
                    is_active=True,
                )
            )
    monkeypatch.setattr(settings, "durable_scoring_enabled", False)
    with sessions() as db:
        stats = score_jobs_for_user(db, 1, force=True, only_missing=False)
        assert stats.scored == 8
    monkeypatch.setattr(settings, "durable_scoring_enabled", True)
    root = durable.accept("USER_REFRESH", user_id=2, actor_user_id=2)
    children = durable.expand(root.id, durable.claim_expansion(root.id))
    assert len(children) == 8
    for child in children:
        claim = durable.claim(child)
        assert durable.complete(claim, validated_result(compute(durable.load_claim(claim)))) == "SUCCEEDED"
    fields = (
        "fit_score",
        "fit_label",
        "fit_summary",
        "strengths",
        "gaps",
        "risks",
        "recommended_resume_angle",
        "confidence",
        "explanation_source",
        "score_state",
        "score_version",
        "job_content_hash",
        "profile_version",
    )
    with sessions() as db:
        legacy = db.scalars(select(JobMatch).where(JobMatch.user_id == 1).order_by(JobMatch.job_id)).all()
        actual = db.scalars(select(JobMatch).where(JobMatch.user_id == 2).order_by(JobMatch.job_id)).all()
        assert [(row.job_id, tuple(getattr(row, field) for field in fields)) for row in legacy] == [
            (row.job_id, tuple(getattr(row, field) for field in fields)) for row in actual
        ]

        def rank(rows):
            ordered = sorted(rows, key=lambda row: (row.fit_score, row.job_id), reverse=True)
            return [row.job_id for row in ordered]

        assert rank(legacy) == rank(actual)
        assert all(
            row.completed_input_digest and row.scoring_job_id and row.operation_attempt_count == 1 for row in actual
        )
