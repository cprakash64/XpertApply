"""Security and wire-compatibility contract for the PyJWT migration."""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.metadata as metadata
import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.core import security, session_tokens
from app.core.config import settings


def _expiry(seconds: int = 300) -> datetime:
    return datetime.now(UTC) + timedelta(seconds=seconds)


def _legacy_token(claims: dict, *, secret: str | None = None, algorithm: str = "HS256") -> str:
    def encode(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    header = encode({"alg": algorithm, "typ": "JWT"})
    payload = encode(claims)
    signing_input = f"{header}.{payload}"
    signature = hmac.new(
        (secret or settings.secret_key).encode(), signing_input.encode(), hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return f"{signing_input}.{encoded_signature}"


def test_dependency_replacement_is_exact() -> None:
    assert metadata.version("PyJWT") == "2.14.0"
    assert metadata.version("cryptography") == "50.0.1"
    for removed in ("python-jose", "ecdsa"):
        with pytest.raises(metadata.PackageNotFoundError):
            metadata.version(removed)


def test_access_token_round_trip_and_legacy_compatibility() -> None:
    assert security.decode_access_token(security.create_access_token("42")) == "42"
    legacy = _legacy_token({"sub": "42", "exp": int(_expiry().timestamp())})
    assert security.decode_access_token(legacy) == "42"


@pytest.mark.parametrize("token", ["", "not-a-jwt", "a.b", "a.b.c.d"])
def test_malformed_access_tokens_are_rejected(token: str) -> None:
    assert security.decode_access_token(token) is None


def test_access_tokens_reject_expired_tampered_and_missing_subject() -> None:
    expired = jwt.encode({"sub": "1", "exp": _expiry(-1)}, settings.secret_key, algorithm="HS256")
    tampered = jwt.encode({"sub": "1", "exp": _expiry()}, "wrong-secret", algorithm="HS256")
    missing = jwt.encode({"exp": _expiry()}, settings.secret_key, algorithm="HS256")
    malformed_subject = jwt.encode({"sub": 1, "exp": _expiry()}, settings.secret_key, algorithm="HS256")
    assert security.decode_access_token(expired) is None
    assert security.decode_access_token(tampered) is None
    assert security.decode_access_token(missing) is None
    assert security.decode_access_token(malformed_subject) is None


@pytest.mark.parametrize("algorithm", ["HS384", "HS512", "none"])
def test_access_tokens_reject_every_unapproved_algorithm(algorithm: str) -> None:
    key = "" if algorithm == "none" else settings.secret_key
    token = jwt.encode({"sub": "1", "exp": _expiry()}, key, algorithm=algorithm)
    assert security.decode_access_token(token) is None


def test_algorithm_allow_list_is_load_bearing_negative_control() -> None:
    token = jwt.encode({"sub": "1", "exp": _expiry()}, settings.secret_key, algorithm="HS384")
    assert security.decode_access_token(token) is None
    assert jwt.decode(token, settings.secret_key, algorithms=["HS256", "HS384"])["sub"] == "1"


def test_session_tokens_round_trip_and_remain_scoped() -> None:
    launch = session_tokens.create_launch_token(7, 3)
    session = session_tokens.create_session_token(7, 3)
    assert session_tokens.decode_scoped_token(launch, "launch")["sid"] == 7
    assert session_tokens.decode_scoped_token(session, "session")["uid"] == 3
    assert session_tokens.decode_scoped_token(launch, "session") is None
    assert session_tokens.decode_scoped_token(session, "launch") is None


def test_session_tokens_reject_expired_tampered_and_bad_claim_types() -> None:
    claims = {"typ": "session", "sid": 1, "uid": 1}
    expired = jwt.encode({**claims, "exp": _expiry(-1)}, settings.secret_key, algorithm="HS256")
    tampered = jwt.encode({**claims, "exp": _expiry()}, "wrong-secret", algorithm="HS256")
    wrong_types = jwt.encode(
        {**claims, "sid": "1", "uid": "1", "exp": _expiry()},
        settings.secret_key,
        algorithm="HS256",
    )
    assert session_tokens.decode_scoped_token(expired, "session") is None
    assert session_tokens.decode_scoped_token(tampered, "session") is None
    assert session_tokens.decode_scoped_token(wrong_types, "session") is None


def test_legacy_scoped_token_remains_compatible() -> None:
    legacy = _legacy_token(
        {"typ": "session", "sid": 7, "uid": 3, "exp": int(_expiry().timestamp())}
    )
    assert session_tokens.decode_scoped_token(legacy, "session")["sid"] == 7
