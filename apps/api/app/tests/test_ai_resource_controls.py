import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.ai.provider import AIProvider
from app.core import resource_controls as c
from app.core.config import settings


def test_ai_budget_and_input(monkeypatch):
    async def run():
        b = c.Budget(principal="user:1")
        token = c.budget.set(b)
        try:
            monkeypatch.setattr(settings, "ai_max_calls_per_request", 1)
            async with c.ai_call(10):
                pass
            with pytest.raises(HTTPException) as e:
                async with c.ai_call(10):
                    pass
            assert e.value.status_code == 429
            with pytest.raises(HTTPException):
                async with c.ai_call(settings.ai_max_input_chars + 1):
                    pass
        finally:
            c.budget.reset(token)

    asyncio.run(run())


def test_ai_overall_timeout_releases(monkeypatch):
    async def run():
        monkeypatch.setattr(settings, "ai_timeout_seconds", 0.01)
        with pytest.raises(TimeoutError):
            async with c.ai_call(10):
                await asyncio.Future()
        assert all(not slots for slots in c.store.slots.values())

    asyncio.run(run())


def test_provider_passes_server_output_cap_and_disables_sdk_retries(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "synthetic-test-key")
    provider = AIProvider()
    assert provider.client.max_retries == 0
    calls = []

    async def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"summary":"ok"}'))])

    monkeypatch.setattr(provider.client.chat.completions, "create", create)
    result = asyncio.run(provider.json_task("tailor_resume.md", {}))
    assert result.ai_used and len(calls) == 1 and calls[0]["max_tokens"] == settings.ai_max_output_tokens


def test_no_paid_call_without_authorization(monkeypatch):
    async def run():
        token = c.budget.set(None)
        try:
            with pytest.raises(HTTPException) as e:
                async with c.ai_call(10):
                    raise AssertionError("should not call")
            assert e.value.status_code == 401
        finally:
            c.budget.reset(token)

    asyncio.run(run())


def test_daily_ai_budget_and_release(monkeypatch):
    monkeypatch.setattr(settings, "ai_daily_user_calls", 1)
    monkeypatch.setattr(settings, "ai_daily_global_calls", 2)

    async def call(user):
        token = c.budget.set(c.Budget(principal=user))
        try:
            async with c.ai_call(10):
                pass
        finally:
            c.budget.reset(token)

    asyncio.run(call("user:a"))
    with pytest.raises(HTTPException) as e:
        asyncio.run(call("user:a"))
    assert e.value.status_code == 429
    asyncio.run(call("user:b"))
    with pytest.raises(HTTPException):
        asyncio.run(call("user:c"))
    assert all(not slots for slots in c.store.slots.values())
