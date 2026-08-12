"""Application-scoped answer overrides.

"Yes, for this application" is a different statement from "yes, always". These
prove the two never leak into each other: an override answers the employer in
front of the user and expires with the session, while the reusable vault stays
untouched until a separate explicit save.
"""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.applications.eligibility_service import set_eligibility_answer
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.entities import ApplicationAnswer, ApplicationSession, JobPosting, JobSource, User
from app.models.entities import ApplicationSessionStatus as SessStatus

WORK_AUTH_Q = "Are you legally authorized to work in the US without restriction?"
SPONSOR_Q = "Will you now or in the future require visa sponsorship or a visa transfer?"
YES_NO = [{"option_ref": "o-yes", "label": "Yes"}, {"option_ref": "o-no", "label": "No"}]


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


def _db() -> Session:
    return next(app.dependency_overrides[get_db]())


def _auth(client: TestClient, email: str) -> dict[str, str]:
    token = client.post("/auth/signup", json={"email": email, "password": "password123"}).json()
    return {"Authorization": f"Bearer {token['access_token']}"}


_seq = {"n": 0}


def _seed_session(email: str, *, expires_in_hours: float = 1) -> tuple[int, int]:
    db = _db()
    _seq["n"] += 1
    user = db.scalar(select(User).where(User.email == email))
    source = db.scalar(select(JobSource).where(JobSource.type == "greenhouse"))
    if source is None:
        source = JobSource(
            name="src", type="greenhouse", base_url="https://x.test",
            enabled=True, supports_api=True,
        )
        db.add(source)
        db.flush()
    tag = f"{user.id}-{_seq['n']}"
    job = JobPosting(
        source_id=source.id,
        external_id=f"j{tag}",
        title="Engineer",
        company="Acme",
        location="Remote",
        application_url="https://x.test/a",
        source_url="https://x.test/a",
        hash_for_deduplication=f"h{tag}",
    )
    db.add(job)
    db.flush()
    session = ApplicationSession(
        user_id=user.id,
        job_id=job.id,
        status=SessStatus.ready,
        source_url="https://x.test/a",
        expires_at=datetime.now(UTC) + timedelta(hours=expires_in_hours),
    )
    db.add(session)
    db.commit()
    return session.id, user.id


@pytest.fixture()
def owner(client: TestClient) -> tuple[dict[str, str], int, int]:
    headers = _auth(client, "owner@mailbox.test-domain.co")
    session_id, user_id = _seed_session("owner@mailbox.test-domain.co")
    return headers, session_id, user_id


def _put(client, headers, session_id, key, value):
    return client.put(
        f"/application-sessions/{session_id}/answers/override/{key}",
        headers=headers, json={"value": value},
    )


def _resolve(client, headers, session_id, question):
    return client.post(
        f"/application-sessions/{session_id}/resolve-questions",
        headers=headers,
        json={"questions": [{
            "field_ref": "f1", "question": question, "section": "Eligibility",
            "control_type": "combobox", "required": True, "locale": "en-US", "options": YES_NO,
        }]},
    )


# --------------------------------------------------------------------------- #
# Storing
# --------------------------------------------------------------------------- #
def test_the_owner_can_answer_for_this_application(client, owner) -> None:
    headers, session_id, _ = owner
    response = _put(client, headers, session_id, "work_authorization_us", True)
    assert response.status_code == 200
    body = response.json()
    assert body["scope"] == "application_session"
    assert body["source_label"] == "Confirmed for this application"
    assert body["confirmed_at"]


def test_an_override_does_not_touch_the_reusable_vault(client, owner) -> None:
    headers, session_id, user_id = owner
    _put(client, headers, session_id, "work_authorization_us", True)
    db = _db()
    row = db.scalar(select(ApplicationAnswer).where(
        (ApplicationAnswer.user_id == user_id)
        & (ApplicationAnswer.canonical_key == "work_authorization_us")))
    # No reusable answer was created. "For this application" stayed that way.
    assert row is None


def test_an_override_does_not_overwrite_an_existing_saved_answer(client, owner) -> None:
    headers, session_id, user_id = owner
    db = _db()
    set_eligibility_answer(db, user_id, "work_authorization_us", "no")
    db.commit()

    _put(client, headers, session_id, "work_authorization_us", True)

    row = db.scalar(select(ApplicationAnswer).where(
        (ApplicationAnswer.user_id == user_id)
        & (ApplicationAnswer.canonical_key == "work_authorization_us")))
    assert row.value == "No"   # unchanged


def test_an_override_is_visible_only_in_its_own_session(client, owner) -> None:
    headers, session_id, _ = owner
    _put(client, headers, session_id, "work_authorization_us", True)
    other_session_id, _ = _seed_session("owner@mailbox.test-domain.co")
    body = client.get(
        f"/application-sessions/{other_session_id}/answers/override", headers=headers
    ).json()
    assert body["overrides"] == []


def test_the_override_summary_never_reveals_the_value(client, owner) -> None:
    headers, session_id, _ = owner
    _put(client, headers, session_id, "work_authorization_us", True)
    text = client.get(f"/application-sessions/{session_id}/answers/override", headers=headers).text
    assert "work_authorization_us" in text
    assert '"Yes"' not in text


# --------------------------------------------------------------------------- #
# It actually answers the employer
# --------------------------------------------------------------------------- #
def test_an_override_resolves_the_employer_question(client, owner) -> None:
    headers, session_id, _ = owner
    _put(client, headers, session_id, "work_authorization_us", True)
    result = _resolve(client, headers, session_id, WORK_AUTH_Q).json()["results"][0]
    assert result["status"] == "resolved"
    assert result["selected_option_ref"] == "o-yes"
    assert result["safe_source"] == "application_override"


def test_an_override_outranks_the_saved_answer_for_this_session(client, owner) -> None:
    headers, session_id, user_id = owner
    db = _db()
    set_eligibility_answer(db, user_id, "work_authorization_us", "no")
    db.commit()
    _put(client, headers, session_id, "work_authorization_us", True)

    result = _resolve(client, headers, session_id, WORK_AUTH_Q).json()["results"][0]
    assert result["selected_option_ref"] == "o-yes"   # the override, not the saved No


def test_a_combined_sponsorship_override_answers_without_decomposing(client, owner) -> None:
    headers, session_id, user_id = owner
    _put(client, headers, session_id, "sponsorship_required_now_or_future", True)

    result = _resolve(client, headers, session_id, SPONSOR_Q).json()["results"][0]
    assert result["status"] == "resolved"
    assert result["selected_option_ref"] == "o-yes"

    # The two reusable components must NOT have been invented from the combined
    # answer — the user answered the employer's question, not ours.
    db = _db()
    for key in ("sponsorship_required_now", "sponsorship_required_future"):
        row = db.scalar(select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id) & (ApplicationAnswer.canonical_key == key)))
        assert row is None, key


# --------------------------------------------------------------------------- #
# Policy
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("key", ["citizenship_status", "unknown_key", ""])
def test_an_unsupported_canonical_key_is_rejected(client, owner, key) -> None:
    headers, session_id, _ = owner
    assert _put(client, headers, session_id, key or "x", True).status_code in (404, 422)


def test_salary_expectation_cannot_be_overridden(client, owner) -> None:
    # Registry marks it autofill-forbidden; an override must not route around that.
    headers, session_id, _ = owner
    response = _put(client, headers, session_id, "salary_expectation", "100000")
    assert response.status_code == 422


@pytest.mark.parametrize("value", ["maybe", 42, None, ""])
def test_an_invalid_boolean_is_rejected(client, owner, value) -> None:
    headers, session_id, _ = owner
    assert _put(client, headers, session_id, "work_authorization_us", value).status_code == 422


def test_a_client_cannot_supply_provenance(client, owner) -> None:
    headers, session_id, _ = owner
    response = client.put(
        f"/application-sessions/{session_id}/answers/override/work_authorization_us",
        headers=headers,
        json={
            "value": True,
            "source": "explicit_profile", "is_user_verified": True,
            "allow_auto_fill": True, "scope": "global", "user_id": 999,
        },
    )
    assert response.status_code == 200
    db = _db()
    session = db.get(ApplicationSession, session_id)
    stored = session.application_overrides["work_authorization_us"]
    # Server-owned, regardless of what was sent.
    assert stored["source"] == "user_confirmed_application"
    assert stored["scope"] == "application_session"


# --------------------------------------------------------------------------- #
# Ownership and lifecycle
# --------------------------------------------------------------------------- #
def test_unauthenticated_requests_are_rejected(client, owner) -> None:
    _, session_id, _ = owner
    response = client.put(
        f"/application-sessions/{session_id}/answers/override/work_authorization_us",
        json={"value": True},
    )
    assert response.status_code in (401, 403)


def test_another_user_cannot_override_someone_elses_session(client, owner) -> None:
    _, session_id, _ = owner
    intruder = _auth(client, "intruder@mailbox.test-domain.co")
    assert _put(client, intruder, session_id, "work_authorization_us", True).status_code == 403


def test_an_unknown_session_is_rejected(client, owner) -> None:
    headers, _, _ = owner
    assert _put(client, headers, 999999, "work_authorization_us", True).status_code == 404


def test_an_expired_session_cannot_be_answered(client) -> None:
    headers = _auth(client, "expired@mailbox.test-domain.co")
    session_id, _ = _seed_session("expired@mailbox.test-domain.co", expires_in_hours=-1)
    response = _put(client, headers, session_id, "work_authorization_us", True)
    assert response.status_code in (403, 410)


def test_the_override_lives_on_the_session_so_it_expires_with_it(client, owner) -> None:
    headers, session_id, _ = owner
    _put(client, headers, session_id, "work_authorization_us", True)
    db = _db()
    session = db.get(ApplicationSession, session_id)
    assert "work_authorization_us" in session.application_overrides
    # Nothing outlives the session row itself.
    db.delete(session)
    db.commit()
    assert db.get(ApplicationSession, session_id) is None


def test_no_answer_value_is_logged(client, owner, caplog) -> None:
    headers, session_id, _ = owner
    with caplog.at_level("INFO"):
        _put(client, headers, session_id, "work_authorization_us", True)
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "owner@mailbox" not in logged
    assert "value=Yes" not in logged


# --------------------------------------------------------------------------- #
# Surviving a session refresh
# --------------------------------------------------------------------------- #
# An override lives on the session row, and a profile refresh rewrites the
# GENERATED answers on that same row. These prove the refresh does not take the
# user's application-only answer with it — the extension re-resolves after a
# reinjection or a service-worker restart, and that re-resolution must still see
# what the user answered.
def _refresh(client, headers, session_id):
    return client.post(
        f"/application-sessions/{session_id}/refresh-from-profile", headers=headers
    )


def test_an_override_survives_a_session_refresh(client, owner) -> None:
    headers, session_id, _ = owner
    _put(client, headers, session_id, "work_authorization_us", True)

    assert _refresh(client, headers, session_id).status_code == 200

    db = _db()
    session = db.get(ApplicationSession, session_id)
    assert "work_authorization_us" in (session.application_overrides or {})
    stored = session.application_overrides["work_authorization_us"]
    # Provenance survives intact, still server-owned.
    assert stored["source"] == "user_confirmed_application"
    assert stored["scope"] == "application_session"


def test_an_override_still_resolves_after_a_refresh(client, owner) -> None:
    headers, session_id, user_id = owner
    db = _db()
    # A saved answer that DISAGREES, so a resolution falling back to the vault
    # would be visible rather than coincidentally correct.
    set_eligibility_answer(db, user_id, "work_authorization_us", "no")
    db.commit()
    _put(client, headers, session_id, "work_authorization_us", True)
    _refresh(client, headers, session_id)

    result = _resolve(client, headers, session_id, WORK_AUTH_Q).json()["results"][0]
    assert result["status"] == "resolved"
    assert result["selected_option_ref"] == "o-yes"
    assert result["safe_source"] == "application_override"


def test_a_refresh_does_not_leak_the_override_into_the_vault(client, owner) -> None:
    headers, session_id, user_id = owner
    _put(client, headers, session_id, "work_authorization_us", True)
    _refresh(client, headers, session_id)

    db = _db()
    row = db.scalar(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id)
            & (ApplicationAnswer.canonical_key == "work_authorization_us")
        )
    )
    # The refresh regenerates answers from the PROFILE. An application-only
    # answer is not a profile answer, so it must not appear here.
    assert row is None


# --------------------------------------------------------------------------- #
# Sponsorship dependencies
# --------------------------------------------------------------------------- #
# Employers commonly ask only the combined question. Answering a component for
# this application therefore has to change what the combined question resolves
# to, or the extension would keep reporting it unanswered right after the user
# answered it.
def _seed_both_components(user_id: int, *, now: str, future: str) -> None:
    db = _db()
    set_eligibility_answer(db, user_id, "sponsorship_required_now", now)
    set_eligibility_answer(db, user_id, "sponsorship_required_future", future)
    db.commit()


def test_a_now_override_refreshes_the_combined_question(client, owner) -> None:
    headers, session_id, user_id = owner
    _seed_both_components(user_id, now="no", future="no")
    # Baseline: both saved answers are No, so the combined question is No.
    before = _resolve(client, headers, session_id, SPONSOR_Q).json()["results"][0]
    assert before["selected_option_ref"] == "o-no"
    assert before["safe_source"] == "saved_profile"

    _put(client, headers, session_id, "sponsorship_required_now", True)

    after = _resolve(client, headers, session_id, SPONSOR_Q).json()["results"][0]
    assert after["status"] == "resolved"
    # now OR future — answering the CURRENT component Yes makes the whole Yes.
    assert after["selected_option_ref"] == "o-yes"
    assert after["safe_source"] == "application_override"


def test_a_future_override_refreshes_the_combined_question(client, owner) -> None:
    headers, session_id, user_id = owner
    _seed_both_components(user_id, now="no", future="no")
    _put(client, headers, session_id, "sponsorship_required_future", True)

    result = _resolve(client, headers, session_id, SPONSOR_Q).json()["results"][0]
    assert result["selected_option_ref"] == "o-yes"
    assert result["safe_source"] == "application_override"


def test_a_component_override_leaves_the_saved_components_alone(client, owner) -> None:
    headers, session_id, user_id = owner
    _seed_both_components(user_id, now="no", future="no")
    _put(client, headers, session_id, "sponsorship_required_now", True)

    db = _db()
    rows = {
        row.canonical_key: row
        for row in db.scalars(
            select(ApplicationAnswer).where(ApplicationAnswer.user_id == user_id)
        )
    }
    # The saved answer is still No. The override answered ONE employer, not the
    # user's standing position.
    assert rows["sponsorship_required_now"].value.strip().lower() in {"no", "false"}
    assert rows["sponsorship_required_future"].value.strip().lower() in {"no", "false"}


def test_a_component_override_cannot_answer_a_half_known_combined_question(client, owner) -> None:
    headers, session_id, _ = owner
    # Only the CURRENT component is known, and only for this application. Needing
    # no sponsorship today says nothing about later, so the combined question
    # stays unanswered rather than being answered No.
    _put(client, headers, session_id, "sponsorship_required_now", False)

    result = _resolve(client, headers, session_id, SPONSOR_Q).json()["results"][0]
    assert result["status"] != "resolved"
    assert result["selected_option_ref"] is None
    assert result["reason_code"] == "component_missing"


def test_a_direct_combined_override_does_not_answer_the_components(client, owner) -> None:
    headers, session_id, _ = owner
    _put(client, headers, session_id, "sponsorship_required_now_or_future", True)

    # The combined answer is not a statement about either component, so a page
    # asking the CURRENT question specifically must still go to the user.
    result = _resolve(
        client, headers, session_id, "Do you currently require visa sponsorship?"
    ).json()["results"][0]
    assert result["status"] != "resolved"
    assert result["selected_option_ref"] is None


def test_an_override_in_one_session_does_not_reach_another(client, owner) -> None:
    headers, session_id, user_id = owner
    _seed_both_components(user_id, now="no", future="no")
    _put(client, headers, session_id, "sponsorship_required_now", True)

    other_session_id, _ = _seed_session("owner@mailbox.test-domain.co")
    result = _resolve(client, headers, other_session_id, SPONSOR_Q).json()["results"][0]
    # The user's own second application sees their SAVED answers only.
    assert result["selected_option_ref"] == "o-no"
    assert result["safe_source"] == "saved_profile"
