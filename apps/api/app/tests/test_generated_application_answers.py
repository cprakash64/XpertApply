from __future__ import annotations

import pytest

from app.ai.provider import AIResult
from app.applications import generated_answer_service as service

PROFILE = {
    "profile": {"skills": ["Python", "FastAPI"]},
    "experience": [{"title": "Backend Engineer", "company": "Example Co"}],
    "projects": [],
    "education": [],
}
JOB = {
    "company": "Acme",
    "title": "Software Engineer",
    "responsibilities": ["Build reliable APIs"],
    "required_skills": ["Python"],
}


@pytest.mark.asyncio
async def test_structured_grounded_model_answer_keeps_provenance(monkeypatch) -> None:
    async def fake(*_args, **_kwargs):
        return AIResult(
            data={
                "answers": {
                    "custom_motivation": {
                        "answer": (
                            "My confirmed Python background is relevant to Acme's "
                            "Software Engineer role."
                        ),
                        "claimsUsed": [
                            {"claim": "Python", "source": "profile", "sourceId": "profile.skill.0"},
                            {
                                "claim": "Acme",
                                "source": "company_context",
                                "sourceId": "company_context.company",
                            },
                        ],
                        "missingInformation": [],
                        "containsUnverifiedClaim": False,
                        "requiresReview": True,
                    }
                }
            },
            model_used="test-model",
            ai_used=True,
        )

    monkeypatch.setattr(service.ai_provider, "json_task", fake)
    answer = (await service.generate_written_application_answers(
        profile_payload=PROFILE, job_payload=JOB
    ))[0]
    assert answer["source"] == "openai:test-model"
    assert answer["contains_unverified_claim"] is False
    assert answer["requires_review"] is True
    assert answer["claims_used"][0]["sourceId"] == "profile.skill.0"


@pytest.mark.asyncio
async def test_invented_technology_and_experience_are_rejected(monkeypatch) -> None:
    async def fake(*_args, **_kwargs):
        return AIResult(
            data={
                "answers": {
                    "custom_motivation": {
                        "answer": (
                            "I led Kubernetes programs for 10 years and increased "
                            "revenue by 40%."
                        ),
                        # A model cannot legitimize unsupported prose by citing a
                        # different real fact.
                        "claimsUsed": [
                            {"claim": "Python", "source": "profile", "sourceId": "profile.skill.0"}
                        ],
                        "missingInformation": [],
                        "containsUnverifiedClaim": False,
                        "requiresReview": True,
                    }
                }
            },
            model_used="test-model",
            ai_used=True,
        )

    monkeypatch.setattr(service.ai_provider, "json_task", fake)
    answer = (await service.generate_written_application_answers(
        profile_payload=PROFILE, job_payload=JOB
    ))[0]
    assert answer["source"] == "grounded_template"
    assert "Kubernetes" not in answer["value"]
    assert "10 years" not in answer["value"]
    assert "40%" not in answer["value"]
    assert answer["contains_unverified_claim"] is False


@pytest.mark.asyncio
async def test_missing_or_forged_claim_metadata_falls_back(monkeypatch) -> None:
    async def fake(*_args, **_kwargs):
        return AIResult(
            data={
                "answers": {
                    "custom_motivation": {
                        "answer": "I have a personal connection to Acme.",
                        "claimsUsed": [
                            {
                                "claim": "Personal friend of the founder",
                                "source": "profile",
                                "sourceId": "profile.skill.0",
                            }
                        ],
                        "missingInformation": [],
                        "containsUnverifiedClaim": False,
                    }
                }
            },
            model_used="test-model",
            ai_used=True,
        )

    monkeypatch.setattr(service.ai_provider, "json_task", fake)
    answer = (await service.generate_written_application_answers(
        profile_payload=PROFILE, job_payload=JOB
    ))[0]
    assert answer["source"] == "grounded_template"
    assert "personal connection" not in answer["value"].lower()
