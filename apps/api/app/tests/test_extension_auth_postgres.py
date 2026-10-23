# ruff: noqa: E501
"""Concurrency guarantees that only a real PostgreSQL can prove.

Skipped unless ``XA_TEST_PG_URL`` points at a MIGRATED, DISPOSABLE database
(``alembic upgrade head``). SQLite serialises writers, so it cannot show that two
simultaneous requests are decided by the database rather than by luck.
"""

import asyncio
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app.api.deps import get_db
from app.main import app
from app.models import entities as E
from app.tests.test_extension_auth import REDIRECT, VERIFIER, FakeGenerator, bearer, challenge_for

PG_URL = os.environ.get("XA_TEST_PG_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="XA_TEST_PG_URL not set (needs a migrated disposable PostgreSQL)")

PROFILE = {
    "full_name": "Chandra Pandey", "phone": "602-555-0100", "location_city": "Phoenix", "location_state": "AZ",
    "location_country": "United States", "work_authorization": "authorized_us", "target_roles": ["Backend Engineer"],
    "target_levels": ["Junior"], "preferred_locations": ["United States"], "remote_preference": "remote",
    "skills": ["Python", "FastAPI"],
}
CAREER = {
    "education": [{"school": "Arizona State University", "degree": "BS"}],
    "experience": [{"company": "Cardinal Health", "title": "ML Engineer Intern", "bullets": ["Built Python services"],
                    "technologies": ["Python"], "currently_working": True}],
    "projects": [], "certifications": [], "awards": [],
}


@pytest.fixture()
def pg(monkeypatch: pytest.MonkeyPatch):
    engine = create_engine(PG_URL, pool_size=20, max_overflow=20)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    from app.applications import direct_sessions

    monkeypatch.setattr(direct_sessions, "SessionLocal", factory)
    yield factory, direct_sessions, monkeypatch, engine
    app.dependency_overrides.clear()
    engine.dispose()


async def _signed_in(c: httpx.AsyncClient) -> dict[str, str]:
    email = f"pg-{uuid.uuid4().hex[:10]}@mailbox.test-domain.co"
    token = (await c.post("/auth/signup", json={"email": email, "password": "password123"})).json()["access_token"]
    headers = bearer(token)
    await c.put("/profile", headers=headers, json=PROFILE)
    await c.put("/profile/career", headers=headers, json=CAREER)
    return headers


async def _connect(c: httpx.AsyncClient, headers: dict[str, str]) -> dict:
    code = (await c.post("/extension/auth/code", headers=headers,
                         json={"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT})).json()["code"]
    resp = await c.post("/extension/auth/token", json={
        "grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER, "redirect_uri": REDIRECT})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def test_concurrent_code_redemption_has_exactly_one_winner(pg) -> None:
    async def run():
        async with _client() as c:
            headers = await _signed_in(c)
            code = (await c.post("/extension/auth/code", headers=headers,
                                 json={"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT})).json()["code"]
            body = {"grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER, "redirect_uri": REDIRECT}
            return [r.status_code for r in await asyncio.gather(*[c.post("/extension/auth/token", json=body) for _ in range(12)])]

    statuses = asyncio.run(run())
    assert statuses.count(200) == 1 and statuses.count(400) == 11


def test_concurrent_refresh_has_one_winner_and_a_race_revokes_the_family(pg) -> None:
    async def run():
        async with _client() as c:
            tokens = await _connect(c, await _signed_in(c))
            body = {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]}
            results = await asyncio.gather(*[c.post("/extension/auth/token", json=body) for _ in range(12)])
            winners = [r for r in results if r.status_code == 200]
            return tokens, results, winners, c

    # Re-run the assertions inside one loop so the client stays valid.
    async def full():
        async with _client() as c:
            tokens = await _connect(c, await _signed_in(c))
            body = {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]}
            results = await asyncio.gather(*[c.post("/extension/auth/token", json=body) for _ in range(12)])
            codes = [r.status_code for r in results]
            access_after = await c.get("/extension/me", headers=bearer(tokens["access_token"]))
            return codes, access_after.status_code

    codes, access_status = asyncio.run(full())
    # At most one rotation succeeds; losing the race is treated as theft and kills the family, which
    # also ends the winner's new credentials and every access token of that family.
    assert codes.count(200) <= 1 and codes.count(401) >= 11
    assert access_status == 401


def test_concurrent_identical_direct_requests_share_one_draft_and_one_ai_run(pg) -> None:
    factory, direct_sessions, monkeypatch, _engine = pg
    fake = FakeGenerator()
    monkeypatch.setattr(direct_sessions, "_safe_generate", fake)

    async def run():
        async with _client() as c:
            access = bearer((await _connect(c, await _signed_in(c)))["access_token"])
            url = "https://careers.withwaymo.com/jobs/" + uuid.uuid4().hex[:8]
            resps = await asyncio.gather(*[
                c.post("/extension/direct-sessions", headers=access, json={"url": url}) for _ in range(10)
            ])
            return [r.status_code for r in resps], {r.json()["session_id"] for r in resps}, url

    statuses, ids, url = asyncio.run(run())
    assert set(statuses) == {201} and len(ids) == 1
    assert fake.calls == 2  # one résumé + one cover letter, once, however many requests raced
    db = factory()
    try:
        jobs = db.scalars(select(E.JobPosting).where(E.JobPosting.application_url == url)).all()
        assert len(jobs) == 1 and jobs[0].is_active is False
    finally:
        db.close()


def _forced_interleave(engine, table: str, needle: str):
    """Hold each request that has just READ the row until both have, so the two check-then-write
    sequences genuinely interleave. Code that decides in Python from what it read lets both through;
    code that lets the database decide cannot."""
    barrier = threading.Barrier(2, timeout=5)

    @event.listens_for(engine, "after_cursor_execute")
    def _wait(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        if statement.lstrip().upper().startswith("SELECT") and table in statement and needle in statement:
            try:
                barrier.wait()
            except threading.BrokenBarrierError:
                pass

    return _wait


def _two_at_once(path: str, body: dict) -> list[int]:
    clients = [TestClient(app), TestClient(app)]
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(c.post, path, json=body) for c in clients]
        return sorted(f.result().status_code for f in futures)


def test_interleaved_code_redemption_cannot_double_spend(pg) -> None:
    _f, _d, _m, engine = pg
    client = TestClient(app)
    headers = bearer(client.post("/auth/signup", json={
        "email": f"il-{uuid.uuid4().hex[:8]}@mailbox.test-domain.co", "password": "password123"}).json()["access_token"])
    code = client.post("/extension/auth/code", headers=headers,
                       json={"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT}).json()["code"]
    listener = _forced_interleave(engine, "extension_auth_codes", "code_hash")
    try:
        statuses = _two_at_once("/extension/auth/token", {
            "grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER, "redirect_uri": REDIRECT})
    finally:
        event.remove(engine, "after_cursor_execute", listener)
    assert statuses == [200, 400]


def test_interleaved_refresh_cannot_fork_the_credential_family(pg) -> None:
    _f, _d, _m, engine = pg
    client = TestClient(app)
    headers = bearer(client.post("/auth/signup", json={
        "email": f"il2-{uuid.uuid4().hex[:8]}@mailbox.test-domain.co", "password": "password123"}).json()["access_token"])
    code = client.post("/extension/auth/code", headers=headers,
                       json={"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT}).json()["code"]
    tokens = client.post("/extension/auth/token", json={
        "grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER, "redirect_uri": REDIRECT}).json()
    listener = _forced_interleave(engine, "extension_credentials", "refresh_hash")
    try:
        statuses = _two_at_once("/extension/auth/token", {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
    finally:
        event.remove(engine, "after_cursor_execute", listener)
    # Never two live children. The loser's failed claim is treated as theft and ends the family.
    assert statuses.count(200) <= 1
    assert client.get("/extension/me", headers=bearer(tokens["access_token"])).status_code == 401
