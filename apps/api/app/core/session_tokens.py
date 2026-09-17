"""Short-lived, scoped tokens for the assisted-apply handoff.

Two token types, both signed with the app secret (HS256), independent of the
user's main login token:

- ``launch``  — one-time, ~5 min. Minted by the web app when a session is
  created and handed to the extension. The session also stores only the SHA-256
  of this token; it is invalidated on first exchange.
- ``session`` — ~30 min, scoped to exactly one application session. The
  extension exchanges the launch token for this and uses it as a Bearer token to
  read the session, its documents, and its safe answers — nothing else.

The employer page never receives either token; they live only in the web app and
the extension's isolated context.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt
from jwt import InvalidTokenError

from app.core.config import settings

ALGORITHM = "HS256"
LAUNCH_TOKEN_TTL_MINUTES = 5
SESSION_TOKEN_TTL_MINUTES = 30

TokenType = Literal["launch", "session"]


def create_launch_token(session_id: int, user_id: int) -> str:
    """One-time launch token with a random ``jti`` for hash-based invalidation."""
    return _encode(
        {
            "typ": "launch",
            "sid": int(session_id),
            "uid": int(user_id),
            "jti": secrets.token_urlsafe(16),
        },
        ttl_minutes=LAUNCH_TOKEN_TTL_MINUTES,
    )


def create_session_token(session_id: int, user_id: int) -> str:
    return _encode(
        {"typ": "session", "sid": int(session_id), "uid": int(user_id)},
        ttl_minutes=SESSION_TOKEN_TTL_MINUTES,
    )


def decode_scoped_token(token: str, expected_type: TokenType) -> dict[str, Any] | None:
    payload = _decode(token)
    if payload is None or payload.get("typ") != expected_type:
        return None
    if not isinstance(payload.get("sid"), int) or not isinstance(payload.get("uid"), int):
        return None
    return payload


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _encode(claims: dict[str, Any], *, ttl_minutes: int) -> str:
    expires = datetime.now(UTC) + timedelta(minutes=ttl_minutes)
    payload = {**claims, "exp": int(expires.timestamp())}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def _decode(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except InvalidTokenError:
        return None
