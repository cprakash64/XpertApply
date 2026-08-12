"""POST /application-sessions/{id}/resolve-questions.

The join between "what does this employer question mean" and "what did the user
actually answer". Database-backed: a saved answer must survive the whole path
and come back as an option reference the page reported seeing.
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
SOURCE_Q = "Where did you hear about this opportunity?"
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


def _seed_session(email: str, *, source_type: str = "greenhouse") -> tuple[int, int]:
    """Create a job + application session owned by ``email``. Returns (session_id, user_id)."""
    db = _db()
    user = db.scalar(select(User).where(User.email == email))
    source = db.scalar(select(JobSource).where(JobSource.type == source_type))
    if source is None:
        source = JobSource(
            name=f"src-{source_type}", type=source_type, base_url="https://x.test",
            enabled=True, supports_api=True,
        )
        db.add(source)
        db.flush()
    job = JobPosting(
        source_id=source.id, external_id=f"job-{user.id}-{source_type}", title="Engineer",
        company="Acme", location="Remote", application_url="https://x.test/a",
        source_url="https://x.test/a", hash_for_deduplication=f"h{user.id}{source_type}",
    )
    db.add(job)
    db.flush()
    session = ApplicationSession(
        user_id=user.id, job_id=job.id, status=SessStatus.ready,
        source_url="https://x.test/a", expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db.add(session)
    db.commit()
    return session.id, user.id


def _resolve(client, headers, session_id, questions):
    return client.post(
        f"/application-sessions/{session_id}/resolve-questions",
        headers=headers,
        json={"questions": questions},
    )


def _q(field_ref: str, question: str, options=None) -> dict:
    return {
        "field_ref": field_ref,
        "question": question,
        "section": "Eligibility",
        "control_type": "combobox",
        "required": True,
        "locale": "en-US",
        "options": options if options is not None else YES_NO,
    }


@pytest.fixture()
def owner(client: TestClient) -> tuple[dict[str, str], int, int]:
    headers = _auth(client, "owner@mailbox.test-domain.co")
    session_id, user_id = _seed_session("owner@mailbox.test-domain.co")
    return headers, session_id, user_id


def _save(user_id: int, field: str, choice: str) -> None:
    db = _db()
    set_eligibility_answer(db, user_id, field, choice)
    db.commit()


def _age(user_id: int, key: str, days: int) -> None:
    db = _db()
    row = db.scalar(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id) & (ApplicationAnswer.canonical_key == key)
        )
    )
    row.last_verified_at = datetime.now(UTC) - timedelta(days=days)
    db.commit()


# --------------------------------------------------------------------------- #
# Contract
# --------------------------------------------------------------------------- #
def test_the_owner_can_resolve_their_own_session(client, owner) -> None:
    headers, session_id, _ = owner
    response = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)])
    assert response.status_code == 200
    body = response.json()
    assert body["registry_version"] == "1.0.0"
    assert body["answer_contract_version"] == 3


def test_every_submitted_field_gets_exactly_one_result_in_order(client, owner) -> None:
    headers, session_id, _ = owner
    questions = [_q("f1", WORK_AUTH_Q), _q("f2", SPONSOR_Q), _q("f3", "Unrecognised wording?")]
    results = _resolve(client, headers, session_id, questions).json()["results"]
    assert [r["field_ref"] for r in results] == ["f1", "f2", "f3"]


def test_unauthenticated_requests_are_rejected(client, owner) -> None:
    _, session_id, _ = owner
    response = client.post(
        f"/application-sessions/{session_id}/resolve-questions",
        json={"questions": [_q("f1", WORK_AUTH_Q)]},
    )
    assert response.status_code in (401, 403)


def test_another_user_cannot_resolve_through_someone_elses_session(client, owner) -> None:
    _, session_id, owner_id = owner
    _save(owner_id, "work_authorization_us", "yes")
    intruder = _auth(client, "intruder@mailbox.test-domain.co")
    response = _resolve(client, intruder, session_id, [_q("f1", WORK_AUTH_Q)])
    assert response.status_code == 403


def test_an_unknown_session_is_rejected(client, owner) -> None:
    headers, _, _ = owner
    assert _resolve(client, headers, 999999, [_q("f1", WORK_AUTH_Q)]).status_code == 404


@pytest.mark.parametrize(
    "questions,reason",
    [
        ([], "empty batch"),
        ([_q(f"f{i}", WORK_AUTH_Q) for i in range(61)], "too many questions"),
        ([_q("f1", "x" * 501)], "question too long"),
        (
            [_q("f1", WORK_AUTH_Q, [{"option_ref": "o", "label": "y" * 201}])],
            "option label too long",
        ),
        ([_q("f1", WORK_AUTH_Q, [{"option_ref": "o" * 129, "label": "Yes"}])], "ref too long"),
        (
            [_q("f1", WORK_AUTH_Q, [{"option_ref": f"o{i}", "label": f"L{i}"} for i in range(61)])],
            "too many options",
        ),
    ],
)
def test_payload_bounds_are_enforced(client, owner, questions, reason) -> None:
    headers, session_id, _ = owner
    assert _resolve(client, headers, session_id, questions).status_code == 422, reason


# --------------------------------------------------------------------------- #
# Work authorization
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("choice,expected_ref", [("yes", "o-yes"), ("no", "o-no")])
def test_a_verified_answer_selects_the_matching_submitted_option(
    client, owner, choice, expected_ref
) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", choice)
    result = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).json()["results"][0]
    assert result["status"] == "resolved"
    assert result["canonical_key"] == "work_authorization_us"
    assert result["selected_option_ref"] == expected_ref
    assert result["safe_source"] == "saved_profile"
    assert result["sensitivity"] == "legal"


def test_broader_authorization_uses_only_the_safe_implication_direction(client, owner) -> None:
    headers, session_id, user_id = owner
    broader = "Are you authorized to work in the United States?"

    _save(user_id, "work_authorization_us", "yes")
    affirmative = _resolve(client, headers, session_id, [_q("f1", broader)]).json()["results"][0]
    assert affirmative["status"] == "resolved"
    assert affirmative["selected_option_ref"] == "o-yes"
    assert affirmative["resolution_method"].startswith("deterministic_implication")

    _save(user_id, "work_authorization_us", "no")
    negative = _resolve(client, headers, session_id, [_q("f1", broader)]).json()["results"][0]
    assert negative["status"] == "requires_confirmation"
    assert negative["selected_option_ref"] is None
    assert negative["reason_code"] == "non_equivalent_negative_requires_confirmation"


def test_conflicting_accessible_descriptor_is_a_resolution_conflict(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    question = _q("f1", WORK_AUTH_Q)
    question["accessible_name"] = "Will you require sponsorship in the future?"
    result = _resolve(client, headers, session_id, [question]).json()["results"][0]
    assert result["status"] == "unsupported"
    assert result["selected_option_ref"] is None
    assert result["reason_code"] == "canonical_resolution_conflict"


def test_a_missing_answer_stays_missing_and_never_becomes_no(client, owner) -> None:
    headers, session_id, _ = owner
    result = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).json()["results"][0]
    assert result["status"] == "missing"
    assert result["selected_option_ref"] is None


def test_answer_each_time_does_not_autofill(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    _save(user_id, "work_authorization_us", "answer_each_time")
    result = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).json()["results"][0]
    assert result["status"] == "missing"
    assert result["selected_option_ref"] is None


def test_a_stale_answer_requires_confirmation(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    _age(user_id, "work_authorization_us", 400)
    result = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).json()["results"][0]
    assert result["status"] == "requires_confirmation"
    assert result["selected_option_ref"] is None


def test_a_disallowed_source_does_not_autofill(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    db = _db()
    row = db.scalar(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id)
            & (ApplicationAnswer.canonical_key == "work_authorization_us")
        )
    )
    # Exactly the shape the removed visa inference used to write.
    row.source = "resume_inference"
    db.commit()
    result = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).json()["results"][0]
    assert result["status"] == "unsupported"
    assert result["selected_option_ref"] is None


def test_autofill_disabled_is_respected(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    db = _db()
    row = db.scalar(
        select(ApplicationAnswer).where(
            (ApplicationAnswer.user_id == user_id)
            & (ApplicationAnswer.canonical_key == "work_authorization_us")
        )
    )
    row.allow_auto_fill = False
    db.commit()
    result = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).json()["results"][0]
    assert result["status"] == "requires_confirmation"


@pytest.mark.parametrize(
    "options",
    [
        [
            {"option_ref": "a", "label": "Yes, with restrictions"},
            {"option_ref": "b", "label": "No"},
        ],
        [
            {"option_ref": "a", "label": "Yes, temporarily"},
            {"option_ref": "b", "label": "No, but eligible later"},
        ],
    ],
)
def test_qualified_options_are_ambiguous_not_approximated(client, owner, options) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    result = _resolve(
        client, headers, session_id, [_q("f1", WORK_AUTH_Q, options)]
    ).json()["results"][0]
    assert result["status"] == "ambiguous"
    assert result["selected_option_ref"] is None


# --------------------------------------------------------------------------- #
# Combined sponsorship
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "now,future,expected_ref",
    [("no", "no", "o-no"), ("yes", "no", "o-yes"), ("no", "yes", "o-yes"), ("yes", "yes", "o-yes")],
)
def test_combined_sponsorship_truth_table_end_to_end(
    client, owner, now, future, expected_ref
) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "sponsorship_required_now", now)
    _save(user_id, "sponsorship_required_future", future)
    result = _resolve(client, headers, session_id, [_q("f1", SPONSOR_Q)]).json()["results"][0]
    assert result["status"] == "resolved"
    assert result["canonical_key"] == "sponsorship_required_now_or_future"
    assert result["selected_option_ref"] == expected_ref


@pytest.mark.parametrize("present", ["sponsorship_required_now", "sponsorship_required_future"])
def test_one_missing_component_is_never_guessed(client, owner, present) -> None:
    headers, session_id, user_id = owner
    _save(user_id, present, "no")
    result = _resolve(client, headers, session_id, [_q("f1", SPONSOR_Q)]).json()["results"][0]
    assert result["status"] == "missing"
    assert result["selected_option_ref"] is None


def test_a_stale_component_requires_confirmation(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "sponsorship_required_now", "no")
    _save(user_id, "sponsorship_required_future", "no")
    _age(user_id, "sponsorship_required_future", 400)
    result = _resolve(client, headers, session_id, [_q("f1", SPONSOR_Q)]).json()["results"][0]
    assert result["status"] == "requires_confirmation"


def test_scenario_a_yields_sponsorship_no(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    _save(user_id, "sponsorship_required_now", "no")
    _save(user_id, "sponsorship_required_future", "no")
    results = _resolve(
        client, headers, session_id, [_q("f1", WORK_AUTH_Q), _q("f2", SPONSOR_Q)]
    ).json()["results"]
    assert results[0]["selected_option_ref"] == "o-yes"
    assert results[1]["selected_option_ref"] == "o-no"


def test_closed_live_dropdown_preserves_false_before_options_exist(client, owner) -> None:
    """The production boundary: TikTok renders no option DOM while closed."""
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    _save(user_id, "sponsorship_required_now", "no")
    _save(user_id, "sponsorship_required_future", "no")

    response = _resolve(
        client,
        headers,
        session_id,
        [
            _q("auth", WORK_AUTH_Q, []),
            _q("sponsor", SPONSOR_Q, []),
        ],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["request_schema_version"] == 2  # backwards-compatible default
    auth, sponsor = body["results"]

    assert auth["status"] == "resolved"
    assert auth["canonical_key"] == "work_authorization_us"
    assert auth["typed_answer"] is True
    assert auth["display_answer"] == "Yes"
    assert auth["selected_option_ref"] is None

    assert sponsor["status"] == "resolved"
    assert sponsor["canonical_key"] == "sponsorship_required_now_or_future"
    assert sponsor["transform"] == "boolean_or"
    assert sponsor["required_canonical_keys"] == [
        "sponsorship_required_now",
        "sponsorship_required_future",
    ]
    assert sponsor["source_values"] == [False, False]
    assert sponsor["typed_answer"] is False
    assert sponsor["display_answer"] == "No"
    assert sponsor["safe_source"] == "saved_profile"
    assert sponsor["reason_code"] == "answer_resolved_options_unavailable"
    # Proves JSON serialization itself did not turn false into null/missing.
    assert '"typed_answer":false' in response.text


def test_boolean_false_override_survives_json_merge_and_resolution(client, owner) -> None:
    headers, session_id, _ = owner
    db = _db()
    session = db.get(ApplicationSession, session_id)
    session.application_overrides = {
        "work_authorization_us": {
            "value": False,
            "source": "user_confirmed_application",
            "scope": "application_session",
        }
    }
    db.commit()

    result = _resolve(
        client, headers, session_id, [_q("auth", WORK_AUTH_Q, [])]
    ).json()["results"][0]
    assert result["status"] == "resolved"
    assert result["safe_source"] == "application_override"
    assert result["typed_answer"] is False
    assert result["display_answer"] == "No"


def test_scenario_b_yields_sponsorship_yes(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    _save(user_id, "sponsorship_required_now", "no")
    _save(user_id, "sponsorship_required_future", "yes")
    results = _resolve(
        client, headers, session_id, [_q("f1", WORK_AUTH_Q), _q("f2", SPONSOR_Q)]
    ).json()["results"]
    assert results[0]["selected_option_ref"] == "o-yes"
    assert results[1]["selected_option_ref"] == "o-yes"


def test_an_option_absent_from_the_submitted_set_stays_unresolved(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "sponsorship_required_now", "no")
    _save(user_id, "sponsorship_required_future", "no")
    options = [{"option_ref": "x", "label": "Maybe"}, {"option_ref": "y", "label": "Unsure"}]
    result = _resolve(
        client, headers, session_id, [_q("f1", SPONSOR_Q, options)]
    ).json()["results"][0]
    assert result["status"] == "missing"
    assert result["selected_option_ref"] is None


# --------------------------------------------------------------------------- #
# Job source
# --------------------------------------------------------------------------- #
def test_a_board_sourced_job_maps_to_the_company_website_option(client) -> None:
    headers = _auth(client, "src@mailbox.test-domain.co")
    session_id, _ = _seed_session("src@mailbox.test-domain.co", source_type="greenhouse")
    options = [
        {"option_ref": "s1", "label": "Company website"},
        {"option_ref": "s2", "label": "Other"},
    ]
    body = _resolve(client, headers, session_id, [_q("f1", SOURCE_Q, options)]).json()
    result = body["results"][0]
    assert result["status"] == "resolved"
    assert result["selected_option_ref"] == "s1"


def test_job_source_never_blindly_selects_other(client) -> None:
    headers = _auth(client, "src2@mailbox.test-domain.co")
    session_id, _ = _seed_session("src2@mailbox.test-domain.co", source_type="greenhouse")
    options = [{"option_ref": "s1", "label": "Career fair"}, {"option_ref": "s2", "label": "Other"}]
    body = _resolve(client, headers, session_id, [_q("f1", SOURCE_Q, options)]).json()
    result = body["results"][0]
    assert result["status"] == "missing"
    assert result["selected_option_ref"] is None


def test_an_unrecognised_provider_leaves_the_source_question_unresolved(client) -> None:
    headers = _auth(client, "src3@mailbox.test-domain.co")
    session_id, _ = _seed_session("src3@mailbox.test-domain.co", source_type="mystery_board")
    options = [{"option_ref": "s1", "label": "Company website"}]
    body = _resolve(client, headers, session_id, [_q("f1", SOURCE_Q, options)]).json()
    result = body["results"][0]
    assert result["status"] == "missing"


# --------------------------------------------------------------------------- #
# Safety
# --------------------------------------------------------------------------- #
def test_consent_questions_are_returned_as_manual(client, owner) -> None:
    headers, session_id, _ = owner
    result = _resolve(
        client, headers, session_id,
        [_q("f1", "I agree to the privacy policy and terms", [])],
    ).json()["results"][0]
    assert result["status"] == "manual"
    assert result["sensitivity"] == "consent"
    assert result["selected_option_ref"] is None


def test_attestations_are_returned_as_manual(client, owner) -> None:
    headers, session_id, _ = owner
    result = _resolve(
        client, headers, session_id,
        [_q("f1", "I certify that the information provided is accurate", [])],
    ).json()["results"][0]
    assert result["status"] == "manual"


def test_broader_authorization_uses_confirmed_affirmative_implication(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    result = _resolve(
        client, headers, session_id, [_q("f1", "Are you authorized to work in the United States?")]
    ).json()["results"][0]
    assert result["status"] == "resolved"
    assert result["selected_option_ref"] == "o-yes"


def test_profile_work_authorization_status_cannot_influence_the_result(client, owner) -> None:
    headers, session_id, user_id = owner
    # The legacy inference inputs, set as unhelpfully as possible.
    client.put(
        "/profile", headers=headers,
        json={
            "full_name": "Test User",
            "work_authorization": "citizen",
            "requires_sponsorship": False,
        },
    )
    result = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).json()["results"][0]
    # Still missing: only an explicit confirmed answer counts.
    assert result["status"] == "missing"
    assert result["selected_option_ref"] is None


def test_typed_answer_contract_returns_only_the_resolved_boolean(client, owner) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    body = _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)]).text
    # The selected option and typed semantic answer are both explicit contract
    # fields; no source provenance row or unrelated profile data is serialized.
    assert "o-yes" in body
    assert '"typed_answer":true' in body
    assert "explicit_profile" not in body


def test_no_answer_value_or_question_text_is_logged(client, owner, caplog) -> None:
    headers, session_id, user_id = owner
    _save(user_id, "work_authorization_us", "yes")
    with caplog.at_level("INFO"):
        _resolve(client, headers, session_id, [_q("f1", WORK_AUTH_Q)])
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "authorized to work" not in logged.lower()
    assert "owner@mailbox" not in logged
    for token in ("Yes", "No"):
        assert f"value={token}" not in logged
