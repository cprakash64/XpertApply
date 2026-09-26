from __future__ import annotations

from collections.abc import Generator

import pytest
from sqlalchemy import create_engine, delete, event, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.external_identities import (
    ExternalIdentityLinkCode,
    ExternalIdentityLinkError,
    ExternalIdentityOutcome,
    VerifiedExternalIdentity,
    attach_external_identity,
    create_provider_user,
    get_external_identity,
    get_user_external_identities,
)
from app.db.base import Base
from app.models.entities import ExternalIdentity, User, UserProfile


@pytest.fixture()
def db() -> Generator[Session, None, None]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(engine, "connect", lambda connection, _record: connection.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _password_user(db: Session, email: str) -> User:
    user = User(email=email, hashed_password="real-password-hash")
    db.add(user)
    db.flush()
    db.add(UserProfile(user_id=user.id))
    db.commit()
    return user


def _claims(provider: str = "google", subject: str = "google-sub-1", email: str | None = "new@example.com"):
    return VerifiedExternalIdentity(
        provider=provider,
        subject=subject,
        provider_email=email,
        email_verified=email is not None,
        display_name="Provider User",
    )


def test_new_verified_identity_creates_one_provider_user_profile_and_identity(db: Session) -> None:
    result = create_provider_user(db, _claims())
    db.commit()

    assert result.outcome is ExternalIdentityOutcome.CREATED
    assert result.user is not None and result.user.hashed_password is None
    assert result.user.email == "new@example.com"
    assert db.scalar(select(func.count()).select_from(User)) == 1
    assert db.scalar(select(func.count()).select_from(UserProfile)) == 1
    assert db.scalar(select(func.count()).select_from(ExternalIdentity)) == 1


def test_existing_subject_returns_existing_user_even_without_fresh_email(db: Session) -> None:
    created = create_provider_user(db, _claims())
    db.commit()

    result = create_provider_user(db, _claims(email=None))

    assert result.outcome is ExternalIdentityOutcome.EXISTING
    assert result.user.id == created.user.id
    assert db.scalar(select(func.count()).select_from(User)) == 1


def test_new_identity_requires_verified_email(db: Session) -> None:
    missing = create_provider_user(db, _claims(email=None))
    unverified = create_provider_user(
        db,
        VerifiedExternalIdentity(
            provider="google",
            subject="sub-unverified",
            provider_email="unverified@example.com",
            email_verified=False,
        ),
    )

    assert missing.outcome is ExternalIdentityOutcome.VERIFIED_EMAIL_REQUIRED
    assert unverified.outcome is ExternalIdentityOutcome.VERIFIED_EMAIL_REQUIRED
    assert db.scalar(select(func.count()).select_from(User)) == 0


def test_same_email_password_account_requires_explicit_link(db: Session) -> None:
    existing = _password_user(db, "collision@example.com")

    result = create_provider_user(db, _claims(email="collision@example.com"))

    assert result.outcome is ExternalIdentityOutcome.EMAIL_LINK_REQUIRED
    assert db.get(User, existing.id).hashed_password == "real-password-hash"
    assert db.scalar(select(func.count()).select_from(ExternalIdentity)) == 0


def test_creation_failure_rolls_back_all_three_rows(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    original_flush = db.flush
    calls = 0

    def fail_second_flush(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("synthetic identity insert failure")
        return original_flush(*args, **kwargs)

    monkeypatch.setattr(db, "flush", fail_second_flush)
    with pytest.raises(RuntimeError, match="synthetic identity"):
        create_provider_user(db, _claims())
    monkeypatch.setattr(db, "flush", original_flush)

    assert db.scalar(select(func.count()).select_from(User)) == 0
    assert db.scalar(select(func.count()).select_from(UserProfile)) == 0
    assert db.scalar(select(func.count()).select_from(ExternalIdentity)) == 0


def test_creation_race_resolves_to_constraint_winner(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    winner = create_provider_user(db, _claims()).user
    db.commit()
    real_scalar = db.scalar
    calls = 0

    def hide_preflight(statement, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls <= 2:
            return None
        return real_scalar(statement, *args, **kwargs)

    monkeypatch.setattr(db, "scalar", hide_preflight)
    result = create_provider_user(db, _claims())

    assert result.outcome is ExternalIdentityOutcome.EXISTING
    assert result.user.id == winner.id
    assert real_scalar(select(func.count()).select_from(User)) == 1


def test_provider_subject_and_user_provider_constraints(db: Session) -> None:
    first = _password_user(db, "first@example.com")
    second = _password_user(db, "second@example.com")
    db.add(ExternalIdentity(user_id=first.id, provider="google", subject="same-sub"))
    db.commit()

    db.add(ExternalIdentity(user_id=second.id, provider="google", subject="same-sub"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    db.add(ExternalIdentity(user_id=first.id, provider="google", subject="different-sub"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_google_and_apple_can_coexist_on_one_user(db: Session) -> None:
    user = _password_user(db, "both@example.com")
    google = attach_external_identity(db, user.id, _claims())
    apple = attach_external_identity(db, user.id, _claims("apple", "apple-sub", "relay@privaterelay.appleid.com"))
    db.commit()

    assert {google.provider, apple.provider} == {"google", "apple"}
    assert [row.provider for row in get_user_external_identities(db, user.id)] == ["apple", "google"]


def test_explicit_link_rejects_duplicate_provider_and_foreign_subject(db: Session) -> None:
    first = _password_user(db, "first-link@example.com")
    second = _password_user(db, "second-link@example.com")
    linked = attach_external_identity(db, first.id, _claims())
    db.commit()
    assert get_external_identity(db, "GOOGLE", "google-sub-1").id == linked.id

    with pytest.raises(ExternalIdentityLinkError) as duplicate:
        attach_external_identity(db, first.id, _claims("google", "other-google-sub"))
    assert duplicate.value.code is ExternalIdentityLinkCode.PROVIDER_ALREADY_LINKED

    with pytest.raises(ExternalIdentityLinkError) as foreign:
        attach_external_identity(db, second.id, _claims())
    assert foreign.value.code is ExternalIdentityLinkCode.SUBJECT_OWNED_BY_ANOTHER_USER


def test_provider_and_subject_are_canonicalized_and_validated(db: Session) -> None:
    created = create_provider_user(
        db,
        VerifiedExternalIdentity(
            provider=" Google ",
            subject=" stable-sub ",
            provider_email=" Person@Example.COM ",
            email_verified=True,
        ),
    )
    db.commit()

    assert created.identity.provider == "google"
    assert created.identity.subject == "stable-sub"
    assert created.user.email == "person@example.com"
    with pytest.raises(ValueError):
        create_provider_user(db, _claims(provider="google oauth"))


def test_deleting_user_cascades_external_identity(db: Session) -> None:
    created = create_provider_user(db, _claims())
    db.commit()

    db.execute(delete(User).where(User.id == created.user.id))
    db.commit()

    assert db.scalar(select(func.count()).select_from(ExternalIdentity)) == 0
