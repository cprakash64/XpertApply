"""Sign-in and sign-up throttling (app/services/auth_throttle.py)."""

import threading
from collections.abc import Generator
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.config import settings
from app.db.base import Base
from app.main import app
from app.models import entities  # noqa: F401
from app.services import auth_throttle

PASSWORD = "correct-horse-battery"


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Session_ = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override() -> Generator[Session, None, None]:
        db = Session_()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture(autouse=True)
def small_limits(monkeypatch):
    monkeypatch.setattr(settings, "auth_login_max_attempts", 5)
    monkeypatch.setattr(settings, "auth_login_window_seconds", 900)
    monkeypatch.setattr(settings, "auth_login_max_attempts_per_ip", 8)
    monkeypatch.setattr(settings, "auth_signup_per_ip_hourly_limit", 3)
    monkeypatch.setattr(settings, "auth_trusted_proxy_hops", 0)


def signup(client, email="user@example.com", headers=None):
    return client.post("/auth/signup", json={"email": email, "password": PASSWORD}, headers=headers or {})


def login(client, email="user@example.com", password=PASSWORD, headers=None):
    return client.post("/auth/login", json={"email": email, "password": password}, headers=headers or {})


def test_account_is_blocked_after_the_limit_with_retry_after(client):
    signup(client)
    assert [login(client, password="wrong-password-1").status_code for _ in range(5)] == [401] * 5
    blocked = login(client, password="wrong-password-1")
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) > 0
    assert "Too many attempts" in blocked.json()["detail"]


def test_a_block_also_refuses_the_correct_password(client):
    """Otherwise the limit would still confirm a guess."""
    signup(client)
    for _ in range(5):
        login(client, password="wrong-password-1")
    assert login(client).status_code == 429


def test_unknown_and_known_emails_are_indistinguishable(client):
    signup(client)
    known = [login(client, password="wrong-password-1") for _ in range(6)]
    unknown = [login(client, email="nobody@example.com", password="wrong-password-1") for _ in range(6)]
    assert [r.status_code for r in known] == [r.status_code for r in unknown] == [401] * 5 + [429]
    assert known[-1].json() == unknown[-1].json()
    assert known[0].json() == unknown[0].json()


def test_a_correct_login_resets_the_counter(client):
    signup(client)
    for _ in range(4):
        login(client, password="wrong-password-1")
    assert login(client).status_code == 200
    assert [login(client, password="wrong-password-1").status_code for _ in range(5)] == [401] * 5
    assert login(client, password="wrong-password-1").status_code == 429


def test_email_case_and_whitespace_share_one_bucket_and_accounts_are_independent(client):
    signup(client)
    signup(client, email="other@example.com")
    for variant in ["USER@example.com", "User@Example.com", "user@example.com", "USER@EXAMPLE.COM", "user@example.com"]:
        assert login(client, email=variant, password="wrong-password-1").status_code == 401
    assert login(client, email="User@example.com", password="wrong-password-1").status_code == 429
    assert login(client, email="other@example.com").status_code == 200


def test_the_window_expires(client, monkeypatch):
    signup(client)
    clock = {"now": 1000.0}
    monkeypatch.setattr(auth_throttle.time, "monotonic", lambda: clock["now"])
    for _ in range(5):
        login(client, password="wrong-password-1")
    assert login(client).status_code == 429
    clock["now"] += settings.auth_login_window_seconds + 1
    assert login(client).status_code == 200


def test_a_blocked_attempt_does_not_check_the_password(client, monkeypatch):
    signup(client)
    for _ in range(5):
        login(client, password="wrong-password-1")
    calls = []
    from app.routes import auth as auth_routes

    monkeypatch.setattr(auth_routes, "verify_password", lambda *a: calls.append(a) or False)
    assert login(client, password="wrong-password-1").status_code == 429
    assert calls == []


def test_per_address_limits_are_off_without_a_trusted_proxy_count(client):
    """Behind the proxy every request shares one address; limiting on it would throttle everyone together."""
    for i in range(12):
        assert login(client, email=f"user{i}@example.com", password="x" * 12).status_code == 401
    assert [signup(client, email=f"new{i}@example.com").status_code for i in range(5)] == [200] * 5


def test_per_address_limit_with_a_trusted_proxy(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_trusted_proxy_hops", 1)
    one = {"X-Forwarded-For": "203.0.113.7"}
    other = {"X-Forwarded-For": "198.51.100.9"}
    codes = [login(client, email=f"user{i}@example.com", password="x" * 12, headers=one).status_code for i in range(10)]
    assert codes == [401] * 8 + [429] * 2  # different emails, one address
    assert login(client, email="user99@example.com", password="x" * 12, headers=other).status_code == 401


def test_a_forged_leftmost_forwarded_for_entry_cannot_evade_the_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_trusted_proxy_hops", 1)
    codes = [
        login(
            client,
            email=f"user{i}@example.com",
            password="x" * 12,
            headers={"X-Forwarded-For": f"10.0.0.{i}, 203.0.113.7"},
        ).status_code
        for i in range(10)
    ]
    assert codes == [401] * 8 + [429] * 2  # the proxy-appended rightmost entry is what counts


def test_signup_limit_per_address(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_trusted_proxy_hops", 1)
    h = {"X-Forwarded-For": "203.0.113.7"}
    codes = [signup(client, email=f"new{i}@example.com", headers=h).status_code for i in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    assert signup(client, email="elsewhere@example.com", headers={"X-Forwarded-For": "198.51.100.9"}).status_code == 200


def test_a_redis_outage_degrades_to_the_process_counter_and_still_blocks(client, monkeypatch):
    class Broken:
        def pipeline(self):
            raise ConnectionError("redis down")

        def delete(self, *_):
            raise ConnectionError("redis down")

    monkeypatch.setattr(auth_throttle, "_redis", lambda: Broken())
    signup(client)
    assert [login(client, password="wrong-password-1").status_code for _ in range(5)] == [401] * 5
    assert login(client, password="wrong-password-1").status_code == 429


def test_parallel_attempts_cannot_overshoot_the_limit():
    request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
    outcomes: list[str] = []
    guard = threading.Lock()

    def attempt():
        try:
            auth_throttle.begin_login_attempt(request, "race@example.com")
            result = "allowed"
        except HTTPException as exc:
            result = str(exc.status_code)
        with guard:
            outcomes.append(result)

    threads = [threading.Thread(target=attempt) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert outcomes.count("allowed") == settings.auth_login_max_attempts
    assert outcomes.count("429") == 40 - settings.auth_login_max_attempts


def test_redis_counter_is_used_when_available(client, monkeypatch):
    calls = []

    class FakePipe:
        def __init__(self, store):
            self.store = store
            self.ops = []

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def incr(self, k):
            self.ops.append(("incr", k))

        def expire(self, k, ttl, nx=False):
            self.ops.append(("expire", k, ttl, nx))

        def ttl(self, k):
            self.ops.append(("ttl", k))

        def execute(self):
            key = self.ops[0][1]
            self.store[key] = self.store.get(key, 0) + 1
            calls.append(self.ops)
            return [self.store[key], True, 800]

    class FakeRedis:
        def __init__(self):
            self.store = {}

        def pipeline(self):
            return FakePipe(self.store)

        def delete(self, k):
            self.store.pop(k, None)

    fake = FakeRedis()
    monkeypatch.setattr(auth_throttle, "_redis", lambda: fake)
    signup(client)
    for _ in range(5):
        assert login(client, password="wrong-password-1").status_code == 401
    blocked = login(client, password="wrong-password-1")
    assert blocked.status_code == 429 and blocked.headers["Retry-After"] == "800"
    assert fake.store and all(k.startswith("xa:auththrottle:login:acct:") for k in fake.store)
    assert calls and calls[0][1][0] == "expire" and calls[0][1][3] is True  # fixed window set once (NX)
    assert not any("user@example.com" in key for key in fake.store)  # the email is hashed in the key
