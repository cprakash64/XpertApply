"""Provider waterfall: ordering, fallback triggers, coverage, and merging.

These exercise the orchestration engine directly. Every provider is a stub, so
no test here can make a paid call, and the assertions are about *which*
providers were asked and *why* — the decisions that used to be implicit in a
single-provider pipeline.
"""

from __future__ import annotations

import logging

import pytest

from app.core.config import settings
from app.people.schemas import PeopleCategory, ProviderPerson
from app.people.waterfall import (
    ACTIONABLE_SKIPS,
    CoverageTarget,
    ProviderAvailability,
    ProviderSkipped,
    ProviderStepResult,
    SkipReason,
    categories_below_target,
    configured_provider_order,
    may_fall_back,
    merge_candidates,
    normalize_linkedin,
    normalize_provider_order,
    run_waterfall,
)

CATEGORIES: tuple[PeopleCategory, ...] = (
    "likely_recruiter",
    "potential_hiring_manager",
    "potential_referrer",
)


def person(
    name: str,
    *,
    provider: str = "pdl",
    title: str = "Technical Recruiter",
    company: str = "Acme AI",
    linkedin: str | None = None,
    person_id: str | None = None,
) -> ProviderPerson:
    return ProviderPerson(
        provider=provider,
        provider_person_id=person_id or f"{provider}:{name.lower().replace(' ', '-')}",
        full_name=name,
        current_company_name=company,
        current_title=title,
        linkedin_url=linkedin,
    )


def empty() -> dict[PeopleCategory, list[ProviderPerson]]:
    return {category: [] for category in CATEGORIES}


class StubStep:
    """A provider whose behaviour the test dictates."""

    def __init__(
        self,
        name: str,
        *,
        result: ProviderStepResult | None = None,
        skip: str | None = None,
        raises: Exception | None = None,
    ) -> None:
        self.name = name
        self._result = result or ProviderStepResult(candidates=empty())
        self._skip = skip
        self._raises = raises
        self.calls: list[tuple[tuple[PeopleCategory, ...], int]] = []

    def gate(self, categories: tuple[PeopleCategory, ...]) -> None:
        if self._skip:
            raise ProviderSkipped(self._skip)

    async def run(
        self, categories: tuple[PeopleCategory, ...], call_budget: int
    ) -> ProviderStepResult:
        self.calls.append((categories, call_budget))
        if self._raises is not None:
            raise self._raises
        return self._result

    @property
    def ran(self) -> bool:
        return bool(self.calls)


@pytest.fixture(autouse=True)
def _generous_coverage(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "people_coverage_min_recruiters", 2, raising=False)
    monkeypatch.setattr(settings, "people_coverage_min_managers", 1, raising=False)
    monkeypatch.setattr(settings, "people_coverage_min_referrers", 2, raising=False)
    monkeypatch.setattr(
        settings, "people_provider_max_calls_per_discovery", 12, raising=False
    )
    monkeypatch.setattr(
        settings, "people_provider_fallback_on_no_match", True, raising=False
    )
    monkeypatch.setattr(
        settings, "people_provider_fallback_on_budget_exhausted", True, raising=False
    )


def full_coverage() -> dict[PeopleCategory, list[ProviderPerson]]:
    return {
        "likely_recruiter": [person("Rita Recruiter"), person("Rhea Recruiter")],
        "potential_hiring_manager": [person("Morgan Manager", title="Engineering Manager")],
        "potential_referrer": [
            person("Pat Peer", title="Software Engineer"),
            person("Piper Peer", title="Software Engineer"),
        ],
    }


# --------------------------------------------------------------------------
# Ordering and stopping
# --------------------------------------------------------------------------


def test_configured_order_reads_the_validated_setting(monkeypatch):
    monkeypatch.setattr(settings, "people_provider_order", ["pdl", "apollo"], raising=False)
    assert configured_provider_order() == ["pdl", "apollo"]


def test_a_malformed_order_is_rejected_at_load_time_not_silently_filtered():
    # Filtering used to hide a typo: "aploo" simply vanished and the operator
    # believed a fallback existed.
    for malformed in ("pdl,nope", "pdl,pdl", "pdl,,apollo"):
        with pytest.raises(ValueError):
            normalize_provider_order(malformed)


def test_empty_order_falls_back_to_the_primary_provider(monkeypatch):
    monkeypatch.setattr(settings, "people_provider_order", [], raising=False)
    monkeypatch.setattr(settings, "people_primary_provider", "pdl", raising=False)
    assert configured_provider_order() == ["pdl"]


@pytest.mark.anyio
async def test_sufficient_coverage_stops_the_chain_before_the_next_provider():
    apollo = StubStep("apollo")
    result = await run_waterfall([apollo], seed=full_coverage())

    assert not apollo.ran
    assert result.total_calls == 0
    assert result.coverage() == {
        "likely_recruiter": 2,
        "potential_hiring_manager": 1,
        "potential_referrer": 2,
    }


@pytest.mark.anyio
async def test_fallback_is_asked_only_for_the_categories_still_short():
    # PDL found the recruiters it needed but no manager and no referrers.
    seed = {
        "likely_recruiter": [person("Rita Recruiter"), person("Rhea Recruiter")],
        "potential_hiring_manager": [],
        "potential_referrer": [],
    }
    apollo = StubStep(
        "apollo",
        result=ProviderStepResult(
            candidates={
                **empty(),
                "potential_hiring_manager": [
                    person("Morgan Manager", provider="apollo", title="Engineering Manager")
                ],
            },
            calls=2,
        ),
    )
    await run_waterfall([apollo], seed=seed)

    assert apollo.calls[0][0] == ("potential_hiring_manager", "potential_referrer")
    assert "likely_recruiter" not in apollo.calls[0][0]


# --------------------------------------------------------------------------
# Fallback triggers
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "reason",
    [
        "provider_budget_exceeded",
        "provider_rate_limited",
        "provider_timeout",
        "provider_network_error",
        "provider_unavailable",
        "provider_circuit_open",
    ],
)
def test_recoverable_primary_failures_permit_fallback(reason):
    allowed, trigger = may_fall_back(
        ProviderStepResult(candidates=empty(), failure_reason=reason), had_gap=True
    )
    assert allowed is True
    assert trigger


@pytest.mark.parametrize(
    "reason",
    [
        "provider_request_invalid",
        "company_domain_unresolved",
        "provider_user_limit_exceeded",
        "provider_request_cancelled",
    ],
)
def test_request_scoped_failures_never_fall_back(reason):
    allowed, _ = may_fall_back(
        ProviderStepResult(candidates=empty(), failure_reason=reason), had_gap=True
    )
    assert allowed is False


def test_no_match_falls_back_only_when_the_flag_allows_it(monkeypatch):
    result = ProviderStepResult(candidates=empty())
    assert may_fall_back(result, had_gap=True)[0] is True

    monkeypatch.setattr(
        settings, "people_provider_fallback_on_no_match", False, raising=False
    )
    assert may_fall_back(result, had_gap=True)[0] is False


def test_budget_exhaustion_falls_back_only_when_the_flag_allows_it(monkeypatch):
    result = ProviderStepResult(
        candidates=empty(), failure_reason="provider_budget_exceeded"
    )
    assert may_fall_back(result, had_gap=True)[0] is True

    monkeypatch.setattr(
        settings, "people_provider_fallback_on_budget_exhausted", False, raising=False
    )
    assert may_fall_back(result, had_gap=True)[0] is False


def test_a_covered_result_never_falls_back_even_on_failure():
    # Coverage already met: a partial failure is not worth another provider.
    allowed, _ = may_fall_back(
        ProviderStepResult(candidates=empty(), failure_reason="provider_timeout"),
        had_gap=False,
    )
    assert allowed is False


@pytest.mark.anyio
async def test_budget_exhausted_primary_hands_over_to_the_next_provider():
    apollo = StubStep(
        "apollo",
        result=ProviderStepResult(
            candidates={
                **empty(),
                "likely_recruiter": [
                    person("Rita Recruiter", provider="apollo"),
                    person("Rhea Recruiter", provider="apollo"),
                ],
                "potential_hiring_manager": [
                    person("Morgan Manager", provider="apollo", title="Engineering Manager")
                ],
            },
            calls=3,
        ),
    )
    web = StubStep("openai_web")
    result = await run_waterfall([apollo, web], seed=empty())

    assert apollo.ran
    # Apollo covered recruiters and the manager but not referrers, so the web
    # step is still offered exactly that gap.
    assert web.calls[0][0] == ("potential_referrer",)
    assert result.coverage()["likely_recruiter"] == 2
    assert [attempt.provider for attempt in result.attempts] == ["apollo", "openai_web"]


@pytest.mark.anyio
async def test_a_provider_defect_does_not_end_the_chain():
    broken = StubStep("apollo", raises=RuntimeError("adapter bug"))
    web = StubStep(
        "openai_web",
        result=ProviderStepResult(
            candidates={**empty(), "likely_recruiter": [person("Rita", provider="openai_web")]},
            calls=1,
        ),
    )
    result = await run_waterfall([broken, web], seed=empty())

    assert web.ran
    assert result.coverage()["likely_recruiter"] == 1
    assert result.attempts[0].status == "failed"


@pytest.mark.anyio
async def test_skipped_providers_are_recorded_and_do_not_consume_calls():
    apollo = StubStep("apollo", skip="provider_budget_exceeded")
    web = StubStep("openai_web", skip="provider_disabled")
    result = await run_waterfall([apollo, web], seed=empty())

    assert not apollo.ran and not web.ran
    assert result.total_calls == 0
    assert [(a.provider, a.skip_reason) for a in result.attempts] == [
        ("apollo", "provider_budget_exceeded"),
        ("openai_web", "provider_disabled"),
    ]
    assert result.providers_attempted == []


# --------------------------------------------------------------------------
# Cost ceilings
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_total_calls_stay_under_the_configured_ceiling(monkeypatch):
    monkeypatch.setattr(
        settings, "people_provider_max_calls_per_discovery", 4, raising=False
    )
    apollo = StubStep("apollo", result=ProviderStepResult(candidates=empty(), calls=4))
    web = StubStep("openai_web", result=ProviderStepResult(candidates=empty(), calls=3))
    result = await run_waterfall([apollo, web], seed=empty())

    assert apollo.ran
    # The ceiling was already spent, so the next provider is skipped outright.
    assert not web.ran
    assert result.total_calls == 4
    assert result.attempts[-1].skip_reason == SkipReason.TOTAL_CALL_LIMIT_REACHED.value


@pytest.mark.anyio
async def test_each_provider_is_told_how_many_calls_remain(monkeypatch):
    monkeypatch.setattr(
        settings, "people_provider_max_calls_per_discovery", 10, raising=False
    )
    apollo = StubStep("apollo", result=ProviderStepResult(candidates=empty(), calls=6))
    web = StubStep("openai_web", result=ProviderStepResult(candidates=empty(), calls=1))
    await run_waterfall([apollo, web], seed=empty())

    assert apollo.calls[0][1] == 10
    assert web.calls[0][1] == 4


# --------------------------------------------------------------------------
# Deduplication across providers
# --------------------------------------------------------------------------


def test_the_same_linkedin_profile_from_two_providers_is_one_person():
    existing = {
        **empty(),
        "likely_recruiter": [
            person("Rita Recruiter", linkedin="https://www.linkedin.com/in/rita-recruiter")
        ],
    }
    incoming = {
        **empty(),
        "likely_recruiter": [
            person(
                "Rita R.",
                provider="apollo",
                linkedin="https://linkedin.com/in/rita-recruiter/",
            )
        ],
    }
    merged, duplicates = merge_candidates(existing, incoming)

    assert duplicates == 1
    assert len(merged["likely_recruiter"]) == 1
    # The first provider's record stands; the second is recorded as corroboration.
    assert merged["likely_recruiter"][0].full_name == "Rita Recruiter"
    assert merged["likely_recruiter"][0].evidence["also_seen_by"] == ["apollo"]


def test_a_later_provider_fills_a_missing_linkedin_url():
    existing = {**empty(), "likely_recruiter": [person("Rita Recruiter")]}
    incoming = {
        **empty(),
        "likely_recruiter": [
            person(
                "Rita Recruiter",
                provider="apollo",
                linkedin="https://www.linkedin.com/in/rita-recruiter",
            )
        ],
    }
    merged, duplicates = merge_candidates(existing, incoming)

    assert duplicates == 1
    assert merged["likely_recruiter"][0].linkedin_url == (
        "https://www.linkedin.com/in/rita-recruiter"
    )
    assert merged["likely_recruiter"][0].field_provenance["linkedin_url"] == "apollo"


def test_one_person_is_never_counted_in_two_categories():
    existing = {**empty(), "likely_recruiter": [person("Rita Recruiter")]}
    incoming = {**empty(), "potential_referrer": [person("Rita Recruiter", provider="apollo")]}
    merged, duplicates = merge_candidates(existing, incoming)

    assert duplicates == 1
    assert len(merged["likely_recruiter"]) == 1
    assert merged["potential_referrer"] == []


def test_distinct_people_from_different_providers_both_survive():
    existing = {**empty(), "likely_recruiter": [person("Rita Recruiter")]}
    incoming = {
        **empty(),
        "likely_recruiter": [person("Sam Sourcer", provider="apollo")],
    }
    merged, duplicates = merge_candidates(existing, incoming)

    assert duplicates == 0
    assert len(merged["likely_recruiter"]) == 2


def test_merge_never_upgrades_employment_evidence():
    from datetime import UTC, datetime

    verified = person("Rita Recruiter")
    verified.exact_company_match = True
    weaker = person("Rita Recruiter", provider="openai_web")
    weaker.exact_company_match = False
    weaker.employment_verified_at = datetime(2026, 7, 26, tzinfo=UTC)

    merged, _ = merge_candidates(
        {**empty(), "likely_recruiter": [verified]},
        {**empty(), "likely_recruiter": [weaker]},
    )
    # The conservative view wins for the match, and a public-web sighting never
    # invents a verification the first provider did not have.
    assert merged["likely_recruiter"][0].exact_company_match is False


def test_normalize_linkedin_ignores_host_and_trailing_slash():
    assert normalize_linkedin("https://www.linkedin.com/in/rita/") == "rita"
    assert normalize_linkedin("https://uk.linkedin.com/in/rita") == "rita"
    assert normalize_linkedin("https://example.com/rita") is None
    assert normalize_linkedin(None) is None


# --------------------------------------------------------------------------
# Coverage arithmetic
# --------------------------------------------------------------------------


def test_categories_below_target_reports_only_real_gaps():
    target = CoverageTarget(recruiters=2, managers=1, referrers=2)
    candidates = {
        "likely_recruiter": [person("A"), person("B")],
        "potential_hiring_manager": [],
        "potential_referrer": [person("C")],
    }
    assert categories_below_target(candidates, target) == (
        "potential_hiring_manager",
        "potential_referrer",
    )


# --------------------------------------------------------------------------
# Observability hygiene
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_waterfall_logs_carry_no_personal_data(caplog):
    apollo = StubStep(
        "apollo",
        result=ProviderStepResult(
            candidates={
                **empty(),
                "likely_recruiter": [
                    person(
                        "Rita Recruiter",
                        provider="apollo",
                        linkedin="https://www.linkedin.com/in/rita-recruiter",
                    )
                ],
            },
            calls=1,
        ),
    )
    with caplog.at_level(logging.INFO):
        await run_waterfall([apollo], seed=empty(), discovery_run_id=42)

    text = "\n".join(record.getMessage() for record in caplog.records)
    assert "Rita Recruiter" not in text
    assert "linkedin.com/in/rita-recruiter" not in text
    assert "api_key" not in text.lower()


@pytest.mark.anyio
async def test_attempt_summaries_are_provider_shaped_not_person_shaped():
    apollo = StubStep(
        "apollo",
        result=ProviderStepResult(
            candidates={**empty(), "likely_recruiter": [person("Rita", provider="apollo")]},
            calls=2,
            raw_count=5,
        ),
    )
    result = await run_waterfall([apollo], seed=empty())
    summary = result.safe_summary()

    assert summary["providers_attempted"] == ["apollo"]
    assert summary["total_provider_calls"] == 2
    assert summary["coverage"]["likely_recruiter"] == 1
    assert "Rita" not in str(summary)


# --------------------------------------------------------------------------
# Step events: every provider in the order accounts for itself
# --------------------------------------------------------------------------


@pytest.mark.anyio
async def test_every_provider_emits_exactly_one_step_event(caplog):
    apollo = StubStep(
        "apollo",
        result=ProviderStepResult(
            candidates={**empty(), "likely_recruiter": [person("Rita", provider="apollo")]},
            calls=1,
        ),
    )
    web = StubStep("openai_web", skip=SkipReason.DISABLED.value)

    with caplog.at_level(logging.INFO, logger="jobpilot.people.waterfall"):
        await run_waterfall([apollo, web], seed=empty(), discovery_run_id=7)

    events = [
        record.getMessage()
        for record in caplog.records
        if "people_provider_step" in record.getMessage()
    ]
    assert len(events) == 2
    assert any("provider=apollo" in event and "outcome=success" in event for event in events)
    assert any(
        "provider=openai_web" in event and "outcome=disabled" in event for event in events
    )
    assert all("discovery_run_id=7" in event for event in events)
    assert all("fallback_eligible=" in event for event in events)


@pytest.mark.anyio
async def test_a_misconfigured_provider_is_logged_as_a_warning(caplog):
    # The live defect: Apollo enabled, keyed, and unfunded. It must be loud,
    # because only a configuration change can fix it.
    apollo = StubStep("apollo", skip=SkipReason.INVALID_CONFIGURATION.value)

    with caplog.at_level(logging.INFO, logger="jobpilot.people.waterfall"):
        await run_waterfall([apollo], seed=empty(), discovery_run_id=8)

    step = [record for record in caplog.records if "people_provider_step" in record.getMessage()]
    assert len(step) == 1
    assert step[0].levelno == logging.WARNING
    assert "outcome=invalid_configuration" in step[0].getMessage()


@pytest.mark.anyio
async def test_a_spent_budget_is_informational_not_a_warning(caplog):
    # Nothing to fix: the allowance rolls over on its own.
    apollo = StubStep("apollo", skip=SkipReason.DAILY_BUDGET_EXHAUSTED.value)

    with caplog.at_level(logging.INFO, logger="jobpilot.people.waterfall"):
        await run_waterfall([apollo], seed=empty())

    step = [record for record in caplog.records if "people_provider_step" in record.getMessage()]
    assert step[0].levelno == logging.INFO
    assert "outcome=daily_budget_exhausted" in step[0].getMessage()


@pytest.mark.anyio
async def test_step_events_carry_no_personal_data(caplog):
    apollo = StubStep(
        "apollo",
        result=ProviderStepResult(
            candidates={
                **empty(),
                "likely_recruiter": [
                    person(
                        "Rita Recruiter",
                        provider="apollo",
                        linkedin="https://www.linkedin.com/in/rita-recruiter",
                    )
                ],
            },
            calls=1,
        ),
    )
    with caplog.at_level(logging.INFO, logger="jobpilot.people.waterfall"):
        await run_waterfall([apollo], seed=empty())

    text = "\n".join(record.getMessage() for record in caplog.records)
    assert "Rita Recruiter" not in text
    assert "rita-recruiter" not in text
    assert "Acme" not in text


def test_skip_reasons_are_typed_and_distinguish_off_from_broken():
    # Collapsing these is what made the live defect invisible.
    assert SkipReason.DISABLED not in ACTIONABLE_SKIPS
    assert SkipReason.DAILY_BUDGET_EXHAUSTED not in ACTIONABLE_SKIPS
    assert SkipReason.INVALID_CONFIGURATION in ACTIONABLE_SKIPS
    assert SkipReason.MISSING_CREDENTIALS in ACTIONABLE_SKIPS


def test_availability_carries_its_reason_into_the_skip():
    blocked = ProviderAvailability.blocked(
        "apollo", SkipReason.INVALID_CONFIGURATION, "budgets are both 0"
    )
    with pytest.raises(ProviderSkipped) as raised:
        blocked.raise_if_blocked()
    assert raised.value.reason == "invalid_configuration"
    assert raised.value.detail == "budgets are both 0"

    # An available provider raises nothing.
    ProviderAvailability.ok("apollo").raise_if_blocked()
