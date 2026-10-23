"""Extension-first authentication (PKCE) and independent application drafts."""

import base64
import hashlib
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.main import app
from app.models import entities as E
from app.tests.test_application_applied_lifecycle import auth, complete_profile

REDIRECT = "https://" + "a" * 32 + ".chromiumapp.org/xpertapply"
VERIFIER = "v" * 64


def challenge_for(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def connect(client: TestClient, headers: dict[str, str], verifier: str = VERIFIER) -> dict:
    code = client.post(
        "/extension/auth/code",
        headers=headers,
        json={"code_challenge": challenge_for(verifier), "redirect_uri": REDIRECT},
    )
    assert code.status_code == 200, code.text
    resp = client.post(
        "/extension/auth/token",
        json={
            "grant_type": "authorization_code",
            "code": code.json()["code"],
            "code_verifier": verifier,
            "redirect_uri": REDIRECT,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_pkce_round_trip_and_me(client: TestClient) -> None:
    tokens = connect(client, auth(client))
    me = client.get("/extension/me", headers=bearer(tokens["access_token"]))
    assert me.status_code == 200
    assert me.json()["email"] == tokens["user"]["email"]


def test_code_is_single_use_and_verifier_bound(client: TestClient) -> None:
    headers = auth(client)
    body = {"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT}
    code = client.post("/extension/auth/code", headers=headers, json=body).json()["code"]
    wrong = client.post(
        "/extension/auth/token",
        json={"grant_type": "authorization_code", "code": code, "code_verifier": "w" * 64, "redirect_uri": REDIRECT},
    )
    assert wrong.status_code == 400
    # A failed verifier burns the code: the right verifier no longer works.
    retry = client.post(
        "/extension/auth/token",
        json={"grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER, "redirect_uri": REDIRECT},
    )
    assert retry.status_code == 400


def test_redirect_must_be_an_extension_origin(client: TestClient) -> None:
    resp = client.post(
        "/extension/auth/code",
        headers=auth(client),
        json={"code_challenge": challenge_for(VERIFIER), "redirect_uri": "https://evil.example/cb"},
    )
    assert resp.status_code == 400


def test_extension_token_is_not_a_website_token(client: TestClient) -> None:
    access = connect(client, auth(client))["access_token"]
    assert client.get("/auth/me", headers=bearer(access)).status_code == 401
    assert client.get("/profile", headers=bearer(access)).status_code == 401


def test_website_token_cannot_use_extension_routes(client: TestClient) -> None:
    headers = auth(client)
    assert client.get("/extension/me", headers=headers).status_code == 401
    direct = client.post("/extension/direct-sessions", headers=headers, json={"url": "https://x.example.com/a"})
    assert direct.status_code == 401


def test_refresh_rotates_and_replay_revokes_family(client: TestClient) -> None:
    tokens = connect(client, auth(client))
    first = tokens["refresh_token"]
    rotated = client.post("/extension/auth/token", json={"grant_type": "refresh_token", "refresh_token": first})
    assert rotated.status_code == 200
    newest = rotated.json()
    replay = client.post("/extension/auth/token", json={"grant_type": "refresh_token", "refresh_token": first})
    assert replay.status_code == 401
    # Theft response: the legitimate holder's newest credentials die too.
    refresh = {"grant_type": "refresh_token", "refresh_token": newest["refresh_token"]}
    assert client.post("/extension/auth/token", json=refresh).status_code == 401
    assert client.get("/extension/me", headers=bearer(newest["access_token"])).status_code == 401


def test_revoke_ends_access_immediately(client: TestClient) -> None:
    tokens = connect(client, auth(client))
    assert client.post("/extension/auth/revoke", json={"refresh_token": tokens["refresh_token"]}).status_code == 204
    assert client.get("/extension/me", headers=bearer(tokens["access_token"])).status_code == 401
    refresh = {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]}
    assert client.post("/extension/auth/token", json=refresh).status_code == 401
    # Unknown tokens look identical: no oracle.
    assert client.post("/extension/auth/revoke", json={"refresh_token": "nope"}).status_code == 204


def test_direct_session_is_owned_scoped_and_private(client: TestClient) -> None:
    owner = auth(client, "owner@mailbox.test-domain.co")
    complete_profile(client, owner)
    other = auth(client, "other@mailbox.test-domain.co")
    complete_profile(client, other)
    owner_access = connect(client, owner)["access_token"]

    url = "https://careers.withwaymo.com/jobs/ml-engineer/apply?utm=secret"
    payload = {"url": url, "company": "Waymo", "job_title": "Machine Learning Engineer"}
    resp = client.post("/extension/direct-sessions", headers=bearer(owner_access), json=payload)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["session_token"]
    assert "extension_launch_token" not in body

    db = next(app.dependency_overrides[get_db]())
    try:
        session = db.get(E.ApplicationSession, body["session_id"])
        job = db.get(E.JobPosting, session.job_id)
        assert session.launch_token_used is True and session.launch_token_hash is None
        assert "utm" not in session.source_url and "secret" not in job.application_url
        assert job.is_active is False  # never listed for anyone
        owner_id = session.user_id
    finally:
        db.close()

    # The session token reaches exactly this session, as for website handoffs...
    sid = body["session_id"]
    assert client.get(f"/application-sessions/{sid}", headers=bearer(body["session_token"])).status_code == 200
    # ...and another account's extension credential does not.
    other_access = connect(client, other, verifier="x" * 64)["access_token"]
    assert client.get(f"/application-sessions/{sid}", headers=bearer(other_access)).status_code in {401, 403}
    # Same URL re-opened by the same account resumes the same draft.
    again = client.post("/extension/direct-sessions", headers=bearer(owner_access), json={"url": url})
    assert again.json()["session_id"] == sid
    # A different account gets its own job row and draft for the same page.
    other_draft = client.post("/extension/direct-sessions", headers=bearer(other_access), json={"url": url})
    assert other_draft.status_code == 201 and other_draft.json()["session_id"] != sid
    db = next(app.dependency_overrides[get_db]())
    try:
        rows = db.scalars(select(E.JobPosting).where(E.JobPosting.external_id.like("direct:%"))).all()
        assert len({r.external_id for r in rows}) == 2
        assert owner_id != other_draft.json()["authenticated_user_id"]
    finally:
        db.close()


def test_direct_session_rejects_unusable_urls(client: TestClient) -> None:
    owner = auth(client)
    complete_profile(client, owner)
    access = connect(client, owner)["access_token"]
    for bad in ("javascript:alert(1)", "https://localhost/apply", "ftp://x.example.com/a"):
        assert client.post("/extension/direct-sessions", headers=bearer(access), json={"url": bad}).status_code in {422}


# --------------------------------------------------------------------------- #
# XA-CORE1-S1: cost control, SSRF, redirect allowlist, audience
# --------------------------------------------------------------------------- #
class FakeGenerator:
    """Stands in for the AI provider call and counts how often it is paid for."""

    def __init__(self, fail: bool = False) -> None:
        self.calls = 0
        self.fail = fail

    async def __call__(self, db, user, job, doc_type):  # noqa: ANN001
        self.calls += 1
        if self.fail:
            return None, "Tailored résumé could not be prepared automatically (TimeoutError). You can retry it."
        doc = E.GeneratedDocument(
            user_id=user.id, job_id=job.id, type=doc_type, format=E.DocumentFormat.json, title="t",
            content={}, content_markdown="m", plain_text="p", quality={}, model_used="fake",
        )
        db.add(doc)
        db.commit()
        db.refresh(doc)
        return doc, None


@pytest.fixture()
def prepared(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    from app.applications import direct_sessions

    # The background task opens its own session: point it at the test database.
    override = app.dependency_overrides[get_db]
    monkeypatch.setattr(direct_sessions, "SessionLocal", lambda: next(override()))
    owner = auth(client, "cost@mailbox.test-domain.co")
    complete_profile(client, owner)
    return bearer(connect(client, owner)["access_token"]), monkeypatch, direct_sessions


URL = "https://careers.withwaymo.com/jobs/ml-engineer"


def test_request_path_makes_no_ai_call_and_repeats_are_free(client: TestClient, prepared) -> None:
    access, monkeypatch, direct_sessions = prepared
    fake = FakeGenerator()
    monkeypatch.setattr(direct_sessions, "_safe_generate", fake)
    first = client.post("/extension/direct-sessions", headers=access, json={"url": URL})
    assert first.status_code == 201
    assert fake.calls == 2  # one résumé, one cover letter: prepared after the response, once
    assert first.json()["warnings"] == [direct_sessions.DOCUMENTS_PREPARING]  # what the caller saw at response time
    for _ in range(5):  # reloads, retries, repeated navigation
        again = client.post("/extension/direct-sessions", headers=access, json={"url": URL + "?utm=1#x"})
        assert again.json()["session_id"] == first.json()["session_id"]
    assert fake.calls == 2
    db = next(app.dependency_overrides[get_db]())
    try:
        session = db.get(E.ApplicationSession, first.json()["session_id"])
        assert session.tailored_resume_id and session.tailored_cover_letter_id
        assert direct_sessions.DOCUMENTS_PREPARING not in session.warnings
    finally:
        db.close()


def test_ai_failure_still_yields_a_usable_draft_and_is_not_retried(client: TestClient, prepared) -> None:
    access, monkeypatch, direct_sessions = prepared
    fake = FakeGenerator(fail=True)
    monkeypatch.setattr(direct_sessions, "_safe_generate", fake)
    first = client.post("/extension/direct-sessions", headers=access, json={"url": URL})
    assert first.status_code == 201 and first.json()["session_token"]
    calls = fake.calls
    for _ in range(3):
        assert client.post("/extension/direct-sessions", headers=access, json={"url": URL}).status_code == 201
    assert fake.calls == calls  # a failure is recorded, not retried by every visit
    db = next(app.dependency_overrides[get_db]())
    try:
        session = db.get(E.ApplicationSession, first.json()["session_id"])
        assert direct_sessions.DOCUMENTS_PREPARING not in session.warnings
        assert any("could not be prepared" in w for w in session.warnings)
    finally:
        db.close()


def test_provider_hang_is_bounded(client: TestClient, prepared) -> None:
    import asyncio

    access, monkeypatch, direct_sessions = prepared

    async def hangs(*_a, **_k):  # noqa: ANN002, ANN003
        await asyncio.sleep(60)

    monkeypatch.setattr(direct_sessions, "_safe_generate", hangs)
    monkeypatch.setattr(direct_sessions, "PREPARE_TIMEOUT_SECONDS", 0.2)
    resp = client.post("/extension/direct-sessions", headers=access, json={"url": URL})
    assert resp.status_code == 201
    db = next(app.dependency_overrides[get_db]())
    try:
        session = db.get(E.ApplicationSession, resp.json()["session_id"])
        assert any("took too long" in w for w in session.warnings)
    finally:
        db.close()


@pytest.mark.parametrize(
    "bad",
    [
        "http://careers.withwaymo.com/jobs/1",
        "https://127.0.0.1/apply",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/apply",
        "https://10.0.0.5/apply",
        "https://intranet.corp/apply",
        "https://printer.local/apply",
        "https://careers.withwaymo.com:8443/apply",
        "https://user:pw@careers.withwaymo.com/apply",
        "https://localhost/apply",
        "javascript:alert(1)",
        "not a url",
        "",
    ],
)
def test_unsafe_or_malformed_urls_are_rejected(client: TestClient, bad: str) -> None:
    owner = auth(client, "ssrf@mailbox.test-domain.co")
    complete_profile(client, owner)
    access = bearer(connect(client, owner)["access_token"])
    assert client.post("/extension/direct-sessions", headers=access, json={"url": bad}).status_code == 422


def test_expired_and_forged_extension_tokens_are_rejected(client: TestClient) -> None:
    import jwt as pyjwt

    from app.core.config import settings

    owner = auth(client, "tok@mailbox.test-domain.co")
    tokens = connect(client, owner)
    claims = pyjwt.decode(
        tokens["access_token"], settings.secret_key, algorithms=["HS256"], audience="xpertapply-extension"
    )
    for mutated in (
        {**claims, "exp": 1},  # expired
        {k: v for k, v in claims.items() if k != "aud"},  # no audience
        {**claims, "aud": "xpertapply-web"},  # wrong audience
        {**claims, "iss": "someone-else"},  # wrong issuer
        {**claims, "typ": "session"},  # another token type
    ):
        forged = pyjwt.encode(mutated, settings.secret_key, algorithm="HS256")
        assert client.get("/extension/me", headers=bearer(forged)).status_code == 401
    # A scoped session token minted by the website flow is not an extension token either.
    from app.core.session_tokens import create_session_token

    assert client.get("/extension/me", headers=bearer(create_session_token(1, 1))).status_code == 401


def test_redirect_allowlist_is_exact_and_production_fails_closed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.core.config import settings

    headers = auth(client, "redir@mailbox.test-domain.co")
    body = {"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT}
    monkeypatch.setattr(settings, "app_env", "production")
    monkeypatch.setattr(settings, "extension_allowed_ids", [])
    assert client.post("/extension/auth/code", headers=headers, json=body).status_code == 400  # nothing configured
    monkeypatch.setattr(settings, "extension_allowed_ids", ["b" * 32])
    assert client.post("/extension/auth/code", headers=headers, json=body).status_code == 400  # a different extension
    monkeypatch.setattr(settings, "extension_allowed_ids", ["a" * 32])
    assert client.post("/extension/auth/code", headers=headers, json=body).status_code == 200
    # Path tricks and lookalike hosts never pass the shape check.
    for uri in (
        "https://" + "a" * 32 + ".chromiumapp.org.evil.example/cb",
        "https://" + "a" * 32 + ".chromiumapp.org@evil.example/cb",
        "http://" + "a" * 32 + ".chromiumapp.org/cb",
        "https://" + "a" * 32 + ".chromiumapp.org/cb?x=1",
    ):
        bad = {"code_challenge": challenge_for(VERIFIER), "redirect_uri": uri}
        assert client.post("/extension/auth/code", headers=headers, json=bad).status_code == 400


def test_token_endpoint_rejects_a_redirect_different_from_the_one_authorised(client: TestClient) -> None:
    headers = auth(client, "mism@mailbox.test-domain.co")
    request = {"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT}
    code = client.post("/extension/auth/code", headers=headers, json=request).json()["code"]
    other = "https://" + "c" * 32 + ".chromiumapp.org/xpertapply"
    resp = client.post(
        "/extension/auth/token",
        json={"grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER, "redirect_uri": other},
    )
    assert resp.status_code == 400


def test_extension_credentials_never_reach_the_logs(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("DEBUG")
    tokens = connect(client, auth(client, "log@mailbox.test-domain.co"))
    client.get("/extension/me", headers=bearer(tokens["access_token"]))
    client.post("/extension/auth/revoke", json={"refresh_token": tokens["refresh_token"]})
    text = caplog.text
    assert tokens["access_token"] not in text and tokens["refresh_token"] not in text
