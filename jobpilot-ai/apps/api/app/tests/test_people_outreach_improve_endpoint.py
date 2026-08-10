"""The explicit "Improve with AI" endpoint, wired end to end.

The properties that matter are not "does it produce nice prose" but:

* nothing calls OpenAI unless the user explicitly asked,
* one explicit action costs at most one completion,
* and a model that misbehaves changes nothing the user sees.

The deterministic draft is built before the model is consulted, so every exit
path already holds correct content. These tests assert that the content really
does survive each failure mode rather than being replaced by an error or a
blank.

No OpenAI request is made anywhere in this file: the provider is always
substituted.
"""

from __future__ import annotations

import pytest

from app.ai.provider import AIResult
from app.core.config import settings
from app.people import outreach_improve
from app.people.outreach_improve import GENERATION_PATHS, improve_outreach_draft
from app.people.schemas import OutreachDraftRequest

DETERMINISTIC = {
    "subject": "Quick question about the Machine Learning Engineer role",
    "body": "Hi Rita,\n\nI'm applying.\n\nThanks,\nCasey Candidate",
    "linkedin_body": "Hi Rita — I'm applying. Thanks, Casey",
    "draft": "Hi Rita,\n\nI'm applying.\n\nThanks,\nCasey Candidate",
    "facts_used": [],
    "generation_path": "deterministic_template",
    "character_count": 48,
}


class _Recorder:
    """Counts completions so "one action, one request" is measurable."""

    def __init__(self, result: object) -> None:
        self.calls = 0
        self._result = result

    async def json_task(self, *_args: object, **_kwargs: object) -> object:
        self.calls += 1
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


@pytest.fixture(autouse=True)
def _wiring(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolate the endpoint from the database, Redis and the real provider."""

    monkeypatch.setattr(settings, "people_outreach_ai_enabled", True)
    monkeypatch.setattr(settings, "people_outreach_ai_per_user_daily_limit", 50)
    monkeypatch.setattr(settings, "people_outreach_ai_daily_budget", 500)
    # No Redis in unit tests: the cache is an optimisation, never a dependency.
    monkeypatch.setattr(outreach_improve, "_redis", lambda: None)
    monkeypatch.setattr(
        outreach_improve, "_job_or_404_unused", lambda *a, **k: None, raising=False
    )


def _patch_service(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stand in for the ownership checks and the deterministic builder."""

    import app.people.service as service

    class _Job:
        company = "Acme AI"
        title = "Machine Learning Engineer"
        required_skills = ["machine learning"]
        role_family = "machine_learning"

    class _Candidate:
        candidate_category = "likely_recruiter"

    class _Person:
        canonical_full_name = "rita recruiter"
        current_title = "Technical Recruiter"

    monkeypatch.setattr(service, "_job_or_404", lambda db, job_id: _Job())
    monkeypatch.setattr(
        service,
        "owned_recommendation",
        lambda db, user, job_id, rec_id: (object(), _Candidate(), _Person()),
    )
    monkeypatch.setattr(
        service,
        "outreach_draft",
        lambda *a, **k: dict(DETERMINISTIC),
    )
    monkeypatch.setattr(service, "rate_limit", lambda *a, **k: None)


class _User:
    id = 7


class _Db:
    """The profile lookup is the only DB access left after the stubs above."""

    @staticmethod
    def scalar(*_a: object, **_k: object) -> None:
        return None


def _request() -> OutreachDraftRequest:
    return OutreachDraftRequest(draft_type="recruiter_introduction")


async def _improve(monkeypatch: pytest.MonkeyPatch, recorder: _Recorder) -> dict:
    _patch_service(monkeypatch)
    monkeypatch.setattr(outreach_improve, "AIProvider", lambda: recorder)
    monkeypatch.setattr(
        outreach_improve,
        "_build_context",
        lambda **kwargs: _CONTEXT,
    )
    return await improve_outreach_draft(_Db(), _User(), 1, 2, _request())


from app.people.outreach_ai import OutreachContext, OutreachFact  # noqa: E402

_CONTEXT = OutreachContext(
    recipient_first_name="Rita",
    recipient_full_name="Rita Recruiter",
    category="likely_recruiter",
    company="Acme AI",
    short_job_title="Machine Learning Engineer",
    application_status="not_submitted",
    candidate_display_name="Casey Candidate",
    candidate_first_name="Casey",
    recipient_title="Technical Recruiter",
    qualifications=[OutreachFact("qual:0", "Python")],
)

VALID_MODEL_OUTPUT = {
    "email_subject": "Quick question about the Machine Learning Engineer role",
    "email_body": (
        "Hi Rita,\n\nI'm applying for the Machine Learning Engineer role at "
        "Acme AI. My background in Python lines up closely with what the "
        "posting describes for this team, and the problems it works on are the "
        "ones I have spent the most time on.\n\nIs there anything the team is "
        "prioritising most for this opening?\n\nThanks,\nCasey Candidate"
    ),
    "linkedin_body": (
        "Hi Rita — I'm applying for the Machine Learning Engineer role at Acme "
        "AI. My background in Python is closely related. Is there anything the "
        "team is prioritising most for this opening? Thanks, Casey"
    ),
    "facts_used": ["qual:0"],
    "omitted_uncertain_facts": [],
    "requires_manual_review": False,
}


def _ai(data: dict) -> AIResult:
    return AIResult(data=data, model_used="test-model", ai_used=True)


# --- Gating -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_flag_off_refuses_without_calling_the_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    monkeypatch.setattr(settings, "people_outreach_ai_enabled", False)
    recorder = _Recorder(_ai(VALID_MODEL_OUTPUT))
    with pytest.raises(HTTPException):
        await _improve(monkeypatch, recorder)
    assert recorder.calls == 0


@pytest.mark.asyncio
async def test_one_explicit_action_costs_exactly_one_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder = _Recorder(_ai(VALID_MODEL_OUTPUT))
    await _improve(monkeypatch, recorder)
    assert recorder.calls == 1


# --- The accepted path --------------------------------------------------------


@pytest.mark.asyncio
async def test_a_validated_result_replaces_all_three_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = await _improve(monkeypatch, _Recorder(_ai(VALID_MODEL_OUTPUT)))
    assert result["generation_path"] == "openai_validated"
    assert result["subject"] == VALID_MODEL_OUTPUT["email_subject"]
    assert result["body"] == VALID_MODEL_OUTPUT["email_body"]
    assert result["linkedin_body"] == VALID_MODEL_OUTPUT["linkedin_body"]
    # The email action reads `draft`; it must move with the body.
    assert result["draft"] == result["body"]
    assert result["prompt_version"] == "people-outreach-ai-v1"


# --- Every failure keeps the deterministic draft -------------------------------


@pytest.mark.parametrize(
    ("label", "model_result"),
    [
        ("malformed json", {"not": "a draft"}),
        ("empty object", {}),
        (
            "unknown fact id",
            {**VALID_MODEL_OUTPUT, "facts_used": ["qual:invented"]},
        ),
        (
            "invented employer",
            {
                **VALID_MODEL_OUTPUT,
                "email_body": VALID_MODEL_OUTPUT["email_body"].replace(
                    "the most time on.", "the most time on. Globex shaped that."
                ),
            },
        ),
        (
            "invented relationship",
            {
                **VALID_MODEL_OUTPUT,
                "linkedin_body": "Hi Rita — we were classmates. "
                + VALID_MODEL_OUTPUT["linkedin_body"],
            },
        ),
        (
            "referral demand",
            {
                **VALID_MODEL_OUTPUT,
                "linkedin_body": VALID_MODEL_OUTPUT["linkedin_body"].replace(
                    "Is there anything the team is prioritising most for this "
                    "opening?",
                    "Would you refer me?",
                ),
            },
        ),
        (
            "banned phrase",
            {
                **VALID_MODEL_OUTPUT,
                "email_body": VALID_MODEL_OUTPUT["email_body"].replace(
                    "Hi Rita,", "Hi Rita,\n\nI hope this message finds you well."
                ),
            },
        ),
        (
            "false application status",
            {
                **VALID_MODEL_OUTPUT,
                "email_body": VALID_MODEL_OUTPUT["email_body"].replace(
                    "I'm applying for", "I recently applied for"
                ),
            },
        ),
    ],
)
@pytest.mark.asyncio
async def test_unsafe_output_never_reaches_the_user(
    monkeypatch: pytest.MonkeyPatch, label: str, model_result: dict
) -> None:
    result = await _improve(monkeypatch, _Recorder(_ai(model_result)))
    assert result["generation_path"] == "deterministic_fallback", label
    # The deterministic content is returned verbatim — not blanked, not an error.
    assert result["subject"] == DETERMINISTIC["subject"], label
    assert result["body"] == DETERMINISTIC["body"], label
    assert result["linkedin_body"] == DETERMINISTIC["linkedin_body"], label
    assert result["ai_fallback_reason"], label


@pytest.mark.asyncio
async def test_a_provider_exception_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = await _improve(monkeypatch, _Recorder(RuntimeError("boom")))
    assert result["generation_path"] == "deterministic_fallback"
    assert result["ai_fallback_reason"] == "provider_error"
    assert result["body"] == DETERMINISTIC["body"]


@pytest.mark.asyncio
async def test_the_providers_own_local_fallback_is_not_a_refinement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AIProvider returns ai_used=False when it never reached OpenAI."""

    offline = AIResult(data=VALID_MODEL_OUTPUT, model_used="deterministic-local", ai_used=False)
    result = await _improve(monkeypatch, _Recorder(offline))
    assert result["generation_path"] == "deterministic_fallback"
    assert result["ai_fallback_reason"] == "provider_unavailable"


@pytest.mark.asyncio
async def test_a_daily_limit_refuses_before_spending_a_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    import app.people.service as service

    _patch_service(monkeypatch)

    def _refuse(*_a: object, **_k: object) -> None:
        raise HTTPException(status_code=429, detail={"code": "PEOPLE_RATE_LIMITED"})

    monkeypatch.setattr(service, "rate_limit", _refuse)
    recorder = _Recorder(_ai(VALID_MODEL_OUTPUT))
    monkeypatch.setattr(outreach_improve, "AIProvider", lambda: recorder)
    with pytest.raises(HTTPException):
        await improve_outreach_draft(_Db(), _User(), 1, 2, _request())
    assert recorder.calls == 0


def test_the_generation_paths_are_the_documented_three() -> None:
    assert GENERATION_PATHS == (
        "deterministic_template",
        "openai_validated",
        "deterministic_fallback",
    )
