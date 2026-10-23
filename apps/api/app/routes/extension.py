"""Extension-first authentication and independent (direct) application drafts.

The browser extension signs in through a trusted XpertApply page using an
authorization-code + PKCE exchange, then holds a short-lived *extension* access
token and a rotating refresh credential inside its service worker. That token is
deliberately not a website login token: it is accepted only by the routes below,
never by the general API, and it dies the moment its credential family is
revoked.

``/extension/direct-sessions`` lets an authenticated extension open an
application draft for the page the user is on, without a website-created launch.
It derives ownership from the token and the job from the URL the extension
reports; it never accepts a user id and returns a token scoped to that one
session, exactly like the website handoff does.
"""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlparse

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.applications.preparation import PreparationError
from app.applications.session_service import create_application_session
from app.applications.url_validation import InvalidApplicationURL, validate_official_url
from app.core.config import settings
from app.core.session_tokens import create_session_token, hash_token
from app.db.session import get_db
from app.models.entities import (
    ExtensionAuthCode,
    ExtensionCredential,
    JobPosting,
    User,
)
from app.routes.applications import _preparation_error_response, _rate_limit, _serialize_session

router = APIRouter(prefix="/extension", tags=["extension"])
_bearer = HTTPBearer(auto_error=False)

ALGORITHM = "HS256"
ACCESS_TOKEN_TTL_MINUTES = 30
AUTH_CODE_TTL_SECONDS = 120
REFRESH_TTL_DAYS = 30

# Chrome's identity API redirects to https://<extension-id>.chromiumapp.org/...
# An extension id is 32 characters in a-p. Anything else is not an extension.
_REDIRECT_RE = re.compile(r"^https://[a-p]{32}\.chromiumapp\.org/[A-Za-z0-9._~/-]{0,100}$")
_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


# --------------------------------------------------------------------------- #
# Tokens
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def _access_token(user_id: int, family_id: str) -> str:
    # No ``sub`` claim on purpose: ``decode_access_token`` keys on it, so this
    # token can never be mistaken for a website login token.
    return jwt.encode(
        {
            "typ": "ext",
            "uid": int(user_id),
            "fam": family_id,
            "exp": int((_now() + timedelta(minutes=ACCESS_TOKEN_TTL_MINUTES)).timestamp()),
        },
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def _issue(db: Session, user: User, family_id: str | None = None) -> dict[str, Any]:
    family = family_id or secrets.token_hex(16)
    refresh = secrets.token_urlsafe(48)
    db.add(
        ExtensionCredential(
            user_id=user.id,
            family_id=family,
            refresh_hash=hash_token(refresh),
            expires_at=_now() + timedelta(days=REFRESH_TTL_DAYS),
        )
    )
    return {
        "access_token": _access_token(user.id, family),
        "refresh_token": refresh,
        "expires_in": ACCESS_TOKEN_TTL_MINUTES * 60,
        "user": {"id": user.id, "email": user.email},
    }


def _revoke_family(db: Session, family_id: str) -> None:
    now = _now()
    for row in db.scalars(
        select(ExtensionCredential).where(
            ExtensionCredential.family_id == family_id, ExtensionCredential.revoked_at.is_(None)
        )
    ):
        row.revoked_at = now


def get_extension_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """Authenticate an extension access token whose credential family is live."""
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    try:
        claims = jwt.decode(credentials.credentials, settings.secret_key, algorithms=[ALGORITHM])
    except InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from None
    uid, fam = claims.get("uid"), claims.get("fam")
    if claims.get("typ") != "ext" or not isinstance(uid, int) or not isinstance(fam, str):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    live = db.scalar(
        select(ExtensionCredential.id).where(
            ExtensionCredential.family_id == fam,
            ExtensionCredential.user_id == uid,
            ExtensionCredential.revoked_at.is_(None),
        ).limit(1)
    )
    if live is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Extension access revoked")
    user = db.get(User, uid)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


# --------------------------------------------------------------------------- #
# Authorization-code + PKCE
# --------------------------------------------------------------------------- #
class CodeIn(BaseModel):
    code_challenge: str = Field(min_length=43, max_length=43)
    redirect_uri: str = Field(max_length=300)


class TokenIn(BaseModel):
    grant_type: Literal["authorization_code", "refresh_token"]
    code: str | None = Field(default=None, max_length=200)
    code_verifier: str | None = Field(default=None, max_length=128)
    redirect_uri: str | None = Field(default=None, max_length=300)
    refresh_token: str | None = Field(default=None, max_length=200)


class RevokeIn(BaseModel):
    refresh_token: str = Field(max_length=200)


@router.post("/auth/code")
def create_code(
    payload: CodeIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """Called by the signed-in website's connect page, never by the extension."""
    _rate_limit(f"extcode:{user.id}", limit=10, window_seconds=60)
    if not _CHALLENGE_RE.match(payload.code_challenge) or not _REDIRECT_RE.match(payload.redirect_uri):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid extension authorization request")
    code = secrets.token_urlsafe(32)
    db.add(
        ExtensionAuthCode(
            user_id=user.id,
            code_hash=hash_token(code),
            code_challenge=payload.code_challenge,
            redirect_uri=payload.redirect_uri,
            expires_at=_now() + timedelta(seconds=AUTH_CODE_TTL_SECONDS),
        )
    )
    db.commit()
    return {"code": code}


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


@router.post("/auth/token")
def token(payload: TokenIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _rate_limit("exttoken", limit=120, window_seconds=60)
    if payload.grant_type == "authorization_code":
        if not payload.code or not payload.code_verifier or not payload.redirect_uri:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid grant")
        row = db.scalar(select(ExtensionAuthCode).where(ExtensionAuthCode.code_hash == hash_token(payload.code)))
        # Single use: mark it spent before anything else can fail, so a replayed
        # or guessed-verifier attempt cannot be retried against the same code.
        if row is None or row.used_at is not None or _aware(row.expires_at) < _now():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid grant")
        row.used_at = _now()
        db.flush()
        verifier_ok = _VERIFIER_RE.match(payload.code_verifier) is not None and secrets.compare_digest(
            _pkce_challenge(payload.code_verifier), row.code_challenge
        )
        if not verifier_ok or payload.redirect_uri != row.redirect_uri:
            db.commit()
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid grant")
        user = db.get(User, row.user_id)
        if user is None:
            db.commit()
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid grant")
        body = _issue(db, user)
        db.commit()
        return body

    if not payload.refresh_token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid grant")
    cred = db.scalar(
        select(ExtensionCredential).where(ExtensionCredential.refresh_hash == hash_token(payload.refresh_token))
    )
    if cred is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    if cred.revoked_at is not None or _aware(cred.expires_at) < _now():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    if cred.rotated_at is not None:
        # A token that was already exchanged is being replayed: assume theft and
        # end the whole family, including the holder's newest token.
        _revoke_family(db, cred.family_id)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    user = db.get(User, cred.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    cred.rotated_at = _now()
    body = _issue(db, user, cred.family_id)
    db.commit()
    return body


@router.post("/auth/revoke", status_code=status.HTTP_204_NO_CONTENT)
def revoke(payload: RevokeIn, db: Session = Depends(get_db)) -> Response:
    """Logout. Always 204 so the endpoint reveals nothing about token validity."""
    cred = db.scalar(
        select(ExtensionCredential).where(ExtensionCredential.refresh_hash == hash_token(payload.refresh_token))
    )
    if cred is not None:
        _revoke_family(db, cred.family_id)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me")
def me(user: User = Depends(get_extension_user)) -> dict[str, Any]:
    return {"id": user.id, "email": user.email}


# --------------------------------------------------------------------------- #
# Direct (independent) application drafts
# --------------------------------------------------------------------------- #
class DirectSessionIn(BaseModel):
    url: str = Field(max_length=1000)
    company: str | None = Field(default=None, max_length=200)
    job_title: str | None = Field(default=None, max_length=300)


def _canonical_direct_url(url: str) -> str:
    parsed = urlparse(url.strip())
    # Query strings and fragments carry tracking ids, tokens and emails; the
    # application's identity is its origin and path.
    return f"{parsed.scheme.lower()}://{(parsed.hostname or '').lower()}{parsed.path.rstrip('/') or '/'}"


def _direct_job(db: Session, user: User, payload: DirectSessionIn, canonical: str) -> JobPosting:
    external_id = f"direct:{user.id}:{hashlib.sha256(canonical.encode()).hexdigest()[:32]}"
    job = db.scalar(
        select(JobPosting).where(JobPosting.source_id.is_(None), JobPosting.external_id == external_id)
    )
    host = urlparse(canonical).hostname or "employer"
    company = (payload.company or "").strip() or host
    title = (payload.job_title or "").strip() or "Job application"
    if job is None:
        job = JobPosting(
            source_id=None,
            external_id=external_id,
            title=title,
            company=company,
            company_domain=host[:255],
            application_url=canonical,
            source_url=canonical,
            # Private to the user who opened it: never listed, matched or shared.
            is_active=False,
            hash_for_deduplication=f"direct-{external_id}"[:64],
            raw_json={"origin": "extension_direct", "user_id": user.id},
        )
        db.add(job)
        db.flush()
    return job


@router.post("/direct-sessions", status_code=status.HTTP_201_CREATED)
async def create_direct_session(
    payload: DirectSessionIn,
    request: Request,
    user: User = Depends(get_extension_user),
    db: Session = Depends(get_db),
):
    request_id = getattr(request.state, "request_id", None)
    _rate_limit(f"direct:{user.id}", limit=20, window_seconds=60)
    try:
        validate_official_url(payload.url)
    except InvalidApplicationURL as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    canonical = _canonical_direct_url(payload.url)
    try:
        job = _direct_job(db, user, payload, canonical)
        session, _launch_token = await create_application_session(db, user, job)
    except PreparationError as exc:
        return _preparation_error_response(exc, request_id)
    except OperationalError:
        db.rollback()
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database unavailable") from None
    # The extension never needs the website launch token for a direct draft: it
    # already holds the user's extension credential, so the launch token is
    # voided rather than left redeemable.
    session.launch_token_hash = None
    session.launch_token_used = True
    db.commit()
    body = _serialize_session(db, session)
    body["session_token"] = create_session_token(session.id, user.id)
    return body
