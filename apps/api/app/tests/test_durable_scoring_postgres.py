"""Real independent PostgreSQL sessions; no Redis or paid scoring calls."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from threading import Barrier

import pytest
from sqlalchemy import create_engine, delete, event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.jobs.scoring_intents import CapacityUnavailable, DurableScoring, Limits, StaleGeneration, SyntheticResult
from app.models.entities import JobMatch, JobPosting, ScoringCapacity, ScoringIntent, ScoringJob, User, UserProfile
from app.tests.test_prod_auth_migration import requires_postgres, scratch_database  # noqa: F401

pytestmark = [pytest.mark.migration, requires_postgres]


@pytest.fixture()
def foundation(scratch_database):  # noqa: F811
    engine = create_engine(scratch_database)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    clock = [datetime(2026, 1, 1, tzinfo=UTC)]
    with sessions.begin() as db:
        db.add(ScoringCapacity(id=1))
        for i in (1, 2):
            db.add(User(id=i, email=f"synthetic-{i}@example.test", hashed_password="synthetic"))
        db.flush()
        for i in (1, 2):
            db.add(UserProfile(user_id=i, full_name="Synthetic", target_roles=["Engineer"], skills=["Python"]))
            db.add(
                JobPosting(
                    id=i,
                    external_id=f"synthetic-{i}",
                    source_url="https://example.test/job",
                    hash_for_deduplication=f"synthetic-{i}",
                    title="Engineer",
                    company="Synthetic",
                    posted_at=clock[0],
                    application_url="https://example.test/jobs",
                    description_clean="Python",
                    is_active=True,
                )
            )
    service = DurableScoring(sessions, clock=lambda db: clock[0])
    try:
        yield service, sessions, clock
    finally:
        engine.dispose()


def pair(service, uid=1, jid=1):
    r = service.accept("PAIR_REFRESH", user_id=uid, job_id=jid, actor_user_id=uid)
    token = service.claim_expansion(r.id)
    children = service.expand(r.id, token)
    return r.id, children[0]


def counters(sessions):
    with sessions() as db:
        c = db.get(ScoringCapacity, 1)
        return c.live_intents, c.live_children, c.reserved_units, c.running_pairs


def parallel(function):
    barrier = Barrier(2)

    def run(i):
        barrier.wait()
        return function(i)

    with ThreadPoolExecutor(2) as pool:
        return list(pool.map(run, range(2)))


def test_duplicate_acceptance_uncertain_commit_and_redis_down(foundation, monkeypatch):
    s, sessions, _ = foundation
    import redis

    def forbidden(*args, **kwargs):
        raise AssertionError("Redis must not participate")

    monkeypatch.setattr(redis.Redis, "from_url", forbidden)
    out = parallel(lambda i: s.accept("USER_REFRESH", user_id=1, actor_user_id=1))
    assert out[0].id == out[1].id
    assert sorted(x.existing for x in out) == [False, True]
    assert counters(sessions) == (1, 0, 2, 0)

    class UncertainSession(Session):
        pass

    def uncertain(db):
        raise RuntimeError("simulated reply loss after commit")

    event.listen(UncertainSession, "after_commit", uncertain)
    other = DurableScoring(sessionmaker(sessions.kw["bind"], class_=UncertainSession), clock=s.clock)
    with pytest.raises(RuntimeError, match="reply loss"):
        other.accept("PAIR_REFRESH", user_id=2, job_id=2)
    recovered = s.accept("PAIR_REFRESH", user_id=2, job_id=2)
    assert recovered.existing
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 2


def test_concurrent_claim_and_duplicate_delivery(foundation):
    s, sessions, _ = foundation
    _, jid = pair(s)
    claims = parallel(lambda i: s.claim(jid))
    assert sum(c is not None for c in claims) == 1
    claim = next(c for c in claims if c is not None)
    out = parallel(lambda i: s.complete(claim, SyntheticResult(72)))
    assert sorted(out) == ["STALE_WORKER", "SUCCEEDED"]
    assert counters(sessions) == (0, 0, 0, 0)
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(JobMatch)) == 1
        assert db.get(ScoringJob, jid).status == "SUCCEEDED"


def test_two_workers_distinct_users_and_global_slots(foundation):
    s, sessions, _ = foundation
    _, a = pair(s, 1, 1)
    _, b = pair(s, 2, 2)
    claims = parallel(lambda i: s.claim((a, b)[i]))
    assert all(c is not None for c in claims)
    assert len({c.token for c in claims}) == 2
    assert counters(sessions)[3] == 2


def test_expired_boundary_stale_a_after_b_succeeds(foundation):
    s, sessions, clock = foundation
    _, jid = pair(s)
    a = s.claim(jid)
    clock[0] = a.expires_at  # Exact equality is expired, never still owned.
    assert s.complete(a, SyntheticResult(10)) == "STALE_WORKER"
    assert s.recovery() == (jid,)
    assert s.recover_expired() == 1
    with sessions() as db:
        clock[0] = db.get(ScoringJob, jid).next_attempt_at
    b = s.claim(jid)
    assert a.token != b.token
    assert s.complete(b, SyntheticResult(80)) == "SUCCEEDED"
    assert s.complete(a, SyntheticResult(10)) == "STALE_WORKER"
    assert counters(sessions) == (0, 0, 0, 0)
    with sessions() as db:
        assert db.scalar(select(JobMatch)).fit_score == 80
        assert db.scalar(select(JobMatch)).operation_attempt_count == 2


def test_retry_budget_shared_across_roots_survives_restart(foundation):
    s, sessions, clock = foundation
    _, first = pair(s)
    r = s.accept("USER_REFRESH", user_id=1)
    second = s.expand(r.id, s.claim_expansion(r.id))[0]
    for attempt in range(1, 4):
        claim = s.claim(first)
        assert claim is not None
        state = s.fail(claim, "WORKER_TIMEOUT")
        assert state == ("RETRY_WAIT" if attempt < 3 else "TERMINAL_FAILED")
        if attempt < 3:
            assert s.claim(first) is None
            assert s.claim(second) is None
            with sessions() as db:
                due = db.get(ScoringJob, first).next_attempt_at
            seconds = (due - clock[0]).total_seconds()
            assert (30 <= seconds <= 40) if attempt == 1 else (120 <= seconds <= 130)
            clock[0] = due
        s = DurableScoring(sessions, clock=lambda db: clock[0])
    assert s.claim(second) is None
    with sessions() as db:
        assert db.get(ScoringJob, second).status == "TERMINAL_FAILED"
        assert db.scalar(select(JobMatch)).operation_attempt_count == 3
        assert not db.scalar(select(JobMatch)).recovery_cycle_used


def test_failed_commit_rolls_back_result_state_and_counters(foundation):
    s, sessions, _ = foundation
    _, jid = pair(s)
    claim = s.claim(jid)

    class BrokenSession(Session):
        pass

    def fail(db):
        raise RuntimeError("test transaction failure")

    event.listen(BrokenSession, "before_commit", fail)
    broken = DurableScoring(sessionmaker(sessions.kw["bind"], class_=BrokenSession), clock=s.clock)
    with pytest.raises(RuntimeError):
        broken.complete(claim, SyntheticResult(99))
    with sessions() as db:
        assert db.get(ScoringJob, jid).status == "CLAIMED"
        assert db.scalar(select(JobMatch)).fit_score is None
    assert counters(sessions) == (1, 1, 1, 1)
    assert s.complete(claim, SyntheticResult(66)) == "SUCCEEDED"


@pytest.mark.parametrize("mode", ["cancel", "supersede", "generation", "digest", "token"])
def test_fencing_and_no_double_release(foundation, mode):
    s, sessions, _ = foundation
    root, jid = pair(s)
    claim = s.claim(jid)
    if mode in {"cancel", "supersede"}:
        s.invalidate(root, state="CANCELED" if mode == "cancel" else "SUPERSEDED")
        assert s.invalidate(root, state="CANCELED" if mode == "cancel" else "SUPERSEDED") == 0
    elif mode == "generation":
        s.advance_generation(user_id=1, expected=0)
    elif mode == "digest":
        claim = replace(claim, input_digest="f" * 64)
    else:
        claim = replace(claim, token="forged")
    assert s.complete(claim, SyntheticResult(99)) == "STALE_WORKER"
    assert s.fail(claim, "DB_UNAVAILABLE") == "STALE_WORKER"
    assert all(n >= 0 for n in counters(sessions))


def test_supersede_before_claim_and_generation_cas(foundation):
    s, sessions, _ = foundation
    root, jid = pair(s)

    def advance(i):
        try:
            return s.advance_generation(user_id=1, expected=0)
        except StaleGeneration:
            return "stale"

    assert sorted(parallel(advance), key=str) == [1, "stale"]
    assert s.claim(jid) is None
    assert counters(sessions) == (0, 0, 0, 0)
    with pytest.raises(StaleGeneration):
        s.accept("PAIR_REFRESH", user_id=1, job_id=1, expected_user_generation=0)


def test_capacity_rollback_concurrent_boundary_and_private_status(foundation):
    s, sessions, _ = foundation
    small = DurableScoring(sessions, limits=Limits(units=1), clock=s.clock)

    def accept(i):
        try:
            return small.accept("PAIR_REFRESH", user_id=i + 1, job_id=i + 1).id
        except CapacityUnavailable:
            return None

    assert sum(v is not None for v in parallel(accept)) == 1
    assert counters(sessions) == (1, 0, 1, 0)
    with pytest.raises(CapacityUnavailable):
        small.accept("USER_REFRESH", user_id=1)
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 1
    with pytest.raises(PermissionError):
        s.accept("USER_REFRESH", user_id=2, actor_user_id=1)
    with pytest.raises(PermissionError):
        s.status_for_user(2, actor_user_id=1)
    with pytest.raises(ValueError):
        s.fail(__import__("types").SimpleNamespace(), "raw private exception")


def test_paged_expansion_crash_restart_and_recovery_pagination(foundation):
    s, sessions, clock = foundation
    with sessions.begin() as db:
        db.add(
            JobPosting(
                id=10,
                external_id="synthetic-10",
                source_url="https://example.test/job",
                application_url="https://example.test/apply",
                hash_for_deduplication="synthetic-10",
                title="Engineer",
                company="Synthetic",
                posted_at=clock[0],
                is_active=True,
            )
        )
    r = s.accept("USER_REFRESH", user_id=1)
    token = s.claim_expansion(r.id)
    first = s.expand(r.id, token, batch_size=1)
    assert s.expand(r.id, token, batch_size=1) is None  # replay cannot advance a committed cursor
    s = DurableScoring(sessions, clock=lambda db: clock[0])
    while True:
        token = s.claim_expansion(r.id)
        if token is None:
            break
        s.expand(r.id, token, batch_size=1)
    with sessions() as db:
        root = db.get(ScoringIntent, r.id)
        assert root.cursor_id == 10 and root.expansion_complete
        assert root.remaining_units == 3
        assert db.scalar(select(func.count()).select_from(ScoringJob)) == 3
    a = s.recovery(batch_size=1)
    b = s.recovery(after_id=a[0], batch_size=1)
    assert a == first and b[0] > a[0]
    assert counters(sessions) == (1, 3, 3, 0)


def test_parent_expansion_lease_crash(foundation):
    s, sessions, clock = foundation
    r = s.accept("USER_REFRESH", user_id=1)
    token = s.claim_expansion(r.id)
    clock[0] += timedelta(seconds=90)
    assert s.expand(r.id, token) is None
    assert s.recover_expired() == 1
    clock[0] += timedelta(seconds=30)
    token2 = s.claim_expansion(r.id)
    assert token != token2
    assert len(s.expand(r.id, token2)) == 2


def test_completed_equivalent_reuses_without_compute(foundation):
    s, sessions, _ = foundation
    _, jid = pair(s)
    assert s.complete(s.claim(jid), SyntheticResult(75)) == "SUCCEEDED"
    r = s.accept("USER_REFRESH", user_id=1)
    ids = s.expand(r.id, s.claim_expansion(r.id))
    assert s.claim(ids[0]) is None
    with sessions() as db:
        assert db.get(ScoringJob, ids[0]).outcome == "REUSED_EXISTING"
        assert db.scalar(select(JobMatch).where(JobMatch.job_id == 1)).operation_attempt_count == 1


def test_database_constraints_and_privacy_delete(foundation):
    s, sessions, _ = foundation
    root, jid = pair(s)
    claim = s.claim(jid)
    with pytest.raises(IntegrityError), sessions.begin() as db:
        db.execute(delete(User).where(User.id == 1))  # RESTRICT prevents dangling metadata/counter loss
    with pytest.raises(IntegrityError), sessions.begin() as db:
        db.execute(text("UPDATE scoring_capacity SET reserved_units=-1 WHERE id=1"))
    with pytest.raises(IntegrityError), sessions.begin() as db:
        db.execute(
            text("UPDATE scoring_jobs SET status='SUCCEEDED', lease_token=NULL, lease_expires_at=NULL WHERE id=:id"),
            {"id": jid},
        )
    s.delete_user_work(1)
    assert s.complete(claim, SyntheticResult(88)) == "STALE_WORKER"
    assert counters(sessions) == (0, 0, 0, 0)
    with sessions.begin() as db:
        db.execute(delete(User).where(User.id == 1))
        assert db.scalar(select(func.count()).select_from(ScoringJob).where(ScoringJob.user_id == 1)) == 0
        assert db.scalar(select(func.count()).select_from(ScoringIntent).where(ScoringIntent.user_id == 1)) == 0


def test_database_clock_and_skip_locked_child(foundation):
    s, sessions, _ = foundation
    _, jid = pair(s)
    with sessions() as locked, locked.begin():
        locked.scalar(select(ScoringJob).where(ScoringJob.id == jid).with_for_update())
        assert s.claim(jid) is None
    real_clock = DurableScoring(sessions)
    claim = real_clock.claim(jid)
    assert claim is None  # The January fixture's seven-day deadline has expired.
    assert counters(sessions) == (0, 0, 0, 0)


def test_partial_completion_cancel_and_nonretryable_failure(foundation):
    s, sessions, _ = foundation
    r = s.accept("USER_REFRESH", user_id=1)
    ids = s.expand(r.id, s.claim_expansion(r.id))
    assert s.complete(s.claim(ids[0]), SyntheticResult(70)) == "SUCCEEDED"
    with sessions() as db:
        assert db.get(ScoringIntent, r.id).status == "WAITING"
    assert s.fail(s.claim(ids[1]), "INPUT_MISSING") == "TERMINAL_FAILED"
    assert counters(sessions) == (0, 0, 0, 0)
    with sessions() as db:
        assert db.get(ScoringIntent, r.id).status == "TERMINAL_FAILED"
    fanout = s.accept("JOB_FANOUT", job_id=2)
    children = s.expand(fanout.id, s.claim_expansion(fanout.id))
    assert s.invalidate(fanout.id, batch_size=1) == 1
    assert counters(sessions) == (0, 1, 1, 0)
    assert s.claim(children[1]) is None
    assert counters(sessions) == (0, 0, 0, 0)


def test_daily_duplicate_and_user_live_limits(foundation):
    s, sessions, clock = foundation
    limited = DurableScoring(sessions, clock=s.clock, limits=Limits(daily_roots=1))
    first = limited.accept("PAIR_REFRESH", user_id=1, job_id=1)
    assert limited.accept("PAIR_REFRESH", user_id=1, job_id=1).existing
    limited.invalidate(first.id)
    with pytest.raises(CapacityUnavailable):
        limited.accept("PAIR_REFRESH", user_id=2, job_id=2)
    clock[0] += timedelta(days=1)
    assert not limited.accept("PAIR_REFRESH", user_id=2, job_id=2).existing
    with sessions() as db:
        assert db.get(ScoringCapacity, 1).admitted_roots_today == 1
    # Different selection roots cannot exceed the per-user live-root cap.
    s.accept("USER_REFRESH", user_id=1, days=6)
    s.accept("USER_REFRESH", user_id=1, days=7)
    with pytest.raises(CapacityUnavailable):
        s.accept("USER_REFRESH", user_id=1, days=8)


def test_actual_input_change_and_job_generation_fence(foundation):
    s, sessions, _ = foundation
    _, jid = pair(s)
    claim = s.claim(jid)
    with sessions.begin() as db:
        db.get(JobPosting, 1).work_authorization_notes = "Changed synthetic input"
    assert s.complete(claim, SyntheticResult(90)) == "STALE_WORKER"
    assert s.advance_generation(job_id=1, expected=0) == 1
    assert s.fail(claim, "WORKER_TIMEOUT") == "STALE_WORKER"


def test_incomplete_profile_result_and_no_scorer_calls(foundation, monkeypatch):
    from app.jobs import scoring_service

    def forbidden(*args, **kwargs):
        raise AssertionError("Foundation must not invoke the scorer")

    monkeypatch.setattr(scoring_service, "_compute_match", forbidden)
    s, sessions, _ = foundation
    with sessions.begin() as db:
        profile = db.scalar(select(UserProfile).where(UserProfile.user_id == 1))
        profile.target_roles = []
        profile.skills = []
    _, jid = pair(s)
    claim = s.claim(jid)
    assert s.complete(claim, SyntheticResult(None, profile_incomplete=True)) == "SUCCEEDED"
    with sessions() as db:
        assert db.get(ScoringJob, jid).outcome == "PROFILE_INCOMPLETE"
        assert db.scalar(select(JobMatch)).score_state == "profile_incomplete"


@pytest.mark.parametrize("state", ["CANCELED", "SUPERSEDED"])
def test_terminal_invalidation_races_completion(foundation, state):
    s, sessions, _ = foundation
    root, jid = pair(s)
    claim = s.claim(jid)
    outputs = parallel(lambda i: s.complete(claim, SyntheticResult(72)) if i == 0 else s.invalidate(root, state=state))
    assert outputs[0] in {"SUCCEEDED", "STALE_WORKER"}
    assert counters(sessions) == (0, 0, 0, 0)
    with sessions() as db:
        job = db.get(ScoringJob, jid)
        assert job.status == ("SUCCEEDED" if outputs[0] == "SUCCEEDED" else state)
        assert job.completed_at is not None
        assert job.lease_token is None


def test_claim_commit_failure_does_not_consume_attempt(foundation):
    s, sessions, _ = foundation
    _, jid = pair(s)

    class BrokenClaimSession(Session):
        pass

    def fail(db):
        raise RuntimeError("synthetic claim commit failure")

    event.listen(BrokenClaimSession, "before_commit", fail)
    broken = DurableScoring(sessionmaker(sessions.kw["bind"], class_=BrokenClaimSession), clock=s.clock)
    with pytest.raises(RuntimeError):
        broken.claim(jid)
    with sessions() as db:
        assert db.get(ScoringJob, jid).attempt_count == 0
        assert db.get(ScoringJob, jid).status == "PENDING"
        assert db.scalar(select(func.count()).select_from(JobMatch)) == 0
    assert counters(sessions) == (1, 1, 1, 0)
    assert s.claim(jid) is not None



def test_lease_expiry_during_result_lookup_is_fenced(foundation, monkeypatch):
    s, sessions, clock = foundation
    _, jid = pair(s)
    claim = s.claim(jid)
    original = s._inputs

    def slow_lookup(*args):
        value = original(*args)
        clock[0] = claim.expires_at
        return value

    monkeypatch.setattr(s, "_inputs", slow_lookup)
    assert s.complete(claim, SyntheticResult(99)) == "STALE_WORKER"
    with sessions() as db:
        assert db.scalar(select(JobMatch)).fit_score is None
        assert db.get(ScoringJob, jid).status == "CLAIMED"
    assert counters(sessions) == (1, 1, 1, 1)



def test_lease_expiry_during_retry_lookup_is_fenced(foundation, monkeypatch):
    s, sessions, clock = foundation
    _, jid = pair(s)
    claim = s.claim(jid)
    original = s._match

    def slow_lookup(*args):
        value = original(*args)
        clock[0] = claim.expires_at
        return value

    monkeypatch.setattr(s, "_match", slow_lookup)
    assert s.fail(claim, "WORKER_TIMEOUT") == "STALE_WORKER"
    assert counters(sessions) == (1, 1, 1, 1)
    with sessions() as db:
        assert db.get(ScoringJob, jid).status == "CLAIMED"
