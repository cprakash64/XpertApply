from __future__ import annotations

import json
import time
from collections.abc import Generator
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.auth.google_oauth import GoogleOIDCClient, GoogleTokenExchangeError, s256
from app.core.config import settings
from app.main import app
from app.models.entities import ExternalIdentity, User, UserProfile
from app.routes import google_auth


class MemoryStore:
    def __init__(self):
        self.values: dict[tuple[str, str], dict] = {}
        self.ttls: dict[tuple[str, str], int] = {}
        self.counts: dict[str, int] = {}

    def put(self, kind, token, value, ttl):
        from dataclasses import asdict
        self.values[(kind, token)] = asdict(value)
        self.ttls[(kind, token)] = ttl

    def consume(self, kind, token):
        return self.values.pop((kind, token), None)

    def peek(self, kind, token):
        return self.values.get((kind, token))

    def rate_limit(self, key, limit, ttl):
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key] <= limit


class FakeOIDC:
    claims = {
        "sub": "google-subject",
        "email": "google@example.com",
        "email_verified": True,
        "name": "Google Person",
    }
    error: Exception | None = None
    seen_code = ""
    seen_verifier = ""

    def exchange_code(self, code, verifier):
        self.seen_code, self.seen_verifier = code, verifier
        if self.error:
            raise self.error
        return "synthetic-id-token"

    def verify_id_token(self, token, nonce):
        if self.error:
            raise self.error
        return dict(self.claims)


@pytest.fixture()
def google_client(monkeypatch: pytest.MonkeyPatch) -> Generator[tuple[TestClient, MemoryStore, FakeOIDC], None, None]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    from app.db.base import Base
    Base.metadata.create_all(engine)

    def override_db():
        with factory() as db:
            yield db

    memory, oidc = MemoryStore(), FakeOIDC()
    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr(google_auth, "store", memory)
    monkeypatch.setattr(google_auth, "oidc_client", oidc)
    monkeypatch.setattr(settings, "google_oauth_enabled", True)
    monkeypatch.setattr(settings, "google_oauth_client_id", "test-client.apps.googleusercontent.com")
    monkeypatch.setattr(settings, "google_oauth_client_secret", "test-secret")
    monkeypatch.setattr(settings, "google_oauth_redirect_uri", "http://testserver/auth/google/callback")
    monkeypatch.setattr(settings, "google_oauth_web_callback_url", "https://web.example.test/auth/google/callback")
    try:
        yield TestClient(app), memory, oidc
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def start(client: TestClient):
    verifier = "v" * 43
    response = client.get(
        "/auth/google/start",
        params={"handoff_challenge": s256(verifier), "return_to": "/profile"},
        follow_redirects=False,
    )
    query = parse_qs(urlparse(response.headers["location"]).query)
    return response, query, verifier


def callback(client: TestClient, query: dict[str, list[str]], **params):
    return client.get(
        "/auth/google/callback",
        params={"state": query["state"][0], "code": "synthetic-code", **params},
        follow_redirects=False,
    )


def test_google_disabled_is_not_advertised_or_started(google_client, monkeypatch):
    client, _, _ = google_client
    monkeypatch.setattr(settings, "google_oauth_enabled", False)
    assert client.get("/auth/providers").json() == {"google": {"enabled": False}}
    response = client.get("/auth/google/start", params={"handoff_challenge": "x" * 43})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "GOOGLE_AUTH_UNAVAILABLE"


def test_start_has_state_nonce_pkce_scopes_ttl_and_secure_binding(google_client, monkeypatch):
    client, memory, _ = google_client
    monkeypatch.setattr(settings, "google_oauth_redirect_uri", "https://api.example.test/auth/google/callback")
    response, query, _ = start(client)
    assert response.status_code == 303
    assert query["response_type"] == ["code"]
    assert query["scope"] == ["openid email profile"]
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["state"][0]) >= 40 and len(query["nonce"][0]) >= 40
    transaction = memory.values[("oauth", query["state"][0])]
    assert query["code_challenge"] == [s256(transaction["pkce_verifier"])]
    assert memory.ttls[("oauth", query["state"][0])] == 600
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie
    assert "access_type" not in query and "prompt" not in query


@pytest.mark.parametrize(
    "return_to",
    ["https://evil.test/", "//evil.test/", "/auth/google/callback", "/profile?code=steal"],
)
def test_start_rejects_unsafe_return_paths(google_client, return_to):
    client, _, _ = google_client
    response = client.get("/auth/google/start", params={"handoff_challenge": "x" * 43, "return_to": return_to})
    assert response.status_code == 400


def test_valid_new_user_callback_and_one_time_handoff(google_client):
    client, _, oidc = google_client
    _, query, verifier = start(client)
    response = callback(client, query)
    completion_code = parse_qs(urlparse(response.headers["location"]).query)["code"][0]
    assert "access_token" not in response.headers["location"]
    assert oidc.seen_code == "synthetic-code"
    complete = client.post("/auth/google/complete", json={"code": completion_code, "verifier": verifier})
    assert complete.status_code == 200 and complete.json()["access_token"]
    assert complete.json()["return_to"] == "/profile"
    assert client.post("/auth/google/complete", json={"code": completion_code, "verifier": verifier}).status_code == 400


def test_state_replay_and_browser_binding_mismatch_fail(google_client):
    client, _, _ = google_client
    _, query, _ = start(client)
    client.cookies.set("xa_google_binding", "wrong")
    assert callback(client, query).json()["error"]["code"] == "GOOGLE_STATE_INVALID"
    assert callback(client, query).json()["error"]["code"] == "GOOGLE_SESSION_EXPIRED"


def test_cancel_is_safe_and_consumes_state(google_client):
    client, _, _ = google_client
    _, query, _ = start(client)
    response = callback(client, query, error="access_denied")
    assert response.headers["location"].endswith("error=GOOGLE_AUTH_CANCELLED")
    assert "access_denied" not in response.headers["location"]


def test_missing_and_expired_state_are_rejected(google_client):
    client, memory, _ = google_client
    assert client.get("/auth/google/callback").json()["error"]["code"] == "GOOGLE_STATE_INVALID"
    _, query, _ = start(client)
    memory.values[("oauth", query["state"][0])]["created_at"] = int(time.time()) - 601
    response = callback(client, query)
    assert response.json()["error"]["code"] == "GOOGLE_SESSION_EXPIRED"


def test_code_exchange_failure_is_safe_and_consumes_state(google_client):
    client, _, oidc = google_client
    _, query, _ = start(client)
    oidc.error = ValueError("provider payload must never be returned")
    response = callback(client, query)
    assert response.headers["location"].endswith("error=GOOGLE_TOKEN_INVALID")
    assert "provider" not in response.headers["location"]
    assert callback(client, query).json()["error"]["code"] == "GOOGLE_SESSION_EXPIRED"


@pytest.mark.parametrize("claims", [
    {"sub": "s", "email_verified": True},
    {"email": "missing-sub@example.com", "email_verified": True},
    {"sub": "s", "email": "unverified@example.com", "email_verified": False},
])
def test_invalid_or_unverified_claims_fail_safely(google_client, claims):
    client, _, oidc = google_client
    oidc.claims = claims
    _, query, _ = start(client)
    response = callback(client, query)
    assert "error=GOOGLE_" in response.headers["location"]


def test_email_collision_requires_password_then_links_once(google_client):
    client, _, oidc = google_client
    signup = client.post("/auth/signup", json={"email": "collision@example.com", "password": "correct-password"})
    assert signup.status_code == 200
    oidc.claims = {"sub": "collision-google-sub", "email": "collision@example.com", "email_verified": True}
    _, query, verifier = start(client)
    response = callback(client, query)
    code = parse_qs(urlparse(response.headers["location"]).query)["code"][0]
    completion = client.post("/auth/google/complete", json={"code": code, "verifier": verifier}).json()
    assert completion["result"] == "link_required"
    ticket = completion["link_ticket"]
    wrong = client.post("/auth/google/link", json={"link_ticket": ticket, "password": "wrong-password"})
    assert wrong.status_code == 401 and wrong.json()["error"]["code"] == "GOOGLE_LINK_INVALID"
    linked = client.post("/auth/google/link", json={"link_ticket": ticket, "password": "correct-password"})
    assert linked.status_code == 200 and linked.json()["access_token"]
    replay = client.post(
        "/auth/google/link",
        json={"link_ticket": ticket, "password": "correct-password"},
    )
    assert replay.status_code == 400
    override = app.dependency_overrides[get_db]
    with next(override()) as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert db.scalar(select(func.count()).select_from(ExternalIdentity)) == 1


def test_returning_subject_reuses_provider_account(google_client):
    client, _, _ = google_client
    for _ in range(2):
        _, query, verifier = start(client)
        response = callback(client, query)
        code = parse_qs(urlparse(response.headers["location"]).query)["code"][0]
        assert client.post("/auth/google/complete", json={"code": code, "verifier": verifier}).status_code == 200
    override = app.dependency_overrides[get_db]
    with next(override()) as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert db.scalar(select(func.count()).select_from(UserProfile)) == 1
        assert db.scalar(select(func.count()).select_from(ExternalIdentity)) == 1
        user = db.scalar(select(User))
        assert user is not None and user.hashed_password is None


def test_expired_completion_and_link_tickets_fail_closed(google_client):
    client, _, _ = google_client
    complete = client.post(
        "/auth/google/complete", json={"code": "missing", "verifier": "v" * 43}
    )
    link = client.post(
        "/auth/google/link", json={"link_ticket": "missing", "password": "anything"}
    )
    assert complete.json()["error"]["code"] == "GOOGLE_SESSION_EXPIRED"
    assert link.json()["error"]["code"] == "GOOGLE_LINK_EXPIRED"


def test_link_rate_limit_and_caller_substitution_are_rejected(google_client):
    client, _, oidc = google_client
    client.post("/auth/signup", json={"email": "rate@example.com", "password": "correct-password"})
    oidc.claims = {"sub": "rate-sub", "email": "rate@example.com", "email_verified": True}
    _, query, verifier = start(client)
    code = parse_qs(urlparse(callback(client, query).headers["location"]).query)["code"][0]
    ticket = client.post("/auth/google/complete", json={"code": code, "verifier": verifier}).json()["link_ticket"]
    substituted = client.post(
        "/auth/google/link",
        json={"link_ticket": ticket, "password": "correct-password", "subject": "attacker-sub"},
    )
    assert substituted.status_code == 422
    for _ in range(5):
        response = client.post("/auth/google/link", json={"link_ticket": ticket, "password": "wrong"})
    assert response.status_code == 401
    assert client.post("/auth/google/link", json={"link_ticket": ticket, "password": "wrong"}).status_code == 429


def test_wrong_handoff_verifier_consumes_completion(google_client):
    client, _, _ = google_client
    _, query, verifier = start(client)
    response = callback(client, query)
    code = parse_qs(urlparse(response.headers["location"]).query)["code"][0]
    assert client.post("/auth/google/complete", json={"code": code, "verifier": "z" * 43}).status_code == 400
    assert client.post("/auth/google/complete", json={"code": code, "verifier": verifier}).status_code == 400


def _signed_token(private_key, **overrides):
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com",
        "aud": "test-client.apps.googleusercontent.com",
        "sub": "signed-subject",
        "iat": now,
        "exp": now + 300,
        "nonce": "expected-nonce",
        "email": "signed@example.com",
        "email_verified": True,
        **overrides,
    }
    return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": "synthetic-key"})


@pytest.mark.parametrize(
    ("overrides", "nonce"),
    [
        ({"iss": "https://evil.example"}, "expected-nonce"),
        ({"aud": "wrong-client"}, "expected-nonce"),
        ({"exp": 1}, "expected-nonce"),
        ({}, "wrong-nonce"),
        ({"aud": ["test-client.apps.googleusercontent.com", "other"], "azp": "other"}, "expected-nonce"),
    ],
)
def test_google_id_token_rejects_invalid_security_claims(monkeypatch, overrides, nonce):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "synthetic-key", "alg": "RS256", "use": "sig"})
    monkeypatch.setattr(settings, "google_oauth_client_id", "test-client.apps.googleusercontent.com")
    client = GoogleOIDCClient()
    monkeypatch.setattr(client, "_fetch_jwks", lambda **_: __import__("jwt").PyJWKSet.from_dict({"keys": [jwk]}))
    with pytest.raises(jwt.InvalidTokenError):
        client.verify_id_token(_signed_token(private_key, **overrides), nonce)


def test_google_id_token_accepts_valid_signature_and_claims(monkeypatch):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "synthetic-key", "alg": "RS256", "use": "sig"})
    monkeypatch.setattr(settings, "google_oauth_client_id", "test-client.apps.googleusercontent.com")
    client = GoogleOIDCClient()
    monkeypatch.setattr(client, "_fetch_jwks", lambda **_: __import__("jwt").PyJWKSet.from_dict({"keys": [jwk]}))
    claims = client.verify_id_token(_signed_token(private_key), "expected-nonce")
    assert claims["sub"] == "signed-subject"


def test_google_id_token_rejects_bad_signature_and_algorithm(monkeypatch):
    trusted = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(trusted.public_key()))
    jwk.update({"kid": "synthetic-key", "alg": "RS256", "use": "sig"})
    monkeypatch.setattr(settings, "google_oauth_client_id", "test-client.apps.googleusercontent.com")
    client = GoogleOIDCClient()
    monkeypatch.setattr(client, "_fetch_jwks", lambda **_: __import__("jwt").PyJWKSet.from_dict({"keys": [jwk]}))
    with pytest.raises(jwt.InvalidTokenError):
        client.verify_id_token(_signed_token(attacker), "expected-nonce")
    hs_token = jwt.encode(
        {
            "iss": "https://accounts.google.com",
            "aud": settings.google_oauth_client_id,
            "sub": "s",
            "iat": int(time.time()),
            "exp": int(time.time()) + 60,
            "nonce": "expected-nonce",
        },
        "not-a-google-key-that-is-long-enough",
        algorithm="HS256",
        headers={"kid": "synthetic-key"},
    )
    with pytest.raises(jwt.InvalidTokenError):
        client.verify_id_token(hs_token, "expected-nonce")


def test_google_id_token_refreshes_jwks_once_for_key_rotation(monkeypatch):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "synthetic-key", "alg": "RS256", "use": "sig"})
    old_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    old_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(old_key.public_key()))
    old_jwk.update({"kid": "retired-key", "alg": "RS256", "use": "sig"})
    empty = __import__("jwt").PyJWKSet.from_dict({"keys": [old_jwk]})
    rotated = __import__("jwt").PyJWKSet.from_dict({"keys": [jwk]})
    calls: list[bool] = []
    monkeypatch.setattr(settings, "google_oauth_client_id", "test-client.apps.googleusercontent.com")
    client = GoogleOIDCClient()

    def fetch(*, force=False):
        calls.append(force)
        return rotated if force else empty

    monkeypatch.setattr(client, "_fetch_jwks", fetch)
    assert client.verify_id_token(_signed_token(private_key), "expected-nonce")["sub"] == "signed-subject"
    assert calls == [False, True]


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"error": "invalid_client", "error_description": "synthetic secret detail"}, "invalid_client"),
        ({"error": "invalid_grant", "error_description": "synthetic code detail"}, "invalid_grant"),
        ({"error": "future_google_error", "error_description": "synthetic unknown"}, "upstream_failure"),
        (b"not-json synthetic raw body", "upstream_failure"),
    ],
)
def test_token_exchange_failure_retains_only_safe_metadata(monkeypatch, caplog, body, expected):
    request = httpx.Request("POST", "https://oauth2.googleapis.com/token")
    if isinstance(body, bytes):
        response = httpx.Response(502, content=body, request=request)
    else:
        response = httpx.Response(400, json=body, request=request)
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: response)
    client = GoogleOIDCClient()
    with pytest.raises(GoogleTokenExchangeError) as caught:
        client.exchange_code("SYNTHETIC_AUTH_CODE", "SYNTHETIC_PKCE_VERIFIER")
    assert caught.value.status_code == response.status_code
    assert caught.value.category == expected
    logged = caplog.text
    for forbidden in (
        "synthetic secret detail",
        "synthetic code detail",
        "synthetic unknown",
        "not-json synthetic raw body",
        "SYNTHETIC_AUTH_CODE",
        "SYNTHETIC_PKCE_VERIFIER",
    ):
        assert forbidden not in logged


def test_callback_logs_safe_token_exchange_category_only(google_client, caplog):
    client, _, oidc = google_client
    oidc.error = GoogleTokenExchangeError(401, "invalid_client")
    _, query, _ = start(client)
    with caplog.at_level("WARNING", logger="jobpilot.auth.google"):
        response = callback(client, query)
    assert response.headers["location"].endswith("error=GOOGLE_TOKEN_INVALID")
    assert "category=token_exchange_invalid_client upstream_status=401" in caplog.text
    assert "synthetic-code" not in caplog.text
