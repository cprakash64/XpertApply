"""GET /jobs ranking and pagination: Best & Recent, Best Fit, Newest, stable keyset paging, authorization."""

from __future__ import annotations

import base64
import json
from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.jobs.ranking import (
    InvalidCursor,
    decode_cursor,
    encode_cursor,
    fit_band,
    page_of,
    rank_cards,
    rank_key,
)
from app.main import app
from app.models import entities as E

NOW = datetime(2026, 7, 20, 15, 0, tzinfo=UTC)


# --------------------------------------------------------------------------- #
# Pure ordering rules
# --------------------------------------------------------------------------- #
def card(job_id: int, fit: float | None, posted: datetime | None) -> dict:
    return {"id": job_id, "posted_at": posted, "match": None if fit is None else {"fit_score": fit}}


def order(cards: list[dict], sort: str) -> list[int]:
    return [c["id"] for _, c in rank_cards(cards, sort)]  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("score", "band"),
    [(100, 3), (80, 3), (79.9, 2), (60, 2), (59.9, 1), (45, 1), (44.9, 0), (0, 0), (None, -1), (float("nan"), -1)],
)
def test_fit_bands_match_the_product_thresholds(score, band) -> None:
    assert fit_band(score) == band


def test_best_recent_puts_a_strong_old_match_above_a_brand_new_weak_one() -> None:
    cards = [
        card(1, 30, NOW),  # posted just now, low fit
        card(2, 92, NOW - timedelta(days=6)),  # a week old, excellent fit
        card(3, 62, NOW - timedelta(hours=1)),  # good fit, very new
    ]
    assert order(cards, "best_recent") == [2, 3, 1]


def test_best_recent_prefers_newer_within_a_band_and_better_fit_within_a_day() -> None:
    cards = [
        card(1, 99, NOW - timedelta(days=3)),
        card(2, 81, NOW - timedelta(days=1)),
        card(3, 85, NOW - timedelta(days=1, hours=2)),  # same day as #2: higher fit goes first
        card(4, 88, NOW - timedelta(days=2)),
    ]
    assert order(cards, "best_recent") == [3, 2, 4, 1]


def test_undated_jobs_sort_after_dated_ones_in_every_mode_and_a_discovery_time_never_counts() -> None:
    undated_hot = card(1, 95, None)  # excellent but no verified posting date
    dated_cold = card(2, 90, NOW - timedelta(days=6))
    assert order([undated_hot, dated_cold], "best_recent") == [2, 1]
    assert order([undated_hot, dated_cold], "newest") == [2, 1]
    assert order([undated_hot, dated_cold], "fit") == [1, 2]  # fit mode is by score; dates only break ties


def test_newest_is_strictly_chronological_and_fit_is_strictly_by_score() -> None:
    cards = [card(i, (i * 37) % 100, NOW - timedelta(minutes=i * 11 % 97)) for i in range(1, 60)]
    newest = [c for _, c in rank_cards(cards, "newest")]
    times = [c["posted_at"] for c in newest]
    assert times == sorted(times, reverse=True)
    best = [c for _, c in rank_cards(cards, "fit")]
    scores = [c["match"]["fit_score"] for c in best]
    assert scores == sorted(scores, reverse=True)


def test_unscored_jobs_rank_last_and_ties_break_on_the_id() -> None:
    cards = [card(5, None, NOW), card(3, 70, NOW), card(2, 70, NOW), card(9, 20, NOW)]
    assert order(cards, "best_recent") == [2, 3, 9, 5]
    assert order(cards, "fit") == [2, 3, 9, 5]


def test_keys_are_a_strict_total_order() -> None:
    cards = [card(i, float(i % 7 * 10), NOW - timedelta(hours=i % 5)) for i in range(1, 200)]
    for sort in ("best_recent", "fit", "newest"):
        keys = [k for k, _ in rank_cards(cards, sort)]  # type: ignore[arg-type]
        assert len(set(keys)) == len(keys)


def test_cursor_round_trip_and_rejection() -> None:
    key = rank_key("best_recent", job_id=7, fit_score=88.5, posted_at=NOW)
    assert decode_cursor(encode_cursor("best_recent", key), "best_recent") == key
    with pytest.raises(InvalidCursor):
        decode_cursor(encode_cursor("best_recent", key), "fit")  # another sort mode
    for bad in [
        "",
        "not-base64!!",
        base64.urlsafe_b64encode(b"{}").decode(),
        base64.urlsafe_b64encode(b'{"s":"fit","k":["x"]}').decode(),
        base64.urlsafe_b64encode(json.dumps({"s": "fit", "k": [1]}).encode()).decode(),
    ]:
        with pytest.raises(InvalidCursor):
            decode_cursor(bad, "fit")


def test_pages_cover_the_ranked_list_exactly_once() -> None:
    cards = [card(i, float(i * 13 % 100), NOW - timedelta(minutes=i * 7)) for i in range(1, 104)]
    for sort in ("best_recent", "fit", "newest"):
        ranked = rank_cards(cards, sort)  # type: ignore[arg-type]
        seen: list[int] = []
        cursor = None
        while True:
            items, paging = page_of(ranked, sort, limit=10, cursor=cursor)  # type: ignore[arg-type]
            seen += [c["id"] for c in items]
            assert paging["total"] == 103
            if not paging["has_more"]:
                assert paging["next_cursor"] is None
                break
            cursor = paging["next_cursor"]
        assert seen == [c["id"] for _, c in ranked]
        assert len(set(seen)) == 103


# --------------------------------------------------------------------------- #
# Through the API
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override() -> Generator[Session, None, None]:
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def signup(client: TestClient, email: str) -> dict[str, str]:
    token = client.post("/auth/signup", json={"email": email, "password": "password123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    resp = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "Chandra Pandey",
            "application_email": email,
            "phone": "602-555-0100",
            "location_city": "Phoenix",
            "location_state": "AZ",
            "location_country": "United States",
            "work_authorization": "authorized_us",
            "target_roles": ["Backend Engineer"],
            "target_levels": ["Junior"],
            "preferred_locations": ["United States"],
            "remote_preference": "remote",
            "skills": ["Python", "FastAPI"],
        },
    )
    assert resp.status_code == 200, resp.text
    return headers


def db_session() -> Session:
    return next(app.dependency_overrides[get_db]())


def user_id(email: str) -> int:
    db = db_session()
    try:
        return db.scalar(select(E.User.id).where(E.User.email == email))
    finally:
        db.close()


def seed(
    n: int,
    *,
    fit: float | None,
    posted: datetime | None,
    emails: tuple[str, ...],
    workplace: str = "remote",
    title: str | None = None,
    discovered: datetime | None = None,
) -> int:
    db = db_session()
    try:
        src = db.scalar(select(E.JobSource).where(E.JobSource.name == "Acme"))
        if src is None:
            src = E.JobSource(name="Acme", type="greenhouse", base_url="x", enabled=True, supports_api=True)
            db.add(src)
            db.flush()
        url = f"https://boards.greenhouse.io/acme/{n}"
        job = E.JobPosting(
            source_id=src.id,
            external_id=f"ext-{n}",
            title=title or f"Backend Engineer {n}",
            company="Acme",
            location="Remote, United States",
            remote_type=workplace,
            posted_at=posted,
            discovered_at=discovered or datetime.now(UTC),
            application_url=url,
            source_url=url,
            description_raw="",
            description_clean="Backend Engineer. Requirements: Python, FastAPI.",
            required_skills=["Python", "FastAPI"],
            hash_for_deduplication=f"h-{n}",
        )
        db.add(job)
        db.flush()
        if fit is not None:
            for email in emails:
                db.add(
                    E.JobMatch(
                        user_id=db.scalar(select(E.User.id).where(E.User.email == email)),
                        job_id=job.id,
                        fit_score=fit,
                        score_state="scored",
                    )
                )
        db.commit()
        return job.id
    finally:
        db.close()


A = "ana@mailbox.test-domain.co"
B = "ben@mailbox.test-domain.co"


def fetch(client: TestClient, headers: dict[str, str], **params) -> dict:
    resp = client.get("/jobs", headers=headers, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def ids(payload: dict) -> list[int]:
    return [j["id"] for j in payload["jobs"]]


def seed_catalog(emails=(A,), count: int = 57) -> None:
    now = datetime.now(UTC)
    for n in range(1, count + 1):
        seed(
            n,
            fit=float((n * 17) % 100),
            posted=now - timedelta(minutes=(n * 53) % 9000),
            emails=emails,
            workplace="remote" if n % 3 else "hybrid",
        )


def test_default_is_best_recent_and_orders_by_band_then_recency(client: TestClient) -> None:
    headers = signup(client, A)
    now = datetime.now(UTC)
    new_weak = seed(1, fit=20, posted=now - timedelta(minutes=5), emails=(A,))
    old_strong = seed(2, fit=95, posted=now - timedelta(days=5), emails=(A,))
    new_good = seed(3, fit=65, posted=now - timedelta(hours=1), emails=(A,))
    older_strong = seed(4, fit=82, posted=now - timedelta(days=6), emails=(A,))
    payload = fetch(client, headers)
    assert payload["page"]["sort"] == "best_recent"
    assert ids(payload) == [old_strong, older_strong, new_good, new_weak]
    assert payload["page"]["total"] == 4 and payload["page"]["limit"] is None and payload["page"]["has_more"] is False


def test_newest_first_is_strictly_chronological_and_best_fit_strictly_by_score(client: TestClient) -> None:
    headers = signup(client, A)
    seed_catalog()
    newest = fetch(client, headers, sort="newest", posted_within_days=30)["jobs"]
    times = [datetime.fromisoformat(j["posted_at"]) for j in newest]
    assert times == sorted(times, reverse=True) and len(newest) == 57
    best = fetch(client, headers, sort="fit", posted_within_days=30)["jobs"]
    scores = [j["match"]["fit_score"] for j in best]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.parametrize("sort", ["best_recent", "fit", "newest"])
def test_pages_have_no_duplicates_or_gaps_and_equal_the_unpaged_list(client: TestClient, sort: str) -> None:
    headers = signup(client, A)
    seed_catalog()
    whole = ids(fetch(client, headers, sort=sort, posted_within_days=30))
    pages: list[int] = []
    cursor = None
    for _ in range(20):
        params = {"sort": sort, "posted_within_days": 30, "limit": 10}
        if cursor:
            params["cursor"] = cursor
        payload = fetch(client, headers, **params)
        assert len(payload["jobs"]) <= 10 and payload["page"]["total"] == 57
        pages += ids(payload)
        cursor = payload["page"]["next_cursor"]
        if not payload["page"]["has_more"]:
            assert cursor is None
            break
    assert pages == whole and len(set(pages)) == 57


def test_filters_apply_to_every_page_and_the_total(client: TestClient) -> None:
    headers = signup(client, A)
    seed_catalog()
    expected = ids(fetch(client, headers, posted_within_days=30, workplace_type="hybrid", min_fit_score=50))
    assert 0 < len(expected) < 57
    got: list[int] = []
    cursor = None
    while True:
        params = {"posted_within_days": 30, "workplace_type": "hybrid", "min_fit_score": 50, "limit": 4}
        if cursor:
            params["cursor"] = cursor
        payload = fetch(client, headers, **params)
        assert payload["page"]["total"] == len(expected)
        for job in payload["jobs"]:
            assert job["workplace_type"] == "hybrid" and job["match"]["fit_score"] >= 50
        got += ids(payload)
        cursor = payload["page"]["next_cursor"]
        if not payload["page"]["has_more"]:
            break
    assert got == expected


def test_a_job_added_between_pages_never_duplicates_or_drops_the_rest(client: TestClient) -> None:
    headers = signup(client, A)
    seed_catalog(count=30)
    first = fetch(client, headers, posted_within_days=30, limit=10)
    page1 = ids(first)
    newcomer = seed(999, fit=99, posted=datetime.now(UTC), emails=(A,))  # lands at the very top of the ranking
    rest: list[int] = []
    cursor = first["page"]["next_cursor"]
    while cursor:
        payload = fetch(client, headers, posted_within_days=30, limit=10, cursor=cursor)
        rest += ids(payload)
        cursor = payload["page"]["next_cursor"]
    assert newcomer not in page1 and newcomer not in rest  # it sorts before the cursor, so this scroll never reshuffles
    assert set(page1).isdisjoint(rest)
    assert len(page1) + len(rest) == 30  # nothing from the original ranking was lost


def test_undated_jobs_are_explicit_and_last_and_discovery_time_is_not_a_posting_date(client: TestClient) -> None:
    headers = signup(client, A)
    now = datetime.now(UTC)
    old_dated = seed(1, fit=90, posted=now - timedelta(days=5), emails=(A,))
    undated = seed(2, fit=95, posted=None, emails=(A,), discovered=now)  # found just now, no verified date
    excluded = ids(fetch(client, headers))
    assert undated not in excluded  # undated is hidden by default, explicitly
    payload = fetch(client, headers, include_unknown_dates=True)
    assert ids(payload) == [old_dated, undated]
    undated_card = payload["jobs"][1]
    assert undated_card["posted_at"] is None and undated_card["discovered_at"] is not None
    assert ids(fetch(client, headers, include_unknown_dates=True, sort="newest")) == [old_dated, undated]


def test_invalid_input_is_rejected_cleanly(client: TestClient) -> None:
    headers = signup(client, A)
    seed_catalog(count=5)
    assert client.get("/jobs", headers=headers, params={"limit": 0}).status_code == 422
    assert client.get("/jobs", headers=headers, params={"limit": 101}).status_code == 422
    assert client.get("/jobs", headers=headers, params={"sort": "random"}).status_code == 422
    bad = client.get("/jobs", headers=headers, params={"limit": 2, "cursor": "garbage"})
    assert bad.status_code == 400 and bad.json()["detail"] == "Invalid cursor."
    cursor = fetch(client, headers, limit=2)["page"]["next_cursor"]
    assert client.get("/jobs", headers=headers, params={"limit": 2, "sort": "fit", "cursor": cursor}).status_code == 400


def test_ranking_and_cursors_are_scoped_to_the_caller(client: TestClient) -> None:
    ha, hb = signup(client, A), signup(client, B)
    now = datetime.now(UTC)
    # The same postings, scored differently for each user.
    for n in range(1, 13):
        job = seed(n, fit=None, posted=now - timedelta(hours=n), emails=())
        db = db_session()
        db.add(E.JobMatch(user_id=user_id(A), job_id=job, fit_score=float(10 + n * 7), score_state="scored"))
        db.add(E.JobMatch(user_id=user_id(B), job_id=job, fit_score=float(100 - n * 7), score_state="scored"))
        db.commit()
        db.close()
    # B has already applied to job 1: it must stay hidden from B only.
    db = db_session()
    first = db.scalar(select(E.JobPosting.id).where(E.JobPosting.external_id == "ext-1"))
    db.add(E.ApplicationTracker(user_id=user_id(B), job_id=first, status=E.ApplicationStatus.applied))
    db.commit()
    db.close()

    a_all, b_all = ids(fetch(client, ha, sort="fit")), ids(fetch(client, hb, sort="fit"))
    assert a_all != b_all  # each user's own scores decide their own order
    assert first in a_all and first not in b_all  # B's tracked job is not visible to B
    a_cursor = fetch(client, ha, sort="fit", limit=3)["page"]["next_cursor"]
    leaked = fetch(client, hb, sort="fit", limit=50, cursor=a_cursor)  # A's cursor, replayed by B
    assert first not in ids(leaked)
    # Everything B receives is B's own ranked list, filtered by key: a suffix of b_all.
    got = ids(leaked)
    assert got == b_all[len(b_all) - len(got) :]
    assert client.get("/jobs", params={"limit": 3}).status_code in (401, 403)  # unauthenticated: nothing
