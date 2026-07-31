"""Provider configuration: the shapes that must be refused, and the ones that work.

The live defect these cover: Apollo was enabled, keyed, and listed in the
provider order, but both of its budgets were zero. Nothing refused to start,
nothing said why, and at runtime the waterfall silently skipped Apollo — so an
exhausted PDL budget surfaced to users as "People search is temporarily
unavailable" while a working Apollo account sat behind it.

Zero budget is a *misconfiguration*, not a disabled provider. The difference is
the whole point: a provider nobody asked for may sit at zero forever, but a
provider you put in the chain and switched on must be funded or removed.
"""

from __future__ import annotations

import pytest

from app.core.config import Settings
from app.core.config_validation import ConfigurationError, collect_findings, enforce
from app.people.waterfall import KNOWN_PROVIDERS, normalize_provider_order

# The exact configuration the running API reported.
LIVE_APOLLO_ZERO_BUDGET = dict(
    app_env="production",
    people_recommendations_enabled=True,
    people_primary_provider="pdl",
    people_provider_order=["pdl", "apollo"],
    people_pdl_discovery_enabled=True,
    pdl_api_key="pdl-key",
    people_pdl_daily_credit_budget=100,
    people_pdl_per_user_daily_limit=10,
    people_apollo_discovery_enabled=True,
    apollo_api_key="apollo-key",
    people_apollo_daily_credit_budget=0,
    people_apollo_per_user_daily_limit=0,
    people_apollo_max_enrichments_per_discovery=6,
    people_provider_max_calls_per_discovery=12,
)


def findings_for(**overrides) -> dict[str, str]:
    settings = Settings(**{**LIVE_APOLLO_ZERO_BUDGET, **overrides})
    return {finding.setting: finding.problem for finding in collect_findings(settings)}


# --------------------------------------------------------------------------
# The live defect
# --------------------------------------------------------------------------


def test_enabled_apollo_with_zero_budgets_is_refused_at_startup():
    findings = findings_for()

    assert "PEOPLE_APOLLO_DAILY_CREDIT_BUDGET" in findings
    assert "PEOPLE_APOLLO_PER_USER_DAILY_LIMIT" in findings
    # The message has to tell an operator what to do, not just what is wrong.
    message = findings["PEOPLE_APOLLO_DAILY_CREDIT_BUDGET"]
    assert "PEOPLE_PROVIDER_ORDER" in message
    assert "positive" in message
    # It names the remedy, not just the symptom.
    assert "remove apollo" in message.lower()


def test_startup_actually_raises_rather_than_warning():
    with pytest.raises(ConfigurationError) as raised:
        enforce(Settings(**LIVE_APOLLO_ZERO_BUDGET))

    detail = str(raised.value)
    assert "PEOPLE_APOLLO_DAILY_CREDIT_BUDGET" in detail
    # Never the credential itself.
    assert "apollo-key" not in detail
    assert "pdl-key" not in detail


def test_every_apollo_problem_is_reported_in_one_run():
    # An operator should not have to fix one setting, redeploy, and discover the
    # next one.
    findings = findings_for(
        apollo_api_key=None,
        people_apollo_daily_credit_budget=0,
        people_apollo_per_user_daily_limit=0,
        people_apollo_max_enrichments_per_discovery=0,
        people_apollo_recruiter_results=0,
    )

    for setting in (
        "APOLLO_API_KEY",
        "PEOPLE_APOLLO_DAILY_CREDIT_BUDGET",
        "PEOPLE_APOLLO_PER_USER_DAILY_LIMIT",
        "PEOPLE_APOLLO_MAX_ENRICHMENTS_PER_DISCOVERY",
        "PEOPLE_APOLLO_RECRUITER_RESULTS",
    ):
        assert setting in findings, setting


def test_enabling_apollo_without_listing_it_is_still_validated():
    # The discovery flag alone means someone intends to use Apollo.
    findings = findings_for(people_provider_order=["pdl"])

    assert "PEOPLE_APOLLO_DAILY_CREDIT_BUDGET" in findings


def test_the_diagnostic_flag_does_not_enable_discovery():
    # PEOPLE_APOLLO_DIAGNOSTIC_ENABLED is an internal probe, not a discovery
    # switch, and must not by itself demand a discovery budget.
    findings = findings_for(
        people_provider_order=["pdl"],
        people_apollo_discovery_enabled=False,
        people_apollo_diagnostic_enabled=True,
    )

    assert not any(setting.startswith("PEOPLE_APOLLO") for setting in findings)


def test_unused_apollo_may_keep_zero_budgets():
    findings = findings_for(
        people_provider_order=["pdl"],
        people_apollo_discovery_enabled=False,
        apollo_api_key=None,
    )

    assert not any("APOLLO" in setting for setting in findings)


def test_a_funded_apollo_chain_validates_cleanly():
    findings = findings_for(
        people_apollo_daily_credit_budget=500,
        people_apollo_per_user_daily_limit=25,
    )

    # Unrelated production findings (secret key, database) are another test's
    # subject; this one asserts the People chain is clean.
    people = {
        setting: problem
        for setting, problem in findings.items()
        if "PEOPLE" in setting or "APOLLO" in setting or "PDL" in setting
    }
    assert people == {}


def test_the_call_ceiling_must_leave_room_for_an_apollo_search():
    # A ceiling PDL alone can exhaust makes Apollo unreachable in practice, which
    # is the same silent skip in a different disguise.
    findings = findings_for(
        people_apollo_daily_credit_budget=500,
        people_apollo_per_user_daily_limit=25,
        people_provider_max_calls_per_discovery=1,
    )

    assert "PEOPLE_PROVIDER_MAX_CALLS_PER_DISCOVERY" in findings


def test_development_cannot_bypass_validation_when_apollo_is_enabled():
    # enforce() skips non-production environments, so an explicitly enabled but
    # unfunded Apollo has to be visible to collect_findings regardless of env.
    findings = findings_for(app_env="development")

    assert "PEOPLE_APOLLO_DAILY_CREDIT_BUDGET" in findings


# --------------------------------------------------------------------------
# Provider order parsing
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    ['["pdl","apollo"]', "pdl,apollo", " pdl , apollo ", "PDL,Apollo"],
)
def test_json_and_csv_orders_normalize_identically(raw):
    settings = Settings(**{**LIVE_APOLLO_ZERO_BUDGET, "people_provider_order": raw})
    assert settings.people_provider_order == ["pdl", "apollo"]


def test_a_single_provider_is_accepted_in_either_form():
    assert Settings(people_provider_order="pdl").people_provider_order == ["pdl"]
    assert Settings(people_provider_order='["pdl"]').people_provider_order == ["pdl"]


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("pdl,,apollo", "empty"),
        ("pdl,nope", "unknown"),
        ("pdl,apollo,pdl", "duplicate"),
    ],
)
def test_malformed_orders_are_rejected_with_a_named_cause(raw, expected):
    with pytest.raises(ValueError) as raised:
        Settings(people_provider_order=raw)
    assert expected in str(raised.value).lower()


def test_mock_is_rejected_outside_tests():
    with pytest.raises(ValueError):
        Settings(app_env="production", people_provider_order="pdl,mock")


def test_an_order_that_does_not_start_with_the_primary_is_a_finding():
    findings = findings_for(
        people_provider_order=["apollo", "pdl"],
        people_apollo_daily_credit_budget=500,
        people_apollo_per_user_daily_limit=25,
    )

    assert "PEOPLE_PROVIDER_ORDER" in findings


def test_normalize_provider_order_is_the_single_parsing_entry_point():
    assert normalize_provider_order("pdl, apollo") == ["pdl", "apollo"]
    assert normalize_provider_order(["pdl", "apollo"]) == ["pdl", "apollo"]
    assert normalize_provider_order(None) == []
    assert set(KNOWN_PROVIDERS) >= {"pdl", "apollo", "openai_web"}


# --------------------------------------------------------------------------
# The runtime half of the same defect
# --------------------------------------------------------------------------


def test_unfunded_apollo_is_reported_as_misconfigured_not_merely_unavailable():
    """The runtime gate must agree with startup validation about the cause.

    Before the fix this returned a generic "budget not configured" skip that was
    indistinguishable from a disabled provider, so the only symptom was Apollo
    never being attempted.
    """

    from app.people.service import _provider_budget_state
    from app.people.waterfall import ACTIONABLE_SKIPS, SkipReason

    reason = _provider_budget_state(
        db=None,  # unreachable: the zero-budget check short-circuits first
        provider="apollo",
        user_id=1,
        global_budget=0,
        per_user_budget=0,
    )
    assert reason is SkipReason.INVALID_CONFIGURATION
    assert reason in ACTIONABLE_SKIPS


# --------------------------------------------------------------------------
# The deployment paths that actually load the setting
# --------------------------------------------------------------------------


def _write(tmp_path, body: str):
    path = tmp_path / ".env"
    path.write_text(body)
    return path


def test_json_and_csv_both_load_from_a_dotenv_file(tmp_path):
    """The path the live crash came from.

    pydantic-settings JSON-decodes list fields *inside the env source*, before
    any field validator runs, so `PEOPLE_PROVIDER_ORDER=pdl,apollo` in a .env
    file used to raise an opaque SettingsError naming only the field.
    """

    json_env = tmp_path / "json.env"
    json_env.write_text('PEOPLE_PROVIDER_ORDER=["pdl","apollo"]\n')
    csv_env = tmp_path / "csv.env"
    csv_env.write_text("PEOPLE_PROVIDER_ORDER=pdl,apollo\n")

    assert Settings(_env_file=str(json_env)).people_provider_order == ["pdl", "apollo"]
    assert Settings(_env_file=str(csv_env)).people_provider_order == ["pdl", "apollo"]


def test_a_typo_in_a_dotenv_file_names_the_unknown_provider(tmp_path):
    env = _write(tmp_path, "PEOPLE_PROVIDER_ORDER=pdl,aploo\n")
    with pytest.raises(ValueError) as raised:
        Settings(_env_file=str(env))
    message = str(raised.value)
    assert "aploo" in message
    assert "apollo" in message  # the known-provider list points at the fix


def test_the_shipped_env_example_loads_and_validates(tmp_path):
    # The documented example must be a configuration the app can actually boot
    # with — that is the whole contract of .env.example.
    from pathlib import Path

    example = Path(__file__).resolve().parents[4] / ".env.example"
    if not example.exists():  # pragma: no cover - repo layout guard
        pytest.skip(".env.example not found")

    settings = Settings(_env_file=str(example))
    assert settings.people_provider_order == ["pdl"]
    # Apollo is off and unfunded in the example, which is a valid combination.
    people_findings = [
        finding.setting
        for finding in collect_findings(settings)
        if "APOLLO" in finding.setting or "PROVIDER_ORDER" in finding.setting
    ]
    assert people_findings == []
