"""Whole-chain failure precedence, as a table.

The live defect was not that the ranking was wrong — it was that the ranking
never saw a follower's failure at all. Both halves are pinned here: the ordering
itself, exhaustively, and the rule that a budget stop can only be the final word
when nothing else in the chain has anything to say.
"""

from __future__ import annotations

import httpx
import pytest

from app.people.finalization import (
    PEOPLE_DISPLAY_POLICY_VERSION,
    PEOPLE_FINALIZATION_VERSION,
    FinalizationEvent,
    ProviderOutcome,
    decide_outcome,
    display_policy_rejection,
    dominant_failure,
    every_failure_was_a_budget_stop,
)
from app.people.providers import (
    _classify_apollo_rejection,
    _safe_apollo_validation_metadata,
)

BUDGET = "provider_budget_exceeded"
SCHEMA = "provider_schema_error"
AUTH = "provider_unauthorized"
FORBIDDEN = "provider_forbidden"
TIMEOUT = "provider_timeout"
NETWORK = "provider_network_error"
OUTAGE = "provider_unavailable"
RATE = "provider_rate_limited"
DOMAIN = "company_domain_unresolved"
USER_BUDGET = "provider_user_limit_exceeded"
CANCELLED = "provider_request_cancelled"


@pytest.mark.parametrize(
    ("reasons", "expected"),
    [
        # A budget stop alone is honest.
        ([BUDGET], BUDGET),
        ([BUDGET, BUDGET], BUDGET),
        ([BUDGET, USER_BUDGET], BUDGET),
        # The live case: PDL's budget moved the chain along, Apollo's rejected
        # request is why the user has nobody.
        ([BUDGET, SCHEMA], SCHEMA),
        ([SCHEMA, BUDGET], SCHEMA),
        # Every other non-budget cause outranks it too.
        ([BUDGET, AUTH], AUTH),
        ([BUDGET, FORBIDDEN], FORBIDDEN),
        ([BUDGET, TIMEOUT], TIMEOUT),
        ([BUDGET, NETWORK], NETWORK),
        ([BUDGET, OUTAGE], OUTAGE),
        ([BUDGET, RATE], RATE),
        ([BUDGET, DOMAIN], DOMAIN),
        ([BUDGET, CANCELLED], CANCELLED),
        # Configuration outranks everything, including our own bad request.
        ([SCHEMA, AUTH], AUTH),
        ([TIMEOUT, AUTH], AUTH),
        # Our own bad request outranks a transient provider wobble: retrying
        # cannot help until the adapter changes.
        ([TIMEOUT, SCHEMA], SCHEMA),
        # Nothing at all.
        ([], None),
    ],
)
def test_the_chain_reports_the_failure_that_actually_explains_it(reasons, expected):
    assert dominant_failure(reasons) == expected


@pytest.mark.parametrize(
    ("reasons", "expected"),
    [
        ([BUDGET], True),
        ([BUDGET, USER_BUDGET], True),
        ([BUDGET, SCHEMA], False),
        ([SCHEMA], False),
        ([], False),
    ],
)
def test_budget_copy_is_gated_on_the_budget_being_the_whole_story(reasons, expected):
    assert every_failure_was_a_budget_stop(reasons) is expected


# --------------------------------------------------------------------------
# The whole decision, not just the ranking
# --------------------------------------------------------------------------


def test_an_accepted_candidate_outranks_every_provider_failure():
    outcome = decide_outcome(accepted_count=2, failures=[BUDGET, SCHEMA])
    assert outcome.status == "partial"
    assert outcome.reason is None


def test_a_clean_run_with_contacts_is_complete():
    assert decide_outcome(accepted_count=3, failures=[]).status == "complete"


def test_an_enrichment_warning_never_fails_a_run_that_found_people():
    """Rule 5: PDL budget + Apollo candidates + an enrichment warning."""

    outcome = decide_outcome(
        accepted_count=2, failures=[BUDGET], warnings=[SCHEMA]
    )
    assert outcome.status == "partial"
    assert outcome.reason is None


def test_an_enrichment_warning_speaks_when_nothing_survived():
    """The exact live shape: the swallowed rejection is what must be reported.

    With no candidates left, the enrichment rejection is the honest cause and
    the earlier budget stop is not.
    """

    outcome = decide_outcome(accepted_count=0, failures=[BUDGET], warnings=[SCHEMA])
    assert outcome.status == "invalid_request"
    assert outcome.reason == SCHEMA


def test_a_provider_that_answered_with_nobody_outranks_a_budget_stop():
    outcome = decide_outcome(
        accepted_count=0,
        failures=[BUDGET],
        no_match_categories={"likely_recruiter"},
    )
    assert outcome.status == "complete"
    assert outcome.reason is None


def test_budget_is_still_the_answer_when_no_provider_ever_answered():
    outcome = decide_outcome(accepted_count=0, failures=[BUDGET, BUDGET])
    assert outcome.status == "provider_budget_exhausted"
    assert outcome.reason == BUDGET


def test_a_truthful_empty_answer_is_not_a_failure():
    outcome = decide_outcome(
        accepted_count=0, failures=[], no_match_categories={"potential_referrer"}
    )
    assert outcome.status == "complete"
    assert outcome.is_failure is False


# --------------------------------------------------------------------------
# OpenAI parity. The finalizer must not know which provider it is looking at.
# --------------------------------------------------------------------------


def test_an_accepted_openai_candidate_outranks_earlier_provider_failures():
    outcome = decide_outcome(accepted_count=1, failures=[BUDGET, SCHEMA])
    assert outcome.status == "partial"


def test_an_openai_no_match_is_neutral_not_a_budget_stop():
    outcome = decide_outcome(
        accepted_count=0, failures=[BUDGET], no_match_categories={"likely_recruiter"}
    )
    assert outcome.status == "complete"


def test_an_openai_tool_failure_outranks_an_earlier_budget_error():
    outcome = decide_outcome(
        accepted_count=0, failures=[BUDGET, "provider_response_invalid"]
    )
    assert outcome.reason == "provider_response_invalid"
    assert outcome.status == "invalid_request"


# --------------------------------------------------------------------------
# Display policy
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Priya Raghavan", None),
        ("Daniel Okafor", None),
        # Apollo's masked-surname shapes. A redaction is not a name.
        ("Priya R███████", "obfuscated_surname"),
        ("Priya R", "obfuscated_surname"),
        ("Priya ****", "obfuscated_surname"),
        ("Priya", "incomplete_name"),
        ("", "missing_name"),
    ],
)
def test_only_a_name_a_user_could_act_on_is_displayable(name, expected):
    assert display_policy_rejection(name) == expected


# --------------------------------------------------------------------------
# Apollo 422 classification
# --------------------------------------------------------------------------


def _rejection(payload: object = None, *, text: str | None = None, status: int = 422):
    request = httpx.Request("POST", "https://api.apollo.io/api/v1/people/bulk_match")
    if text is not None:
        return httpx.Response(status, request=request, text=text)
    return httpx.Response(status, request=request, json=payload)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"error_code": "INVALID_DETAILS"}, "invalid_details"),
        ({"message": "The details parameter must be an array"}, "invalid_details"),
        ({"message": "A master api key is required"}, "master_key_required"),
        ({"message": "Your plan does not permit this"}, "plan_not_supported"),
        ({"message": "invalid id supplied"}, "invalid_identifier"),
        ({"message": "too many records requested"}, "malformed_request"),
        ({"message": "something nobody has seen before"}, "unknown_validation_error"),
    ],
)
def test_a_rejection_is_reduced_to_an_actionable_token(payload, expected):
    metadata = _safe_apollo_validation_metadata(_rejection(payload))
    assert metadata["classification"] == expected
    # A provider error *code* is contract vocabulary and is kept. A provider
    # *sentence* is not, and none of it survives.
    for value in payload.get("message", ""), payload.get("error_message", ""):
        if value:
            assert str(value) not in str(metadata)


def test_a_plain_text_rejection_is_classified_from_a_bounded_fingerprint():
    metadata = _safe_apollo_validation_metadata(
        _rejection(text="A master api key is required for this endpoint")
    )
    assert metadata["classification"] == "master_key_required"
    assert metadata["response_body_type"] == "string"
    assert "endpoint for this" not in str(metadata)


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (402, "credits_exhausted"),
        (403, "master_key_required"),
        (404, "endpoint_not_available"),
    ],
)
def test_status_codes_with_a_settled_meaning_classify_directly(status, expected):
    assert (
        _classify_apollo_rejection(
            error_types=(), message_code=None, status_code=status
        )
        == expected
    )


def test_an_empty_body_is_reported_as_empty_rather_than_as_prose():
    metadata = _safe_apollo_validation_metadata(_rejection(text=""))
    assert metadata["response_body_type"] == "empty"
    assert metadata["response_length"] == 0


# --------------------------------------------------------------------------
# The finalization event itself
# --------------------------------------------------------------------------


def test_the_finalization_event_carries_every_required_field(caplog):
    event = FinalizationEvent(
        job_id=7,
        discovery_run_id=68,
        provider_order=["pdl", "apollo"],
        providers_attempted=["pdl", "apollo"],
        provider_outcomes={
            "pdl": ProviderOutcome.SEARCH_FAILED.value,
            "apollo": ProviderOutcome.SEARCH_SUCCESS_ENRICHMENT_FAILED.value,
        },
        accepted_count=2,
        accepted_sources={"apollo": 2},
        final_status="partial",
        final_reason=None,
        quota_decision="charged",
        cache_decision="miss",
        provider_calls=4,
        duration_ms=812.4,
    )
    with caplog.at_level("INFO", logger="jobpilot.people.finalization"):
        event.emit()

    message = caplog.text
    assert "people_waterfall_finalized" in message
    for fragment in (
        "discovery_run_id=68",
        "job_id=7",
        "provider_order=pdl,apollo",
        "providers_attempted=pdl,apollo",
        "accepted_count=2",
        "final_status=partial",
        "quota_decision=charged",
        "cache_decision=miss",
        "provider_calls=4",
        f"finalization_version={PEOPLE_FINALIZATION_VERSION}",
    ):
        assert fragment in message, fragment
    assert "search_success_enrichment_failed" in message


def test_the_contract_versions_are_the_ones_the_live_defect_retired():
    from app.people.actionable import ACTIONABLE_CONTACT_POLICY_VERSION
    from app.people.brightdata import BRIGHTDATA_PROFILE_STRATEGY_VERSION
    from app.people.openai_web import OPENAI_IDENTITY_VERSION
    from app.people.service import PEOPLE_SEARCH_CONTRACT_VERSION

    assert PEOPLE_FINALIZATION_VERSION == "people-finalization-v4"
    assert PEOPLE_DISPLAY_POLICY_VERSION == "people-display-policy-v2"
    assert PEOPLE_FINALIZATION_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION
    assert PEOPLE_DISPLAY_POLICY_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION
    # Every retired contract, by name. v2 produced incorrect final statuses
    # live; v3 counted masked, linkless records as contacts. Nothing recorded
    # under either may be replayed as a current result.
    for retired in (
        "people-finalization-v2",
        "people-finalization-v3",
        "people-display-policy-v1",
    ):
        assert retired not in PEOPLE_SEARCH_CONTRACT_VERSION
    # The acceptance gate and both new provider strategies are part of the
    # contract, so changing any of them retires stored runs too.
    assert ACTIONABLE_CONTACT_POLICY_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION
    assert BRIGHTDATA_PROFILE_STRATEGY_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION
    assert OPENAI_IDENTITY_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION
