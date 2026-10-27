"""Required invocation sets RESOURCE_TEST_REDIS_URL to a disposable Redis."""

import os
from concurrent.futures import ProcessPoolExecutor

import pytest
from fastapi import HTTPException

from app.core import resource_controls as c


def admission(url, index, slots):
    import redis

    store = c.RedisStore()
    store.client = redis.Redis.from_url(url)
    try:
        lease = store.admit(
            c.Policy("integration", 5, aggregate=5, global_slots=slots, user_slots=slots), "user:" + str(index)
        )
        return lease
    except HTTPException as e:
        return e.status_code


def test_two_worker_atomic_global_rate_and_capacity():
    url = os.environ.get("RESOURCE_TEST_REDIS_URL")
    if not url:
        pytest.skip("requires disposable Redis URL")
    import redis

    client = redis.Redis.from_url(url)
    # Dedicated disposable DB only; never flush a developer or production store.
    keys = list(client.scan_iter(c.NAMESPACE + "integration:*"))
    if keys:
        client.delete(*keys)
    with ProcessPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(admission, [url] * 20, range(20), [0] * 20))
    assert sum(isinstance(r, tuple) for r in results) == 5
    assert results.count(429) == 15
    keys = list(client.scan_iter(c.NAMESPACE + "integration:*"))
    assert len(keys) == 6
    assert all(0 < client.pttl(k) <= 60000 for k in keys)
    client.delete(*keys)
    with ProcessPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(admission, [url] * 20, range(20), [2] * 20))
    leases = [r for r in results if isinstance(r, tuple)]
    assert len(leases) == 2
    store = c.RedisStore()
    store.client = client
    for lease in leases:
        store.release(*lease)
    admission(url, 999, 2)
    # Deterministic server-side expiry, without timing-sensitive sleeps.
    keys = list(client.scan_iter(c.NAMESPACE + "integration:*"))
    for key in keys:
        client.pexpireat(key, 1)
    assert isinstance(admission(url, 1000, 2), tuple)


def test_broker_queue_capacity_duplicate_and_retry_transfer(monkeypatch):
    url = os.environ.get("RESOURCE_TEST_REDIS_URL")
    if not url:
        pytest.skip("requires disposable Redis URL")
    from types import SimpleNamespace

    import redis
    from celery import Celery

    from app.workers.tasks import BoundedCelery, release_task_dedup

    client = redis.Redis.from_url(url)
    # This Redis DB is disposable; remove only the fixed test category's keys.
    for pattern in (c.NAMESPACE + "enqueue:*", c.NAMESPACE + "queued:*", c.NAMESPACE + "publish-lock"):
        keys = list(client.scan_iter(pattern))
        if keys:
            client.delete(*keys)
    store = c.RedisStore()
    store.client = client
    monkeypatch.setattr(c, "store", store)
    sent = []

    def send(self, name, args=None, kwargs=None, **options):
        sent.append(options)
        return "published"

    monkeypatch.setattr(Celery, "send_task", send)
    app = BoundedCelery("synthetic-queue-test")
    b = c.Budget(principal="user:queue-test")
    reset = c.budget.set(b)
    try:
        assert app.send_task("match_jobs_for_user", [1]) == "published"
        with pytest.raises(HTTPException) as e:
            app.send_task("match_jobs_for_user", [1])
        assert e.value.status_code == 503
        first = sent[0]
        key = first["headers"]["xa-dedup"]
        assert 0 < client.ttl(key) <= 360
        # Finite Celery retry reuses ID and transfers ownership. Completion of
        # the prior attempt must not clear the newly queued retry's reservation.
        assert (
            app.send_task("match_jobs_for_user", [1], headers=dict(first["headers"]), task_id=first["task_id"])
            == "published"
        )
        release_task_dedup(task=SimpleNamespace(request=SimpleNamespace(headers=first["headers"])))
        assert client.exists(key)
        release_task_dedup(task=SimpleNamespace(request=SimpleNamespace(headers=sent[1]["headers"])))
        assert not client.exists(key)
        monkeypatch.setattr(c.settings, "task_queue_max_depth", 1)
        client.rpush("celery", "synthetic-message")
        try:
            with pytest.raises(HTTPException) as e:
                app.send_task("match_jobs_for_user", [2])
            assert e.value.status_code == 503
        finally:
            client.delete("celery")
        assert sent[0]["expires"] == 60 and sent[0]["retry"] is False
    finally:
        c.budget.reset(reset)
