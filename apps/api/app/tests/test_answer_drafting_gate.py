"""Fail-closed gate for NAV02 application-answer drafting (APPLICATION_ANSWER_DRAFTING_ENABLED).

A configured OPENAI_API_KEY must never be enough to reach the provider. The provider is
mocked everywhere; nothing here makes a network call.
"""

# ruff: noqa: F811  (the shared `client` fixture is imported, then requested by name)
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.ai.provider import AIResult, ai_provider
from app.applications import question_drafting_service as service
from app.core.config import Settings, settings
from app.models.entities import ApplicationAnswer, ApplicationAuditLog, ApplicationSession
from app.models.entities import ApplicationSessionStatus as SessStatus
from app.tests.test_question_drafting import (  # noqa: F401  (client is a pytest fixture)
    JOB,
    PROFILE,
    Q_AGENT,
    _db,
    _record,
    _seed,
    _signup,
    client,
)

URL = "/application-sessions/{}/draft-answers"
BODY = {
    "questions": [
        {"field_identifier": "q1", "question": Q_AGENT.question, "control_type": "textarea", "max_length": 800}
    ]
}


@pytest.fixture()
def provider_calls(monkeypatch) -> list[tuple]:
    """Replace the provider so any call is recorded; also fail loudly on a raw OpenAI client call."""
    calls: list[tuple] = []

    async def fake(name, payload, smart=True):
        calls.append((name,))
        return AIResult(data={"answers": [_record()]}, model_used="test-model", ai_used=True)

    monkeypatch.setattr(service.ai_provider, "json_task", fake)
    monkeypatch.setattr(ai_provider, "client", _ExplodingClient(), raising=False)
    monkeypatch.setattr(settings, "openai_api_key", "sk-test-not-real")
    return calls


class _ExplodingClient:
    def __getattr__(self, name):
        raise AssertionError("the OpenAI client must not be touched while drafting is disabled")


def _snapshot() -> tuple:
    db = _db()
    try:
        sessions = [(s.id, s.status, s.updated_at, s.expires_at) for s in db.scalars(select(ApplicationSession)).all()]
        logs = [row.id for row in db.scalars(select(ApplicationAuditLog)).all()]
        return sessions, logs
    finally:
        db.close()


# --- setting semantics ------------------------------------------------------ #
def test_setting_defaults_to_false_when_absent(monkeypatch) -> None:
    monkeypatch.delenv("APPLICATION_ANSWER_DRAFTING_ENABLED", raising=False)
    assert Settings(_env_file=None).application_answer_drafting_enabled is False


@pytest.mark.parametrize("raw,expected", [("false", False), ("0", False), ("true", True), ("1", True)])
def test_setting_parses_explicit_values(monkeypatch, raw, expected) -> None:
    monkeypatch.setenv("APPLICATION_ANSWER_DRAFTING_ENABLED", raw)
    assert Settings(_env_file=None).application_answer_drafting_enabled is expected


def test_setting_is_independent_of_openai_key_and_outreach_flag(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("PEOPLE_OUTREACH_DRAFTING_ENABLED", "true")
    monkeypatch.setenv("PEOPLE_OUTREACH_AI_ENABLED", "true")
    monkeypatch.delenv("APPLICATION_ANSWER_DRAFTING_ENABLED", raising=False)
    cfg = Settings(_env_file=None)
    assert cfg.openai_api_key == "sk-test-not-real"
    assert cfg.application_answer_drafting_enabled is False


# --- disabled behaviour ----------------------------------------------------- #
@pytest.mark.parametrize("state", ["absent", "false"])
def test_disabled_endpoint_returns_503_with_zero_provider_calls_and_no_mutation(
    client, provider_calls, monkeypatch, state
) -> None:
    # "absent" uses the field's declared default; "false" sets it explicitly. Both with a key configured.
    default = Settings.model_fields["application_answer_drafting_enabled"].default
    monkeypatch.setattr(settings, "application_answer_drafting_enabled", default if state == "absent" else False)
    headers = _signup(client, f"gate-{state}@example.com")
    sid = _seed(f"gate-{state}@example.com", "Co", "Built an agent")
    before = _snapshot()
    resp = client.post(URL.format(sid), headers=headers, json=BODY)
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "answer_drafting_disabled"
    text = resp.text
    assert "sk-test" not in text and "Built an agent" not in text and Q_AGENT.question not in text
    assert provider_calls == []
    assert _snapshot() == before


def test_disabled_gate_does_not_weaken_authentication_or_authorization(client, provider_calls, monkeypatch) -> None:
    monkeypatch.setattr(settings, "application_answer_drafting_enabled", False)
    _signup(client, "auth-a@example.com")
    b = _signup(client, "auth-b@example.com")
    sid = _seed("auth-a@example.com", "Co", "fact")
    assert client.post(URL.format(sid), json=BODY).status_code in (401, 403)
    assert client.post(URL.format(sid), headers={"Authorization": "Bearer garbage"}, json=BODY).status_code in (
        401,
        403,
    )
    assert client.post(URL.format(sid), headers=b, json=BODY).status_code in (401, 403, 404)
    assert provider_calls == []


def test_disabled_service_refuses_direct_invocation_before_any_provider_work(monkeypatch, provider_calls) -> None:
    import asyncio

    monkeypatch.setattr(settings, "application_answer_drafting_enabled", False)
    with pytest.raises(service.DraftingDisabledError):
        asyncio.run(service.draft_answers(questions=[Q_AGENT], profile_payload=PROFILE, job_payload=JOB))
    assert provider_calls == []


def test_non_boolean_truthy_values_do_not_enable(monkeypatch) -> None:
    for value in ("true", 1, "yes", None):
        monkeypatch.setattr(settings, "application_answer_drafting_enabled", value)
        assert service.drafting_enabled() is False


def test_disabled_request_on_a_near_expiry_session_only_slides_the_session_deadline(
    client, provider_calls, monkeypatch
) -> None:
    """session_access (existing behaviour, unchanged) extends a live session's idle deadline on any
    authenticated request, committing before the gate runs. So a disabled request is NOT zero DB writes:
    the one permitted write is that expiry slide. No draft, answer or audit data may change."""
    monkeypatch.setattr(settings, "application_answer_drafting_enabled", False)
    headers = _signup(client, "touch@example.com")
    sid = _seed("touch@example.com", "Co", "Built an agent")
    db = _db()
    try:
        near = datetime.now(UTC) + timedelta(minutes=5)
        db.get(ApplicationSession, sid).expires_at = near
        db.commit()
        answers_before = [a.id for a in db.scalars(select(ApplicationAnswer)).all()]
        logs_before = [row.id for row in db.scalars(select(ApplicationAuditLog)).all()]
    finally:
        db.close()

    resp = client.post(URL.format(sid), headers=headers, json=BODY)

    assert resp.status_code == 503 and resp.json()["detail"]["code"] == "answer_drafting_disabled"
    assert provider_calls == []
    db = _db()
    try:
        session = db.get(ApplicationSession, sid)
        expires = session.expires_at if session.expires_at.tzinfo else session.expires_at.replace(tzinfo=UTC)
        assert expires > near + timedelta(minutes=10), "the existing expiry touch is expected to have slid the deadline"
        assert session.status == SessStatus.ready
        assert [a.id for a in db.scalars(select(ApplicationAnswer)).all()] == answers_before
        assert [row.id for row in db.scalars(select(ApplicationAuditLog)).all()] == logs_before
        assert all(row.action_type != "answer_drafting" for row in db.scalars(select(ApplicationAuditLog)).all())
    finally:
        db.close()


# --- enabled behaviour ------------------------------------------------------ #
def test_enabled_endpoint_keeps_the_existing_flow_with_a_mocked_provider(client, provider_calls, monkeypatch) -> None:
    monkeypatch.setattr(settings, "application_answer_drafting_enabled", True)
    headers = _signup(client, "on@example.com")
    sid = _seed("on@example.com", "Co", "Built a support-triage agent used by 40 agents daily")
    resp = client.post(URL.format(sid), headers=headers, json=BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"drafts", "drafted"}
    assert body["drafts"][0]["field_identifier"] == "q1" and body["drafts"][0]["verified"] is False
    assert len(provider_calls) == 1
    db = _db()
    try:
        assert db.scalars(select(ApplicationAuditLog)).all(), "enabled drafting still records its audit action"
    finally:
        db.close()


# --- scope guards ----------------------------------------------------------- #
# "Other OpenAI features are unaffected" is supported by source-diff inspection, not a behavioural test:
# the diff adds the flag only to config.py, the drafting service and the drafting route; app/ai/provider.py
# and every other caller are untouched.
def test_no_new_celery_tasks_orm_tables_or_migration_heads() -> None:
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from app.db.base import Base
    from app.workers.tasks import celery_app

    tasks = sorted(name for name in celery_app.tasks if not name.startswith("celery."))
    assert tasks == ["match_jobs_for_user", "run_daily_ingestion", "score_jobs_for_users"]
    assert len(Base.metadata.tables) == 34  # +password_reset_tokens (0034)
    assert ScriptDirectory.from_config(Config("alembic.ini")).get_heads() == ["0034_password_reset"]
