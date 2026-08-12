"""The live TikTok failure, reduced to assertions.

A user with three explicit saved eligibility answers saw three questions left
empty on a real application. These pin down the parts of that path that live in
the backend, so the next time it happens the answer to "was it the server?" is
already written down.

Two properties matter most:

* The resolver reads the user's answers **at resolve time**, not from a package
  captured when the application session was created. An answer changed after the
  session was opened must still be used — otherwise every session opened before
  a profile edit silently resolves against stale data.
* The three exact question strings resolve with **zero AI involvement**, because
  a deterministic registry match is the only thing that can be relied on.
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
from app.applications.question_resolver import resolve_question
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.entities import ApplicationAnswer, ApplicationSession, JobPosting, JobSource, User
from app.models.entities import ApplicationSessionStatus as SessStatus

# The exact wording observed on the live application.
WORK_AUTH_Q = "Are you legally authorized to work in the US without restriction?"
SPONSOR_Q = "Will you now or in the future require visa sponsorship or a visa transfer?"
SOURCE_Q = "Where did you hear about this opportunity?"

YES_NO = [{"option_ref": "o-yes", "label": "Yes"}, {"option_ref": "o-no", "label": "No"}]
SOURCE_OPTIONS = [
    {"option_ref": "o-cw", "label": "Company website"},
    {"option_ref": "o-li", "label": "LinkedIn"},
    {"option_ref": "o-ot", "label": "Other"},
]


# --------------------------------------------------------------------------- #
# Deterministic classification (no database, no model)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("question", "canonical"),
    [
        (WORK_AUTH_Q, "work_authorization_us"),
        (SPONSOR_Q, "sponsorship_required_now_or_future"),
        (SOURCE_Q, "source_where_heard_about_job"),
    ],
)
def test_the_live_questions_resolve_deterministically(question, canonical) -> None:
    resolution = resolve_question(question)
    assert resolution.canonical_key == canonical
    # An exact alias, so this costs nothing and behaves identically every time.
    # If this ever degrades to a pattern or an unknown, the live page stops
    # filling — which is exactly the reported symptom.
    assert resolution.method == "exact_alias"
    assert resolution.reason_code == "alias_match"


def test_trivial_wording_differences_still_resolve() -> None:
    # Normalization is what makes the registry usable against real pages, which
    # differ in case, spacing and trailing punctuation.
    for variant in (
        "  Are you legally authorized to work in the US without restriction?  ",
        "ARE YOU LEGALLY AUTHORIZED TO WORK IN THE US WITHOUT RESTRICTION?",
        "Are you legally authorized to work in the US without restriction",
    ):
        assert resolve_question(variant).canonical_key == "work_authorization_us", variant


# --------------------------------------------------------------------------- #
# Database-backed: does the resolver see CURRENT answers?
# --------------------------------------------------------------------------- #
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


def _seed_session(email: str) -> tuple[int, int]:
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
        source_id=source.id, external_id=f"j{tag}", title="Engineer", company="Acme",
        location="Remote", application_url="https://x.test/a", source_url="https://x.test/a",
        hash_for_deduplication=f"h{tag}",
    )
    db.add(job)
    db.flush()
    session = ApplicationSession(
        user_id=user.id, job_id=job.id, status=SessStatus.ready,
        source_url="https://x.test/a",
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db.add(session)
    db.commit()
    return session.id, user.id


@pytest.fixture()
def owner(client: TestClient) -> tuple[dict[str, str], int, int]:
    headers = _auth(client, "live@mailbox.test-domain.co")
    session_id, user_id = _seed_session("live@mailbox.test-domain.co")
    return headers, session_id, user_id


def _resolve(client, headers, session_id, *questions):
    payload = []
    for index, question in enumerate(questions):
        options = SOURCE_OPTIONS if question == SOURCE_Q else YES_NO
        payload.append({
            "field_ref": f"f{index}", "question": question, "section": "Eligibility",
            "control_type": "combobox", "required": True, "locale": "en-US", "options": options,
        })
    response = client.post(
        f"/application-sessions/{session_id}/resolve-questions",
        headers=headers, json={"questions": payload},
    )
    assert response.status_code == 200, response.text
    return {r["field_ref"]: r for r in response.json()["results"]}


def _answer_all(user_id: int, *, work_auth: str, now: str, future: str) -> None:
    db = _db()
    set_eligibility_answer(db, user_id, "work_authorization_us", work_auth)
    set_eligibility_answer(db, user_id, "sponsorship_required_now", now)
    set_eligibility_answer(db, user_id, "sponsorship_required_future", future)
    db.commit()


def test_the_users_saved_answers_fill_all_three_questions(client, owner) -> None:
    """The reported scenario, end to end on the server side."""
    headers, session_id, user_id = owner
    _answer_all(user_id, work_auth="yes", now="no", future="no")

    results = _resolve(client, headers, session_id, WORK_AUTH_Q, SPONSOR_Q, SOURCE_Q)

    auth = results["f0"]
    assert auth["status"] == "resolved"
    assert auth["canonical_key"] == "work_authorization_us"
    assert auth["selected_option_ref"] == "o-yes"
    assert auth["safe_source"] == "saved_profile"

    sponsor = results["f1"]
    assert sponsor["status"] == "resolved"
    assert sponsor["canonical_key"] == "sponsorship_required_now_or_future"
    # No now OR No later = No.
    assert sponsor["selected_option_ref"] == "o-no"

    # The job came from a Greenhouse-backed source, so the truthful answer to
    # "where did you hear about this" is the company's own site.
    source = results["f2"]
    assert source["status"] == "resolved"
    assert source["selected_option_ref"] == "o-cw"


def test_answers_saved_AFTER_the_session_was_created_are_still_used(client, owner) -> None:
    """The stale-package hypothesis, ruled out.

    The session is created first and the answers are saved afterwards — the exact
    ordering that would break if resolution read a package captured at session
    creation. It reads the vault at resolve time, so it does not.
    """
    headers, session_id, user_id = owner
    # Nothing saved yet: the questions genuinely have no answer.
    before = _resolve(client, headers, session_id, WORK_AUTH_Q, SPONSOR_Q)
    assert before["f0"]["status"] == "missing"
    assert before["f1"]["status"] == "missing"

    _answer_all(user_id, work_auth="yes", now="no", future="no")

    after = _resolve(client, headers, session_id, WORK_AUTH_Q, SPONSOR_Q)
    assert after["f0"]["selected_option_ref"] == "o-yes"
    assert after["f1"]["selected_option_ref"] == "o-no"


def test_changing_an_answer_changes_the_next_resolution(client, owner) -> None:
    headers, session_id, user_id = owner
    _answer_all(user_id, work_auth="yes", now="no", future="no")
    assert _resolve(client, headers, session_id, SPONSOR_Q)["f0"]["selected_option_ref"] == "o-no"

    # The user now needs sponsorship later. Same session, no refresh call.
    db = _db()
    set_eligibility_answer(db, user_id, "sponsorship_required_future", "yes")
    db.commit()

    assert _resolve(client, headers, session_id, SPONSOR_Q)["f0"]["selected_option_ref"] == "o-yes"


def test_a_half_answered_sponsorship_pair_is_not_guessed(client, owner) -> None:
    headers, session_id, user_id = owner
    db = _db()
    set_eligibility_answer(db, user_id, "sponsorship_required_now", "no")
    db.commit()

    result = _resolve(client, headers, session_id, SPONSOR_Q)["f0"]
    # Needing no sponsorship today says nothing about later.
    assert result["status"] != "resolved"
    assert result["selected_option_ref"] is None
    assert result["reason_code"] == "component_missing"


def test_an_answer_the_user_never_confirmed_is_not_used(client, owner) -> None:
    """Why a saved-looking answer can still resolve to `missing`.

    This is the other half of the live diagnosis: a row can exist and still be
    unusable. The state is reported so the widget can say WHICH problem it is
    rather than a generic "needs information".
    """
    headers, session_id, user_id = owner
    db = _db()
    set_eligibility_answer(db, user_id, "work_authorization_us", "yes")
    row = db.scalar(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id)
            & (ApplicationAnswer.canonical_key == "work_authorization_us")
        )
    )
    row.is_user_verified = False
    db.commit()

    result = _resolve(client, headers, session_id, WORK_AUTH_Q)["f0"]
    assert result["status"] == "requires_confirmation"
    assert result["selected_option_ref"] is None
    # The canonical key is still reported, so the review item can name the
    # question rather than falling back to generic wording.
    assert result["canonical_key"] == "work_authorization_us"


def test_another_users_answers_are_never_used(client, owner) -> None:
    headers, session_id, user_id = owner
    _answer_all(user_id, work_auth="yes", now="no", future="no")

    # A second user with no answers at all, resolving against their OWN session.
    other_headers = _auth(client, "other@mailbox.test-domain.co")
    other_session_id, _ = _seed_session("other@mailbox.test-domain.co")
    results = _resolve(client, other_headers, other_session_id, WORK_AUTH_Q, SPONSOR_Q)
    assert results["f0"]["status"] == "missing"
    assert results["f1"]["status"] == "missing"


def test_resolution_reports_its_contract_versions(client, owner) -> None:
    """So a client can tell it is talking to an older resolver."""
    headers, session_id, _ = owner
    response = client.post(
        f"/application-sessions/{session_id}/resolve-questions",
        headers=headers,
        json={"questions": [{
            "field_ref": "f0", "question": WORK_AUTH_Q, "section": None,
            "control_type": "combobox", "required": True, "locale": "en-US", "options": YES_NO,
        }]},
    )
    body = response.json()
    assert body["registry_version"] == "1.0.0"
    assert body["answer_contract_version"] >= 2


def test_no_answer_value_or_question_text_is_logged(client, owner, caplog) -> None:
    headers, session_id, user_id = owner
    _answer_all(user_id, work_auth="yes", now="no", future="no")
    with caplog.at_level("INFO"):
        _resolve(client, headers, session_id, WORK_AUTH_Q, SPONSOR_Q, SOURCE_Q)
    logged = "\n".join(record.getMessage() for record in caplog.records)
    # Counts and outcome codes only.
    assert "legally authorized" not in logged
    assert "live@mailbox" not in logged
    assert "Yes" not in logged
