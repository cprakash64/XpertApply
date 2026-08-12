"""Public-web fallback: what it is allowed to believe.

The model is a retrieval reporter, not a source of truth. Every test here is a
way it could invent a person, and the assertion is that XpertApply throws the row
away. No test makes a network call: the OpenAI client is a stub.
"""

from __future__ import annotations

import json

import pytest

from app.core.config import settings
from app.people.openai_web import (
    OpenAIWebPeopleProvider,
    build_search_plan,
    is_public_source_url,
    safe_public_linkedin_url,
)

LINKEDIN = "https://www.linkedin.com/in/rita-recruiter"
SOURCE = "https://acme.example/team/talent"


class StubResponses:
    def __init__(self, payload: object) -> None:
        self._payload = payload
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)

        class _Response:
            output_text = (
                self._payload if isinstance(self._payload, str) else json.dumps(self._payload)
            )

        return _Response()


class StubClient:
    def __init__(self, payload: object) -> None:
        self.responses = StubResponses(payload)


def candidate(**overrides) -> dict:
    row = {
        "full_name": "Rita Recruiter",
        "current_title": "Senior Technical Recruiter",
        "current_company": "Acme AI",
        "category": "likely_recruiter",
        "linkedin_url": LINKEDIN,
        # The profile itself is the retrieved page, which is what corroborates
        # the URL. A URL with no such backing is dropped.
        "source_url": LINKEDIN,
        "source_title": "Rita Recruiter — LinkedIn",
        "evidence_excerpt": "Rita Recruiter is a Senior Technical Recruiter at Acme AI.",
        "confidence": 0.93,
    }
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def _enabled(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "people_openai_web_discovery_enabled", True, raising=False)
    monkeypatch.setattr(settings, "openai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "people_openai_web_min_confidence", 0.85, raising=False)
    monkeypatch.setattr(settings, "people_openai_web_max_candidates", 4, raising=False)
    monkeypatch.setattr(
        settings, "people_openai_web_max_searches_per_discovery", 2, raising=False
    )


async def discover(payload: object, **kwargs):
    provider = OpenAIWebPeopleProvider(client=StubClient(payload))
    return await provider.discover(
        company_name=kwargs.pop("company_name", "Acme AI"),
        company_aliases=kwargs.pop("company_aliases", ()),
        company_domain=kwargs.pop("company_domain", "acme.example"),
        categories=kwargs.pop("categories", ("likely_recruiter",)),
        **kwargs,
    )


# --------------------------------------------------------------------------
# The happy path is still conservative
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_a_fully_sourced_candidate_is_accepted_but_marked_unverified():
    outcome = await discover({"candidates": [candidate()]})

    assert len(outcome.candidates) == 1
    found = outcome.candidates[0]
    assert found.provider == "openai_web"
    assert found.linkedin_url == LINKEDIN
    assert found.employment_source == "public_web_discovered"
    assert found.evidence["independently_verified"] is False
    assert found.evidence["source_url"] == LINKEDIN
    # A public page is never an employment verification.
    assert found.employment_verified_at is None


@pytest.mark.anyio
async def test_provider_is_inert_until_explicitly_enabled(monkeypatch):
    monkeypatch.setattr(
        settings, "people_openai_web_discovery_enabled", False, raising=False
    )
    client = StubClient({"candidates": [candidate()]})
    provider = OpenAIWebPeopleProvider(client=client)
    outcome = await provider.discover(
        company_name="Acme AI", categories=("likely_recruiter",)
    )

    assert outcome.candidates == []
    assert outcome.failure_reason == "provider_not_configured"
    assert client.responses.calls == []


# --------------------------------------------------------------------------
# Every way the model could invent a person
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_a_candidate_without_a_source_url_is_rejected():
    outcome = await discover({"candidates": [candidate(source_url="")]})
    assert outcome.candidates == []
    assert outcome.rejected["missing_source_url"] == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "url",
    [
        "http://acme.example/team",
        "https://localhost/team",
        "https://www.linkedin.com/feed/update/123",
        "https://user:pass@acme.example/team",
        "not-a-url",
    ],
)
async def test_non_public_or_authenticated_sources_are_rejected(url):
    outcome = await discover({"candidates": [candidate(source_url=url)]})
    assert outcome.candidates == []
    assert outcome.rejected


@pytest.mark.anyio
async def test_evidence_that_never_names_the_company_is_an_unsupported_claim():
    outcome = await discover(
        {"candidates": [candidate(evidence_excerpt="A recruiter posted a job today.")]}
    )
    assert outcome.candidates == []
    assert outcome.rejected["unsupported_claim"] == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "excerpt",
    [
        "Rita Recruiter is a former recruiter at Acme AI.",
        "Rita Recruiter previously worked at Acme AI.",
        "Rita Recruiter, ex-Acme AI recruiter, now at Globex.",
    ],
)
async def test_past_employment_only_evidence_is_rejected(excerpt):
    outcome = await discover({"candidates": [candidate(evidence_excerpt=excerpt)]})
    assert outcome.candidates == []
    assert outcome.rejected["past_employment_only"] == 1


@pytest.mark.anyio
async def test_an_uncorroborated_profile_url_is_dropped_but_the_person_is_kept():
    # The URL appears in no retrieved source. The person's identity rests on the
    # cited team page, so they survive — without a link XpertApply cannot stand
    # behind. Showing a guessed profile would point at a real stranger.
    outcome = await discover(
        {
            "candidates": [
                candidate(linkedin_url="https://www.linkedin.com/in/some-other-slug")
            ]
        }
    )
    assert len(outcome.candidates) == 1
    assert outcome.candidates[0].linkedin_url is None
    assert outcome.rejected["uncorroborated_linkedin_url"] == 1


@pytest.mark.anyio
async def test_a_cited_linkedin_url_is_kept_even_when_it_matches_the_name():
    # Same slug, but this time the URL *is* the retrieved source.
    outcome = await discover(
        {
            "candidates": [
                candidate(
                    linkedin_url="https://www.linkedin.com/in/ritarecruiter",
                    source_url="https://www.linkedin.com/in/ritarecruiter",
                )
            ]
        }
    )
    assert len(outcome.candidates) == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "url",
    [
        "http://www.linkedin.com/in/rita",
        "https://linkedin.example.com/in/rita",
        "https://www.linkedin.com/company/acme",
        "javascript:alert(1)",
    ],
)
async def test_unsafe_profile_urls_are_rejected_outright(url):
    outcome = await discover({"candidates": [candidate(linkedin_url=url)]})
    assert outcome.candidates == []
    assert outcome.rejected["manufactured_linkedin_url"] == 1


@pytest.mark.anyio
async def test_a_row_carrying_an_email_is_discarded_entirely():
    outcome = await discover(
        {"candidates": [candidate(email="rita@acme.example")]}
    )
    assert outcome.candidates == []
    assert outcome.rejected["email_supplied"] == 1


@pytest.mark.anyio
async def test_low_confidence_rows_are_rejected():
    outcome = await discover({"candidates": [candidate(confidence=0.6)]})
    assert outcome.candidates == []
    assert outcome.rejected["low_confidence"] == 1


@pytest.mark.anyio
async def test_a_missing_or_unparseable_confidence_is_rejected():
    outcome = await discover({"candidates": [candidate(confidence="very sure")]})
    assert outcome.candidates == []
    assert outcome.rejected["low_confidence"] == 1


@pytest.mark.anyio
async def test_a_different_current_employer_is_rejected():
    outcome = await discover(
        {
            "candidates": [
                candidate(
                    current_company="Globex",
                    evidence_excerpt="Rita works at Globex, a partner of Acme AI.",
                )
            ]
        }
    )
    assert outcome.candidates == []
    assert outcome.rejected["company_mismatch"] == 1


@pytest.mark.anyio
async def test_two_people_sharing_a_name_are_both_rejected_as_ambiguous():
    outcome = await discover(
        {
            "candidates": [
                candidate(),
                candidate(
                    current_title="Recruiting Coordinator",
                    source_url="https://acme.example/team/coordinators",
                    linkedin_url=None,
                    source_title="Acme AI — Coordinators",
                ),
            ]
        }
    )
    assert outcome.candidates == []
    assert outcome.rejected["ambiguous_identity"] == 2


@pytest.mark.anyio
async def test_rows_missing_required_fields_are_rejected():
    outcome = await discover({"candidates": [candidate(full_name="", current_title="")]})
    assert outcome.candidates == []
    assert outcome.rejected["missing_required_field"] == 1


@pytest.mark.anyio
async def test_a_category_the_caller_did_not_ask_for_is_not_returned():
    outcome = await discover(
        {"candidates": [candidate(category="potential_referrer")]},
        categories=("likely_recruiter",),
    )
    assert outcome.candidates == []


@pytest.mark.anyio
async def test_unparseable_model_output_yields_nothing_rather_than_guesses():
    outcome = await discover("I could not find anyone useful, sorry!")
    assert outcome.candidates == []


@pytest.mark.anyio
async def test_an_empty_answer_is_a_valid_answer():
    outcome = await discover({"candidates": []})
    assert outcome.candidates == []
    assert outcome.failure_reason is None


@pytest.mark.anyio
async def test_a_client_failure_is_reported_without_leaking_the_request():
    class Boom:
        class responses:  # noqa: N801 - stub shape mirrors the SDK
            @staticmethod
            async def create(**_kwargs):
                raise RuntimeError("rita@acme.example leaked in the message")

    provider = OpenAIWebPeopleProvider(client=Boom())
    outcome = await provider.discover(
        company_name="Acme AI", categories=("likely_recruiter",)
    )
    assert outcome.candidates == []
    assert outcome.failure_reason == "provider_unavailable"


@pytest.mark.anyio
async def test_candidate_count_is_capped(monkeypatch):
    monkeypatch.setattr(settings, "people_openai_web_max_candidates", 1, raising=False)
    outcome = await discover(
        {
            "candidates": [
                candidate(),
                candidate(
                    full_name="Sam Sourcer",
                    linkedin_url=None,
                    source_url="https://acme.example/team/sourcing",
                    evidence_excerpt="Sam Sourcer is a recruiter at Acme AI.",
                    source_title="Acme AI — Sourcing",
                ),
            ]
        }
    )
    assert len(outcome.candidates) == 1


# --------------------------------------------------------------------------
# Query planning
# --------------------------------------------------------------------------


def test_the_search_plan_is_capped_and_gap_scoped():
    plan = build_search_plan(
        company_name="Acme AI",
        categories=("likely_recruiter", "potential_hiring_manager", "potential_referrer"),
        max_searches=2,
    )
    assert len(plan) == 2
    assert all('"Acme AI"' in query for query in plan)
    assert "site:linkedin.com/in" in plan[0]


def test_no_searches_are_planned_when_the_budget_is_zero():
    assert build_search_plan(
        company_name="Acme AI", categories=("likely_recruiter",), max_searches=0
    ) == []


# --------------------------------------------------------------------------
# URL helpers
# --------------------------------------------------------------------------


def test_safe_public_linkedin_url_accepts_only_real_profile_links():
    assert safe_public_linkedin_url(LINKEDIN) == LINKEDIN
    assert safe_public_linkedin_url("https://uk.linkedin.com/in/rita") == (
        "https://uk.linkedin.com/in/rita"
    )
    assert safe_public_linkedin_url("https://www.linkedin.com/in/") is None
    assert safe_public_linkedin_url(None) is None


def test_public_source_urls_exclude_authenticated_surfaces():
    assert is_public_source_url("https://acme.example/team") is True
    assert is_public_source_url("https://www.linkedin.com/in/rita") is True
    assert is_public_source_url("https://www.linkedin.com/checkpoint/lg/login") is False
    assert is_public_source_url("https://acme.local/team") is False
