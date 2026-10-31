"""score_pair must survive losing the INSERT race for a (user, job) row (finding: HTTP 500 on /jobs/scoring/advance).

Needs a migrated disposable PostgreSQL in XA_TEST_PG_URL (same convention as the other *_postgres tests)."""

import os
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.jobs import scoring_service
from app.models.entities import JobMatch, JobPosting, JobSource, User, UserProfile

PG_URL = os.environ.get("XA_TEST_PG_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="XA_TEST_PG_URL not set (needs a migrated disposable PostgreSQL)")


@pytest.fixture()
def factory():
    engine = create_engine(PG_URL)
    yield sessionmaker(bind=engine, autoflush=False, autocommit=False)
    engine.dispose()


def _seed(factory):
    suffix = uuid.uuid4().hex[:8]
    with factory() as db:
        user = User(email=f"race-{suffix}@mailbox.test-domain.co", hashed_password="x")
        source = JobSource(name=f"race-{suffix}", type="greenhouse", base_url="https://example.com")
        db.add_all([user, source])
        db.flush()
        db.add(UserProfile(user_id=user.id, full_name="R T", target_roles=["Backend Engineer"], skills=["Python"],
                           remote_preference="remote", work_authorization="authorized_us", location_country="United States"))
        jobs = [JobPosting(source_id=source.id, external_id=f"{suffix}-{i}", title=f"Backend Engineer {i}", company="Co",
                           location="Remote", remote_type="remote", posted_at=datetime.now(UTC), discovered_at=datetime.now(UTC),
                           is_active=True, application_url="https://example.com/a", source_url="https://example.com/a",
                           description_raw="x", description_clean="Build Python services.", required_skills=["Python"],
                           hash_for_deduplication=f"{suffix}{i:060d}"[:64]) for i in range(3)]
        db.add_all(jobs)
        db.commit()
        return user.id, [j.id for j in jobs]


def _views(db, user_id):
    profile_view, criteria = scoring_service.build_profile_view(db, user_id)
    return profile_view, scoring_service.compute_profile_version(profile_view), criteria


def test_losing_the_insert_race_adopts_the_other_writers_row_and_keeps_the_batch(factory, monkeypatch):
    user_id, job_ids = _seed(factory)
    real_compute = scoring_service._compute_match
    calls = {"n": 0}

    def compute_then_lose_the_race(profile_view, job, criteria):
        calls["n"] += 1
        if calls["n"] == 2:  # between this session's SELECT (no row) and its INSERT, another writer commits the same pair
            with factory() as other:
                other.add(JobMatch(user_id=user_id, job_id=job.id, score_state="scored", fit_score=77.0, scoring_attempts=1))
                other.commit()
        return real_compute(profile_view, job, criteria)

    monkeypatch.setattr(scoring_service, "_compute_match", compute_then_lose_the_race)
    with factory() as db:
        profile_view, profile_hash, criteria = _views(db, user_id)
        outcomes = []
        for job_id in job_ids:
            job = db.get(JobPosting, job_id)
            outcomes.append(scoring_service.score_pair(db, user_id, job, profile_view, profile_hash, criteria))
        db.commit()  # the session must still be usable and its earlier work kept
        assert [o.changed for o in outcomes] == [True, False, True]
        rows = db.scalars(select(JobMatch).where(JobMatch.user_id == user_id)).all()
        assert len(rows) == 3
        by_job = {r.job_id: r for r in rows}
        assert by_job[job_ids[1]].fit_score == 77.0 and by_job[job_ids[1]].scoring_attempts == 1  # the winner's row, untouched
        assert by_job[job_ids[0]].score_state == "scored" and by_job[job_ids[2]].score_state == "scored"
        assert db.scalar(select(func.count()).select_from(JobMatch).where(JobMatch.user_id == user_id)) == 3
