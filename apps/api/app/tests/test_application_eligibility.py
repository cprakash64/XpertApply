"""The three explicit legal answers: writing them, reading them, and the rules
that stop a browser from minting a trusted one."""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.applications.answer_vault_service import build_safe_answers, legal_answer_state
from app.applications.eligibility_service import (
    is_stale,
    read_eligibility,
    resolve_combined_sponsorship,
    set_eligibility_answer,
)
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.entities import ApplicationAnswer, User


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
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


def _auth(client: TestClient, email: str) -> dict[str, str]:
    token = client.post("/auth/signup", json={"email": email, "password": "password123"}).json()
    return {"Authorization": f"Bearer {token['access_token']}"}


@pytest.fixture()
def auth_headers(client: TestClient) -> dict[str, str]:
    return _auth(client, "eligible@mailbox.test-domain.co")


@pytest.fixture()
def other_auth_headers(client: TestClient) -> dict[str, str]:
    return _auth(client, "other@mailbox.test-domain.co")


@pytest.fixture()
def db_session(client: TestClient) -> Session:
    return next(app.dependency_overrides[get_db]())


@pytest.fixture()
def user(client: TestClient, db_session: Session, auth_headers: dict[str, str]) -> User:
    return db_session.scalar(
        select(User).where(User.email == "eligible@mailbox.test-domain.co")
    )

FIELDS = ["work_authorization_us", "sponsorship_required_now", "sponsorship_required_future"]


def _row(db, user_id, key) -> ApplicationAnswer | None:
    return db.scalar(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id) & (ApplicationAnswer.canonical_key == key)
        )
    )


# --------------------------------------------------------------------------- #
# Initial state
# --------------------------------------------------------------------------- #
def test_a_new_user_has_all_three_questions_unanswered(db_session, user) -> None:
    answers = read_eligibility(db_session, user.id)
    assert len(answers) == 3
    for entry in answers:
        assert entry["answered"] is False
        # Crucially NOT "no" — unanswered and No are different states.
        assert entry["answer"] is None
        assert entry["reusable"] is False


def test_nothing_is_preselected_as_no(db_session, user) -> None:
    assert all(entry["answer"] is None for entry in read_eligibility(db_session, user.id))


def test_a_legacy_ambiguous_row_is_not_shown_as_a_confirmed_no(db_session, user) -> None:
    # Exactly what the old derivation left behind: a value, but no proof the
    # user ever confirmed it.
    db_session.add(
        ApplicationAnswer(
            user_id=user.id, canonical_key="sponsorship_required_now", value="No",
            display_value="No", scope="sensitive", company_key="", source="profile",
            is_user_verified=True, allow_auto_fill=True, last_verified_at=None,
        )
    )
    db_session.flush()
    entries = read_eligibility(db_session, user.id)
    entry = next(e for e in entries if e["field"] == "sponsorship_required_now")
    assert entry["answered"] is False
    assert entry["answer"] is None


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("choice,expected", [("yes", "Yes"), ("no", "No")])
def test_saving_creates_an_explicit_verified_reusable_answer(
    db_session, user, choice, expected
) -> None:
    set_eligibility_answer(db_session, user.id, "work_authorization_us", choice)
    row = _row(db_session, user.id, "work_authorization_us")
    assert row.value == expected
    assert row.source == "explicit_profile"
    assert row.is_user_verified is True
    assert row.allow_auto_fill is True
    assert row.last_verified_at is not None
    assert legal_answer_state(row) == "explicit_verified"


def test_answer_each_time_removes_reuse_without_storing_false(db_session, user) -> None:
    set_eligibility_answer(db_session, user.id, "sponsorship_required_now", "yes")
    set_eligibility_answer(db_session, user.id, "sponsorship_required_now", "answer_each_time")
    row = _row(db_session, user.id, "sponsorship_required_now")
    # No stale value left behind, and definitely not "No".
    assert row.value == ""
    assert row.allow_auto_fill is False
    assert row.is_user_verified is False
    assert legal_answer_state(row) == "missing"


def test_updating_an_answer_refreshes_confirmation_metadata(db_session, user) -> None:
    first = set_eligibility_answer(db_session, user.id, "work_authorization_us", "yes")
    row = _row(db_session, user.id, "work_authorization_us")
    row.last_verified_at = datetime.now(UTC) - timedelta(days=10)
    db_session.flush()
    second = set_eligibility_answer(db_session, user.id, "work_authorization_us", "no")
    refreshed = _row(db_session, user.id, "work_authorization_us")
    assert refreshed.value == "No"
    assert second["version"] > first["version"]
    assert refreshed.last_verified_at > datetime.now(UTC) - timedelta(minutes=1)


# --------------------------------------------------------------------------- #
# Reconfirmation
# --------------------------------------------------------------------------- #
def test_a_stale_answer_is_not_reusable_and_asks_for_confirmation(db_session, user) -> None:
    set_eligibility_answer(db_session, user.id, "work_authorization_us", "yes")
    row = _row(db_session, user.id, "work_authorization_us")
    row.last_verified_at = datetime.now(UTC) - timedelta(days=400)
    db_session.flush()
    assert is_stale(row) is True
    entries = read_eligibility(db_session, user.id)
    entry = next(e for e in entries if e["field"] == "work_authorization_us")
    assert entry["needs_confirmation"] is True
    assert entry["reusable"] is False


# --------------------------------------------------------------------------- #
# Combined sponsorship
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "now,future,expected",
    [("no", "no", "No"), ("yes", "no", "Yes"), ("no", "yes", "Yes"), ("yes", "yes", "Yes")],
)
def test_combined_sponsorship_truth_table(db_session, user, now, future, expected) -> None:
    set_eligibility_answer(db_session, user.id, "sponsorship_required_now", now)
    set_eligibility_answer(db_session, user.id, "sponsorship_required_future", future)
    result = resolve_combined_sponsorship(db_session, user.id)
    assert result == {"status": "resolved", "value": expected}


def test_a_missing_component_leaves_the_combined_question_unresolved(db_session, user) -> None:
    set_eligibility_answer(db_session, user.id, "sponsorship_required_now", "no")
    result = resolve_combined_sponsorship(db_session, user.id)
    assert result["status"] == "unresolved"
    assert result["missing"] == "sponsorship_required_future"


def test_a_stale_component_needs_confirmation_rather_than_guessing(db_session, user) -> None:
    set_eligibility_answer(db_session, user.id, "sponsorship_required_now", "no")
    set_eligibility_answer(db_session, user.id, "sponsorship_required_future", "no")
    row = _row(db_session, user.id, "sponsorship_required_future")
    row.last_verified_at = datetime.now(UTC) - timedelta(days=400)
    db_session.flush()
    assert resolve_combined_sponsorship(db_session, user.id)["status"] == "needs_confirmation"


# --------------------------------------------------------------------------- #
# It actually reaches the application package
# --------------------------------------------------------------------------- #
def test_a_saved_answer_reaches_build_safe_answers(db_session, user) -> None:
    set_eligibility_answer(db_session, user.id, "work_authorization_us", "yes")
    answers, _ = build_safe_answers(db_session, user)
    by_key = {a["canonical_key"]: a for a in answers}
    assert by_key["work_authorization_us"]["value"] == "Yes"
    assert by_key["work_authorization_us"]["verified"] is True


# --------------------------------------------------------------------------- #
# API surface
# --------------------------------------------------------------------------- #
def test_the_browser_cannot_set_verification_metadata(client: TestClient, auth_headers) -> None:
    response = client.put(
        "/profile/application-eligibility",
        headers=auth_headers,
        json={
            "field": "work_authorization_us",
            "answer": "yes",
            # All of these must be ignored, not honoured.
            "source": "verified_answer_vault",
            "is_user_verified": True,
            "allow_auto_fill": True,
            "last_verified_at": "1999-01-01T00:00:00Z",
            "user_id": 999999,
            "version": 42,
        },
    )
    assert response.status_code == 200
    entry = next(e for e in response.json()["answers"] if e["field"] == "work_authorization_us")
    # Server-owned values, not the ones the client tried to inject.
    assert entry["version"] == 1
    assert entry["confirmed_at"] is not None
    assert entry["confirmed_at"][:4] != "1999"


def test_an_unknown_field_is_rejected(client: TestClient, auth_headers) -> None:
    response = client.put(
        "/profile/application-eligibility",
        headers=auth_headers,
        json={"field": "citizenship_status", "answer": "yes"},
    )
    assert response.status_code == 422


def test_eligibility_requires_authentication(client: TestClient) -> None:
    assert client.get("/profile/application-eligibility").status_code in (401, 403)
    assert client.put(
        "/profile/application-eligibility", json={"field": "work_authorization_us", "answer": "yes"}
    ).status_code in (401, 403)


def test_one_user_cannot_read_or_change_another_users_answers(
    client: TestClient, auth_headers, other_auth_headers
) -> None:
    client.put(
        "/profile/application-eligibility",
        headers=auth_headers,
        json={"field": "work_authorization_us", "answer": "yes"},
    )
    other = client.get("/profile/application-eligibility", headers=other_auth_headers)
    assert other.status_code == 200
    entry = next(e for e in other.json()["answers"] if e["field"] == "work_authorization_us")
    assert entry["answered"] is False
