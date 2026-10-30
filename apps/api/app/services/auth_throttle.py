"""Brute-force and abuse limits for password sign-in and sign-up.

Why this exists: ``POST /auth/login`` and ``POST /auth/signup`` accept unlimited attempts, so a password can be
guessed (or a leaked credential list replayed) as fast as the API answers. Only password recovery and People search
were limited.

Policy (all values are settings, see ``Settings.auth_*``):

* **Per account:** at most ``auth_login_max_attempts`` password attempts per ``auth_login_window_seconds`` for one
  email. The counter is keyed by a hash of the normalised email, and unknown emails are counted exactly like known
  ones, so the 429 reveals nothing about whether an account exists. A successful sign-in clears the counter. Counting
  happens BEFORE the password is checked and is atomic, so a parallel burst cannot overshoot the limit, and a blocked
  attempt costs no password hashing.
* **Per client address:** only when ``auth_trusted_proxy_hops`` is set. Behind the reverse proxy every request arrives
  from the proxy's address, so keying on ``request.client`` would throttle every user as one client. With hops
  configured, the client is the address the edge proxy appended to ``X-Forwarded-For`` (the Nth entry from the right,
  which the client cannot forge). With hops at 0 the per-address limits are off and the per-account limit still
  applies.
* **Sign-up:** ``auth_signup_per_ip_hourly_limit`` account creations per hour per client address (same trust rule).

State is shared across workers and containers through Redis (fixed window, ``INCR`` + ``EXPIRE NX``). If Redis is
unreachable the limiter falls back to a per-process counter rather than failing open, so protection degrades but does
not disappear. Under pytest only the in-process store is used, like the other external caches.

Known trade-off: an attacker who knows an address can keep that account's sign-in blocked for one window. The window
is short (default 15 minutes), recovery by email is unaffected, and the alternative is unlimited guessing. An edge
``limit_req`` rule on the two endpoints is recommended in addition (see ``docs/plans/auth-login-throttling.md``).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from app.core.config import running_under_test, settings

logger = logging.getLogger("jobpilot.auth_throttle")

TOO_MANY = "Too many attempts. Please wait a few minutes and try again."


@dataclass(frozen=True)
class _Hit:
    count: int
    retry_after: int


_LOCK = threading.Lock()
_LOCAL: dict[str, tuple[int, float]] = {}  # key -> (count, window_ends_at monotonic)
_redis_client = None
_redis_down_logged = False


def reset_auth_throttle() -> None:
    """Clear the in-process store (tests; also harmless in operations)."""
    with _LOCK:
        _LOCAL.clear()


def _redis():
    global _redis_client
    if running_under_test():
        return None
    if _redis_client is None:
        try:
            import redis

            _redis_client = redis.Redis.from_url(
                settings.redis_url, socket_connect_timeout=0.5, socket_timeout=0.5, decode_responses=True
            )
        except Exception:  # noqa: BLE001 - optional dependency/connection; the local store covers it
            return None
    return _redis_client


def _hit_local(key: str, window_seconds: int) -> _Hit:
    now = time.monotonic()
    with _LOCK:
        count, ends = _LOCAL.get(key, (0, 0.0))
        if now >= ends:
            count, ends = 0, now + window_seconds
        count += 1
        _LOCAL[key] = (count, ends)
        if len(_LOCAL) > 50_000:  # bound memory: drop expired windows
            for stale in [k for k, (_, e) in _LOCAL.items() if e <= now]:
                _LOCAL.pop(stale, None)
        return _Hit(count, max(1, int(ends - now)))


def _hit(key: str, window_seconds: int) -> _Hit:
    """Count one attempt against ``key`` and return the running count in its current window."""
    global _redis_down_logged
    client = _redis()
    if client is not None:
        try:
            redis_key = f"xa:auththrottle:{key}"
            with client.pipeline() as pipe:
                pipe.incr(redis_key)
                pipe.expire(redis_key, window_seconds, nx=True)
                pipe.ttl(redis_key)
                count, _, ttl = pipe.execute()
            _redis_down_logged = False
            return _Hit(int(count), max(1, int(ttl) if int(ttl) > 0 else window_seconds))
        except Exception:  # noqa: BLE001 - never fail open and never fail the request on a cache outage
            if not _redis_down_logged:
                logger.warning("Auth throttle: Redis unavailable; using the per-process counter.")
                _redis_down_logged = True
    return _hit_local(key, window_seconds)


def _clear(key: str) -> None:
    client = _redis()
    if client is not None:
        try:
            client.delete(f"xa:auththrottle:{key}")
        except Exception:  # noqa: BLE001
            pass
    with _LOCK:
        _LOCAL.pop(key, None)


def _digest(value: str) -> str:
    return hashlib.sha256(value.strip().lower().encode()).hexdigest()


def client_address(request: Request) -> str | None:
    """The real client address, or None when it cannot be trusted (no proxy hop count configured)."""
    hops = settings.auth_trusted_proxy_hops
    if hops <= 0:
        return None
    entries = [part.strip() for part in request.headers.get("x-forwarded-for", "").split(",") if part.strip()]
    if len(entries) >= hops:
        return entries[-hops]
    return request.client.host if request.client else None


def _block(retry_after: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=TOO_MANY,
        headers={"Retry-After": str(retry_after)},
    )


def begin_login_attempt(request: Request, email: str) -> str:
    """Count this attempt and refuse it when over the limit. Returns the account key to pass to ``login_succeeded``."""
    window = settings.auth_login_window_seconds
    account_key = f"login:acct:{_digest(email)}"
    address = client_address(request)
    if address is not None:
        ip_hit = _hit(f"login:ip:{_digest(address)}", window)
        if ip_hit.count > settings.auth_login_max_attempts_per_ip:
            raise _block(ip_hit.retry_after)
    hit = _hit(account_key, window)
    if hit.count > settings.auth_login_max_attempts:
        raise _block(hit.retry_after)
    return account_key


def login_succeeded(account_key: str) -> None:
    """A correct password clears the account's counter (the per-address counter is left to expire)."""
    _clear(account_key)


def check_signup_allowed(request: Request) -> None:
    address = client_address(request)
    if address is None:
        return
    hit = _hit(f"signup:ip:{_digest(address)}", 3600)
    if hit.count > settings.auth_signup_per_ip_hourly_limit:
        raise _block(hit.retry_after)
