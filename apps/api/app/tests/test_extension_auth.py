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
