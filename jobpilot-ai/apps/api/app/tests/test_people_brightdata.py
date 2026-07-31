"""Bright Data adapter: the documented contract, and the gate on the undocumented one.

Everything here runs against a fake transport. No Bright Data account is
contacted, and no record is ever purchased.

The contract exercised below is the one published in Bright Data's docs:

* ``POST /datasets/v3/scrape?dataset_id=…&format=json`` — synchronous, ≤20 URLs
* ``POST /datasets/v3/trigger?dataset_id=…&type=discover_new&discover_by=…``
* ``GET  /datasets/v3/progress/{snapshot_id}`` → starting|running|ready|failed
* ``GET  /datasets/v3/snapshot/{snapshot_id}?format=json``

Discovery stays gated because the *input schema* for a people search by company
and title is account-specific and unpublished. That gate is itself tested: an
unconfigured deployment must report a typed configuration problem, never guess.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from app.core.config import settings
from app.people.brightdata import (
    BrightDataOutcome,
    BrightDataPeopleProvider,
    configured_for_discovery,
    configured_for_verification,
    discovery_configuration_gap,
    normalize_brightdata_profile,
)

COMPANY = "Northwind Robotics"
DOMAIN = "northwindrobotics.example"
PROFILE_URL = "https://www.linkedin.com/in/priya-raghavan"


def _row(**overrides: object) -> dict:
    row = {
        "name": "Priya Raghavan",
        "url": PROFILE_URL,
        "position": "Senior Technical Recruiter",
        "current_company": {"name": COMPANY, "link": "https://www.linkedin.com/company/nw"},
        "city": "Austin",
        "country_code": "US",
        "experience": [{"company": "Previous Co"}],
        "education": [{"title": "State University"}],
    }
    row.update(overrides)
    return row


class _Transport:
    """Records every call and replays scripted responses."""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = responses
        self.calls: list[tuple[str, str, dict]] = []

    async def request(self, method, url, *, params=None, json=None, headers=None):
        self.calls.append((method, url, dict(params or {})))
        assert headers["Authorization"].startswith("Bearer ")
        if not self._responses:
            raise AssertionError(f"unexpected extra call to {url}")
        return self._responses.pop(0)


def _json(payload: object, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status, request=httpx.Request("POST", "https://api.brightdata.com/x"), json=payload
    )


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "brightdata_api_token", "bd-test-token-not-a-secret")
    monkeypatch.setattr(settings, "people_brightdata_dataset_id", "gd_test_profiles")
    monkeypatch.setattr(settings, "people_brightdata_discovery_dataset_id", None)
    monkeypatch.setattr(settings, "people_brightdata_max_records_per_discovery", 5)
    monkeypatch.setattr(settings, "people_brightdata_poll_interval_seconds", 0.001)
    monkeypatch.setattr(settings, "people_brightdata_max_poll_seconds", 1.0)


# --------------------------------------------------------------------------
# Normalization
# --------------------------------------------------------------------------


def test_a_profile_record_normalizes_onto_the_shared_candidate_shape():
    person = normalize_brightdata_profile(
        _row(), company_name=COMPANY, company_domain=DOMAIN
    )
    assert person is not None
    assert person.provider == "brightdata"
    assert person.full_name == "Priya Raghavan"
    assert person.linkedin_url == PROFILE_URL
    # The profile URL is the identity: Bright Data's internal ids are not stable.
    assert person.provider_person_id == PROFILE_URL
    assert person.current_title == "Senior Technical Recruiter"
    assert person.current_company_name == COMPANY
    assert person.location == "Austin, US"
    assert person.previous_employers == ["Previous Co"]
    # A public profile is credible current employment, not an independent
    # verification, so no verified-at timestamp is invented.
    assert person.employment_verified_at is None
    assert person.evidence["linkedin_url_source"] == "provider_record"


def test_the_company_domain_is_attached_only_on_an_exact_employer_name_match():
    person = normalize_brightdata_profile(
        _row(), company_name=COMPANY, company_domain=DOMAIN
    )
    assert person.current_company_domain == DOMAIN
    assert person.evidence["exact_employer_name_match"] is True
    assert (
        person.evidence["company_domain_evidence"]
        == "job_verified_domain_on_exact_name_match"
    )


def test_a_different_employer_never_borrows_the_jobs_verified_domain():
    """The failure this prevents: a contact at the wrong company looking exact."""

    outcome = BrightDataOutcome()
    person = normalize_brightdata_profile(
        _row(current_company={"name": "Northwind Health"}),
        company_name=COMPANY,
        company_domain=DOMAIN,
        outcome=outcome,
    )
    assert person is not None
    assert person.current_company_domain is None
    assert outcome.rejected["company_mismatch"] == 1


def test_an_alias_counts_as_the_same_employer():
    person = normalize_brightdata_profile(
        _row(current_company={"name": "Northwind"}),
        company_name=COMPANY,
        company_aliases=("Northwind",),
        company_domain=DOMAIN,
    )
    assert person.current_company_domain == DOMAIN


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"name": ""}, "missing_name"),
        ({"url": "https://profiles.invalid/in/priya"}, "missing_linkedin_url"),
        ({"url": None}, "missing_linkedin_url"),
        ({"current_company": {}}, "missing_company"),
        ({"position": ""}, "missing_title"),
    ],
)
def test_a_malformed_record_is_rejected_rather_than_patched(overrides, reason):
    outcome = BrightDataOutcome()
    row = _row(**overrides)
    if overrides.get("position") == "":
        row.pop("current_company_title", None)
    person = normalize_brightdata_profile(
        row, company_name=COMPANY, company_domain=DOMAIN, outcome=outcome
    )
    assert person is None
    assert outcome.rejected.get(reason) == 1


def test_a_non_dict_record_is_rejected():
    outcome = BrightDataOutcome()
    assert (
        normalize_brightdata_profile(
            ["not", "a", "record"], company_name=COMPANY, outcome=outcome
        )
        is None
    )
    assert outcome.rejected["malformed_record"] == 1


# --------------------------------------------------------------------------
# Verification: the documented synchronous path
# --------------------------------------------------------------------------


def test_verification_posts_only_validated_profile_urls():
    transport = _Transport([_json([_row()])])
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.verify_profiles(
            [PROFILE_URL, "https://profiles.invalid/in/nope", "not a url"],
            company_name=COMPANY,
            company_domain=DOMAIN,
        )
    )

    method, url, params = transport.calls[0]
    assert method == "POST"
    assert url == "https://api.brightdata.com/datasets/v3/scrape"
    assert params == {"dataset_id": "gd_test_profiles", "format": "json"}
    # Two of the three inputs could never be a profile and never cost a record.
    assert outcome.rejected["invalid_linkedin_url"] == 2
    assert len(outcome.candidates) == 1
    assert outcome.records_returned == 1


def test_a_partial_batch_keeps_the_records_that_were_valid():
    transport = _Transport([_json([_row(), _row(name=""), {"garbage": True}])])
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.verify_profiles(
            [PROFILE_URL], company_name=COMPANY, company_domain=DOMAIN
        )
    )

    assert len(outcome.candidates) == 1
    assert outcome.records_returned == 3
    assert outcome.failure_reason is None


def test_verification_is_capped_at_the_documented_twenty_urls():
    transport = _Transport([_json([])])
    provider = BrightDataPeopleProvider(client=transport)
    urls = [f"https://www.linkedin.com/in/person-{index}" for index in range(30)]

    asyncio.run(provider.verify_profiles(urls, company_name=COMPANY))

    assert len(transport.calls) == 1


def test_verification_without_configuration_reports_it_rather_than_calling():
    transport = _Transport([])
    provider = BrightDataPeopleProvider(client=transport)
    settings_backup = settings.people_brightdata_dataset_id
    try:
        settings.people_brightdata_dataset_id = None
        outcome = asyncio.run(
            provider.verify_profiles([PROFILE_URL], company_name=COMPANY)
        )
    finally:
        settings.people_brightdata_dataset_id = settings_backup

    assert outcome.failure_reason == "provider_not_configured"
    assert transport.calls == []


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (401, "provider_unauthorized"),
        (402, "provider_budget_exceeded"),
        (403, "provider_forbidden"),
        (404, "provider_route_invalid"),
        (422, "provider_schema_error"),
        (429, "provider_rate_limited"),
        (500, "provider_unavailable"),
    ],
)
def test_every_http_failure_gets_its_own_typed_reason(status, reason):
    transport = _Transport([_json({"error": "x"}, status=status)])
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.verify_profiles([PROFILE_URL], company_name=COMPANY)
    )

    assert outcome.failure_reason == reason
    assert outcome.candidates == []


def test_a_timeout_is_typed_as_a_timeout_not_as_an_outage():
    class _Timeout:
        async def request(self, *_args, **_kwargs):
            raise httpx.ReadTimeout("slow")

    provider = BrightDataPeopleProvider(client=_Timeout())
    outcome = asyncio.run(
        provider.verify_profiles([PROFILE_URL], company_name=COMPANY)
    )
    assert outcome.failure_reason == "provider_timeout"


# --------------------------------------------------------------------------
# Discovery: gated, then the real lifecycle
# --------------------------------------------------------------------------


def test_discovery_is_unavailable_until_its_dataset_is_configured():
    assert configured_for_verification() is True
    assert configured_for_discovery() is False
    gap = discovery_configuration_gap()
    assert "PEOPLE_BRIGHTDATA_DISCOVERY_DATASET_ID" in gap
    # The gap names what is missing rather than implying the provider is broken.
    assert "not published" in gap


def test_an_unconfigured_discovery_never_calls_the_provider():
    transport = _Transport([])
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.discover(
            [{"keyword": "x"}], discover_by="keyword", company_name=COMPANY
        )
    )

    assert outcome.failure_reason == "provider_not_configured"
    assert "discovery_not_configured" in outcome.warnings
    assert transport.calls == []


def test_the_documented_trigger_poll_download_lifecycle(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        settings, "people_brightdata_discovery_dataset_id", "gd_test_discovery"
    )
    monkeypatch.setattr(settings, "people_brightdata_daily_record_budget", 100)
    transport = _Transport(
        [
            _json({"snapshot_id": "s_abc123"}),
            _json({"snapshot_id": "s_abc123", "status": "running"}),
            _json({"snapshot_id": "s_abc123", "status": "ready"}),
            _json([_row()]),
        ]
    )
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.discover(
            [{"keyword": f"{COMPANY} technical recruiter"}],
            discover_by="keyword",
            company_name=COMPANY,
            company_domain=DOMAIN,
        )
    )

    trigger = transport.calls[0]
    assert trigger[1] == "https://api.brightdata.com/datasets/v3/trigger"
    assert trigger[2]["type"] == "discover_new"
    assert trigger[2]["discover_by"] == "keyword"
    # limit_per_input is the cost ceiling, not a nicety.
    assert trigger[2]["limit_per_input"] == 5
    assert transport.calls[1][1].endswith("/progress/s_abc123")
    assert transport.calls[3][1].endswith("/snapshot/s_abc123")
    assert len(outcome.candidates) == 1


def test_a_failed_snapshot_is_reported_not_polled_forever(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        settings, "people_brightdata_discovery_dataset_id", "gd_test_discovery"
    )
    transport = _Transport(
        [_json({"snapshot_id": "s_x"}), _json({"snapshot_id": "s_x", "status": "failed"})]
    )
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.discover([{"keyword": "x"}], discover_by="keyword", company_name=COMPANY)
    )

    assert outcome.failure_reason == "provider_unavailable"


def test_a_slow_snapshot_is_abandoned_at_the_deadline(monkeypatch: pytest.MonkeyPatch):
    """A user request must never wait on an unbounded collection job."""

    monkeypatch.setattr(
        settings, "people_brightdata_discovery_dataset_id", "gd_test_discovery"
    )
    monkeypatch.setattr(settings, "people_brightdata_poll_interval_seconds", 0.01)
    monkeypatch.setattr(settings, "people_brightdata_max_poll_seconds", 0.02)
    transport = _Transport(
        [_json({"snapshot_id": "s_x"})]
        + [_json({"snapshot_id": "s_x", "status": "running"}) for _ in range(50)]
    )
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.discover([{"keyword": "x"}], discover_by="keyword", company_name=COMPANY)
    )

    assert outcome.failure_reason == "provider_timeout"
    # Bounded by poll count as well as by wall clock, so the ceiling holds even
    # when the provider answers instantly: one trigger plus at most
    # ceiling/interval polls, not the 50 the transport was willing to serve.
    assert len(transport.calls) == 3


def test_an_unrecognised_snapshot_state_is_a_response_defect(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        settings, "people_brightdata_discovery_dataset_id", "gd_test_discovery"
    )
    transport = _Transport(
        [_json({"snapshot_id": "s_x"}), _json({"snapshot_id": "s_x", "status": "wat"})]
    )
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.discover([{"keyword": "x"}], discover_by="keyword", company_name=COMPANY)
    )

    assert outcome.failure_reason == "provider_response_invalid"


def test_discovery_results_are_capped_by_the_record_budget(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        settings, "people_brightdata_discovery_dataset_id", "gd_test_discovery"
    )
    monkeypatch.setattr(settings, "people_brightdata_max_records_per_discovery", 2)
    transport = _Transport(
        [
            _json({"snapshot_id": "s_x"}),
            _json({"snapshot_id": "s_x", "status": "ready"}),
            _json([_row(url=f"https://www.linkedin.com/in/p{i}") for i in range(9)]),
        ]
    )
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.discover(
            [{"keyword": "x"}],
            discover_by="keyword",
            company_name=COMPANY,
            company_domain=DOMAIN,
        )
    )

    assert outcome.records_returned == 2
    assert len(outcome.candidates) == 2


# --------------------------------------------------------------------------
# Safety
# --------------------------------------------------------------------------


def test_no_token_no_name_and_no_url_ever_reaches_the_log(caplog):
    transport = _Transport([_json({"error": "x"}, status=500)])
    provider = BrightDataPeopleProvider(client=transport)

    with caplog.at_level("INFO"):
        asyncio.run(
            provider.verify_profiles(
                [PROFILE_URL], company_name=COMPANY, company_domain=DOMAIN
            )
        )

    assert "bd-test-token-not-a-secret" not in caplog.text
    assert "priya-raghavan" not in caplog.text
    assert "Priya Raghavan" not in caplog.text


def test_an_oversized_response_is_refused_rather_than_parsed(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "people_provider_response_max_bytes", 10)
    transport = _Transport([_json([_row() for _ in range(5)])])
    provider = BrightDataPeopleProvider(client=transport)

    outcome = asyncio.run(
        provider.verify_profiles([PROFILE_URL], company_name=COMPANY)
    )

    assert outcome.failure_reason == "provider_response_invalid"


def test_a_record_observed_now_is_timestamped_now():
    before = datetime.now(UTC)
    person = normalize_brightdata_profile(
        _row(), company_name=COMPANY, company_domain=DOMAIN
    )
    assert person.provider_record_observed_at >= before
