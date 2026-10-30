# ruff: noqa: E501
"""Automatic, bounded initial fit scoring (finding F2): progress, advance, concurrency, failure, isolation."""

import threading
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.config import settings
from app.db.base import Base
from app.jobs import initial_scoring, scoring_service
from app.jobs.scoring_service import SCORE_VERSION, compute_profile_version, score_jobs_for_user
from app.main import app
from app.models import entities  # noqa: F401
from app.models.entities import (
    ApplicationStatus,
    ApplicationTracker,
    JobMatch,
    JobPosting,
    JobSource,
    User,
    UserProfile,
)
from app.routes import jobs as jobs_routes

NOW = datetime.now(UTC)
TITLES = ["Backend Engineer", "Senior Software Engineer", "Data Engineer", "Product Manager", "Account Executive", "Python Developer"]
LOREM = "Build resilient distributed systems, own services end to end, mentor teammates and ship reliably. " * 3


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    initial_scoring.reset_for_tests()
    monkeypatch.setattr(settings, "scoring_advance_batch_size", 15)
    monkeypatch.setattr(settings, "scoring_advance_time_budget_seconds", 30.0)
    monkeypatch.setattr(settings, "scoring_advance_max_concurrent", 2)
    yield
    initial_scoring.reset_for_tests()


def add_jobs(db: Session, count: int) -> None:
    db.add_all([JobSource(name=f"s{i}", type=t, base_url="https://example.com") for i, t in enumerate(["greenhouse", "ashby"])])
    db.flush()
    for i in range(count):
        days = [0.3, 1, 2, 4, 6, 9, 15, 25][i % 8] + (i % 7) / 10
        db.add(
            JobPosting(
                source_id=1 + i % 2, external_id=f"e{i}", title=f"{TITLES[i % len(TITLES)]} {i}", company=f"Company {i % 11}",
                location=["Remote, United States", "New York, NY", "London, UK"][i % 3], remote_type=["remote", "hybrid", "onsite"][i % 3],
                seniority_level=["junior", "mid", "senior"][i % 3], posted_at=None if i % 13 == 0 else NOW - timedelta(days=days),
                discovered_at=NOW - timedelta(days=days), is_active=True,
                application_url=f"https://boards.greenhouse.io/c{i % 11}/jobs/{i}", source_url=f"https://boards.greenhouse.io/c{i % 11}/jobs/{i}",
                description_raw="<p>" + LOREM * 30 + "</p>", description_clean=LOREM * 6,
                required_skills=["Python", "FastAPI", "PostgreSQL"][: 1 + i % 3], preferred_skills=["Docker"], responsibilities=[LOREM[:60]] * 4,
                raw_json={"content": LOREM * 20}, hash_for_deduplication=f"{i:064d}",
            )
        )
    db.commit()


def add_user(db: Session, email: str, *, scorable: bool = True, skills=None) -> User:
    user = User(email=email, hashed_password="x")
    db.add(user)
    db.flush()
    db.add(
        UserProfile(
            user_id=user.id, full_name="T U", target_roles=["Backend Engineer", "Software Engineer"] if scorable else [],
            target_levels=["Junior", "Mid"], preferred_locations=["United States"], skills=(skills or ["Python", "FastAPI"]) if scorable else [],
            remote_preference="remote", work_authorization="authorized_us", location_country="United States",
        )
    )
    db.commit()
    return user


def listing(db, user, **kw):
    params = dict(sort="best_recent", posted_within_days=30, limit=100)
    params.update(kw)
    return jobs_routes._list_payload(db, user, **params)


def advance(db, user, **kw):
    params = dict(posted_within_days=30, include_unknown_dates=False, include_unknown_location=False, retry_failed=False)
    params.update(kw)
    return jobs_routes.advance_scoring(user=user, db=db, **params)


def drain(db, user, limit=40, **kw):
    for _ in range(limit):
        out = advance(db, user, **kw)
        if out["scoring"]["state"] != "scoring":
            return out
    raise AssertionError("scoring did not converge")


def rows(db, user):
    return {m.job_id: m for m in db.scalars(select(JobMatch).where(JobMatch.user_id == user.id))}


@pytest.fixture()
def world(db):
    add_jobs(db, 90)
    return add_user(db, "a@example.com")


# --------------------------------------------------------------------------- progress and completion
def test_a_new_account_starts_pending_then_scores_automatically_in_bounded_batches(db, world):
    before = listing(db, world)["scoring"]
    assert before["state"] == "scoring" and before["pending"] == before["total"] > 0 and before["scored"] == 0
    first = advance(db, world)
    assert 0 < first["advanced"] <= 15 and first["scoring"]["state"] == "scoring"  # one bounded batch, not everything
    assert first["scoring"]["pending"] == before["pending"] - first["advanced"]
    final = drain(db, world)
    assert final["scoring"]["state"] == "complete" and final["scoring"]["scored"] == before["total"]
    body = listing(db, world)
    assert body["scoring"]["state"] == "complete"
    assert all(job["match"]["score_state"] == "scored" and job["match"]["fit_score"] is not None for job in body["jobs"])


def test_scores_persist_and_equal_the_manual_path(db, world):
    drain(db, world)
    persisted = {job_id: m.fit_score for job_id, m in rows(db, world).items()}
    assert persisted and all(m.score_version == SCORE_VERSION for m in rows(db, world).values())
    score_jobs_for_user(db, world.id, days=30, force=True)  # the old manual path, forced
    manual = {job_id: m.fit_score for job_id, m in rows(db, world).items() if job_id in persisted}
    assert manual == persisted


def test_only_jobs_the_list_can_show_are_scored(db, world):
    drain(db, world)
    shown = {job["id"] for job in listing(db, world, limit=None)["jobs"]}
    assert set(rows(db, world)) == shown and len(shown) < 90  # ineligible and stale jobs were never scored


def test_the_applied_jobs_in_the_tracker_are_not_part_of_progress(db, world):
    before = listing(db, world)["scoring"]["total"]
    first_visible = listing(db, world)["jobs"][0]["id"]
    db.add(ApplicationTracker(user_id=world.id, job_id=first_visible, status=ApplicationStatus.applied))
    db.commit()
    assert listing(db, world)["scoring"]["total"] == before - 1
    drain(db, world)
    assert first_visible not in rows(db, world)


# --------------------------------------------------------------------------- incomplete profile
def test_an_incomplete_profile_gets_an_honest_state_and_no_scores(db):
    add_jobs(db, 40)
    user = add_user(db, "thin@example.com", scorable=False)
    body = listing(db, user)
    assert body["scoring"]["state"] == "profile_incomplete" and body["scoring"]["pending"] == 0
    assert body["jobs"] and all(job["match"]["score_state"] == "profile_incomplete" and job["match"]["fit_score"] is None for job in body["jobs"])
    out = advance(db, user)
    assert out["scoring"]["state"] == "profile_incomplete" and out["advanced"] == 0
    assert db.scalar(select(func.count()).select_from(JobMatch)) == 0  # nothing invented


# --------------------------------------------------------------------------- existing accounts
def statements(db: Session):
    log: list[str] = []

    @event.listens_for(db.get_bind(), "before_cursor_execute")
    def capture(_c, _cur, statement, *_a):
        log.append(statement)

    return log, capture


def test_an_already_scored_account_is_a_noop_with_no_writes(db, world):
    drain(db, world)
    stamps = {job_id: m.scored_at for job_id, m in rows(db, world).items()}
    log, capture = statements(db)
    try:
        out = advance(db, world)
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", capture)
    assert out["advanced"] == 0 and out["scoring"]["state"] == "complete"
    assert not [s for s in log if s.lstrip().upper().startswith(("INSERT", "UPDATE")) and "job_matches" in s]
    db.expire_all()
    assert {job_id: m.scored_at for job_id, m in rows(db, world).items()} == stamps  # nothing was recomputed


def test_missing_scores_are_filled_without_touching_the_valid_ones(db, world):
    drain(db, world)
    existing = rows(db, world)
    gone = list(existing)[:5]
    keep = {job_id: m.scored_at for job_id, m in existing.items() if job_id not in gone}
    for job_id in gone:
        db.delete(existing[job_id])
    db.commit()
    assert listing(db, world)["scoring"]["pending"] == 5
    out = drain(db, world)
    assert out["scoring"]["state"] == "complete"
    db.expire_all()
    now = rows(db, world)
    assert set(gone) <= set(now) and {job_id: now[job_id].scored_at for job_id in keep} == keep


def test_a_row_left_in_the_scoring_state_by_a_crashed_worker_is_recovered(db, world):
    drain(db, world)
    victim = next(iter(rows(db, world).values()))
    victim.score_state = "scoring"
    db.commit()
    assert listing(db, world)["scoring"]["pending"] == 1
    drain(db, world)
    db.expire_all()
    assert rows(db, world)[victim.job_id].score_state == "scored"


def test_a_profile_change_makes_scores_stale_and_they_refresh(db, world):
    drain(db, world)
    old_hash = next(iter(rows(db, world).values())).profile_version
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == world.id))
    profile.skills = ["Python", "FastAPI", "Kubernetes", "Go"]
    db.commit()
    stale = listing(db, world)["scoring"]
    assert stale["state"] == "scoring" and stale["pending"] == stale["total"]
    drain(db, world)
    db.expire_all()
    assert {m.profile_version for m in rows(db, world).values()} == {compute_profile_version(scoring_service.build_profile_view(db, world.id)[0])}
    assert old_hash not in {m.profile_version for m in rows(db, world).values()}


# --------------------------------------------------------------------------- interruption, retry, failure
def test_an_interrupted_run_resumes_without_duplicates(db, world, monkeypatch):
    monkeypatch.setattr(initial_scoring, "CHUNK_SIZE", 5)
    monkeypatch.setattr(settings, "scoring_advance_time_budget_seconds", 0.0)  # stop after the first chunk, as a timeout would
    first = advance(db, world)
    assert first["advanced"] == 5 and first["scoring"]["state"] == "scoring"
    monkeypatch.setattr(settings, "scoring_advance_time_budget_seconds", 30.0)
    drain(db, world)
    counts = db.execute(select(JobMatch.job_id, func.count()).where(JobMatch.user_id == world.id).group_by(JobMatch.job_id)).all()
    assert counts and all(n == 1 for _, n in counts)


def test_failed_pairs_are_retried_then_reported_and_can_be_retried_by_the_user(db, world, monkeypatch):
    drain(db, world)
    victim_id = next(iter(rows(db, world)))
    db.delete(rows(db, world)[victim_id])
    db.commit()
    real = scoring_service._compute_match

    def flaky(profile_view, job, criteria):
        if job.id == victim_id:
            raise RuntimeError("boom")
        return real(profile_view, job, criteria)

    monkeypatch.setattr(scoring_service, "_compute_match", flaky)
    states = [advance(db, world)["scoring"]["state"] for _ in range(initial_scoring.MAX_ATTEMPTS)]
    assert states[:-1] == ["scoring"] * (initial_scoring.MAX_ATTEMPTS - 1)  # retried while attempts remain
    failed = advance(db, world)
    assert states[-1] == "failed" and failed["scoring"]["state"] == "failed" and failed["scoring"]["failed"] == 1
    assert failed["advanced"] == 0 and rows(db, world)[victim_id].scoring_attempts == initial_scoring.MAX_ATTEMPTS  # no endless retries
    assert listing(db, world)["scoring"]["state"] == "failed"
    monkeypatch.setattr(scoring_service, "_compute_match", real)  # the fault is fixed
    assert advance(db, world)["scoring"]["state"] == "failed"  # still not automatic
    healed = advance(db, world, retry_failed=True)
    assert healed["scoring"]["state"] == "complete" and healed["advanced"] == 1
    db.expire_all()
    assert rows(db, world)[victim_id].score_state == "scored"


# --------------------------------------------------------------------------- concurrency
def test_a_second_advance_for_the_same_user_does_nothing(db, world):
    with initial_scoring.advance_slot(world.id) as held:
        assert held
        busy = advance(db, world)
        assert busy["busy"] is True and busy["advanced"] == 0 and busy["retry_after_seconds"] == 2
        assert db.scalar(select(func.count()).select_from(JobMatch)) == 0
    assert advance(db, world)["advanced"] > 0  # released: the next call works


def test_the_process_wide_cap_refuses_extra_users(db):
    with initial_scoring.advance_slot(1) as a, initial_scoring.advance_slot(2) as b, initial_scoring.advance_slot(3) as c:
        assert (a, b, c) == (True, True, False)  # cap is 2
    with initial_scoring.advance_slot(3) as again:
        assert again


def test_many_parallel_initialisations_never_exceed_one_per_user_or_the_cap():
    gate = threading.Lock()
    active: dict[int, int] = {}
    peak_total = peak_user = 0

    def attempt(user_id: int):
        nonlocal peak_total, peak_user
        with initial_scoring.advance_slot(user_id) as granted:
            if not granted:
                return
            with gate:
                active[user_id] = active.get(user_id, 0) + 1
                peak_user = max(peak_user, active[user_id])
                peak_total = max(peak_total, sum(active.values()))
            threading.Event().wait(0.01)
            with gate:
                active[user_id] -= 1

    threads = [threading.Thread(target=attempt, args=(1 + i % 5,)) for i in range(60)]  # 5 users, 12 duplicate events each
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak_user == 1 and peak_total <= settings.scoring_advance_max_concurrent


# --------------------------------------------------------------------------- isolation, ordering, pagination
def test_accounts_are_isolated(db, world):
    other = add_user(db, "b@example.com", skills=["Go", "Kubernetes"])
    drain(db, world)
    assert rows(db, other) == {} and listing(db, other)["scoring"]["state"] == "scoring"
    a_scores = {job_id: m.fit_score for job_id, m in rows(db, world).items()}
    drain(db, other)
    assert {m.user_id for m in db.scalars(select(JobMatch))} == {world.id, other.id}
    db.expire_all()
    assert {job_id: m.fit_score for job_id, m in rows(db, world).items()} == a_scores  # B's run never touched A
    for user in (world, other):
        assert all(job["match"]["fit_score"] == rows(db, user)[job["id"]].fit_score for job in listing(db, user)["jobs"])


def test_search_sorting_and_pagination_after_scoring(db, world):
    drain(db, world)
    everything = listing(db, world, limit=None)["jobs"]
    for sort in ("best_recent", "fit", "newest"):
        seen, cursor = [], None
        while True:
            page = listing(db, world, sort=sort, limit=7, cursor=cursor)
            seen += [job["id"] for job in page["jobs"]]
            if not page["page"]["has_more"]:
                break
            cursor = page["page"]["next_cursor"]
        assert len(seen) == len(set(seen)) == len(everything)
        assert page["scoring"]["state"] == "complete"
    fit_order = [job["match"]["fit_score"] for job in listing(db, world, sort="fit", limit=None)["jobs"]]
    assert fit_order == sorted(fit_order, reverse=True)
    searched = listing(db, world, role="python", limit=None)["jobs"]
    assert searched and all("python" in f"{j['title']} {j['description_clean']} {' '.join(j['required_skills'])}".lower() for j in searched)


# --------------------------------------------------------------------------- cost
def test_advance_scans_light_rows_and_loads_full_rows_only_in_small_chunks(db, world):
    log, capture = statements(db)
    try:
        advance(db, world)
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", capture)
    scan = [s for s in log if "FROM job_postings" in s and "is_active" in s and " IN " not in s]
    assert scan and not any(h in s for s in scan for h in ("description_raw", "raw_json", "responsibilities"))
    full = [s for s in log if "FROM job_postings" in s and " IN " in s]
    assert full and len(full) <= -(-settings.scoring_advance_batch_size // initial_scoring.CHUNK_SIZE)


def test_the_refresh_path_helpers_select_only_what_they_need_and_agree_with_the_old_logic(db, world):
    from app.jobs.job_normalization_service import is_fresh

    log, capture = statements(db)
    try:
        ids = scoring_service._fresh_active_job_ids(db, days=30, include_unknown=False)
        stale = jobs_routes._stale_count(db, 30, False)
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", capture)
    assert not any(h in s for s in log for h in ("description_raw", "raw_json", "responsibilities", "description_clean"))
    every = db.scalars(select(JobPosting).order_by(JobPosting.id)).all()
    assert ids == [j.id for j in every if j.is_active and is_fresh(j.posted_at, 30, include_unknown=False)]
    cutoff = datetime.now(UTC) - timedelta(days=30)
    assert stale == sum(1 for j in every if not jobs_routes._passes_freshness(j.posted_at, cutoff, False))


# --------------------------------------------------------------------------- HTTP
@pytest.fixture()
def client(db):
    def override():
        yield db

    app.dependency_overrides[get_db] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_the_endpoint_requires_authentication_and_works_end_to_end(client, db):
    assert client.post("/jobs/scoring/advance").status_code == 401
    add_jobs(db, 60)
    token = client.post("/auth/signup", json={"email": "http@example.com", "password": "correct-horse-battery"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/jobs/scoring/advance", headers=headers).json()["scoring"]["state"] == "profile_incomplete"
    client.put("/profile", headers=headers, json={"full_name": "H T", "target_roles": ["Backend Engineer"], "target_levels": ["Mid"], "preferred_locations": ["United States"], "remote_preference": "remote", "skills": ["Python"], "location_country": "United States", "work_authorization": "authorized_us"})
    listed = client.get("/jobs", params={"limit": 25, "posted_within_days": 30}, headers=headers).json()
    assert listed["scoring"]["state"] == "scoring"
    for _ in range(30):
        out = client.post("/jobs/scoring/advance", params={"posted_within_days": 30}, headers=headers).json()
        if out["scoring"]["state"] == "complete":
            break
    assert out["scoring"]["state"] == "complete"
    assert client.post("/jobs/scoring/advance", params={"posted_within_days": 999}, headers=headers).status_code == 422
