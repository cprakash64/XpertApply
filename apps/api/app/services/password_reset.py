"""Password recovery: tokens, rate limits and the two emails.

Security properties this module (with app.routes.auth) provides, following the
OWASP Forgot Password Cheat Sheet:

- The token is 256 random bits (``secrets.token_urlsafe(32)``). Only its SHA-256
  is stored; the token lives in the email alone.
- It is single use and short lived (``password_reset_token_ttl_minutes``). A new
  request replaces any earlier unused token for that user.
- Reset links are built from ``settings.web_base_url``, never a request header,
  and carry the token in the URL FRAGMENT, which browsers do not send to servers
  or in Referer headers and which therefore cannot reach access logs.
- Requests answer identically for known, unknown and provider-only accounts, and
  the email itself is sent after the response, so neither content nor timing
  tells an observer whether an account exists.
- Accounts that signed up with a provider (no local password) never get a reset
  token: they get a plain note pointing them at their sign-in method. Recovery
  cannot be used to add a local password to a provider account.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import time
from collections import deque
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.email import EmailDeliveryError, recipient_fingerprint, send_email
from app.models.entities import PasswordResetToken

logger = logging.getLogger("jobpilot.auth.recovery")

RESET_PATH = "/reset-password"
HOUR = 3600

# --- in-process sliding-window limiter (per worker; the DB cap below is shared) ---
_BUCKETS: dict[str, deque[float]] = {}


def rate_limit(key: str, *, limit: int, window_seconds: int) -> None:
    now = time.monotonic()
    bucket = _BUCKETS.setdefault(key, deque())
    while bucket and now - bucket[0] > window_seconds:
        bucket.popleft()
    if len(bucket) >= limit:
        retry_after = max(1, int(window_seconds - (now - bucket[0])))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please wait a few minutes and try again.",
            headers={"Retry-After": str(retry_after)},
        )
    bucket.append(now)


def reset_rate_limits() -> None:
    _BUCKETS.clear()


def email_key(email: str) -> str:
    return "pwreset:email:" + hashlib.sha256(email.strip().lower().encode()).hexdigest()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def utcnow() -> datetime:
    return datetime.now(UTC)


def aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def issue_token(db: Session, user_id: int) -> str | None:
    """Create a fresh token (replacing any unused one). None when the per-user
    hourly cap, which holds across workers, is already reached."""
    window_start = utcnow() - timedelta(seconds=HOUR)
    recent = db.scalar(
        select(func.count())
        .select_from(PasswordResetToken)
        .where(PasswordResetToken.user_id == user_id, PasswordResetToken.created_at >= window_start)
    )
    if (recent or 0) >= settings.password_reset_per_email_hourly_limit:
        return None
    # Expired or consumed rows are dead weight; unused live ones are superseded.
    db.execute(
        delete(PasswordResetToken).where(
            PasswordResetToken.user_id == user_id,
            (PasswordResetToken.used_at.is_(None)) | (PasswordResetToken.expires_at < utcnow()),
        )
    )
    token = secrets.token_urlsafe(32)
    db.add(
        PasswordResetToken(
            user_id=user_id,
            token_hash=hash_token(token),
            created_at=utcnow(),
            expires_at=utcnow() + timedelta(minutes=settings.password_reset_token_ttl_minutes),
        )
    )
    db.commit()
    return token


def reset_link(token: str) -> str:
    return f"{settings.web_base_url.rstrip('/')}{RESET_PATH}#token={token}"


def send_reset_email(to: str, token: str) -> None:
    """Background task: deliver the reset email. Never raises; failures are
    logged by type and recipient fingerprint only (no address, no link)."""
    minutes = settings.password_reset_token_ttl_minutes
    link = reset_link(token)
    text = (
        "We received a request to reset your XpertApply password.\n\n"
        f"Choose a new password here (the link works once and expires in {minutes} minutes):\n\n"
        f"{link}\n\n"
        "If you did not ask for this, you can ignore this email: your password has not changed.\n"
    )
    html = (
        "<p>We received a request to reset your XpertApply password.</p>"
        f'<p><a href="{link}">Choose a new password</a><br>'
        f"The link works once and expires in {minutes} minutes.</p>"
        "<p>If you did not ask for this, you can ignore this email: your password has not changed.</p>"
    )
    _deliver(to, "Reset your XpertApply password", text, html)


def send_provider_account_notice(to: str) -> None:
    text = (
        "Someone asked to reset the password for this XpertApply account.\n\n"
        "This account signs in with Google and has no XpertApply password, so there is "
        'nothing to reset. Use "Continue with Google" on the sign-in page.\n\n'
        "If you did not ask for this, you can ignore this email.\n"
    )
    _deliver(to, "Sign in to XpertApply", text, None)


def _deliver(to: str, subject: str, text: str, html: str | None) -> None:
    try:
        send_email(to=to, subject=subject, text=text, html=html)
        logger.info("recovery email handed to backend recipient=%s", recipient_fingerprint(to))
    except EmailDeliveryError as exc:
        logger.error("recovery email failed recipient=%s reason=%s", recipient_fingerprint(to), exc)
    except Exception:  # pragma: no cover - the response is already sent; never crash the worker
        logger.exception("recovery email crashed recipient=%s", recipient_fingerprint(to))
