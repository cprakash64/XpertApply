"""Authenticated HTTP noninterference and privacy on real PostgreSQL."""

import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.security import create_access_token
from app.db.session import get_db
from app.main import app
from app.models.entities import JobMatch
from app.tests.test_durable_runtime_postgres import runtime  # noqa: F401
from app.tests.test_prod_auth_migration import requires_postgres, scratch_database  # noqa: F401

pytestmark = [pytest.mark.migration, requires_postgres]


@pytest.fixture
def http(runtime):  # noqa: F811
    _service, sessions = runtime

    def get_test_db():
        with sessions() as db:
            yield db

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = get_test_db
    try:
        with TestClient(app) as client:
            yield client, sessions
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous


def auth(uid):
    return {"Authorization": "Bearer " + create_access_token(str(uid))}


@pytest.mark.parametrize("enabled", [False, True])
def test_debug_cross_user_noninterference_in_both_directions(http, monkeypatch, enabled):
    client, sessions = http
    monkeypatch.setattr(settings, "durable_scoring_enabled", enabled)
    initial_a = client.get("/debug/scoring-status", headers=auth(1))
    assert initial_a.status_code == 200
    with sessions.begin() as db:
        db.add(JobMatch(user_id=2, job_id=1, fit_score=None, score_state="pending"))
    assert client.get("/debug/scoring-status", headers=auth(1)).json() == initial_a.json()
    initial_b = client.get("/debug/scoring-status", headers=auth(2)).json()
    assert initial_b["pending_backlog"] == 1
    with sessions.begin() as db:
        db.add(JobMatch(user_id=1, job_id=2, fit_score=75, score_state="scored"))
    assert client.get("/debug/scoring-status", headers=auth(2)).json() == initial_b
    assert client.get("/debug/scoring-status", headers=auth(1)).json()["by_state"]["scored"] == 1
    payload = json.dumps(initial_b)
    for key in ("lease", "digest", "generation", "operation", "capacity", "user_id", "job_id"):
        assert key not in payload


def test_debug_unauthenticated_access_denied(http):
    client, _ = http
    assert client.get("/debug/scoring-status").status_code in (401, 403)


def test_status_empty_pending_ownership_and_bounded_page(http):
    from app.jobs.durable_producer import accept_user
    from app.models.entities import ScoringIntent

    client, sessions = http
    assert client.get("/jobs/scoring-status", headers=auth(1)).json() == {
        "enabled": True,
        "status": "complete",
        "jobs": [],
        "next_cursor": None,
    }
    with sessions.begin() as db:
        receipt = accept_user(db, 2)
    before = client.get("/jobs/scoring-status", headers=auth(1)).json()
    assert before["status"] == "complete"
    assert client.get("/jobs/scoring-status", headers=auth(2)).json()["status"] == "pending"
    foreign = client.get(f"/jobs/scoring-status?intent_id={receipt.id}", headers=auth(1))
    absent = client.get("/jobs/scoring-status?intent_id=999999", headers=auth(1))
    assert foreign.status_code == absent.status_code == 404
    assert foreign.json() == absent.json()
    assert client.get("/jobs/scoring-status?page_size=101", headers=auth(1)).status_code == 422
    assert client.get("/jobs/scoring-status").status_code in (401, 403)
    with sessions() as db:
        assert db.get(ScoringIntent, receipt.id).user_id == 2


def test_actual_profile_producer_atomicity_generation_and_no_legacy(http, monkeypatch):
    from sqlalchemy import func, select

    from app.models.entities import ScoringIntent, User, UserProfile
    from app.routes import profile as profile_routes

    client, sessions = http

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Legacy publication executed")

    monkeypatch.setattr(profile_routes, "_enqueue_profile_rescore", forbidden)
    response = client.patch("/profile", headers=auth(1), json={"skills": ["Python", "SQL"]})
    assert response.status_code == 200, response.text
    assert response.json()["processing"]["status"] == "pending"
    with sessions() as db:
        assert db.get(User, 1).scoring_generation == 1
        assert db.scalar(select(UserProfile).where(UserProfile.user_id == 1)).skills == ["Python", "SQL"]
        assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 1
    unchanged = client.patch("/profile", headers=auth(1), json={"skills": ["Python", "SQL"]})
    assert unchanged.status_code == 200
    irrelevant = client.patch("/profile", headers=auth(1), json={"phone": "+16025550123"})
    assert irrelevant.status_code == 200, irrelevant.text
    with sessions() as db:
        assert db.get(User, 1).scoring_generation == 1
        assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 1


def test_capacity_rejection_rolls_back_actual_profile_mutation(http, monkeypatch):
    from sqlalchemy import select

    from app.models.entities import ScoringCapacity, User, UserProfile

    client, sessions = http
    with sessions.begin() as db:
        db.get(ScoringCapacity, 1).live_intents = 1
    monkeypatch.setattr(settings, "durable_scoring_max_intents", 1)
    response = client.patch("/profile", headers=auth(1), json={"skills": ["Rust"]})
    assert response.status_code == 503, response.text
    with sessions() as db:
        assert db.get(User, 1).scoring_generation == 0
        assert db.scalar(select(UserProfile).where(UserProfile.user_id == 1)).skills == ["Python"]


def test_pair_refresh_accepts_once_without_inline_or_celery(http, monkeypatch):
    from sqlalchemy import func, select

    from app.models.entities import ScoringIntent, ScoringJob
    from app.routes import jobs as job_routes

    client, sessions = http

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Inline/legacy scoring executed")

    monkeypatch.setattr(job_routes, "rematch_user", forbidden)
    first = client.post("/jobs/1/match", headers=auth(1))
    second = client.post("/jobs/1/match", headers=auth(1))
    assert first.status_code == second.status_code == 202
    assert first.json()["processing"]["intent_id"] == second.json()["processing"]["intent_id"]
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 1
        assert db.scalar(select(func.count()).select_from(ScoringJob)) == 0


@pytest.mark.parametrize("state", ["PENDING", "CLAIMED", "RETRY_WAIT", "SUCCEEDED", "TERMINAL_FAILED"])
@pytest.mark.parametrize("enabled", [False, True])
def test_actual_account_deletion_all_states_and_flag_rollback(http, runtime, monkeypatch, state, enabled):  # noqa: F811
    from sqlalchemy import func, select

    from app.jobs.scoring_intents import SyntheticResult
    from app.models.entities import ScoringCapacity, ScoringIntent, ScoringJob, User

    client, sessions = http
    durable, _ = runtime
    root = durable.accept("PAIR_REFRESH", user_id=1, job_id=1, actor_user_id=1)
    child = durable.expand(root.id, durable.claim_expansion(root.id))[0]
    claim = None
    if state != "PENDING":
        claim = durable.claim(child)
    if state == "RETRY_WAIT":
        assert durable.fail(claim, "WORKER_LOST") == state
    elif state == "SUCCEEDED":
        assert durable.complete(claim, SyntheticResult(77)) == state
    elif state == "TERMINAL_FAILED":
        assert durable.fail(claim, "INPUT_INVALID") == state
    monkeypatch.setattr(settings, "durable_scoring_enabled", enabled)
    response = client.delete("/privacy/account", headers=auth(1))
    assert response.status_code == 204, response.text
    if claim is not None:
        assert durable.complete(claim, SyntheticResult(99)) == "STALE_WORKER"
    with sessions() as db:
        assert db.get(User, 1) is None and db.get(User, 2) is not None
        assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 0
        assert db.scalar(select(func.count()).select_from(ScoringJob)) == 0
        cap = db.get(ScoringCapacity, 1)
        assert (cap.live_intents, cap.live_children, cap.reserved_units, cap.running_pairs) == (0, 0, 0, 0)


def test_status_job_export_and_counts_cross_user_matrix(http, runtime):  # noqa: F811
    from app.jobs.scoring_intents import SyntheticResult

    client, _ = http
    durable, _ = runtime
    paths = ("/jobs/scoring-status", "/debug/scoring-status", "/jobs/1", "/privacy/export")
    before = {path: client.get(path, headers=auth(1)).json() for path in paths}
    root = durable.accept("PAIR_REFRESH", user_id=2, job_id=1, actor_user_id=2)
    child = durable.expand(root.id, durable.claim_expansion(root.id))[0]
    claim = durable.claim(child)
    assert durable.complete(claim, SyntheticResult(88)) == "SUCCEEDED"
    for path in paths:
        response = client.get(path, headers=auth(1))
        assert response.status_code == 200, response.text
        assert response.json() == before[path]
    own_export = client.get("/privacy/export", headers=auth(2)).json()
    assert len(own_export["matches"]) == 1
    text = json.dumps(own_export)
    for internal in (
        "lease_token",
        "input_digest",
        "operation_digest",
        "scoring_generation",
        "operation_attempt_count",
        "completed_user_generation",
        "scoring_job_id",
    ):
        assert internal not in text
    for uid in (1, 2):
        for action in ("cancel", "retry"):
            response = client.post(f"/jobs/scoring-status/{root.id}/{action}", headers=auth(uid))
            assert response.status_code == 404


@pytest.mark.parametrize(
    "state,category", [("TERMINAL_FAILED", "INPUT_INVALID"), ("CANCELED", None), ("SUPERSEDED", None)]
)
def test_empty_terminal_status_is_safe(http, runtime, state, category):  # noqa: F811
    client, _ = http
    durable, _ = runtime
    root = durable.accept("USER_REFRESH", user_id=1, actor_user_id=1)
    if state == "TERMINAL_FAILED":
        child = durable.expand(root.id, durable.claim_expansion(root.id))[0]
        durable.fail(durable.claim(child), category)
        # Terminal parent includes remaining children; cancel cleanup is separate.
        with runtime[1].begin() as db:
            from app.models.entities import ScoringIntent

            parent = db.get(ScoringIntent, root.id)
            parent.deadline_at = parent.created_at
        durable.reconcile()
    else:
        durable.invalidate(root.id, state=state)
    response = client.get(f"/jobs/scoring-status?intent_id={root.id}", headers=auth(1))
    assert response.status_code == 200, response.text
    assert (
        response.json()["status"]
        == {"TERMINAL_FAILED": "failed", "CANCELED": "canceled", "SUPERSEDED": "superseded"}[state]
    )


def test_unavailable_database_fails_actual_http_safely_without_acceptance(http, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.routes import profile as profile_routes

    client, _ = http
    unavailable = create_engine(
        "postgresql+psycopg://postgres@127.0.0.1:1/postgres", connect_args={"connect_timeout": 1}
    )
    factory = sessionmaker(unavailable)
    previous = app.dependency_overrides[get_db]

    def unavailable_db():
        with factory() as db:
            yield db

    def forbidden(*args, **kwargs):
        raise AssertionError("Legacy fallback executed")

    monkeypatch.setattr(profile_routes, "_enqueue_profile_rescore", forbidden)
    app.dependency_overrides[get_db] = unavailable_db
    try:
        response = client.patch("/profile", headers=auth(1), json={"skills": ["Rust"]})
        assert response.status_code == 503
        payload = response.json()
        assert payload["error"]["code"] == "ACCEPTANCE_UNCERTAIN"
        assert "accepted" not in json.dumps(payload)
        assert "postgresql" not in json.dumps(payload)
    finally:
        app.dependency_overrides[get_db] = previous
        unavailable.dispose()


def test_actor_daily_admission_returns_429_and_rolls_back_profile(http):
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.models.entities import User, UserProfile

    client, sessions = http
    with sessions.begin() as db:
        actor = db.get(User, 1)
        actor.scoring_admission_day = datetime.now(UTC).date()
        actor.scoring_roots_today = 20
    response = client.patch("/profile", headers=auth(1), json={"skills": ["Rust"]})
    assert response.status_code == 429
    with sessions() as db:
        assert db.get(User, 1).scoring_generation == 0
        assert db.scalar(select(UserProfile).where(UserProfile.user_id == 1)).skills == ["Python"]


def test_profile_response_lost_after_commit_reuses_intent_and_capacity(http, monkeypatch):
    from sqlalchemy import select

    from app.models.entities import ScoringCapacity, ScoringIntent, User
    from app.routes import profile as profile_routes

    client, sessions = http
    original = profile_routes.serialize_profile
    lost = False

    def lose_first_response(profile):
        nonlocal lost
        if not lost:
            lost = True
            raise RuntimeError("synthetic response lost after commit")
        return original(profile)

    monkeypatch.setattr(profile_routes, "serialize_profile", lose_first_response)
    payload = {"skills": ["Python", "SQL"]}
    with pytest.raises(RuntimeError, match="response lost after commit"):
        client.patch("/profile", headers=auth(1), json=payload)
    with sessions() as db:
        intent = db.scalar(select(ScoringIntent))
        assert intent is not None and db.get(User, 1).scoring_generation == 1
        intent_id = intent.id
        capacity = db.get(ScoringCapacity, 1)
        before = (capacity.live_intents, capacity.live_children, capacity.reserved_units)
    retry = client.patch("/profile", headers=auth(1), json=payload)
    assert retry.status_code == 200
    with sessions() as db:
        assert [r.id for r in db.scalars(select(ScoringIntent))] == [intent_id]
        assert db.get(User, 1).scoring_generation == 1
        capacity = db.get(ScoringCapacity, 1)
        assert (capacity.live_intents, capacity.live_children, capacity.reserved_units) == before
