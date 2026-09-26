from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.entities import ExternalIdentity, User, UserProfile

_PROVIDER_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_EMAIL_ADAPTER = TypeAdapter(EmailStr)


class ExternalIdentityOutcome(StrEnum):
    EXISTING = "existing"
    CREATED = "created"
    EMAIL_LINK_REQUIRED = "email_link_required"
    VERIFIED_EMAIL_REQUIRED = "verified_email_required"


class ExternalIdentityLinkCode(StrEnum):
    SUBJECT_OWNED_BY_ANOTHER_USER = "subject_owned_by_another_user"
    PROVIDER_ALREADY_LINKED = "provider_already_linked"
    USER_NOT_FOUND = "user_not_found"


class ExternalIdentityLinkError(Exception):
    def __init__(self, code: ExternalIdentityLinkCode):
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class VerifiedExternalIdentity:
    """Claims accepted only after a caller's cryptographic verification boundary."""

    provider: str
    subject: str
    provider_email: str | None = None
    email_verified: bool = False
    display_name: str | None = None


@dataclass(frozen=True)
class ExternalIdentityResult:
    outcome: ExternalIdentityOutcome
    user: User | None = None
    identity: ExternalIdentity | None = None


def _canonical_claims(claims: VerifiedExternalIdentity) -> VerifiedExternalIdentity:
    provider = claims.provider.strip().lower()
    subject = claims.subject.strip()
    if not _PROVIDER_PATTERN.fullmatch(provider):
        raise ValueError("Invalid external identity provider.")
    if not subject or len(subject) > 255:
        raise ValueError("Invalid external identity subject.")
    email = None
    if claims.provider_email is not None:
        try:
            email = str(_EMAIL_ADAPTER.validate_python(claims.provider_email)).lower()
        except ValidationError as exc:
            raise ValueError("Invalid external identity email.") from exc
    display_name = claims.display_name.strip() if claims.display_name else None
    if display_name and len(display_name) > 200:
        raise ValueError("External identity display name is too long.")
    return VerifiedExternalIdentity(
        provider=provider,
        subject=subject,
        provider_email=email,
        email_verified=claims.email_verified,
        display_name=display_name,
    )


def get_external_identity(
    db: Session, provider: str, subject: str
) -> ExternalIdentity | None:
    claims = _canonical_claims(VerifiedExternalIdentity(provider=provider, subject=subject))
    return db.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.provider == claims.provider,
            ExternalIdentity.subject == claims.subject,
        )
    )


def get_user_external_identities(db: Session, user_id: int) -> list[ExternalIdentity]:
    return list(
        db.scalars(
            select(ExternalIdentity)
            .where(ExternalIdentity.user_id == user_id)
            .order_by(ExternalIdentity.provider)
        )
    )


def _result_for_creation_conflict(
    db: Session, claims: VerifiedExternalIdentity, cause: IntegrityError
) -> ExternalIdentityResult:
    existing = get_external_identity(db, claims.provider, claims.subject)
    if existing is not None:
        return ExternalIdentityResult(
            ExternalIdentityOutcome.EXISTING, existing.user, existing
        )
    if claims.provider_email is not None and db.scalar(
        select(User).where(User.email == claims.provider_email)
    ):
        return ExternalIdentityResult(ExternalIdentityOutcome.EMAIL_LINK_REQUIRED)
    raise cause


def create_provider_user(
    db: Session, verified_identity: VerifiedExternalIdentity
) -> ExternalIdentityResult:
    """Resolve or create an account after provider verification, without committing."""

    claims = _canonical_claims(verified_identity)
    existing = get_external_identity(db, claims.provider, claims.subject)
    if existing is not None:
        return ExternalIdentityResult(
            ExternalIdentityOutcome.EXISTING, existing.user, existing
        )
    if not claims.email_verified or claims.provider_email is None:
        return ExternalIdentityResult(ExternalIdentityOutcome.VERIFIED_EMAIL_REQUIRED)
    if db.scalar(select(User).where(User.email == claims.provider_email)) is not None:
        return ExternalIdentityResult(ExternalIdentityOutcome.EMAIL_LINK_REQUIRED)

    try:
        with db.begin_nested():
            user = User(email=claims.provider_email, hashed_password=None)
            db.add(user)
            db.flush()
            db.add(UserProfile(user_id=user.id))
            identity = ExternalIdentity(
                user_id=user.id,
                provider=claims.provider,
                subject=claims.subject,
                provider_email=claims.provider_email,
                email_verified=claims.email_verified,
                display_name=claims.display_name,
            )
            db.add(identity)
            db.flush()
        return ExternalIdentityResult(ExternalIdentityOutcome.CREATED, user, identity)
    except IntegrityError as exc:
        return _result_for_creation_conflict(db, claims, exc)


def attach_external_identity(
    db: Session,
    authenticated_user_id: int,
    verified_identity: VerifiedExternalIdentity,
) -> ExternalIdentity:
    """Explicitly link verified claims to a trusted, already-authenticated user."""

    claims = _canonical_claims(verified_identity)
    user = db.get(User, authenticated_user_id)
    if user is None:
        raise ExternalIdentityLinkError(ExternalIdentityLinkCode.USER_NOT_FOUND)
    owned = get_external_identity(db, claims.provider, claims.subject)
    if owned is not None:
        code = (
            ExternalIdentityLinkCode.PROVIDER_ALREADY_LINKED
            if owned.user_id == user.id
            else ExternalIdentityLinkCode.SUBJECT_OWNED_BY_ANOTHER_USER
        )
        raise ExternalIdentityLinkError(code)
    if db.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.user_id == user.id,
            ExternalIdentity.provider == claims.provider,
        )
    ):
        raise ExternalIdentityLinkError(ExternalIdentityLinkCode.PROVIDER_ALREADY_LINKED)

    try:
        with db.begin_nested():
            identity = ExternalIdentity(
                user_id=user.id,
                provider=claims.provider,
                subject=claims.subject,
                provider_email=claims.provider_email,
                email_verified=claims.email_verified,
                display_name=claims.display_name,
            )
            db.add(identity)
            db.flush()
        return identity
    except IntegrityError as exc:
        owned = get_external_identity(db, claims.provider, claims.subject)
        if owned is not None and owned.user_id != user.id:
            raise ExternalIdentityLinkError(
                ExternalIdentityLinkCode.SUBJECT_OWNED_BY_ANOTHER_USER
            ) from exc
        raise ExternalIdentityLinkError(
            ExternalIdentityLinkCode.PROVIDER_ALREADY_LINKED
        ) from exc
