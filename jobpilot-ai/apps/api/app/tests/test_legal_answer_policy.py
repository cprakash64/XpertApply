"""The one path that may produce a legal application answer.

Work authorization and sponsorship are legal statements the candidate makes to
an employer. These tests pin the rule that no amount of surrounding evidence —
immigration status, resume text, a prior unconfirmed application — may originate
one. Only an explicitly confirmed answer counts, and its absence is a normal,
safe outcome.
"""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.applications.answer_vault_service import (
    ALLOWED_LEGAL_SOURCES,
    ANSWER_VAULT_CONTRACT_VERSION,
    LEGAL_ANSWER_KEYS,
    build_safe_answers,
    legal_answer_state,
)
from app.core.security import hash_password
from app.db.base import Base
from app.models.entities import ApplicationAnswer, User, UserProfile


@pytest.fixture()
def db() -> Generator[Session, None, None]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()

LEGAL_KEYS = ["work_authorization_us", "sponsorship_required_now", "sponsorship_required_future"]


def _user(db: Session, email: str = "legal@mailbox.test-domain.co") -> User:
    user = User(email=email, hashed_password=hash_password("x" * 12))
    db.add(user)
    db.flush()
    db.add(
        UserProfile(
            user_id=user.id,
            full_name="Test Candidate",
            first_name="Test",
            last_name="Candidate",
            name_confirmed=True,
            application_email=email,
            application_email_confirmed=True,
            skills=["python"],
        )
    )
    db.flush()
    return user


def _answer(db: Session, user: User, key: str, **overrides) -> ApplicationAnswer:
    row = ApplicationAnswer(
        user_id=user.id,
        canonical_key=key,
        value=overrides.pop("value", "Yes"),
        display_value=overrides.pop("display_value", "Yes"),
        scope=overrides.pop("scope", "sensitive"),
        company_key="",
        source=overrides.pop("source", "explicit_profile"),
        is_user_verified=overrides.pop("is_user_verified", True),
        allow_auto_fill=overrides.pop("allow_auto_fill", True),
        verification_required=overrides.pop("verification_required", True),
        last_verified_at=overrides.pop("last_verified_at", datetime.now(UTC)),
        **overrides,
    )
    db.add(row)
    db.flush()
    return row


# --------------------------------------------------------------------------- #
# The gate itself
# --------------------------------------------------------------------------- #
def test_missing_row_is_unanswered_not_no(db: Session) -> None:
    assert legal_answer_state(None) == "missing"


def test_explicit_verified_answer_is_accepted(db: Session) -> None:
    user = _user(db)
    row = _answer(db, user, "work_authorization_us", value="Yes")
    assert legal_answer_state(row) == "explicit_verified"


@pytest.mark.parametrize("value", ["Yes", "No"])
def test_both_yes_and_no_are_emitted_when_explicit(db: Session, value: str) -> None:
    user = _user(db, f"{value}@mailbox.test-domain.co")
    _answer(db, user, "work_authorization_us", value=value, display_value=value)
    answers, _ = build_safe_answers(db, user)
    by_key = {a["canonical_key"]: a for a in answers}
    assert by_key["work_authorization_us"]["value"] == value
    assert by_key["work_authorization_us"]["verified"] is True
    assert by_key["work_authorization_us"]["requires_review"] is False


def test_unverified_answer_is_not_emitted(db: Session) -> None:
    user = _user(db)
    row = _answer(db, user, "work_authorization_us", is_user_verified=False)
    assert legal_answer_state(row) == "unverified"
    answers, unresolved = build_safe_answers(db, user)
    assert "work_authorization_us" not in {a["canonical_key"] for a in answers}
    assert any(
        item["canonical_key"] == "work_authorization_us" and item.get("reason_code") == "unverified"
        for item in unresolved
    )


def test_confirmation_without_a_timestamp_does_not_count(db: Session) -> None:
    user = _user(db)
    row = _answer(db, user, "work_authorization_us", last_verified_at=None)
    assert legal_answer_state(row) == "unverified"


@pytest.mark.parametrize(
    "source",
    [
        "resume_inference",
        "model_inference",
        "visa_inference",
        "previous_unconfirmed_application",
        "location_inference",
        "education_inference",
        "employer_inference",
        "demographic_inference",
        "profile",
    ],
)
def test_disallowed_sources_are_rejected(db: Session, source: str) -> None:
    """Even a correct answer from one of these is not the user's statement."""
    user = _user(db, f"{source}@mailbox.test-domain.co")
    row = _answer(db, user, "work_authorization_us", source=source)
    assert legal_answer_state(row) == "source_not_allowed"
    answers, _ = build_safe_answers(db, user)
    assert "work_authorization_us" not in {a["canonical_key"] for a in answers}


def test_auto_fill_disabled_is_respected(db: Session) -> None:
    user = _user(db)
    row = _answer(db, user, "work_authorization_us", allow_auto_fill=False)
    assert legal_answer_state(row) == "auto_fill_disabled"


def test_a_non_boolean_value_is_not_a_legal_answer(db: Session) -> None:
    user = _user(db)
    row = _answer(db, user, "work_authorization_us", value="Prefer not to say")
    assert legal_answer_state(row) == "invalid_type"


def test_blank_value_is_missing_not_false(db: Session) -> None:
    user = _user(db)
    row = _answer(db, user, "work_authorization_us", value="")
    assert legal_answer_state(row) == "missing"


# --------------------------------------------------------------------------- #
# Contract
# --------------------------------------------------------------------------- #
def test_only_the_four_trusted_sources_are_allowed() -> None:
    assert ALLOWED_LEGAL_SOURCES == {
        "explicit_profile",
        "user_confirmed_application",
        "user_confirmed_saved",
        "verified_answer_vault",
    }


def test_the_three_legal_keys_are_governed() -> None:
    assert LEGAL_ANSWER_KEYS == set(LEGAL_KEYS)


def test_contract_version_is_bumped_past_the_unsafe_era() -> None:
    # v1 was the derivation era; cached answers from it must not be replayed.
    assert ANSWER_VAULT_CONTRACT_VERSION >= 2


def test_every_unanswered_legal_key_reaches_the_user(db: Session) -> None:
    user = _user(db)
    _, unresolved = build_safe_answers(db, user)
    unresolved_keys = {item["canonical_key"] for item in unresolved}
    for key in LEGAL_KEYS:
        assert key in unresolved_keys, f"{key} silently disappeared instead of being asked"


def test_unresolved_items_never_carry_the_answer_value(db: Session) -> None:
    user = _user(db)
    _answer(db, user, "work_authorization_us", value="Yes", is_user_verified=False)
    _, unresolved = build_safe_answers(db, user)
    item = next(i for i in unresolved if i["canonical_key"] == "work_authorization_us")
    # It may say a saved value EXISTS, never what it is.
    assert "Yes" not in str(item)
    assert item["has_saved_value"] is True
