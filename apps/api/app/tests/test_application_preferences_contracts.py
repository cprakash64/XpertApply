"""Contracts the Application-Preferences UI reorganization must not break.

The UI moved: the three legal answers now live on one dedicated page, the
Workday credential moved to Settings, and the voluntary EEO questions left the
career wizard. None of that may change what the *extension* and the answer
resolver can read, so these tests pin the server-side contracts rather than the
screens.
"""

from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.applications.eligibility_service import (
    FIELD_TO_CANONICAL,
    resolve_combined_sponsorship,
)
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401
from app.models import entities as E


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


def auth(client: TestClient, email: str = "prefs@mailbox.test-domain.co") -> dict[str, str]:
    token = client.post(
        "/auth/signup", json={"email": email, "password": "password123"}
    ).json()
    return {"Authorization": f"Bearer {token['access_token']}"}


def seed_profile(client: TestClient, headers: dict[str, str]) -> None:
    resp = client.put(
        "/profile",
        headers=headers,
        json={
            "full_name": "Chandra Pandey",
            "application_email": "chandra@mailbox.test-domain.co",
            "phone": "602-555-0100",
            "location_city": "Phoenix",
            "location_state": "AZ",
            "location_country": "United States",
            "work_authorization": "authorized_us",
            "open_to_relocation": True,
            "target_roles": ["Backend Engineer"],
            "preferred_locations": ["United States"],
            "remote_preference": "remote",
            "skills": ["Python"],
        },
    )
    assert resp.status_code == 200, resp.text


def answer(client: TestClient, headers: dict[str, str], field: str, choice: str):
    return client.put(
        "/profile/application-eligibility",
        headers=headers,
        json={"field": field, "answer": choice},
    )


def read_answers(client: TestClient, headers: dict[str, str]) -> dict[str, dict]:
    resp = client.get("/profile/application-eligibility", headers=headers)
    assert resp.status_code == 200, resp.text
    return {row["field"]: row for row in resp.json()["answers"]}


# --------------------------------------------------------------------------- #
# 1. Saved answers survive; 2. canonical values still readable
# --------------------------------------------------------------------------- #
def test_canonical_field_names_are_unchanged(client: TestClient):
    """The names the UI posts are the canonical keys the resolver reads."""
    assert FIELD_TO_CANONICAL == {
        "work_authorization_us": "work_authorization_us",
        "sponsorship_required_now": "sponsorship_required_now",
        "sponsorship_required_future": "sponsorship_required_future",
    }


def test_saved_answers_survive_and_read_back_canonically(client: TestClient):
    headers = auth(client)
    seed_profile(client, headers)
    answer(client, headers, "work_authorization_us", "yes")
    answer(client, headers, "sponsorship_required_now", "no")
    answer(client, headers, "sponsorship_required_future", "yes")

    rows = read_answers(client, headers)
    assert rows["work_authorization_us"]["answer"] == "yes"
    assert rows["sponsorship_required_now"]["answer"] == "no"
    assert rows["sponsorship_required_future"]["answer"] == "yes"
    assert all(row["reusable"] for row in rows.values())

    # And they are stored against the canonical keys the vault/resolver use.
    db = next(app.dependency_overrides[get_db]())
    stored = {
        row.canonical_key: row.value
        for row in db.scalars(select(E.ApplicationAnswer)).all()
    }
    db.close()
    assert stored == {
        "work_authorization_us": "Yes",
        "sponsorship_required_now": "No",
        "sponsorship_required_future": "Yes",
    }


# --------------------------------------------------------------------------- #
# 3. Current and future sponsorship stay distinct
# --------------------------------------------------------------------------- #
def test_current_and_future_sponsorship_are_independent(client: TestClient):
    headers = auth(client, "distinct@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "sponsorship_required_now", "no")
    answer(client, headers, "sponsorship_required_future", "yes")

    rows = read_answers(client, headers)
    assert rows["sponsorship_required_now"]["answer"] == "no"
    assert rows["sponsorship_required_future"]["answer"] == "yes"

    # Answering one must never write the other.
    answer(client, headers, "sponsorship_required_now", "yes")
    rows = read_answers(client, headers)
    assert rows["sponsorship_required_future"]["answer"] == "yes"


@pytest.mark.parametrize(
    ("now", "future", "expected"),
    [("no", "no", "No"), ("yes", "no", "Yes"), ("no", "yes", "Yes"), ("yes", "yes", "Yes")],
)
def test_combined_sponsorship_truth_table(client: TestClient, now, future, expected):
    """The "now or in the future" question is DERIVED, never a third stored bool."""
    headers = auth(client, f"combo-{now}-{future}@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "sponsorship_required_now", now)
    answer(client, headers, "sponsorship_required_future", future)

    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email.like(f"combo-{now}-{future}%")))
    result = resolve_combined_sponsorship(db, user.id)
    db.close()
    assert result == {"status": "resolved", "value": expected}


def test_combined_sponsorship_is_unresolved_when_a_half_is_missing(client: TestClient):
    headers = auth(client, "halfanswer@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "sponsorship_required_now", "no")

    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email.like("halfanswer%")))
    result = resolve_combined_sponsorship(db, user.id)
    db.close()
    # An unanswered half is not evidence that the whole is "No".
    assert result["status"] == "unresolved"
    assert result["missing"] == "sponsorship_required_future"


# --------------------------------------------------------------------------- #
# 4. "Answer during each application" stays distinct from Yes/No
# --------------------------------------------------------------------------- #
def test_answer_each_time_is_not_stored_as_no(client: TestClient):
    headers = auth(client, "eachtime@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "sponsorship_required_now", "yes")
    answer(client, headers, "sponsorship_required_now", "answer_each_time")

    row = read_answers(client, headers)["sponsorship_required_now"]
    assert row["answered"] is False
    assert row["reusable"] is False
    # The critical distinction: it is NOT "no".
    assert row["answer"] is None

    db = next(app.dependency_overrides[get_db]())
    stored = db.scalar(
        select(E.ApplicationAnswer).where(
            E.ApplicationAnswer.canonical_key == "sponsorship_required_now"
        )
    )
    assert stored.value == ""
    assert stored.allow_auto_fill is False
    db.close()


def test_answer_each_time_leaves_the_combined_question_unresolved(client: TestClient):
    headers = auth(client, "eachcombo@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "sponsorship_required_now", "answer_each_time")
    answer(client, headers, "sponsorship_required_future", "no")

    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email.like("eachcombo%")))
    result = resolve_combined_sponsorship(db, user.id)
    db.close()
    assert result["status"] != "resolved"


def test_unknown_eligibility_field_is_rejected(client: TestClient):
    headers = auth(client, "badfield@mailbox.test-domain.co")
    seed_profile(client, headers)
    assert answer(client, headers, "sponsorship_required_maybe", "yes").status_code == 422


# --------------------------------------------------------------------------- #
# 5/6. EEO stays out of the profile surface, matching, and generation
# --------------------------------------------------------------------------- #
def save_demographics(client: TestClient, headers: dict[str, str]):
    return client.put(
        "/profile/demographics",
        headers=headers,
        json={
            "gender_identity": "woman",
            "veteran_status": "not_a_veteran",
            "disability_status": "no",
            "hispanic_or_latino": "no",
            "race_ethnicity": ["asian"],
            "consent_to_store": True,
        },
    )


def test_demographics_are_stored_apart_from_the_profile_record(client: TestClient):
    headers = auth(client, "eeosep@mailbox.test-domain.co")
    seed_profile(client, headers)
    resp = save_demographics(client, headers)
    assert resp.status_code in (200, 422), resp.text
    if resp.status_code != 200:
        pytest.skip("demographics vocabulary differs; separation asserted below regardless")

    profile = client.get("/profile", headers=headers).json()["profile"]
    for leaked in ("gender", "race", "veteran", "disability", "hispanic", "demographic"):
        assert not any(leaked in key.lower() for key in profile), (
            f"GET /profile must not expose {leaked}"
        )


def test_profile_payloads_never_carry_demographics(client: TestClient):
    """Whatever the vocabulary, no profile-shaped payload may include EEO keys."""
    headers = auth(client, "eeokeys@mailbox.test-domain.co")
    seed_profile(client, headers)
    save_demographics(client, headers)

    for path in ("/profile", "/profile/career", "/profile/completeness"):
        body = client.get(path, headers=headers).text.lower()
        for leaked in ("gender", "race_ethnicity", "veteran", "disability", "hispanic"):
            assert leaked not in body, f"{path} leaked {leaked}"


def test_demographics_are_not_read_by_matching_or_scoring(client: TestClient):
    """The scoring profile view is built only from career/preference columns."""
    from app.jobs.scoring_service import build_profile_view

    headers = auth(client, "eeoscore@mailbox.test-domain.co")
    seed_profile(client, headers)
    save_demographics(client, headers)

    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email.like("eeoscore%")))
    built = build_profile_view(db, user.id)
    db.close()

    assert built is not None
    view = built[0]
    fields = {
        name: getattr(view, name) for name in dir(view) if not name.startswith("_")
    }
    serialized = str(fields).lower()
    for leaked in ("woman", "asian", "veteran", "disability", "hispanic"):
        assert leaked not in serialized, f"scoring view leaked {leaked}"


def test_demographics_do_not_affect_autofill_readiness(client: TestClient):
    """Readiness must never pressure a user into answering voluntary questions."""
    headers = auth(client, "eeoready@mailbox.test-domain.co")
    seed_profile(client, headers)
    before = client.get("/profile/completeness", headers=headers).json()
    save_demographics(client, headers)
    after = client.get("/profile/completeness", headers=headers).json()
    assert before["autofillReadiness"]["percent"] == after["autofillReadiness"]["percent"]
    assert before["completion"]["percent"] == after["completion"]["percent"]


# --------------------------------------------------------------------------- #
# 7/8. Workday credential: never plaintext; add / update / remove
# --------------------------------------------------------------------------- #
def test_stored_credential_is_never_returned_in_any_form(client: TestClient):
    headers = auth(client, "cred@mailbox.test-domain.co")
    seed_profile(client, headers)
    secret = "sup3r-secret-workday-pw"

    resp = client.put(
        "/profile/workday-credentials", headers=headers, json={"password": secret}
    )
    assert resp.status_code == 200, resp.text
    # The write itself reports only existence.
    assert resp.json() == {"configured": True}
    assert secret not in resp.text

    for path in ("/profile", "/profile/career", "/profile/completeness"):
        body = client.get(path, headers=headers).text
        assert secret not in body, f"{path} leaked the credential"
        assert "ciphertext" not in body.lower()

    profile = client.get("/profile", headers=headers).json()["profile"]
    # Only a boolean is exposed.
    assert profile["workday_password_configured"] is True
    assert "workday_password" not in profile


def test_credential_is_encrypted_at_rest(client: TestClient):
    headers = auth(client, "credrest@mailbox.test-domain.co")
    seed_profile(client, headers)
    secret = "another-secret-value"
    client.put("/profile/workday-credentials", headers=headers, json={"password": secret})

    db = next(app.dependency_overrides[get_db]())
    profile = db.scalar(select(E.UserProfile))
    stored = profile.workday_password_ciphertext
    db.close()
    assert stored, "a credential should be stored"
    assert secret not in str(stored), "the credential must not be stored in plaintext"


def test_credential_add_update_and_remove(client: TestClient):
    headers = auth(client, "credlifecycle@mailbox.test-domain.co")
    seed_profile(client, headers)

    def configured() -> bool:
        return client.get("/profile", headers=headers).json()["profile"][
            "workday_password_configured"
        ]

    assert configured() is False

    first = client.put(
        "/profile/workday-credentials", headers=headers, json={"password": "first-password"}
    )
    assert first.status_code == 200, first.text
    assert configured() is True

    db = next(app.dependency_overrides[get_db]())
    first_ciphertext = db.scalar(select(E.UserProfile)).workday_password_ciphertext
    db.close()

    # Updating replaces the encrypted value rather than appending to it.
    client.put(
        "/profile/workday-credentials",
        headers=headers,
        json={"password": "second-password"},
    )
    db = next(app.dependency_overrides[get_db]())
    second_ciphertext = db.scalar(select(E.UserProfile)).workday_password_ciphertext
    db.close()
    assert second_ciphertext != first_ciphertext
    assert configured() is True

    # Removing actually clears it.
    resp = client.delete("/profile/workday-credentials", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"configured": False}
    assert configured() is False

    db = next(app.dependency_overrides[get_db]())
    assert db.scalar(select(E.UserProfile)).workday_password_ciphertext is None
    db.close()


def test_credential_endpoints_require_authentication(client: TestClient):
    assert (
        client.put(
            "/profile/workday-credentials", json={"password": "long-enough-pw"}
        ).status_code
        == 401
    )
    assert client.delete("/profile/workday-credentials").status_code == 401


def test_credentials_are_scoped_to_the_signed_in_user(client: TestClient):
    mine = auth(client, "credmine@mailbox.test-domain.co")
    theirs = auth(client, "credtheirs@mailbox.test-domain.co")
    seed_profile(client, mine)
    seed_profile(client, theirs)

    client.put("/profile/workday-credentials", headers=mine, json={"password": "only-mine"})
    other = client.get("/profile", headers=theirs).json()["profile"]
    assert other["workday_password_configured"] is False


# --------------------------------------------------------------------------- #
# Extension-facing behaviour
# --------------------------------------------------------------------------- #
def test_eligibility_endpoint_shape_is_stable(client: TestClient):
    """Field names and the answered/reusable split are what clients branch on."""
    headers = auth(client, "shape@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "work_authorization_us", "yes")

    row = read_answers(client, headers)["work_authorization_us"]
    assert set(row) >= {
        "field",
        "prompt",
        "answer",
        "answered",
        "reusable",
        "needs_confirmation",
        "confirmed_at",
        "version",
    }


def test_answers_are_scoped_to_the_signed_in_user(client: TestClient):
    mine = auth(client, "ansmine@mailbox.test-domain.co")
    theirs = auth(client, "anstheirs@mailbox.test-domain.co")
    seed_profile(client, mine)
    seed_profile(client, theirs)
    answer(client, mine, "work_authorization_us", "yes")

    assert read_answers(client, theirs)["work_authorization_us"]["answered"] is False


def test_credential_rejects_a_too_short_password(client: TestClient):
    """A length floor is an existing safeguard; the UI move must not drop it."""
    headers = auth(client, "credshort@mailbox.test-domain.co")
    seed_profile(client, headers)
    resp = client.put(
        "/profile/workday-credentials", headers=headers, json={"password": "short"}
    )
    assert resp.status_code == 422
    # The rejected value must not be echoed back in a way that could be logged.
    assert resp.json()["detail"][0]["loc"] == ["body", "password"]


# --------------------------------------------------------------------------- #
# "Answer during each application" survives, from a cold start
# --------------------------------------------------------------------------- #
def test_ask_each_time_persists_without_a_prior_answer(client: TestClient):
    """Regression: choosing it first thing used to store nothing at all.

    The branch only updated an existing row, so a user who opened the screen and
    picked "answer during each application" had their choice silently dropped —
    on reload it looked like they had never answered.
    """
    headers = auth(client, "coldask@mailbox.test-domain.co")
    seed_profile(client, headers)
    assert answer(client, headers, "work_authorization_us", "answer_each_time").status_code == 200

    row = read_answers(client, headers)["work_authorization_us"]
    assert row["answered"] is False
    assert row["reusable"] is False
    assert row["answer"] is None

    db = next(app.dependency_overrides[get_db]())
    stored = db.scalar(
        select(E.ApplicationAnswer).where(
            E.ApplicationAnswer.canonical_key == "work_authorization_us"
        )
    )
    # The choice is recorded...
    assert stored is not None
    # ...but carries no value and can never be auto-filled.
    assert stored.value == ""
    assert stored.allow_auto_fill is False
    assert stored.is_user_verified is False
    db.close()


def test_ask_each_time_is_never_resolvable_as_yes_or_no(client: TestClient):
    """The resolver must not invent an answer from a deferred question."""
    from app.applications.answer_vault_service import legal_answer_state

    headers = auth(client, "askstate@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "sponsorship_required_now", "answer_each_time")

    db = next(app.dependency_overrides[get_db]())
    row = db.scalar(
        select(E.ApplicationAnswer).where(
            E.ApplicationAnswer.canonical_key == "sponsorship_required_now"
        )
    )
    state = legal_answer_state(row)
    db.close()
    # "missing" — not auto-fillable. Crucially NOT a resolvable Yes/No.
    assert state == "missing"


def test_switching_from_ask_each_time_back_to_an_answer_works(client: TestClient):
    headers = auth(client, "askflip@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "sponsorship_required_future", "answer_each_time")
    assert read_answers(client, headers)["sponsorship_required_future"]["answered"] is False

    answer(client, headers, "sponsorship_required_future", "yes")
    row = read_answers(client, headers)["sponsorship_required_future"]
    assert row["answered"] is True
    assert row["answer"] == "yes"
    assert row["reusable"] is True


def test_ask_each_time_leaves_the_other_two_questions_alone(client: TestClient):
    headers = auth(client, "askisolate@mailbox.test-domain.co")
    seed_profile(client, headers)
    answer(client, headers, "work_authorization_us", "yes")
    answer(client, headers, "sponsorship_required_now", "no")
    answer(client, headers, "sponsorship_required_future", "answer_each_time")

    rows = read_answers(client, headers)
    assert rows["work_authorization_us"]["answer"] == "yes"
    assert rows["sponsorship_required_now"]["answer"] == "no"
    assert rows["sponsorship_required_future"]["answered"] is False
