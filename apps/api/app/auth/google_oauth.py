from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import secrets
import time
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
import redis
from jwt import InvalidTokenError, PyJWKSet

from app.core.config import settings

logger = logging.getLogger("jobpilot.auth.google")

GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}
GOOGLE_ALGORITHMS = ["RS256"]
HANDOFF_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")


def random_token() -> str:
    return secrets.token_urlsafe(32)


def s256(value: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(value.encode()).digest()).rstrip(b"=").decode()


@dataclass(frozen=True)
class OAuthTransaction:
    nonce: str
    pkce_verifier: str
    browser_binding_hash: str
    handoff_challenge: str
    return_path: str
    created_at: int


@dataclass(frozen=True)
class Completion:
    result: str
    handoff_challenge: str
    return_path: str
    user_id: int | None = None
    link_ticket: str | None = None


@dataclass(frozen=True)
class PendingLink:
    provider: str
    subject: str
    provider_email: str
    display_name: str | None
    expected_user_id: int


class TemporaryAuthStore:
    """Fail-closed Redis storage for one-use OAuth, completion, and link records."""

    def __init__(self, url: str | None = None):
        self.client = redis.Redis.from_url(
            url or settings.redis_url,
            socket_connect_timeout=2,
            socket_timeout=2,
            decode_responses=True,
        )

    def put(self, kind: str, token: str, value: object, ttl: int) -> None:
        self.client.set(f"xa:auth:{kind}:{token}", json.dumps(asdict(value)), ex=ttl)

    def consume(self, kind: str, token: str) -> dict[str, Any] | None:
        raw = self.client.getdel(f"xa:auth:{kind}:{token}")
        return json.loads(raw) if raw else None

    def peek(self, kind: str, token: str) -> dict[str, Any] | None:
        raw = self.client.get(f"xa:auth:{kind}:{token}")
        return json.loads(raw) if raw else None

    def rate_limit(self, key: str, limit: int, ttl: int) -> bool:
        redis_key = f"xa:auth:limit:{key}"
        with self.client.pipeline() as pipe:
            pipe.incr(redis_key)
            pipe.expire(redis_key, ttl, nx=True)
            count, _ = pipe.execute()
        return int(count) <= limit


class GoogleOIDCClient:
    def __init__(self) -> None:
        self._jwks: PyJWKSet | None = None
        self._jwks_expires_at = 0.0

    def _fetch_jwks(self, *, force: bool = False) -> PyJWKSet:
        if not force and self._jwks is not None and time.monotonic() < self._jwks_expires_at:
            return self._jwks
        response = httpx.get(GOOGLE_JWKS_ENDPOINT, timeout=5.0)
        response.raise_for_status()
        if len(response.content) > 262_144:
            raise ValueError("JWKS response too large")
        self._jwks = PyJWKSet.from_dict(response.json())
        self._jwks_expires_at = time.monotonic() + 300
        return self._jwks

    def exchange_code(self, code: str, verifier: str) -> str:
        response = httpx.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": settings.google_oauth_client_id,
                "client_secret": settings.google_oauth_client_secret,
                "redirect_uri": settings.google_oauth_redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            },
            timeout=8.0,
        )
        response.raise_for_status()
        token = response.json().get("id_token")
        if not isinstance(token, str):
            raise ValueError("ID token missing")
        return token

    def verify_id_token(self, token: str, nonce: str) -> dict[str, Any]:
        header = jwt.get_unverified_header(token)
        if header.get("alg") not in GOOGLE_ALGORITHMS or not isinstance(header.get("kid"), str):
            raise InvalidTokenError("Disallowed signing metadata")
        jwks = self._fetch_jwks()
        key = next((item.key for item in jwks.keys if item.key_id == header["kid"]), None)
        if key is None:
            jwks = self._fetch_jwks(force=True)
            key = next((item.key for item in jwks.keys if item.key_id == header["kid"]), None)
        if key is None:
            raise InvalidTokenError("Unknown signing key")
        claims = jwt.decode(
            token,
            key,
            algorithms=GOOGLE_ALGORITHMS,
            audience=settings.google_oauth_client_id,
            issuer=list(GOOGLE_ISSUERS),
            options={"require": ["exp", "iat", "iss", "aud", "sub", "nonce"]},
        )
        if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
            raise InvalidTokenError("Nonce mismatch")
        audience = claims.get("aud")
        if (
            isinstance(audience, list)
            and len(audience) > 1
            and claims.get("azp") != settings.google_oauth_client_id
        ):
            raise InvalidTokenError("Authorized party mismatch")
        if not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise InvalidTokenError("Subject missing")
        return claims


def configured() -> bool:
    return bool(
        settings.google_oauth_enabled
        and settings.google_oauth_client_id
        and settings.google_oauth_client_secret
        and settings.google_oauth_redirect_uri
        and settings.google_oauth_web_callback_url
    )


def authorization_url(state: str, transaction: OAuthTransaction) -> str:
    return f"{GOOGLE_AUTHORIZATION_ENDPOINT}?{urlencode({
        'client_id': settings.google_oauth_client_id,
        'response_type': 'code',
        'redirect_uri': settings.google_oauth_redirect_uri,
        'scope': 'openid email profile',
        'state': state,
        'nonce': transaction.nonce,
        'code_challenge': s256(transaction.pkce_verifier),
        'code_challenge_method': 'S256',
    })}"


def safe_event(name: str, category: str | None = None) -> None:
    logger.info("auth_event=%s category=%s", name, category or "none")
