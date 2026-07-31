"""How a discovery run reports the outcome of a whole provider chain.

The live defect these pin: Apollo was being called — the operator diagnostics
showed apollo/people_search calls — yet every stored run still said
``status=provider_budget_exhausted, provider=pdl`` and the UI kept telling users
the provider budget had been reached. Two independent bugs produced that:

* the run's ``provider`` column was written from the configured primary at
  creation and never updated, so a result Apollo supplied was filed under PDL;
* a stored PDL budget failure was contract-*compatible* with the new
  waterfall-era runs, so ``discover()`` replayed it and returned before the
  waterfall could run at all.

A third, quieter one: the operator inspector *inferred* ``user_quota_charged``
from ``cache_hit`` instead of reading what the run recorded, so a refunded run
claimed a charge the ledger had already given back.
"""

from __future__ import annotations

import pytest

from app.people.errors import PeopleErrorCode
from app.people.quota import QuotaReservation
from app.people.service import (
    PEOPLE_FINALIZATION_VERSION,
    PEOPLE_SEARCH_CONTRACT_VERSION,
    _dominant_failure,
    _final_provider_label,
    _provider_error_blocks_discovery,
    run_is_compatible,
)


class StoredRun:
    """The fields of a persisted PeopleDiscoveryRun these rules read."""

    def __init__(
        self,
        *,
        status: str = "provider_budget_exhausted",
        failure_code: str | None = "provider_budget_exceeded",
        contract: str | None = PEOPLE_SEARCH_CONTRACT_VERSION,
        provider: str = "pdl",
    ) -> None:
        self.status = status
        self.failure_code = failure_code
        self.provider = provider
        self.company_context = (
            {"search_contract_version": contract} if contract else {}
        )
        self.completed_at = None
        self.started_at = None


# --------------------------------------------------------------------------
# Which provider the run says answered
# --------------------------------------------------------------------------


def test_a_result_apollo_supplied_is_never_filed_under_pdl():
    # The exact live symptom: PDL was exhausted, Apollo answered, and the run
    # still named PDL.
    assert (
        _final_provider_label(
            {"apollo": 2}, attempted=["pdl", "apollo"], primary="pdl"
        )
        == "apollo"
    )


def test_contacts_from_several_providers_credit_none_of_them_alone():
    label = _final_provider_label(
        {"pdl": 1, "apollo": 2}, attempted=["pdl", "apollo"], primary="pdl"
    )
    assert label.startswith("multi:")
    assert "apollo" in label and "pdl" in label


def test_a_failed_run_still_records_how_far_the_chain_got():
    assert (
        _final_provider_label({}, attempted=["pdl", "apollo"], primary="pdl")
        == "multi:pdl+apollo"
    )
    # A single-provider deployment keeps its plain name.
    assert _final_provider_label({}, attempted=["pdl"], primary="pdl") == "pdl"


# --------------------------------------------------------------------------
# Which failure the run reports
# --------------------------------------------------------------------------


def test_a_budget_stop_followed_by_another_failure_is_not_the_final_word():
    # PDL's budget is why the chain moved on, not why the user has nobody.
    assert (
        _dominant_failure(["provider_budget_exceeded", "provider_schema_error"])
        == "provider_schema_error"
    )


def test_budget_is_the_final_word_only_when_it_is_the_whole_story():
    assert (
        _dominant_failure(["provider_budget_exceeded", "provider_budget_exceeded"])
        == "provider_budget_exceeded"
    )


# --------------------------------------------------------------------------
# Whether a stored failure may be replayed
# --------------------------------------------------------------------------


def test_a_stored_budget_failure_no_longer_blocks_a_funded_fallback():
    """The cache half of the live defect.

    ``discover()`` consults this before the waterfall. Returning True here is
    what made every subsequent Find people replay the PDL budget message
    instead of letting Apollo answer.
    """

    run = StoredRun()
    assert _provider_error_blocks_discovery(run, fallback_available=True) is False


def test_a_budget_failure_still_blocks_when_nothing_can_follow_it():
    run = StoredRun()
    # No funded follower: replaying is correct, and re-searching would only
    # spend the user's action to reach the same wall.
    assert _provider_error_blocks_discovery(run, fallback_available=False) is True


def test_a_non_budget_failure_is_unaffected_by_a_waiting_fallback():
    # Only a budget stop is provider-scoped in this way. A configuration
    # failure keeps its existing retry semantics.
    run = StoredRun(
        status="provider_configuration_error", failure_code="provider_unauthorized"
    )
    blocked_with = _provider_error_blocks_discovery(run, fallback_available=True)
    blocked_without = _provider_error_blocks_discovery(run, fallback_available=False)
    assert blocked_with == blocked_without


# --------------------------------------------------------------------------
# Which stored runs may be reused at all
# --------------------------------------------------------------------------


def test_legacy_pdl_only_budget_runs_are_contract_incompatible():
    """Runs written before the waterfall must not be served as current.

    Their status was decided by one provider; replaying it would tell a user the
    budget stopped a search that Apollo would now answer.
    """

    legacy = StoredRun(contract="pdl-person-search-v3:pdl-category-search-v2")
    assert run_is_compatible(legacy) is False
    # A run with no recorded contract at all is legacy by definition.
    assert run_is_compatible(StoredRun(contract=None)) is False


def test_the_contract_version_covers_finalization_and_the_provider_chain():
    # Changing either must retire stored runs, which is the whole mechanism
    # that stops an old budget failure from being replayed.
    assert PEOPLE_FINALIZATION_VERSION in PEOPLE_SEARCH_CONTRACT_VERSION
    assert "order:" in PEOPLE_SEARCH_CONTRACT_VERSION


def test_a_current_run_remains_compatible():
    assert run_is_compatible(StoredRun()) is True


# --------------------------------------------------------------------------
# Quota metadata and the ledger cannot disagree
# --------------------------------------------------------------------------


def test_a_reserved_unit_reports_charged():
    from datetime import date

    reservation = QuotaReservation(user_id=1, quota_date=date(2026, 7, 30))
    assert reservation.decision == "charged"


def test_a_refunded_unit_never_claims_to_have_been_charged():
    """The inconsistency the operator saw: run said charged, ledger said zero.

    A refund puts the unit back, so the run must say so — the inspector used to
    infer "charged" from cache_hit and reported the opposite of the truth.
    """

    from datetime import date

    reservation = QuotaReservation(user_id=1, quota_date=date(2026, 7, 30))
    reservation.charged = False
    assert reservation.decision == "refunded"


def test_an_exempt_account_is_labelled_exempt_not_charged():
    from datetime import date

    reservation = QuotaReservation(
        user_id=1, quota_date=date(2026, 7, 30), charged=False, exempt=True
    )
    assert reservation.decision == "exempt"
    assert reservation.decision != "charged"


@pytest.mark.parametrize(
    "reason,expected_code",
    [
        ("provider_budget_exceeded", PeopleErrorCode.PROVIDER_BUDGET_EXHAUSTED),
        ("provider_schema_error", PeopleErrorCode.INVALID_INPUT),
    ],
)
def test_failure_reasons_keep_their_typed_codes(reason, expected_code):
    from app.people.errors import code_for_reason

    assert code_for_reason(reason) is expected_code


def test_the_inspector_reads_the_recorded_decision_rather_than_guessing():
    # A regression guard on the script itself: the inferred expression that
    # produced the contradiction must not come back.
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[2] / "scripts" / "inspect_people_quota.py"
    ).read_text()
    assert "user_quota_decision" in source
    assert 'run.provider == "cache"\n                            ),' not in source
