"""The complete PDL-failure → Apollo-fallback decision matrix.

The question this file answers is the one an operator asks during an incident:
*"PDL is broken in way X. Do users still get people?"*

Two defects were found by writing it out exhaustively:

1. **PDL 401/403 disqualified Apollo.** A revoked key, an expired plan, or a
   grant the account does not hold stopped the entire feature, while a second
   fully-credentialed provider sat idle. Those failures correctly stop *PDL*
   (they open the configuration circuit — retrying cannot fix a bad
   credential), but they say nothing about whether Apollo can answer.

2. **A malformed PDL response was recorded as our own bad request.**
   ``provider_schema_error`` mapped to ``INVALID_INPUT``, which is in
   ``_NEVER_FALLBACK``, so a provider-side contract break blocked fallback and
   was filed under "we sent a bad request".

The rule the matrix encodes: **a failure of the provider permits another
provider; a failure of the question does not.** Company-unresolved, a genuinely
malformed request, and a spent *user* budget are all facts about the request —
Apollo cannot help, and calling it would only spend money to fail again.

No provider account is contacted and no credit is spent in this file.
"""

from __future__ import annotations

import pytest

from app.core.config import settings
from app.people.errors import (
    PeopleErrorCode,
    circuit_kind,
    code_for_reason,
    is_fallback_eligible,
)
from app.people.waterfall import ProviderStepResult, may_fall_back


@pytest.fixture(autouse=True)
def _fallback_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "people_provider_fallback_on_budget_exhausted", True)
    monkeypatch.setattr(settings, "people_provider_fallback_on_no_match", True)


def _fallback_for(reason: str | None) -> tuple[bool, str | None]:
    result = ProviderStepResult(candidates={}, calls=1, failure_reason=reason)
    return may_fall_back(result, had_gap=True)


# --- Provider-side failures: Apollo must be allowed to answer -----------------


@pytest.mark.parametrize(
    ("reason", "expected_code"),
    [
        # HTTP 402 — the live "account maximum for search (all matches used)".
        ("provider_budget_exceeded", PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED),
        # HTTP 401 / 403 — the gap this file was written to close.
        ("provider_unauthorized", PeopleErrorCode.AUTHENTICATION_FAILED),
        ("provider_not_configured", PeopleErrorCode.AUTHENTICATION_FAILED),
        ("provider_forbidden", PeopleErrorCode.AUTHORIZATION_FAILED),
        ("provider_master_key_required_or_forbidden", PeopleErrorCode.AUTHORIZATION_FAILED),
        # HTTP 429 / 5xx / transport.
        ("provider_rate_limited", PeopleErrorCode.RATE_LIMITED),
        ("provider_unavailable", PeopleErrorCode.PROVIDER_SERVER_ERROR),
        ("provider_timeout", PeopleErrorCode.PROVIDER_TIMEOUT),
        ("provider_network_error", PeopleErrorCode.NETWORK_ERROR),
        # A response the adapter cannot read — the provider's contract, not ours.
        ("provider_schema_error", PeopleErrorCode.PROVIDER_CONTRACT_ERROR),
        ("provider_response_invalid", PeopleErrorCode.PROVIDER_CONTRACT_ERROR),
        # PDL already stopped by its own breaker.
        ("provider_circuit_open", PeopleErrorCode.PROVIDER_SERVER_ERROR),
    ],
)
def test_a_provider_side_failure_permits_the_next_provider(
    reason: str, expected_code: PeopleErrorCode
) -> None:
    assert code_for_reason(reason) is expected_code
    allowed, why = _fallback_for(reason)
    assert allowed, f"{reason} must permit fallback"
    assert why  # the trigger is always named, for logs and metrics


def test_a_genuine_empty_result_permits_the_next_provider() -> None:
    """PDL answered and simply did not have enough people."""

    allowed, why = _fallback_for(None)
    assert allowed
    assert why == "no_match"


# --- Request-side failures: another provider cannot help ----------------------


@pytest.mark.parametrize(
    ("reason", "expected_code"),
    [
        # We could not identify the company. Apollo would be asked the same
        # unanswerable question, and charged for it.
        ("company_domain_unresolved", PeopleErrorCode.COMPANY_DOMAIN_UNRESOLVED),
        # Our request really was malformed.
        ("provider_request_invalid", PeopleErrorCode.INVALID_INPUT),
        ("provider_route_invalid", PeopleErrorCode.INVALID_INPUT),
        # The *user's* allowance is spent. Spending a different vendor's credits
        # to bypass the user's own quota would defeat the quota.
        ("provider_user_limit_exceeded", PeopleErrorCode.USER_BUDGET_EXHAUSTED),
        ("provider_request_cancelled", PeopleErrorCode.REQUEST_CANCELLED),
    ],
)
def test_a_request_side_failure_does_not_spend_another_provider(
    reason: str, expected_code: PeopleErrorCode
) -> None:
    assert code_for_reason(reason) is expected_code
    allowed, _ = _fallback_for(reason)
    assert not allowed, f"{reason} must not trigger fallback"


def test_no_gap_means_no_fallback() -> None:
    """PDL already covered the categories. Apollo adds cost, not value."""

    result = ProviderStepResult(candidates={}, calls=1, failure_reason=None)
    allowed, _ = may_fall_back(result, had_gap=False)
    assert not allowed


# --- Fallback must remain switchable ------------------------------------------


def test_budget_fallback_honours_its_configuration_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "people_provider_fallback_on_budget_exhausted", False
    )
    allowed, _ = _fallback_for("provider_budget_exceeded")
    assert not allowed


def test_no_match_fallback_honours_its_configuration_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "people_provider_fallback_on_no_match", False)
    allowed, _ = _fallback_for(None)
    assert not allowed


# --- Fallback eligibility must not disturb circuit behaviour ------------------


def test_credential_failures_still_stop_the_failing_provider() -> None:
    """Allowing fallback must not make a bad credential look retryable.

    401/403 still open the *configuration* circuit, so PDL stops being called
    until an operator fixes it. What changed is only that Apollo is now allowed
    to carry the request meanwhile.
    """

    for code in (
        PeopleErrorCode.AUTHENTICATION_FAILED,
        PeopleErrorCode.AUTHORIZATION_FAILED,
    ):
        assert is_fallback_eligible(code)
        assert circuit_kind(code) == "configuration"


def test_a_contract_error_never_trips_a_circuit() -> None:
    """It must not turn one unreadable response into a retry storm."""

    assert circuit_kind(PeopleErrorCode.PROVIDER_CONTRACT_ERROR) is None
    assert is_fallback_eligible(PeopleErrorCode.PROVIDER_CONTRACT_ERROR)


@pytest.mark.parametrize(
    "code",
    [
        PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED,
        PeopleErrorCode.AUTHENTICATION_FAILED,
        PeopleErrorCode.AUTHORIZATION_FAILED,
        PeopleErrorCode.RATE_LIMITED,
        PeopleErrorCode.PROVIDER_TIMEOUT,
        PeopleErrorCode.PROVIDER_SERVER_ERROR,
        PeopleErrorCode.NETWORK_ERROR,
        PeopleErrorCode.PROVIDER_CONTRACT_ERROR,
        PeopleErrorCode.INVALID_INPUT,
        PeopleErrorCode.COMPANY_DOMAIN_UNRESOLVED,
    ],
)
def test_no_failure_ever_produces_a_reusable_empty_result(
    code: PeopleErrorCode,
) -> None:
    """The core cache-integrity guarantee, stated as one assertion.

    ``_fresh_no_match_run`` will only ever replay a run whose status is exactly
    ``"complete"``. So no failure code may map to that status — otherwise a
    provider outage would be cached and served as "this company has nobody" for
    the full result TTL, which is precisely the incident this pipeline is
    recovering from.
    """

    from app.people.finalization import STATUS_FOR_CODE

    status = STATUS_FOR_CODE.get(code, "provider_unavailable")
    assert status != "complete"
    assert status != "no_reliable_matches"


def test_only_complete_runs_are_replayable() -> None:
    """Pins the guard itself, not just the statuses fed to it."""

    import inspect

    from app.people import service

    source = inspect.getsource(service._fresh_no_match_run)
    assert 'PeopleDiscoveryRun.status == "complete"' in source


def test_quota_exhaustion_is_never_a_verified_empty_result() -> None:
    """The whole point: HTTP 402 is a failure, not an answer about the company."""

    from app.people.finalization import STATUS_FOR_CODE

    status = STATUS_FOR_CODE[PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED]
    assert status == "provider_budget_exhausted"
    assert status not in {"complete", "no_reliable_matches"}
