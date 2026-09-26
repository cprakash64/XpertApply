from __future__ import annotations

import logging
import secrets
import time
from urllib.parse import parse_qsl, urlencode, urlparse

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.external_identities import (
    ExternalIdentityLinkError,
    ExternalIdentityOutcome,
    VerifiedExternalIdentity,
    attach_external_identity,
    create_provider_user,
)
from app.auth.google_oauth import (
    HANDOFF_PATTERN,
    Completion,
    GoogleOIDCClient,
    GoogleTokenExchangeError,
    OAuthTransaction,
    PendingLink,
    TemporaryAuthStore,
    authorization_url,
    configured,
    random_token,
    s256,
    safe_event,
)
from app.core.config import settings
from app.core.security import create_access_token, verify_password
from app.db.session import get_db
from app.models.entities import User

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger("jobpilot.auth.google")
BINDING_COOKIE = "xa_google_binding"
store: TemporaryAuthStore | None = None
oidc_client: GoogleOIDCClient = GoogleOIDCClient()


def transaction_ttl() -> int:
    return settings.google_oauth_transaction_ttl_seconds


class CompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    verifier: str


class LinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    link_ticket: str
    password: str


def _store() -> TemporaryAuthStore:
    global store
    if store is None:
        store = TemporaryAuthStore()
    return store


def _error(code: str, message: str, status: int = 400, retryable: bool = False) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "retryable": retryable}},
    )


def _safe_return_path(value: str | None) -> str | None:
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return None
    parsed = urlparse(value)
    if parsed.scheme or parsed.netloc or parsed.path.startswith("/auth/google"):
        return None
    if {key for key, _ in parse_qsl(parsed.query)} & {
        "token",
        "access_token",
        "refresh_token",
        "id_token",
        "code",
    }:
        return None
    return value


def _web_redirect(**params: str) -> RedirectResponse:
    separator = "&" if "?" in settings.google_oauth_web_callback_url else "?"
    return RedirectResponse(
        f"{settings.google_oauth_web_callback_url}{separator}{urlencode(params)}",
        status_code=303,
    )


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(BINDING_COOKIE, path="/auth/google", samesite="lax")


def _callback_error(code: str, message: str, status: int = 400, retryable: bool = False) -> JSONResponse:
    response = _error(code, message, status, retryable)
    _clear_cookie(response)
    return response


@router.get("/providers")
def providers() -> dict:
    return {"google": {"enabled": configured()}}


@router.get("/google/start")
def google_start(handoff_challenge: str, return_to: str = "/dashboard"):
    if not configured():
        return _error("GOOGLE_AUTH_UNAVAILABLE", "Google sign-in is unavailable.", 503, True)
    if not HANDOFF_PATTERN.fullmatch(handoff_challenge):
        return _error("GOOGLE_STATE_INVALID", "The Google sign-in request is invalid.")
    safe_return = _safe_return_path(return_to)
    if safe_return is None:
        return _error("GOOGLE_STATE_INVALID", "The return destination is invalid.")
    state, binding, verifier = random_token(), random_token(), random_token()
    transaction = OAuthTransaction(
        nonce=random_token(),
        pkce_verifier=verifier,
        browser_binding_hash=s256(binding),
        handoff_challenge=handoff_challenge,
        return_path=safe_return,
        created_at=int(__import__("time").time()),
    )
    try:
        _store().put("oauth", state, transaction, transaction_ttl())
    except Exception:
        safe_event("google_auth_failure", "temporary_store")
        return _error("OAUTH_TEMPORARY_FAILURE", "Google sign-in is temporarily unavailable.", 503, True)
    response = RedirectResponse(authorization_url(state, transaction), status_code=303)
    response.set_cookie(
        BINDING_COOKIE,
        binding,
        max_age=transaction_ttl(),
        httponly=True,
        secure=urlparse(settings.google_oauth_redirect_uri).scheme == "https",
        samesite="lax",
        path="/auth/google",
    )
    safe_event("google_auth_started")
    return response


@router.get("/google/callback")
def google_callback(
    request: Request,
    state: str | None = None,
    code: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    if not state:
        return _callback_error("GOOGLE_STATE_INVALID", "The Google sign-in session is invalid.")
    try:
        raw = _store().consume("oauth", state)
    except Exception:
        return _callback_error(
            "OAUTH_TEMPORARY_FAILURE", "Google sign-in is temporarily unavailable.", 503, True
        )
    if raw is None:
        return _callback_error("GOOGLE_SESSION_EXPIRED", "The Google sign-in session expired.")
    transaction = OAuthTransaction(**raw)
    if int(time.time()) - transaction.created_at > transaction_ttl():
        return _callback_error("GOOGLE_SESSION_EXPIRED", "The Google sign-in session expired.")
    binding = request.cookies.get(BINDING_COOKIE)
    if not binding or not secrets.compare_digest(s256(binding), transaction.browser_binding_hash):
        return _callback_error("GOOGLE_STATE_INVALID", "The Google sign-in session is invalid.")
    if error or not code:
        response = _web_redirect(error="GOOGLE_AUTH_CANCELLED")
        _clear_cookie(response)
        return response
    try:
        id_token = oidc_client.exchange_code(code, transaction.pkce_verifier)
        claims = oidc_client.verify_id_token(id_token, transaction.nonce)
        email = claims.get("email")
        if not isinstance(email, str) or not email:
            raise ValueError("email missing")
        verified = VerifiedExternalIdentity(
            provider="google",
            subject=claims["sub"],
            provider_email=email,
            email_verified=claims.get("email_verified") is True,
            display_name=claims.get("name") if isinstance(claims.get("name"), str) else None,
        )
        result = create_provider_user(db, verified)
        if result.outcome is ExternalIdentityOutcome.VERIFIED_EMAIL_REQUIRED:
            db.rollback()
            response = _web_redirect(error="GOOGLE_EMAIL_UNVERIFIED")
        elif result.outcome is ExternalIdentityOutcome.EMAIL_LINK_REQUIRED:
            db.rollback()
            target = db.scalar(select(User).where(User.email == email.strip().lower()))
            if target is None or target.hashed_password is None:
                response = _web_redirect(error="GOOGLE_PROVIDER_CONFLICT")
            else:
                link_ticket = random_token()
                _store().put(
                    "link",
                    link_ticket,
                    PendingLink("google", claims["sub"], email, verified.display_name, target.id),
                    transaction_ttl(),
                )
                completion_code = random_token()
                _store().put(
                    "completion",
                    completion_code,
                    Completion(
                        "link_required",
                        transaction.handoff_challenge,
                        transaction.return_path,
                        link_ticket=link_ticket,
                    ),
                    transaction_ttl(),
                )
                response = _web_redirect(code=completion_code)
                safe_event("google_auth_link_required")
        else:
            db.commit()
            completion_code = random_token()
            _store().put(
                "completion",
                completion_code,
                Completion(
                    "authenticated",
                    transaction.handoff_challenge,
                    transaction.return_path,
                    user_id=result.user.id,
                ),
                transaction_ttl(),
            )
            response = _web_redirect(code=completion_code)
            safe_event(
                "google_auth_new_user"
                if result.outcome is ExternalIdentityOutcome.CREATED
                else "google_auth_existing_user"
            )
        _clear_cookie(response)
        return response
    except GoogleTokenExchangeError as exc:
        db.rollback()
        logger.warning(
            "auth_event=google_auth_failure category=token_exchange_%s upstream_status=%d",
            exc.category,
            exc.status_code,
        )
        response = _web_redirect(error="GOOGLE_TOKEN_INVALID")
        _clear_cookie(response)
        return response
    except Exception as exc:
        db.rollback()
        logger.warning("auth_event=google_auth_failure category=%s", type(exc).__name__)
        response = _web_redirect(error="GOOGLE_TOKEN_INVALID")
        _clear_cookie(response)
        return response


@router.post("/google/complete")
def google_complete(payload: CompleteRequest):
    if not HANDOFF_PATTERN.fullmatch(payload.verifier):
        return _error("GOOGLE_STATE_INVALID", "The Google sign-in completion is invalid.")
    try:
        raw = _store().consume("completion", payload.code)
    except Exception:
        return _error("OAUTH_TEMPORARY_FAILURE", "Google sign-in is temporarily unavailable.", 503, True)
    if raw is None:
        return _error("GOOGLE_SESSION_EXPIRED", "The Google sign-in completion expired.")
    completion = Completion(**raw)
    if not secrets.compare_digest(s256(payload.verifier), completion.handoff_challenge):
        return _error("GOOGLE_STATE_INVALID", "The Google sign-in completion is invalid.")
    if completion.result == "link_required":
        return {
            "result": "link_required",
            "code": "GOOGLE_LINK_REQUIRED",
            "link_ticket": completion.link_ticket,
            "return_to": completion.return_path,
        }
    return {
        "result": "authenticated",
        "access_token": create_access_token(str(completion.user_id)),
        "token_type": "bearer",
        "return_to": completion.return_path,
    }


@router.post("/google/link")
def google_link(payload: LinkRequest, db: Session = Depends(get_db)):
    try:
        auth_store = _store()
        if not auth_store.rate_limit(f"link:{s256(payload.link_ticket)}", 5, 600):
            return _error("GOOGLE_LINK_INVALID", "Unable to connect Google.", 429)
        raw = auth_store.peek("link", payload.link_ticket)
    except Exception:
        return _error("OAUTH_TEMPORARY_FAILURE", "Google linking is temporarily unavailable.", 503, True)
    if raw is None:
        return _error("GOOGLE_LINK_EXPIRED", "The Google linking session expired.")
    pending = PendingLink(**raw)
    user = db.get(User, pending.expected_user_id)
    if user is None or user.hashed_password is None or not verify_password(payload.password, user.hashed_password):
        return _error("GOOGLE_LINK_INVALID", "Unable to connect Google.", 401)
    try:
        consumed = auth_store.consume("link", payload.link_ticket)
    except Exception:
        return _error("OAUTH_TEMPORARY_FAILURE", "Google linking is temporarily unavailable.", 503, True)
    if consumed != raw:
        return _error("GOOGLE_LINK_EXPIRED", "The Google linking session expired.")
    try:
        attach_external_identity(
            db,
            user.id,
            VerifiedExternalIdentity(
                provider=pending.provider,
                subject=pending.subject,
                provider_email=pending.provider_email,
                email_verified=True,
                display_name=pending.display_name,
            ),
        )
        db.commit()
    except ExternalIdentityLinkError:
        db.rollback()
        return _error("GOOGLE_PROVIDER_CONFLICT", "Google is already connected to another account.", 409)
    safe_event("google_auth_link_success")
    return {"access_token": create_access_token(str(user.id)), "token_type": "bearer"}
