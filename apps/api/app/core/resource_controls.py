"""Finite, shared resource admissions. Redis keys contain only HMAC identities.

Rate windows and leases are evaluated atomically using Redis server time. The
aggregate rate is checked before creating an identity key, bounding cardinality.
No production local fallback is permitted. Tests inject an explicit store.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import time
import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from threading import RLock

import redis
from fastapi import HTTPException

from app.core.config import settings

logger = logging.getLogger("jobpilot.resources")
LEASE_SECONDS = 900
NAMESPACE = "xa:resources:v1:"


@dataclass
class Budget:
    path: str = ""
    method: str = ""
    principal: str | None = None
    admitted: bool = False
    closed: bool = False
    lock: RLock = field(default_factory=RLock)
    calls: int = 0
    leases: list[tuple[list[str], str]] = field(default_factory=list)


budget: ContextVar[Budget | None] = ContextVar("resource_budget", default=None)


@dataclass(frozen=True)
class Policy:
    name: str
    rate: int
    window: int = 60
    aggregate: int = 300
    global_slots: int = 0
    user_slots: int = 0


def policy(path: str, method: str) -> Policy:
    if path == "/profile/import/file":
        return Policy(
            "upload", settings.upload_per_minute, global_slots=settings.parser_global_concurrency, user_slots=1
        )
    if (
        path in {"/profile/import", "/profile/import/text"}
        or any(x in path for x in ("generate-", "regenerate-", "map-option", "outreach-draft/improve"))
        or (path == "/applications" and method == "POST")
    ):
        return Policy(
            "generation",
            settings.ai_per_minute,
            global_slots=settings.ai_global_concurrency,
            user_slots=settings.ai_user_concurrency,
        )
    if "/people" in path and (path.endswith(("/discover", "/broaden", "/email"))):
        # Cached/idempotent People actions retain their existing daily provider
        # quotas; request-level protection must not charge a fresh-discovery quota.
        return Policy("people", 30, aggregate=300, global_slots=4, user_slots=2)
    if any(x in path for x in ("/discover", "/broaden", "/refresh-matches")) or path.endswith("/email"):
        return Policy("discovery", 3, aggregate=60, global_slots=4, user_slots=1)
    if any(x in path for x in ("/documents/", "/export", "/download")) or path.endswith(
        ("/match", "/resume", "/cover-letter")
    ):
        return Policy("documents", 20, global_slots=8, user_slots=2)
    return Policy(
        "read" if method == "GET" else "write",
        120 if method == "GET" else 30,
        aggregate=1200,
        global_slots=32,
        user_slots=4,
    )


# KEYS: aggregate rate, identity rate, global leases, identity leases.
# No identity keys/leases are created when the aggregate guard rejects.
ADMIT = """
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local window=tonumber(ARGV[3]); local retry=redis.call('PTTL',KEYS[1])
if tonumber(redis.call('GET',KEYS[1]) or '0') >= tonumber(ARGV[2]) then return {1,math.max(retry,1)} end
if tonumber(redis.call('GET',KEYS[2]) or '0') >= tonumber(ARGV[1]) then
 return {1,math.max(redis.call('PTTL',KEYS[2]),1)}
end
for i=3,4 do
 redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now)
 local cap=tonumber(ARGV[i+1])
 if cap>0 and redis.call('ZCARD',KEYS[i])>=cap then return {2,0} end
end
for i=1,2 do
 if redis.call('INCR',KEYS[i])==1 then redis.call('PEXPIRE',KEYS[i],window) end
end
for i=3,4 do
 if tonumber(ARGV[i+1])>0 then
  redis.call('ZADD',KEYS[i],now+tonumber(ARGV[7]),ARGV[6]);redis.call('PEXPIRE',KEYS[i],tonumber(ARGV[7]))
 end
end
return {0,0}
"""
RELEASE = """
for i=1,#KEYS do
 redis.call('ZREM',KEYS[i],ARGV[1])
 if redis.call('ZCARD',KEYS[i])==0 then redis.call('DEL',KEYS[i]) end
end
return 1
"""


def opaque(identity: str) -> str:
    if not identity or len(identity) > 256:
        raise limit_error("INVALID_IDENTITY", 401)
    return hmac.new(settings.secret_key.encode(), identity.encode(), hashlib.sha256).hexdigest()


def limit_error(code: str, status: int, retry: int | None = None) -> HTTPException:
    # Fixed labels only: no route parameters, identifiers, contents or exception messages.
    logger.warning("resource_rejection code=%s", code)
    messages = {
        413: "The document or request is too large. Please use a smaller document.",
        429: "Too many requests. Please wait before trying again.",
        503: "Processing capacity is temporarily unavailable. Please try again later.",
        401: "Authentication is required.",
    }
    return HTTPException(
        status_code=status,
        detail=messages.get(status, "The document exceeds a processing limit."),
        headers={"X-Error-Code": code, **({"Retry-After": str(retry)} if retry else {})},
    )


class RedisStore:
    def __init__(self):
        self.client = redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=1, socket_timeout=1, retry_on_timeout=False
        )

    def admit(self, p: Policy, identity: str):
        ident = opaque(identity)
        stem = NAMESPACE + p.name + ":"
        keys = [stem + "rate:global", stem + "rate:" + ident, stem + "slots:global", stem + "slots:" + ident]
        token = uuid.uuid4().hex
        try:
            result = self.client.eval(
                ADMIT,
                4,
                *keys,
                p.rate,
                p.aggregate,
                p.window * 1000,
                p.global_slots,
                p.user_slots,
                token,
                LEASE_SECONDS * 1000,
            )
        except redis.RedisError:
            raise limit_error("LIMIT_STORE_UNAVAILABLE", 503) from None
        if result[0]:
            raise limit_error(
                "RATE_LIMITED" if result[0] == 1 else "CAPACITY_UNAVAILABLE",
                429 if result[0] == 1 else 503,
                max(1, (int(result[1]) + 999) // 1000) if result[0] == 1 else None,
            )
        return [key for key, cap in zip(keys[2:], [p.global_slots, p.user_slots], strict=True) if cap], token

    def renew(self, keys, token):
        code = """
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local refreshed=0
for i=1,#KEYS do
 if redis.call('ZSCORE',KEYS[i],ARGV[1]) then
  redis.call('ZADD',KEYS[i],now+tonumber(ARGV[2]),ARGV[1])
  redis.call('PEXPIRE',KEYS[i],tonumber(ARGV[2])); refreshed=refreshed+1
 end
end
return refreshed
"""
        try:
            count = self.client.eval(code, len(keys), *keys, token, LEASE_SECONDS * 1000)
            if count != len(keys):
                raise limit_error("LIMIT_LEASE_LOST", 503)
        except redis.RedisError:
            raise limit_error("LIMIT_STORE_UNAVAILABLE", 503) from None

    def release(self, keys, token):
        try:
            self.client.eval(RELEASE, len(keys), *keys, token)
        except redis.RedisError:
            logger.warning("resource_release_deferred code=STORE_UNAVAILABLE")


class MemoryStore:
    """Explicitly injected deterministic test double; never selected by settings."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.rates = {}
        self.slots = {}
        self.lock = RLock()

    def admit(self, p, identity):
        identity = opaque(identity)
        now = self.clock()
        keys = [p.name + ":g", p.name + ":" + identity]
        with self.lock:
            for k, cap in zip(keys, [p.aggregate, p.rate], strict=False):
                count, expiry = self.rates.get(k, (0, 0))
                if expiry > now and count >= cap:
                    raise limit_error("RATE_LIMITED", 429, max(1, int(expiry - now) + 1))
            for k, cap in zip(keys, [p.global_slots, p.user_slots], strict=False):
                self.slots[k] = {t: e for t, e in self.slots.get(k, {}).items() if e > now}
                if cap and len(self.slots[k]) >= cap:
                    raise limit_error("CAPACITY_UNAVAILABLE", 503)
            token = uuid.uuid4().hex
            for k, cap in zip(keys, [p.global_slots, p.user_slots], strict=False):
                n, expiry = self.rates.get(k, (0, 0))
                self.rates[k] = (n + 1 if expiry > now else 1, expiry if expiry > now else now + p.window)
                if cap:
                    self.slots[k][token] = now + LEASE_SECONDS
            return keys, token

    def renew(self, keys, token):
        with self.lock:
            for key in keys:
                if token in self.slots.get(key, {}):
                    self.slots[key][token] = self.clock() + LEASE_SECONDS

    def release(self, keys, token):
        with self.lock:
            for k in keys:
                self.slots.get(k, {}).pop(token, None)


store = RedisStore()


def authorize(user_id: int) -> None:
    b = budget.get()
    if b is None:
        return
    principal = "user:" + str(user_id)
    with b.lock:
        if b.closed:
            raise limit_error("REQUEST_CANCELLED", 503)
        if b.principal and b.principal != principal:
            raise limit_error("INVALID_IDENTITY", 401)
        b.principal = principal
        if not b.admitted:
            b.leases.append(store.admit(policy(b.path, b.method), principal))
            b.admitted = True


async def async_admit(p: Policy, identity: str):
    # Cancellation cannot abandon a Redis claim already executing in a thread.
    pending = asyncio.create_task(asyncio.to_thread(store.admit, p, identity))
    try:
        return await asyncio.shield(pending)
    except asyncio.CancelledError:
        try:
            lease = await pending
        except Exception:
            pass
        else:
            store.release(*lease)
        raise


@asynccontextmanager
async def ai_call(input_chars: int):
    if input_chars > settings.ai_max_input_chars:
        raise limit_error("AI_INPUT_LIMIT_EXCEEDED", 413)
    b = budget.get()
    if b is None or b.principal is None:
        raise limit_error("AI_AUTHORIZATION_REQUIRED", 401)
    b.calls += 1
    if b.calls > settings.ai_max_calls_per_request:
        raise limit_error("AI_CALL_BUDGET_EXCEEDED", 429)
    # This is in addition to the HTTP generation rate, and covers every paid call,
    # including discovery and any fallback model across a request's fan-out.
    lease = await async_admit(
        Policy(
            "ai_call",
            settings.ai_per_minute * 2,
            global_slots=settings.ai_global_concurrency,
            user_slots=settings.ai_user_concurrency,
        ),
        b.principal,
    )
    try:
        daily = await async_admit(
            Policy("ai_daily", settings.ai_daily_user_calls, window=86400, aggregate=settings.ai_daily_global_calls),
            b.principal,
        )
        store.release(*daily)
        async with asyncio.timeout(settings.ai_timeout_seconds):
            yield
    except TimeoutError:
        logger.warning("resource_timeout code=AI_TIMEOUT")
        raise
    finally:
        # Synchronous bounded Redis release cannot be abandoned by cancellation.
        store.release(*lease)
