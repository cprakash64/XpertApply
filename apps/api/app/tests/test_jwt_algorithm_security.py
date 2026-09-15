"""The JWT algorithm allow-list, pinned across the PyJWT migration.

DEPENDENCY-01 replaced python-jose 3.3.0 with PyJWT. python-jose carried an
algorithm-confusion advisory (PYSEC-2024-232) and pulled in `ecdsa`, whose
Minerva timing advisory upstream has said it will not fix. Neither vulnerable
path was reachable here — this service issues and accepts HS256 only, uses a
symmetric secret, and never touches JWE or an asymmetric key — but "not
reachable today" is a property of the call sites, and call sites change.

So the property these tests defend is the one that made it unreachable:
`jwt.decode` is given an explicit single-element `algorithms` list, and the
accepted algorithm is therefore never read from the token's own header. That is
the difference between a JWT library being safe and being used safely, and it
has to survive a library swap.

Both token helpers are covered. They are independent implementations of the
same contract — `app.core.security` for the login access token,
`app.core.session_tokens` for the scoped assisted-apply launch/session tokens —
and testing only one would leave the other free to drift.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import jwt as pyjwt
import pytest

from app.core import security, session_tokens
from app.core.config import settings


def _claims(**extra) -> dict:
    return {"sub": "1", "exp": datetime.now(UTC) + timedelta(minutes=5), **extra}


# --------------------------------------------------------------------------- #
# The library is the one we think it is
# --------------------------------------------------------------------------- #
def test_the_jwt_import_resolves_to_pyjwt() -> None:
    """`import jwt` is ambiguous on PyPI — several distributions provide it."""
    import importlib.metadata as meta

    assert meta.version("PyJWT")
    assert pyjwt.__name__ == "jwt"
    assert hasattr(pyjwt, "InvalidTokenError")


def test_python_jose_and_ecdsa_are_gone() -> None:
    import importlib.metadata as meta

    for removed in ("python-jose", "ecdsa"):
        with pytest.raises(meta.PackageNotFoundError):
            meta.version(removed)


# --------------------------------------------------------------------------- #
# Access token — app.core.security
# --------------------------------------------------------------------------- #
def test_a_valid_access_token_round_trips() -> None:
    token = security.create_access_token("42")
    assert isinstance(token, str)  # a header value, never bytes
    assert security.decode_access_token(token) == "42"


def test_an_access_token_signed_with_the_wrong_secret_is_rejected() -> None:
    forged = pyjwt.encode(_claims(), "not-the-application-secret", algorithm="HS256")
    assert security.decode_access_token(forged) is None


def test_an_expired_access_token_is_rejected() -> None:
    stale = pyjwt.encode(
        {"sub": "1", "exp": datetime.now(UTC) - timedelta(seconds=1)},
        settings.secret_key,
        algorithm="HS256",
    )
    assert security.decode_access_token(stale) is None


@pytest.mark.parametrize(
    "malformed",
    ["", "   ", "not-a-jwt", "a.b", "a.b.c.d", "eyJhbGciOiJIUzI1NiJ9..", "Bearer token"],
)
def test_malformed_input_is_rejected_rather_than_raising(malformed) -> None:
    # The boundary matters as much as the verdict: a bad token must be None, so
    # the caller returns 401. An escaping exception would be a 500.
    assert security.decode_access_token(malformed) is None


def test_alg_none_is_rejected() -> None:
    # The classic unsigned-token attack: claim the token needs no signature.
    unsigned = pyjwt.encode(_claims(), key="", algorithm="none")
    assert security.decode_access_token(unsigned) is None


@pytest.mark.parametrize("algorithm", ["HS384", "HS512"])
def test_other_hmac_algorithms_are_rejected_even_with_the_right_secret(algorithm) -> None:
    # Correctly signed with the real secret — only the algorithm differs. This
    # fails ONLY because the allow-list names exactly one algorithm.
    token = pyjwt.encode(_claims(), settings.secret_key, algorithm=algorithm)
    assert security.decode_access_token(token) is None


def _forge_header_algorithm(alg: str, claims: dict) -> str:
    """A token whose HEADER claims `alg`, signed with HMAC-SHA256 over the app
    secret.

    Built by hand because PyJWT will not produce it: asked for an RS256 header
    it tries to sign with RS256 and refuses a symmetric key. That refusal is
    PyJWT behaving well, and it is not the thing under test — the thing under
    test is what our DECODER does when an attacker hands it such a token, which
    is exactly the python-jose confusion shape.
    """
    import base64
    import hashlib
    import hmac
    import json

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = b64(json.dumps({"alg": alg, "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}"
    signature = hmac.new(
        settings.secret_key.encode(), signing_input.encode(), hashlib.sha256
    ).digest()
    return f"{signing_input}.{b64(signature)}"


@pytest.mark.parametrize("alg", ["RS256", "ES256", "none", "HS384"])
def test_a_forged_header_algorithm_cannot_smuggle_a_token_past_the_allow_list(alg) -> None:
    # The signature is genuinely valid HMAC-SHA256 over the real secret. Only
    # the declared algorithm is a lie. A decoder that trusted the header would
    # accept some of these; ours never reads it.
    exp = int((datetime.now(UTC) + timedelta(minutes=5)).timestamp())
    token = _forge_header_algorithm(alg, {"sub": "1", "exp": exp})
    assert security.decode_access_token(token) is None
    assert session_tokens.decode_scoped_token(token, "session") is None


def test_a_token_with_no_subject_yields_no_subject() -> None:
    token = pyjwt.encode(
        {"exp": datetime.now(UTC) + timedelta(minutes=5)}, settings.secret_key, algorithm="HS256"
    )
    assert security.decode_access_token(token) is None


# --------------------------------------------------------------------------- #
# Tokens issued before the migration must keep working
# --------------------------------------------------------------------------- #
def _legacy_hs256(payload: dict) -> str:
    """A token in exactly the JWS compact form python-jose 3.3.0 emitted.

    Built independently of both libraries — base64url header, base64url claims,
    HMAC-SHA256 over `header.claims` with the app secret — so this asserts wire
    compatibility rather than that one library agrees with itself.
    """
    import base64
    import hashlib
    import hmac
    import json

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}"
    sig = hmac.new(settings.secret_key.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64(sig)}"


def _soon() -> int:
    return int((datetime.now(UTC) + timedelta(minutes=30)).timestamp())


def test_an_access_token_issued_before_the_migration_is_still_accepted() -> None:
    """Beta users holding a live token must not be logged out by a library swap.

    A dependency change is not a reason to invalidate credentials, and silently
    doing so would look like an outage rather than an upgrade.
    """
    assert security.decode_access_token(_legacy_hs256({"sub": "4242", "exp": _soon()})) == "4242"


def test_scoped_tokens_issued_before_the_migration_are_still_accepted() -> None:
    session = _legacy_hs256({"typ": "session", "sid": 77, "uid": 9, "exp": _soon()})
    claims = session_tokens.decode_scoped_token(session, "session")
    assert claims is not None and claims["sid"] == 77 and claims["uid"] == 9

    launch = _legacy_hs256({"typ": "launch", "sid": 5, "uid": 6, "jti": "abc", "exp": _soon()})
    claims = session_tokens.decode_scoped_token(launch, "launch")
    assert claims is not None and claims["jti"] == "abc"


def test_a_legacy_format_token_with_a_wrong_secret_is_still_rejected() -> None:
    # Compatibility must not become a hole: the old wire format is accepted,
    # the old signature check is not relaxed.
    import base64
    import hashlib
    import hmac
    import json

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64(json.dumps({"sub": "1", "exp": _soon()}, separators=(",", ":")).encode())
    si = f"{header}.{body}"
    sig = hmac.new(b"a-different-secret", si.encode(), hashlib.sha256).digest()
    assert security.decode_access_token(f"{si}.{b64(sig)}") is None


# --------------------------------------------------------------------------- #
# Scoped tokens — app.core.session_tokens
# --------------------------------------------------------------------------- #
def test_launch_and_session_tokens_round_trip_and_stay_distinct() -> None:
    launch = session_tokens.create_launch_token(7, 3)
    session = session_tokens.create_session_token(7, 3)
    assert isinstance(launch, str) and isinstance(session, str)

    assert session_tokens.decode_scoped_token(launch, "launch")["sid"] == 7
    assert session_tokens.decode_scoped_token(session, "session")["uid"] == 3
    # A launch token must not be usable where a session token is expected.
    assert session_tokens.decode_scoped_token(launch, "session") is None
    assert session_tokens.decode_scoped_token(session, "launch") is None


def test_a_launch_token_carries_a_unique_jti() -> None:
    a = session_tokens.decode_scoped_token(session_tokens.create_launch_token(1, 1), "launch")
    b = session_tokens.decode_scoped_token(session_tokens.create_launch_token(1, 1), "launch")
    assert a["jti"] != b["jti"]


def test_scoped_tokens_reject_the_wrong_secret() -> None:
    forged = pyjwt.encode(
        {"typ": "session", "sid": 1, "uid": 1,
         "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp())},
        "not-the-application-secret",
        algorithm="HS256",
    )
    assert session_tokens.decode_scoped_token(forged, "session") is None


def test_scoped_tokens_reject_expiry() -> None:
    stale = pyjwt.encode(
        {"typ": "session", "sid": 1, "uid": 1,
         "exp": int((datetime.now(UTC) - timedelta(seconds=1)).timestamp())},
        settings.secret_key,
        algorithm="HS256",
    )
    assert session_tokens.decode_scoped_token(stale, "session") is None


@pytest.mark.parametrize("algorithm", ["HS384", "HS512", "none"])
def test_scoped_tokens_reject_every_other_algorithm(algorithm) -> None:
    key = "" if algorithm == "none" else settings.secret_key
    token = pyjwt.encode(
        {"typ": "session", "sid": 1, "uid": 1,
         "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp())},
        key,
        algorithm=algorithm,
    )
    assert session_tokens.decode_scoped_token(token, "session") is None


def test_scoped_tokens_reject_non_integer_identifiers() -> None:
    token = pyjwt.encode(
        {"typ": "session", "sid": "1", "uid": "1",
         "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp())},
        settings.secret_key,
        algorithm="HS256",
    )
    assert session_tokens.decode_scoped_token(token, "session") is None


# --------------------------------------------------------------------------- #
# The allow-list is load-bearing, not decorative
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("module", [security, session_tokens])
def test_each_module_pins_exactly_one_algorithm(module) -> None:
    assert module.ALGORITHM == "HS256"


def test_widening_the_allow_list_would_admit_a_forged_algorithm() -> None:
    """Negative control.

    Every rejection above would also pass against a decoder that simply failed
    for some unrelated reason, so prove the allow-list is what does the work:
    decode the SAME HS384 token while permitting HS384, and it verifies. The
    single-element list is the only thing standing between the two outcomes.
    """
    token = pyjwt.encode(_claims(), settings.secret_key, algorithm="HS384")

    assert security.decode_access_token(token) is None  # as shipped

    widened = pyjwt.decode(token, settings.secret_key, algorithms=["HS256", "HS384"])
    assert widened["sub"] == "1"


# --------------------------------------------------------------------------- #
# HTTP boundary — a bad token is 401, never 500
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client():
    from collections.abc import Generator

    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session, sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.api.deps import get_db
    from app.db.base import Base
    from app.main import app

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override() -> Generator[Session, None, None]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(engine)
        engine.dispose()



def test_the_authorization_dependency_returns_401_for_bad_tokens(client) -> None:
    for bad in ("not-a-jwt", pyjwt.encode(_claims(), "wrong-secret", algorithm="HS256")):
        response = client.get("/profile", headers={"Authorization": f"Bearer {bad}"})
        assert response.status_code == 401, response.text


def test_the_authorization_dependency_accepts_a_real_token(client) -> None:
    token = client.post(
        "/auth/signup", json={"email": "jwt-contract@mailbox.test-domain.co", "password": "password123"}
    ).json()["access_token"]
    response = client.get("/profile", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
