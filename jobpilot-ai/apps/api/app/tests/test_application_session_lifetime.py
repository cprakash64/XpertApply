"""Application-session lifetime across a real employer detour.

Root cause these cover: the session deadline was fixed at creation, so the
genuine path — listing, Apply, employer login, password reset or email
verification, then the application form — could outlast it and fail mid-flight
with "Your session is no longer valid. Reopen the application from JobPilot."

The window now slides on authenticated activity, bounded by an absolute ceiling
so this is not "sessions never expire".
"""

from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.applications.session_service import (
    SESSION_ABSOLUTE_TTL_HOURS,
    SESSION_IDLE_TTL_MINUTES,
    is_expired,
    touch_session,
)
from app.db.base import Base
from app.main import app
from app.models import entities as E
from app.tests.test_application_applied_lifecycle import (
    auth,
    complete_profile,
    db_session,
    seed_job,
)


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    """A local fixture rather than an imported one: every test module in this
    suite owns its own database, and importing a fixture would also shadow the
    `client` parameter name in every test below."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def make_session(
    db, *, user_id: int, job_id: int, created_delta=timedelta(0), expires_delta=None
):
    now = datetime.now(UTC)
    session = E.ApplicationSession(
        user_id=user_id,
        job_id=job_id,
        status=E.ApplicationSessionStatus.ready,
        source_url="https://boards.greenhouse.io/acme/be-1",
        created_at=now + created_delta,
        expires_at=now
        + (expires_delta if expires_delta is not None else timedelta(minutes=1)),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def test_activity_slides_the_deadline_forward(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = client.get("/auth/me", headers=headers).json()["id"]

    db = db_session()
    try:
        session = make_session(
            db, user_id=user_id, job_id=job_id, expires_delta=timedelta(minutes=2)
        )
        before = session.expires_at
        assert touch_session(db, session) is True
        db.commit()
        assert session.expires_at > before
        # Slid to roughly "now + idle TTL", not to some unbounded future.
        expected = datetime.now(UTC) + timedelta(minutes=SESSION_IDLE_TTL_MINUTES)
        assert abs((session.expires_at.replace(tzinfo=UTC) - expected).total_seconds()) < 60
    finally:
        db.close()


def test_a_long_employer_detour_does_not_invalidate_the_session(client) -> None:
    """The reported failure, end to end: work continues past the original TTL
    because each authenticated request refreshes it."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    created = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()
    session_id = created["session_id"]

    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session_id)
        # Simulate the user being 25 minutes into the detour: nearly expired.
        row.expires_at = datetime.now(UTC) + timedelta(minutes=4)
        db.commit()
    finally:
        db.close()

    # Any authenticated touch (the extension polling the session) refreshes it.
    assert client.get(f"/application-sessions/{session_id}", headers=headers).status_code == 200

    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session_id)
        remaining = row.expires_at.replace(tzinfo=UTC) - datetime.now(UTC)
        assert remaining > timedelta(minutes=20), "an active session must not be about to expire"
        assert row.status == E.ApplicationSessionStatus.ready
    finally:
        db.close()


def test_the_absolute_ceiling_still_applies(client) -> None:
    """Activity extends a session; it must not make one immortal."""
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = client.get("/auth/me", headers=headers).json()["id"]

    db = db_session()
    try:
        session = make_session(
            db,
            user_id=user_id,
            job_id=job_id,
            created_delta=-timedelta(hours=SESSION_ABSOLUTE_TTL_HOURS + 1),
            expires_delta=timedelta(minutes=1),
        )
        assert touch_session(db, session) is False
    finally:
        db.close()


def test_a_session_never_slides_past_the_ceiling(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = client.get("/auth/me", headers=headers).json()["id"]

    db = db_session()
    try:
        # Created just under the ceiling: the slide must clamp, not overshoot.
        session = make_session(
            db,
            user_id=user_id,
            job_id=job_id,
            created_delta=-timedelta(hours=SESSION_ABSOLUTE_TTL_HOURS, minutes=-10),
            expires_delta=timedelta(minutes=1),
        )
        touch_session(db, session)
        db.commit()
        ceiling = session.created_at.replace(tzinfo=UTC) + timedelta(
            hours=SESSION_ABSOLUTE_TTL_HOURS
        )
        assert session.expires_at.replace(tzinfo=UTC) <= ceiling
    finally:
        db.close()


@pytest.mark.parametrize(
    "status",
    [
        E.ApplicationSessionStatus.completed,
        E.ApplicationSessionStatus.cancelled,
        E.ApplicationSessionStatus.expired,
    ],
)
def test_terminal_sessions_are_never_revived(client, status) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    user_id = client.get("/auth/me", headers=headers).json()["id"]

    db = db_session()
    try:
        session = make_session(db, user_id=user_id, job_id=job_id)
        session.status = status
        db.commit()
        assert touch_session(db, session) is False
    finally:
        db.close()


def test_a_genuinely_expired_session_still_fails_safely(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    created = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()
    session_id = created["session_id"]

    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session_id)
        row.expires_at = datetime.now(UTC) - timedelta(minutes=5)
        db.commit()
        assert is_expired(row) is True
    finally:
        db.close()

    client.get(f"/application-sessions/{session_id}", headers=headers)

    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session_id)
        assert row.status == E.ApplicationSessionStatus.expired
    finally:
        db.close()


def test_another_user_cannot_extend_someone_elses_session(client) -> None:
    """Sliding happens only after the credential check, so a stranger's request
    is rejected before it can refresh anything."""
    owner = auth(client)
    complete_profile(client, owner)
    job_id = seed_job()
    created = client.post("/application-sessions", headers=owner, json={"job_id": job_id}).json()
    session_id = created["session_id"]

    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session_id)
        row.expires_at = datetime.now(UTC) + timedelta(minutes=2)
        db.commit()
        before = row.expires_at
    finally:
        db.close()

    intruder = auth(client, email="intruder-session@mailbox.test-domain.co")
    assert client.get(f"/application-sessions/{session_id}", headers=intruder).status_code == 403

    db = db_session()
    try:
        row = db.get(E.ApplicationSession, session_id)
        assert row.expires_at == before
    finally:
        db.close()


def test_session_token_is_never_written_to_the_audit_trail(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    created = client.post("/application-sessions", headers=headers, json={"job_id": job_id}).json()
    raw_token = created["extension_launch_token"]

    db = db_session()
    try:
        entries = db.scalars(select(E.ApplicationAuditLog)).all()
        serialized = " ".join(str(entry.metadata_json) for entry in entries)
        assert raw_token not in serialized
        # Only the hash is persisted on the session itself.
        session = db.get(E.ApplicationSession, created["session_id"])
        assert session.launch_token_hash != raw_token
    finally:
        db.close()
