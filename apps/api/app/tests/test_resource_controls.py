import asyncio
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException

from app.core import resource_controls as c
from app.core.config import Settings


def test_rate_boundary_expiry_and_identity():
    now = [0.0]
    store = c.MemoryStore(lambda: now[0])
    p = c.Policy("test", 2, 10, 10)
    store.admit(p, "a")
    store.admit(p, "a")
    with pytest.raises(HTTPException) as e:
        store.admit(p, "a")
    assert e.value.status_code == 429
    store.admit(p, "b")
    store.admit(c.Policy("other", 2), "a")
    now[0] = 10
    store.admit(p, "a")


def test_atomic_global_capacity_and_release():
    store = c.MemoryStore()
    p = c.Policy("parallel", 100, global_slots=2, user_slots=1)

    def admit(i):
        try:
            return store.admit(p, str(i))
        except HTTPException:
            return None

    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(admit, range(20)))
    accepted = [r for r in results if r]
    assert len(accepted) == 2
    for lease in accepted:
        store.release(*lease)
    store.admit(p, "fresh")


@pytest.mark.parametrize(
    "field,value",
    [
        ("upload_max_bytes", 0),
        ("document_timeout_seconds", 0),
        ("parser_global_concurrency", 999),
        ("ai_max_calls_per_request", 0),
        ("task_queue_max_depth", 0),
    ],
)
def test_unsafe_configuration_rejected(field, value):
    with pytest.raises(ValueError):
        Settings(_env_file=None, **{field: value})


def test_invalid_identity_and_opaque_keys():
    with pytest.raises(HTTPException):
        c.opaque("")
    assert "person@example.com" not in c.opaque("person@example.com")


def test_redis_failure_closed(monkeypatch):
    import redis

    store = c.RedisStore()

    def failed(*a, **k):
        raise redis.ConnectionError("synthetic")

    monkeypatch.setattr(store.client, "eval", failed)
    with pytest.raises(HTTPException) as e:
        store.admit(c.Policy("upload", 5), "user:1")
    assert e.value.status_code == 503


@pytest.mark.parametrize("outcome", ["success", "error", "cancel"])
def test_ai_slot_release(outcome):
    async def run():
        b = c.Budget(principal="user:1")
        token = c.budget.set(b)
        try:
            try:
                async with c.ai_call(10):
                    if outcome == "error":
                        raise RuntimeError("synthetic")
                    if outcome == "cancel":
                        raise asyncio.CancelledError()
            except (RuntimeError, asyncio.CancelledError):
                pass
            assert all(not slots for slots in c.store.slots.values())
        finally:
            c.budget.reset(token)

    asyncio.run(run())


def test_forwarding_headers_do_not_change_auth_identity(monkeypatch):
    from app.core.resource_middleware import ResourceMiddleware

    monkeypatch.setattr(c.settings, "auth_login_per_minute", 2)
    statuses = []

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.start":
            statuses.append(msg["status"])

    async def run():
        app = ResourceMiddleware(inner)
        for fake in (b"1.1.1.1", b"2.2.2.2", b"3.3.3.3"):
            await app(
                {
                    "type": "http",
                    "path": "/auth/login",
                    "method": "POST",
                    "client": ("192.0.2.1", 123),
                    "headers": [(b"x-forwarded-for", fake)],
                },
                receive,
                send,
            )

    asyncio.run(run())
    assert statuses == [200, 200, 429]


def test_auth_capacity_independent_of_rate(monkeypatch):
    store = c.MemoryStore()
    p = c.Policy("login", 20, global_slots=2, user_slots=1)
    lease = store.admit(p, "peer:192.0.2.1")
    with pytest.raises(HTTPException) as e:
        store.admit(p, "peer:192.0.2.1")
    assert e.value.status_code == 503
    store.release(*lease)
    store.admit(p, "peer:192.0.2.1")


def test_cancellation_during_redis_admission_releases_claim(monkeypatch):
    import threading

    started = threading.Event()
    proceed = threading.Event()
    store = c.MemoryStore()
    original = store.admit

    def admit(*args):
        started.set()
        assert proceed.wait(2)
        return original(*args)

    monkeypatch.setattr(store, "admit", admit)
    monkeypatch.setattr(c, "store", store)

    async def run():
        task = asyncio.create_task(c.async_admit(c.Policy("cancel_claim", 10, global_slots=1, user_slots=1), "user:1"))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        proceed.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(not slots for slots in store.slots.values())

    asyncio.run(run())


def test_closed_request_cannot_claim_late_thread_capacity():
    b = c.Budget(path="/profile/import/file", method="POST", closed=True)
    token = c.budget.set(b)
    try:
        with pytest.raises(HTTPException):
            c.authorize(1)
        assert not b.leases
    finally:
        c.budget.reset(token)
