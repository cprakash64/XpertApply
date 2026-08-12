"""Short-lived cache for the Dashboard's discovery result.

Only the expensive part is cached: the fresh-match count and the ids of the
best-scoring eligible postings, which together are one evaluation of the
discovery gate. Application counts and the recent-application list are always
read live, so a status change is never shown stale — see
:mod:`app.dashboard.summary_service`.

The storage strategy deliberately mirrors
:mod:`app.people.complete_person_cache`: Redis when it is reachable, an
in-process dict otherwise, and neither in tests. This is the repository's
existing caching approach, not a second one.

Staleness is bounded from two directions:

* the cache key carries a *fingerprint* of everything the count depends on that
  the user can change synchronously — their profile row and their application
  ledger — so editing a profile or applying to a job lands on a different key
  and can never read a stale count;
* :data:`TTL_SECONDS` bounds how long a newly ingested batch of postings takes
  to show up, because job ingestion runs in the background and is not part of
  the fingerprint.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from threading import Lock

from app.core.config import running_under_test, settings

#: Job ingestion is a background batch, so a newly discovered posting may take
#: up to this long to be reflected in the fresh-match count. Everything the user
#: changes themselves is fingerprinted into the key and bypasses this entirely.
TTL_SECONDS = 60

#: Bump when the meaning of a cached value changes, so old entries are ignored
#: rather than misread after a deploy.
CACHE_VERSION = "v2"

_LOCAL: dict[str, tuple[datetime, str]] = {}
_LOCK = Lock()


def cache_key(*, user_id: int, fingerprint: str) -> str:
    return f"dashboard:fresh-matches:{CACHE_VERSION}:{user_id}:{fingerprint}"


def _redis_client():
    """A Redis client, or None when Redis is unavailable or disabled.

    Tests never touch Redis: the local dict alone keeps them deterministic and
    independent of whether a developer has the container running.

    ``app_env`` alone is not enough to guarantee that. A normal local checkout
    runs pytest with the developer's own ``.env``, where ``APP_ENV`` is
    ``development``, so the suite would reach the dev Redis container whenever
    it happened to be up. Every test builds a fresh in-memory database whose
    user ids restart at 1 and whose fixture profiles are identical, so the keys
    collide: ``clear_local_dashboard_cache`` empties the in-process dict but
    cannot evict those entries, and one test reads the previous test's counts.
    Detecting the active pytest run closes that hole without depending on how a
    given machine is configured. ``PYTEST_CURRENT_TEST`` is set by pytest only,
    so this is inert in production.
    """
    if running_under_test():
        return None
    try:
        import redis

        return redis.Redis.from_url(
            settings.redis_url,
            socket_connect_timeout=0.5,
            socket_timeout=0.5,
            decode_responses=True,
        )
    except Exception:
        return None


def read_fresh_matches(key: str) -> dict | None:
    """The cached discovery result, or None on a miss.

    Never raises: a cache failure must degrade to a recompute, never to a failed
    Dashboard. A value that does not have the expected shape is treated as a
    miss, so a stale or corrupted entry cannot reach the response.
    """
    raw: str | None = None
    client = _redis_client()
    if client is not None:
        try:
            raw = client.get(key)
        except Exception:
            raw = None
    if raw is None:
        with _LOCK:
            local = _LOCAL.get(key)
            if local and local[0] > datetime.now(UTC):
                raw = local[1]
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("count"), int)
        or not isinstance(value.get("topJobIds"), list)
        or not isinstance(value.get("strongCount"), int)
    ):
        return None
    return value


def write_fresh_matches(key: str, discovery: dict) -> None:
    """Store the discovery result. Best-effort in the same sense as the read."""
    raw = json.dumps(discovery)
    client = _redis_client()
    if client is not None:
        try:
            client.setex(key, TTL_SECONDS, raw)
        except Exception:
            pass
    with _LOCK:
        _LOCAL[key] = (datetime.now(UTC) + timedelta(seconds=TTL_SECONDS), raw)
        # The local dict is a fallback, not a store: drop entries that have aged
        # out so a long-lived process cannot grow one per user per fingerprint.
        if len(_LOCAL) > 512:
            now = datetime.now(UTC)
            for stale in [k for k, (expires, _) in _LOCAL.items() if expires <= now]:
                _LOCAL.pop(stale, None)


def clear_local_dashboard_cache() -> None:
    """Drop in-process entries. Used by tests."""
    with _LOCK:
        _LOCAL.clear()
