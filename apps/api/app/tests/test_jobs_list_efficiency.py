# ruff: noqa: E501  - the reference copy of the old implementation below is verbatim, long lines included.
"""GET /jobs list: the two-phase implementation must return exactly what the old whole-catalogue one did, using far less.

The old implementation (kept verbatim below as the reference) loaded every column of every active job and built a full card
for every eligible one just to return a page. With a few thousand jobs, four concurrent requests exceeded the API container's
768 MB (reproduced locally, see docs/plans/jobs-list-efficiency.md). These tests pin the behaviour and the cost.
"""

import json
import tracemalloc
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models import entities  # noqa: F401
from app.models.entities import JobMatch, JobPosting, JobSource, User, UserProfile
from app.routes import jobs as jobs_routes

LEGACY_SOURCE = r"""
def _list_payload(
    db: Session,
    user: User,
    *,
    role: str | None = None,
    company: str | None = None,
    location: str | None = None,
    workplace_type: str | None = None,
    min_fit_score: float | None = None,
    posted_within_days: int = 7,
    include_unknown: bool = False,
    include_unknown_location: bool = False,
    include_ineligible: bool = False,
    sort: str = DEFAULT_SORT,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict:
    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    experiences = list(db.scalars(select(Experience).where(Experience.user_id == user.id)).all())
    criteria = build_search_criteria(profile, experiences)
    built = build_profile_view(db, user.id)
    profile_view = built[0] if built else None

    cutoff = datetime.now(UTC) - timedelta(days=posted_within_days)
    # Expired jobs (disappeared from the official source past the grace period)
    # are hidden from discovery by default. Saved jobs stay discoverable; jobs
    # whose application has started or finished live only in the tracker.
    jobs = db.scalars(select(JobPosting).where(JobPosting.is_active.is_(True))).all()
    matches = {
        match.job_id: match
        for match in db.scalars(select(JobMatch).where(JobMatch.user_id == user.id)).all()
    }
    sources = {source.id: source for source in db.scalars(select(JobSource)).all()}
    # One indexed query (ix_tracker_user_status) returns every job this user has
    # already dealt with, as a set. The per-job check below is then a hash
    # lookup — no per-row application query, so adding this exclusion does not
    # turn the list into an N+1. The set is scoped to THIS user: the same job
    # stays fully discoverable for everyone else, and the JobPosting row is
    # never deleted or deactivated.
    tracked_job_ids = set(
        db.scalars(
            select(ApplicationTracker.job_id).where(
                (ApplicationTracker.user_id == user.id)
                & (ApplicationTracker.status.in_(tuple(DISCOVERY_HIDDEN_STATUSES)))
            )
        ).all()
    )

    cards: list[dict] = []
    # Debug counts of why fresh jobs were excluded (shown only in dev on the UI).
    counts = {
        "fresh": 0,
        "excluded_location": 0,
        "excluded_seniority": 0,
        "excluded_role": 0,
        "excluded_other": 0,
        "eligible": 0,
    }
    # Counted, then emitted once per request. A metric per filtered row would
    # put one log line per applied job on every Jobs load.
    filtered_as_applied = 0
    for job in jobs:
        if _is_demo_posting(job, sources.get(job.source_id)):
            continue  # never surface fake/demo/placeholder jobs, even if in the DB
        if job.id in tracked_job_ids:
            # Applied (and later-lifecycle) jobs live only in the Tracker. This
            # runs server-side on every list, so the job cannot come back after
            # a refresh, a new session, a re-login, or provider rediscovery —
            # rediscovery updates the JobPosting row, which this filter does not
            # consult.
            filtered_as_applied += 1
            continue
        if not _passes_freshness(job.posted_at, cutoff, include_unknown):
            continue
        counts["fresh"] += 1

        # Hard eligibility gate: runs before any scoring/soft filters.
        eligibility = None
        if profile_view is not None:
            eligibility = evaluate_eligibility(
                profile_view, _job_view(job), include_unknown_location=include_unknown_location
            )
            if not eligibility.eligible:
                _tally_exclusion(counts, eligibility.reason_codes)
                if not include_ineligible:
                    continue
            else:
                counts["eligible"] += 1

        if not _passes_filters(job, role, company, location, workplace_type):
            continue
        match = matches.get(job.id)
        if min_fit_score is not None and (
            match is None or match.fit_score is None or match.fit_score < min_fit_score
        ):
            continue
        cards.append(_serialize_card(job, match, sources.get(job.source_id), eligibility))

    for card in cards:
        card.pop("_posted_key", None)
    try:
        page, paging = page_of(rank_cards(cards, sort), sort, limit=limit, cursor=cursor)  # type: ignore[arg-type]
    except InvalidCursor as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor.") from error

    if filtered_as_applied:
        metric("applied_job_filtered_from_discovery", filtered_as_applied)

    return {
        "profile_complete": _profile_complete(profile),
        "criteria": criteria.model_dump(),
        "counts": counts,
        "profile_filters": _profile_filter_payload(profile),
        "jobs": page,
        "page": paging,
    }
"""


def _legacy_list_payload():
    namespace = dict(vars(jobs_routes))
    exec(LEGACY_SOURCE.replace("def _list_payload(", "def _legacy_list_payload(", 1), namespace)  # noqa: S102 - test-only reference
    return namespace["_legacy_list_payload"]


NOW = datetime.now(UTC)
TITLES = ["Backend Engineer", "Senior Software Engineer", "Data Engineer", "Product Manager", "Account Executive", "Python Developer"]
SKILLS = ["Python", "FastAPI", "PostgreSQL", "Docker", "Kubernetes", "AWS", "React", "Go"]
LOREM = "Build resilient distributed systems, own services end to end, mentor teammates and ship reliably. " * 4


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


def seed(db: Session, count: int, *, heavy: int = 1) -> User:
    user = User(email="list@example.com", hashed_password="x")
    db.add(user)
    db.flush()
    db.add(UserProfile(user_id=user.id, full_name="L T", target_roles=["Backend Engineer", "Software Engineer"],
                       target_levels=["Junior", "Mid"], preferred_locations=["United States"], skills=["Python", "FastAPI"],
                       remote_preference="remote", work_authorization="authorized_us", location_country="United States"))
    db.add_all([JobSource(name=f"s{i}", type=t, base_url="https://example.com") for i, t in enumerate(["greenhouse", "ashby"])])
    db.flush()
    for i in range(count):
        days = [0.3, 1, 2, 4, 6, 9, 15, 25, 40][i % 9] + (i % 7) / 10
        job = JobPosting(
            source_id=1 + i % 2, external_id=f"e{i}", title=f"{TITLES[i % len(TITLES)]} {i}", company=f"Company {i % 11}",
            location=["Remote, United States", "New York, NY", "London, UK"][i % 3], remote_type=["remote", "hybrid", "onsite"][i % 3],
            seniority_level=["junior", "mid", "senior"][i % 3], posted_at=None if i % 13 == 0 else NOW - timedelta(days=days),
            discovered_at=NOW - timedelta(days=days), is_active=True,
            application_url=f"https://boards.greenhouse.io/c{i % 11}/jobs/{i}", source_url=f"https://boards.greenhouse.io/c{i % 11}/jobs/{i}",
            description_raw="<p>" + LOREM * 60 * heavy + "</p>", description_clean=LOREM * 12,
            required_skills=SKILLS[i % 4 : i % 4 + 3], preferred_skills=SKILLS[4:6], responsibilities=[LOREM[:80]] * 6,
            raw_json={"content": LOREM * 30 * heavy}, hash_for_deduplication=f"{i:064d}",
        )
        db.add(job)
    db.flush()
    for job_id in range(1, count + 1):
        if job_id % 5 == 0:
            continue  # unmatched jobs stay unscored
        db.add(JobMatch(user_id=user.id, job_id=job_id, fit_score=None if job_id % 17 == 0 else float(20 + (job_id * 7) % 70),
                        fit_label="Good fit", score_state="scored", strengths=["s"], gaps=["g"], risks=[]))
    db.commit()
    return user


def canonical(payload: dict) -> str:
    # `scoring` (progress, finding F2) is new and has no counterpart in the old implementation; it is tested in test_initial_scoring.py.
    return json.dumps({key: value for key, value in payload.items() if key != "scoring"}, sort_keys=True, default=str)


CASES = [
    {"sort": "best_recent", "posted_within_days": 30},
    {"sort": "fit", "posted_within_days": 60},
    {"sort": "newest", "posted_within_days": 7},
    {"sort": "best_recent", "posted_within_days": 30, "workplace_type": "remote"},
    {"sort": "fit", "posted_within_days": 30, "min_fit_score": 60.0},
    {"sort": "newest", "posted_within_days": 30, "role": "backend"},
    {"sort": "best_recent", "posted_within_days": 30, "company": "Company 3"},
    {"sort": "best_recent", "posted_within_days": 30, "location": "york"},
    {"sort": "best_recent", "posted_within_days": 30, "include_ineligible": True},
    {"sort": "newest", "posted_within_days": 30, "include_unknown": True},
    {"sort": "fit", "posted_within_days": 1},
]


@pytest.mark.parametrize("params", CASES)
@pytest.mark.parametrize("limit", [None, 7, 25])
def test_two_phase_list_equals_the_old_implementation(db, params, limit):
    user = seed(db, 90)
    legacy = _legacy_list_payload()
    assert canonical(jobs_routes._list_payload(db, user, limit=limit, **params)) == canonical(legacy(db, user, limit=limit, **params))


@pytest.mark.parametrize("sort", ["best_recent", "fit", "newest"])
def test_walking_every_page_equals_the_old_walk(db, sort):
    user = seed(db, 90)
    legacy = _legacy_list_payload()

    def walk(fn):
        cursor, seen = None, []
        while True:
            body = fn(db, user, sort=sort, posted_within_days=30, limit=10, cursor=cursor)
            seen += [job["id"] for job in body["jobs"]]
            if not body["page"]["has_more"]:
                return seen, body["page"]["total"]
            cursor = body["page"]["next_cursor"]

    new_ids, new_total = walk(jobs_routes._list_payload)
    old_ids, old_total = walk(legacy)
    assert new_ids == old_ids and new_total == old_total
    assert len(new_ids) == len(set(new_ids)) == new_total  # none repeated, none skipped


def test_tracked_jobs_demo_jobs_and_a_bad_cursor_behave_as_before(db):
    from fastapi import HTTPException

    from app.models.entities import ApplicationStatus, ApplicationTracker

    user = seed(db, 40)
    db.add(ApplicationTracker(user_id=user.id, job_id=3, status=ApplicationStatus.applied))
    db.add(JobPosting(source_id=1, external_id="demo", title="Demo", company="Acme Demo", location="Remote",
                      posted_at=NOW, discovered_at=NOW, is_active=True, application_url="https://example.com/apply",
                      source_url="https://example.com/job", hash_for_deduplication="d" * 64))
    db.commit()
    legacy = _legacy_list_payload()
    new = jobs_routes._list_payload(db, user, posted_within_days=30, limit=100)
    assert canonical(new) == canonical(legacy(db, user, posted_within_days=30, limit=100))
    assert 3 not in [job["id"] for job in new["jobs"]]
    with pytest.raises(HTTPException) as bad:
        jobs_routes._list_payload(db, user, posted_within_days=30, limit=10, cursor="not-a-cursor")
    assert bad.value.status_code == 400


def _statements(db: Session):
    log: list[str] = []

    @event.listens_for(db.get_bind(), "before_cursor_execute")
    def capture(_conn, _cursor, statement, *_args):
        log.append(statement)

    return log, capture


def test_phase_one_never_reads_the_heavy_columns_and_cards_are_built_for_the_page_only(db, monkeypatch):
    user = seed(db, 120)
    log, capture = _statements(db)
    built = []
    real = jobs_routes._serialize_card
    monkeypatch.setattr(jobs_routes, "_serialize_card", lambda *a, **k: built.append(a[0].id) or real(*a, **k))
    try:
        body = jobs_routes._list_payload(db, user, sort="best_recent", posted_within_days=30, limit=25)
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", capture)
    assert len(body["jobs"]) == 25 and body["page"]["total"] > 25
    assert len(built) == 25, "a full card was built for a job that is not on the page"
    listing = [s for s in log if "FROM job_postings" in s and "is_active" in s and " IN " not in s]
    assert listing, "the phase-1 listing query was not found"
    for statement in listing:
        for heavy in ("description_raw", "raw_json", "responsibilities"):
            assert heavy not in statement, f"phase 1 selected {heavy}"
    hydrate = [s for s in log if "FROM job_postings" in s and " IN " in s]
    assert len(hydrate) == 1  # one query for the page's full rows


def test_query_count_does_not_grow_with_the_catalogue(db):
    small = seed(db, 40)
    log, capture = _statements(db)
    try:
        jobs_routes._list_payload(db, small, sort="best_recent", posted_within_days=30, limit=25)
        small_count = len(log)
        for number in range(41, 241):  # a catalogue six times larger
            db.add(JobPosting(source_id=1, external_id=f"x{number}", title=f"Backend Engineer {number}", company="Co", location="Remote, United States",
                              remote_type="remote", seniority_level="mid", posted_at=NOW - timedelta(days=2), discovered_at=NOW, is_active=True,
                              application_url=f"https://boards.greenhouse.io/c/jobs/{number}", source_url=f"https://boards.greenhouse.io/c/jobs/{number}",
                              hash_for_deduplication=f"{number:064d}"))
        db.commit()
        log.clear()
        jobs_routes._list_payload(db, small, sort="best_recent", posted_within_days=30, limit=25)
    finally:
        event.remove(db.get_bind(), "before_cursor_execute", capture)
    assert len(log) == small_count, f"queries grew with the catalogue: {small_count} -> {len(log)}"


def test_a_job_removed_between_the_phases_shortens_the_page_without_failing(db, monkeypatch):
    user = seed(db, 60)
    real = jobs_routes._load_by_ids

    def drop_one(db_, model, column, ids, *where):
        found = real(db_, model, column, ids, *where)
        if model is JobPosting and found:
            found.pop(next(iter(found)))
        return found

    monkeypatch.setattr(jobs_routes, "_load_by_ids", drop_one)
    body = jobs_routes._list_payload(db, user, sort="best_recent", posted_within_days=30, limit=10)
    assert len(body["jobs"]) == 9 and body["page"]["returned"] == 9 and body["page"]["next_cursor"]


def _peak_bytes(fn) -> int:
    tracemalloc.start()
    try:
        fn()
        return tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def test_peak_memory_is_a_fraction_of_the_old_implementation(db):
    """The regression that killed the container: memory per request must not scale with the full text of every job."""
    user = seed(db, 400, heavy=3)
    legacy = _legacy_list_payload()
    params = {"sort": "best_recent", "posted_within_days": 60, "limit": 25}
    jobs_routes._list_payload(db, user, **params)  # warm imports and caches out of the measurement
    legacy(db, user, **params)
    db.expire_all()
    new_peak = _peak_bytes(lambda: jobs_routes._list_payload(db, user, **params))
    db.expire_all()
    old_peak = _peak_bytes(lambda: legacy(db, user, **params))
    assert new_peak * 3 < old_peak, f"new {new_peak / 1e6:.1f} MB vs old {old_peak / 1e6:.1f} MB"
