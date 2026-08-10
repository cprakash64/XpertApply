"""Fail-fast validation of production configuration.

The failure mode this prevents is silent: every unsafe setting here has a
*working* development default, so a misconfigured production deploy starts
cleanly, serves traffic, and is indistinguishable from a correct one until it is
exploited. Signing JWTs with the shipped default `SECRET_KEY` lets anyone forge
a token for any user.

So these checks run at startup and REFUSE to boot rather than warn. They apply
only when ``APP_ENV`` selects a production-like environment; development keeps
its convenient defaults (that is the whole point of having them).

Nothing in this module logs, returns or embeds a secret VALUE — findings name
the setting only, because the resulting message travels into logs and crash
reporters.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import urlparse

logger = logging.getLogger("jobpilot.config")

# Environments that must be locked down. Everything else (development, test,
# local, ci) keeps the permissive defaults.
PRODUCTION_ENVS = frozenset({"production", "prod", "staging"})

# Values shipped in this repo's docs/compose/defaults. Anything matching is, by
# definition, public knowledge and unusable as a real secret.
KNOWN_DEV_SECRET_KEYS = frozenset(
    {
        "dev-only-change-me",
        "change-me",
        "changeme",
        "secret",
        "secret-key",
        "dev",
        "development",
        "test",
        "jobpilot",
        "please-change-this",
        "your-secret-key-here",
    }
)

KNOWN_DEV_DB_PASSWORDS = frozenset(
    {
        "jobpilot_dev_password",
        "jobpilot",
        "postgres",
        "password",
        "passwd",
        "admin",
        "root",
        "changeme",
        "change-me",
        "dev",
        "test",
    }
)

# A signing key shorter than this cannot carry 128 bits of entropy even if it is
# perfectly random.
MIN_SECRET_KEY_LENGTH = 32
# Guards against "aaaaaaaa..." or "01010101..." padding to reach the length bar.
MIN_SECRET_KEY_DISTINCT_CHARS = 8


class ConfigurationError(RuntimeError):
    """Raised when production configuration is unsafe. Never carries a value."""


@dataclass(frozen=True)
class Finding:
    setting: str
    problem: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.setting}: {self.problem}"


def is_production(app_env: str | None) -> bool:
    return (app_env or "").strip().lower() in PRODUCTION_ENVS


def _check_secret_key(secret_key: str | None) -> list[Finding]:
    key = (secret_key or "").strip()
    if not key:
        return [Finding("SECRET_KEY", "is missing")]
    if key.lower() in KNOWN_DEV_SECRET_KEYS:
        return [Finding("SECRET_KEY", "is a documented development default and is publicly known")]
    findings: list[Finding] = []
    if len(key) < MIN_SECRET_KEY_LENGTH:
        findings.append(
            Finding("SECRET_KEY", f"is shorter than {MIN_SECRET_KEY_LENGTH} characters")
        )
    if len(set(key)) < MIN_SECRET_KEY_DISTINCT_CHARS:
        findings.append(Finding("SECRET_KEY", "has too little variation to be a random key"))
    return findings


def _check_demographics_key(key: str | None, *, required: bool) -> list[Finding]:
    if not required:
        return []
    if not (key or "").strip():
        return [
            Finding(
                "DEMOGRAPHICS_ENCRYPTION_KEY",
                "is missing while encrypted demographics storage is enabled",
            )
        ]
    return []


def _check_workday_credentials_key(key: str | None) -> list[Finding]:
    if (key or "").strip():
        return []
    return [
        Finding(
            "WORKDAY_CREDENTIALS_ENCRYPTION_KEY",
            "is missing; employer-account passwords require a dedicated encryption key",
        )
    ]


def _check_people_encryption_key(key: str | None, *, email_enabled: bool) -> list[Finding]:
    if not email_enabled or (key or "").strip():
        return []
    return [
        Finding(
            "PEOPLE_DATA_ENCRYPTION_KEY",
            "is missing while professional-email discovery is enabled",
        )
    ]


def _check_people_email_configuration(settings) -> list[Finding]:
    if not bool(getattr(settings, "people_email_discovery_enabled", False)):
        return []
    findings: list[Finding] = []
    if not (getattr(settings, "hunter_api_key", None) or "").strip():
        findings.append(
            Finding(
                "HUNTER_API_KEY",
                "is missing while professional-email discovery is enabled",
            )
        )
    for setting, attribute in (
        ("PEOPLE_EMAIL_DAILY_CREDIT_BUDGET", "people_email_daily_credit_budget"),
        ("PEOPLE_EMAIL_PER_USER_DAILY_LIMIT", "people_email_per_user_daily_limit"),
    ):
        if int(getattr(settings, attribute, 0) or 0) <= 0:
            findings.append(
                Finding(
                    setting,
                    "must be a positive limit while professional-email discovery is enabled",
                )
            )
    if int(getattr(settings, "people_email_result_ttl_days", 0) or 0) <= 0:
        findings.append(
            Finding(
                "PEOPLE_EMAIL_RESULT_TTL_DAYS",
                "must be positive while professional-email discovery is enabled",
            )
        )
    return findings


def _check_people_employment_verification_configuration(settings) -> list[Finding]:
    if not bool(
        getattr(
            settings,
            "people_employment_secondary_verification_enabled",
            False,
        )
    ):
        return []
    findings: list[Finding] = []
    if not (getattr(settings, "pdl_api_key", None) or "").strip():
        findings.append(
            Finding(
                "PDL_API_KEY",
                "is missing while secondary employment verification is enabled",
            )
        )
    for setting, attribute in (
        (
            "PEOPLE_EMPLOYMENT_VERIFICATION_DAILY_CREDIT_BUDGET",
            "people_employment_verification_daily_credit_budget",
        ),
        (
            "PEOPLE_EMPLOYMENT_VERIFICATION_PER_USER_DAILY_LIMIT",
            "people_employment_verification_per_user_daily_limit",
        ),
    ):
        if int(getattr(settings, attribute, 0) or 0) <= 0:
            findings.append(
                Finding(
                    setting,
                    "must be positive while secondary employment verification is enabled",
                )
            )
    return findings


def _check_people_discovery_configuration(settings) -> list[Finding]:
    if not bool(getattr(settings, "people_recommendations_enabled", False)):
        return []
    provider = str(
        getattr(settings, "people_primary_provider", "")
    ).strip().lower()
    findings: list[Finding] = []
    if provider != "pdl":
        findings.append(
            Finding(
                "PEOPLE_PRIMARY_PROVIDER",
                "must be pdl for normal People discovery",
            )
        )
        return findings
    if not bool(getattr(settings, "people_pdl_discovery_enabled", False)):
        findings.append(
            Finding(
                "PEOPLE_PDL_DISCOVERY_ENABLED",
                "must be enabled when PDL is the primary provider",
            )
        )
    if not (getattr(settings, "pdl_api_key", None) or "").strip():
        findings.append(
            Finding(
                "PDL_API_KEY",
                "is missing while PDL discovery is enabled",
            )
        )
    for setting, attribute in (
        ("PEOPLE_PDL_DAILY_CREDIT_BUDGET", "people_pdl_daily_credit_budget"),
        (
            "PEOPLE_PDL_PER_USER_DAILY_LIMIT",
            "people_pdl_per_user_daily_limit",
        ),
    ):
        if int(getattr(settings, attribute, 0) or 0) <= 0:
            findings.append(
                Finding(
                    setting,
                    "must be a positive limit while PDL discovery is enabled",
                )
            )
    if int(getattr(settings, "people_pdl_result_ttl_days", 0) or 0) <= 0:
        findings.append(
            Finding(
                "PEOPLE_PDL_RESULT_TTL_DAYS",
                "must be positive while PDL discovery is enabled",
            )
        )
    category_limits = (
        ("PEOPLE_PDL_RECRUITER_RESULTS", "people_pdl_recruiter_results"),
        ("PEOPLE_PDL_MANAGER_RESULTS", "people_pdl_manager_results"),
        ("PEOPLE_PDL_REFERRAL_RESULTS", "people_pdl_referral_results"),
    )
    for setting, attribute in category_limits:
        if int(getattr(settings, attribute, 0) or 0) <= 0:
            findings.append(
                Finding(
                    setting,
                    "must be positive while PDL discovery is enabled",
                )
            )
    total_limit = int(
        getattr(settings, "people_pdl_max_results_per_discovery", 0) or 0
    )
    configured_total = sum(
        max(0, int(getattr(settings, attribute, 0) or 0))
        for _setting, attribute in category_limits
    )
    if total_limit <= 0:
        findings.append(
            Finding(
                "PEOPLE_PDL_MAX_RESULTS_PER_DISCOVERY",
                "must be positive while PDL discovery is enabled",
            )
        )
    elif configured_total > total_limit:
        findings.append(
            Finding(
                "PEOPLE_PDL_MAX_RESULTS_PER_DISCOVERY",
                "must cover the configured category result limits",
            )
        )
    findings.extend(_check_people_provider_waterfall(settings))
    findings.extend(_check_people_resilience_configuration(settings))
    return findings


def _check_people_provider_waterfall(settings) -> list[Finding]:
    """The fallback chain must be well-formed and every enabled hop must be funded.

    A provider that is switched on but unfunded is the worst of the three
    states: it is not disabled (so an operator believes there is redundancy) and
    it is not available (so the waterfall skips it), which is exactly how an
    exhausted PDL budget reached users as "People search is unavailable" while a
    keyed Apollo account sat idle behind it. Zero budget on an *enabled* provider
    is therefore a configuration error, not a quiet default.
    """

    from app.people.provider_registry import KNOWN_PROVIDERS, normalize_provider_order

    findings: list[Finding] = []
    try:
        order = normalize_provider_order(getattr(settings, "people_provider_order", []))
    except ValueError as exc:
        # Reached only when a caller built Settings without the field validator.
        return [Finding("PEOPLE_PROVIDER_ORDER", str(exc))]

    if not order:
        findings.append(
            Finding("PEOPLE_PROVIDER_ORDER", "must list at least one provider")
        )
    if "mock" in order:
        findings.append(
            Finding("PEOPLE_PROVIDER_ORDER", "must not include the mock provider")
        )
    primary = str(getattr(settings, "people_primary_provider", "")).strip().lower()
    if primary and order and order[0] != primary:
        findings.append(
            Finding(
                "PEOPLE_PROVIDER_ORDER",
                f"must start with PEOPLE_PRIMARY_PROVIDER ({primary}); "
                f"it starts with {order[0]}",
            )
        )
    if primary and primary in KNOWN_PROVIDERS and order and primary not in order:
        findings.append(
            Finding(
                "PEOPLE_PROVIDER_ORDER",
                f"must contain the primary provider ({primary})",
            )
        )

    call_ceiling = int(_configured_int(settings, "people_provider_max_calls_per_discovery"))
    if call_ceiling <= 0:
        findings.append(
            Finding(
                "PEOPLE_PROVIDER_MAX_CALLS_PER_DISCOVERY",
                "must be a positive ceiling on provider calls",
            )
        )
    if all(
        int(_configured_int(settings, attribute)) <= 0
        for attribute in (
            "people_coverage_min_recruiters",
            "people_coverage_min_managers",
            "people_coverage_min_referrers",
        )
    ):
        findings.append(
            Finding(
                "PEOPLE_COVERAGE_MIN_RECRUITERS",
                "at least one coverage target must be positive, or the "
                "waterfall stops before calling any provider",
            )
        )

    findings.extend(_check_apollo_provider(settings, order=order, call_ceiling=call_ceiling))
    findings.extend(_check_openai_web_provider(settings, order=order))
    findings.extend(_check_brightdata_provider(settings, order=order))
    return findings


def collect_people_provider_findings(settings) -> list[Finding]:
    """Every provider configuration problem, together, for the operator script.

    Deliberately the same function the startup check uses. An operator running
    the dry-run inspector and a deployment running startup validation must never
    be told different things about the same configuration.
    """

    return _check_people_provider_waterfall(settings)


def _check_brightdata_provider(settings, *, order: list[str]) -> list[Finding]:
    """Bright Data's gates, reported all at once rather than one deploy at a time.

    Bright Data is a *verification* integration: it confirms profiles other
    providers discovered. It is therefore validated whenever verification is
    enabled or whenever "brightdata" is named in the provider order, and it has
    no discovery configuration to check because it performs no discovery.
    """

    listed = "brightdata" in order
    enabled = bool(getattr(settings, "people_brightdata_verification_enabled", False))
    if not (listed or enabled):
        return []

    findings: list[Finding] = []
    where = (
        "is listed in PEOPLE_PROVIDER_ORDER"
        if listed
        else "is enabled by PEOPLE_BRIGHTDATA_VERIFICATION_ENABLED"
    )
    if listed and not enabled:
        findings.append(
            Finding(
                "PEOPLE_BRIGHTDATA_VERIFICATION_ENABLED",
                "must be true while brightdata is listed in PEOPLE_PROVIDER_ORDER, "
                "or discovered profiles will never be verified and none of them "
                "can be displayed",
            )
        )
    if not (getattr(settings, "brightdata_api_token", None) or "").strip():
        findings.append(
            Finding("BRIGHTDATA_API_TOKEN", f"is missing while Bright Data {where}")
        )
    if not (getattr(settings, "people_brightdata_dataset_id", None) or "").strip():
        findings.append(
            Finding(
                "PEOPLE_BRIGHTDATA_DATASET_ID",
                f"is missing while Bright Data {where}. This is the LinkedIn "
                "people-profiles collect-by-URL dataset used for verification.",
            )
        )
    # Verification is the only thing that can turn a public-web sighting into a
    # displayable contact, so a chain with OpenAI but no verifier can never show
    # anyone and should say so at startup rather than at request time.
    if (
        "openai_web" in order
        and not enabled
        and bool(getattr(settings, "people_openai_web_discovery_enabled", False))
    ):
        findings.append(
            Finding(
                "PEOPLE_BRIGHTDATA_VERIFICATION_ENABLED",
                "must be true when openai_web is in PEOPLE_PROVIDER_ORDER: "
                "public-web candidates are only displayable once Bright Data "
                "has verified their profile",
            )
        )
    for setting, attribute in (
        ("PEOPLE_BRIGHTDATA_DAILY_RECORD_BUDGET", "people_brightdata_daily_record_budget"),
        (
            "PEOPLE_BRIGHTDATA_PER_USER_DAILY_LIMIT",
            "people_brightdata_per_user_daily_limit",
        ),
        (
            "PEOPLE_BRIGHTDATA_MAX_RECORDS_PER_DISCOVERY",
            "people_brightdata_max_records_per_discovery",
        ),
    ):
        if int(_configured_int(settings, attribute)) <= 0:
            findings.append(
                Finding(
                    setting,
                    f"is 0 while Bright Data {where}. Set a positive value, or "
                    "remove brightdata from PEOPLE_PROVIDER_ORDER.",
                )
            )
    if _configured_float(settings, "people_brightdata_timeout_seconds") <= 0:
        findings.append(
            Finding(
                "PEOPLE_BRIGHTDATA_TIMEOUT_SECONDS",
                f"must be a positive number while Bright Data {where}",
            )
        )
    return findings


def _apollo_is_intended(settings, *, order: list[str]) -> bool:
    """Whether this deployment means to use Apollo for discovery.

    Deliberately excludes PEOPLE_APOLLO_DIAGNOSTIC_ENABLED: that flag is an
    internal probe of the Apollo account, not a statement that Apollo should
    answer user-facing searches, and conflating the two would demand a discovery
    budget from deployments that only run diagnostics.
    """

    return "apollo" in order or bool(
        getattr(settings, "people_apollo_discovery_enabled", False)
    )


def _check_apollo_provider(
    settings, *, order: list[str], call_ceiling: int
) -> list[Finding]:
    if not _apollo_is_intended(settings, order=order):
        # Nobody asked for Apollo: zero budgets are correct and mean "off".
        return []

    listed = "apollo" in order
    where = (
        "is listed in PEOPLE_PROVIDER_ORDER"
        if listed
        else "is enabled by PEOPLE_APOLLO_DISCOVERY_ENABLED"
    )
    remedy = (
        "Set a positive value, or remove apollo from PEOPLE_PROVIDER_ORDER."
        if listed
        else "Set a positive value, or set PEOPLE_APOLLO_DISCOVERY_ENABLED=false."
    )

    findings: list[Finding] = []
    if not (getattr(settings, "apollo_api_key", None) or "").strip():
        findings.append(
            Finding("APOLLO_API_KEY", f"is missing while Apollo {where}")
        )
    if listed and not bool(getattr(settings, "people_apollo_discovery_enabled", False)):
        findings.append(
            Finding(
                "PEOPLE_APOLLO_DISCOVERY_ENABLED",
                "must be true while apollo is listed in PEOPLE_PROVIDER_ORDER, "
                "or the waterfall will skip it on every discovery",
            )
        )

    # Every remaining check reports independently so one deploy surfaces the
    # complete list rather than one problem at a time.
    for setting, attribute in (
        ("PEOPLE_APOLLO_DAILY_CREDIT_BUDGET", "people_apollo_daily_credit_budget"),
        ("PEOPLE_APOLLO_PER_USER_DAILY_LIMIT", "people_apollo_per_user_daily_limit"),
        (
            "PEOPLE_APOLLO_MAX_ENRICHMENTS_PER_DISCOVERY",
            "people_apollo_max_enrichments_per_discovery",
        ),
        ("PEOPLE_APOLLO_RECRUITER_RESULTS", "people_apollo_recruiter_results"),
        ("PEOPLE_APOLLO_MANAGER_RESULTS", "people_apollo_manager_results"),
        ("PEOPLE_APOLLO_REFERRAL_RESULTS", "people_apollo_referral_results"),
    ):
        if int(_configured_int(settings, attribute)) <= 0:
            findings.append(
                Finding(
                    setting,
                    f"is 0 while Apollo {where}. {remedy}",
                )
            )

    # Apollo needs at least one search call plus one enrichment call to be
    # reachable at all; a ceiling the primary can exhaust on its own makes the
    # fallback decorative.
    if 0 < call_ceiling < 2:
        findings.append(
            Finding(
                "PEOPLE_PROVIDER_MAX_CALLS_PER_DISCOVERY",
                f"is {call_ceiling}, which leaves no room for an Apollo search "
                f"while Apollo {where}",
            )
        )
    return findings


def _check_openai_web_provider(settings, *, order: list[str]) -> list[Finding]:
    # Unlike Apollo, the public-web fallback is only validated when explicitly
    # enabled: listing it in the order while disabled is a documented way to
    # stage the rollout.
    if not bool(getattr(settings, "people_openai_web_discovery_enabled", False)):
        return []

    findings: list[Finding] = []
    if "openai_web" not in order:
        findings.append(
            Finding(
                "PEOPLE_PROVIDER_ORDER",
                "must include openai_web while "
                "PEOPLE_OPENAI_WEB_DISCOVERY_ENABLED is true",
            )
        )
    if not (getattr(settings, "openai_api_key", None) or "").strip():
        findings.append(
            Finding(
                "OPENAI_API_KEY",
                "is missing while public-web people discovery is enabled",
            )
        )
    if not str(getattr(settings, "people_openai_web_model", "") or "").strip():
        findings.append(
            Finding(
                "PEOPLE_OPENAI_WEB_MODEL",
                "must name a model while public-web people discovery is enabled",
            )
        )
    confidence = _configured_float(settings, "people_openai_web_min_confidence")
    if not 0.5 <= confidence <= 1:
        findings.append(
            Finding(
                "PEOPLE_OPENAI_WEB_MIN_CONFIDENCE",
                "must be between 0.5 and 1.0 for an unverified public-web source",
            )
        )
    for setting, attribute in (
        (
            "PEOPLE_OPENAI_WEB_MAX_SEARCHES_PER_DISCOVERY",
            "people_openai_web_max_searches_per_discovery",
        ),
        ("PEOPLE_OPENAI_WEB_MAX_CANDIDATES", "people_openai_web_max_candidates"),
        ("PEOPLE_OPENAI_WEB_DAILY_CALL_BUDGET", "people_openai_web_daily_call_budget"),
        (
            "PEOPLE_OPENAI_WEB_PER_USER_DAILY_LIMIT",
            "people_openai_web_per_user_daily_limit",
        ),
        ("PEOPLE_OPENAI_WEB_CACHE_TTL_SECONDS", "people_openai_web_cache_ttl_seconds"),
    ):
        if int(_configured_int(settings, attribute)) <= 0:
            findings.append(
                Finding(
                    setting,
                    "must be positive while public-web people discovery is enabled",
                )
            )
    return findings


def _configured_int(settings, attribute: str) -> int:
    """Read an int setting, falling back to the Settings model's own default.

    Callers may pass a partial settings object (tests do). Treating an absent
    attribute as 0 would report a violation for a value the deployment never
    set and that has a safe default.
    """

    from app.core.config import Settings

    field = Settings.model_fields.get(attribute)
    default = field.default if field is not None else 0
    value = getattr(settings, attribute, None)
    if value is None:
        value = default
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default or 0)


def _configured_float(settings, attribute: str) -> float:
    from app.core.config import Settings

    field = Settings.model_fields.get(attribute)
    default = field.default if field is not None else 0.0
    value = getattr(settings, attribute, None)
    if value is None:
        value = default
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default or 0.0)


def _check_people_resilience_configuration(settings) -> list[Finding]:
    """Circuit, concurrency, and domain-confidence guardrails.

    These protect two opposite failure modes: a breaker so loose it never trips
    during a real outage, and one so tight that ordinary traffic pauses the
    feature. Both are configuration errors, so they are caught at startup.
    """

    findings: list[Finding] = []
    for setting, attribute, minimum in (
        ("PEOPLE_CIRCUIT_FAILURE_THRESHOLD", "people_circuit_failure_threshold", 2),
        (
            "PEOPLE_CIRCUIT_FAILURE_WINDOW_SECONDS",
            "people_circuit_failure_window_seconds",
            5,
        ),
        ("PEOPLE_CIRCUIT_COOLDOWN_SECONDS", "people_circuit_cooldown_seconds", 5),
        (
            "PEOPLE_CIRCUIT_CONFIGURATION_THRESHOLD",
            "people_circuit_configuration_threshold",
            1,
        ),
        (
            "PEOPLE_CIRCUIT_RATE_LIMIT_THRESHOLD",
            "people_circuit_rate_limit_threshold",
            1,
        ),
        (
            "PEOPLE_PROVIDER_MAX_CONCURRENT_CALLS",
            "people_provider_max_concurrent_calls",
            1,
        ),
        ("PEOPLE_STALE_RESULT_WINDOW_DAYS", "people_stale_result_window_days", 0),
    ):
        if _configured_int(settings, attribute) < minimum:
            findings.append(
                Finding(setting, f"must be at least {minimum}")
            )
    cooldown = _configured_int(settings, "people_circuit_cooldown_seconds")
    max_cooldown = _configured_int(settings, "people_circuit_max_cooldown_seconds")
    if max_cooldown < cooldown:
        findings.append(
            Finding(
                "PEOPLE_CIRCUIT_MAX_COOLDOWN_SECONDS",
                "must not be below PEOPLE_CIRCUIT_COOLDOWN_SECONDS",
            )
        )
    for setting, attribute, minimum, maximum in (
        (
            "PEOPLE_PDL_COMPANY_MIN_LIKELIHOOD",
            "people_pdl_company_min_likelihood",
            1,
            10,
        ),
        (
            "PEOPLE_PDL_MAX_QUERY_STRATEGIES",
            "people_pdl_max_query_strategies",
            1,
            6,
        ),
        (
            "PEOPLE_PDL_SEARCH_RESULT_LIMIT",
            "people_pdl_search_result_limit",
            1,
            100,
        ),
        (
            "PEOPLE_PDL_MAX_PROVIDER_CALLS_PER_DISCOVERY",
            "people_pdl_max_provider_calls_per_discovery",
            1,
            50,
        ),
    ):
        value = _configured_int(settings, attribute)
        if not minimum <= value <= maximum:
            findings.append(
                Finding(setting, f"must be between {minimum} and {maximum}")
            )
    if _configured_int(settings, "people_pdl_negative_cache_ttl_seconds") < 0:
        findings.append(
            Finding("PEOPLE_PDL_NEGATIVE_CACHE_TTL_SECONDS", "must not be negative")
        )
    # User quota. Counted in actions, so these must never be conflated with the
    # provider credit budgets above.
    standard = _configured_int(settings, "people_user_daily_discovery_limit")
    internal = _configured_int(settings, "people_internal_user_daily_discovery_limit")
    hourly = _configured_int(settings, "people_discovery_rate_limit_per_hour")
    if standard <= 0:
        findings.append(
            Finding("PEOPLE_USER_DAILY_DISCOVERY_LIMIT", "must be positive")
        )
    if internal <= 0:
        findings.append(
            Finding("PEOPLE_INTERNAL_USER_DAILY_DISCOVERY_LIMIT", "must be positive")
        )
    elif internal < standard:
        findings.append(
            Finding(
                "PEOPLE_INTERNAL_USER_DAILY_DISCOVERY_LIMIT",
                "must not be below PEOPLE_USER_DAILY_DISCOVERY_LIMIT",
            )
        )
    if hourly <= 0:
        findings.append(
            Finding("PEOPLE_DISCOVERY_RATE_LIMIT_PER_HOUR", "must be positive")
        )
    timezone_name = str(
        getattr(settings, "people_quota_reset_timezone", None) or "UTC"
    ).strip()
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(timezone_name)
    except Exception:
        findings.append(
            Finding("PEOPLE_QUOTA_RESET_TIMEZONE", "is not a valid IANA timezone")
        )
    # One discovery must be able to complete within the provider budget.
    per_discovery = _configured_int(
        settings, "people_pdl_max_provider_calls_per_discovery"
    )
    provider_budget = _configured_int(settings, "people_pdl_daily_credit_budget")
    if provider_budget and per_discovery > provider_budget:
        findings.append(
            Finding(
                "PEOPLE_PDL_MAX_PROVIDER_CALLS_PER_DISCOVERY",
                "must fit within PEOPLE_PDL_DAILY_CREDIT_BUDGET",
            )
        )
    confidence = _configured_float(settings, "people_domain_min_confidence")
    if not 0.0 < confidence <= 1.0:
        findings.append(
            Finding(
                "PEOPLE_DOMAIN_MIN_CONFIDENCE",
                "must be greater than 0 and at most 1",
            )
        )
    return findings


def _check_cors(origins: list[str] | None, *, allow_credentials: bool) -> list[Finding]:
    values = [o.strip() for o in (origins or []) if o and o.strip()]
    if not values:
        return [
            Finding("CORS_ORIGINS", "is empty; production must list trusted origins explicitly")
        ]
    if "*" in values:
        if allow_credentials:
            # Browsers reject this combination outright, so the practical effect
            # is that every credentialed cross-origin call silently breaks — and
            # it signals the origin list was never configured.
            return [
                Finding(
                    "CORS_ORIGINS",
                    "uses the wildcard '*' together with credentialed requests",
                )
            ]
        return [Finding("CORS_ORIGINS", "uses the wildcard '*' in production")]
    findings = []
    for origin in values:
        if origin.startswith("http://") and not origin.startswith("http://localhost"):
            findings.append(
                Finding(
                    "CORS_ORIGINS", f"contains a plaintext http:// origin ({_host_only(origin)})"
                )
            )
    return findings


def _host_only(origin: str) -> str:
    """Host without scheme/path — safe to log, and never a credential."""
    try:
        return urlparse(origin).hostname or "unknown"
    except ValueError:
        return "unparseable"


def _check_database_url(database_url: str | None) -> list[Finding]:
    url = (database_url or "").strip()
    if not url:
        return [Finding("DATABASE_URL", "is missing")]
    if url.startswith("sqlite"):
        return [Finding("DATABASE_URL", "points at SQLite, which is not supported in production")]
    try:
        parsed = urlparse(url)
    except ValueError:
        return [Finding("DATABASE_URL", "could not be parsed")]

    findings: list[Finding] = []
    password = parsed.password
    # Compared, never logged or echoed.
    if password is None or password == "":
        findings.append(Finding("DATABASE_URL", "has no password"))
    elif password.lower() in KNOWN_DEV_DB_PASSWORDS:
        findings.append(Finding("DATABASE_URL", "uses a documented development database password"))
    return findings


def _check_debug(debug: bool) -> list[Finding]:
    return [Finding("DEBUG", "is enabled in production")] if debug else []


def collect_findings(settings) -> list[Finding]:
    """Every unsafe production setting. Empty means the config is acceptable.

    Pure and side-effect free so it can be unit-tested and also used by a
    pre-deploy config check without booting the app.
    """
    findings: list[Finding] = []
    findings += _check_secret_key(getattr(settings, "secret_key", None))
    findings += _check_demographics_key(
        getattr(settings, "demographics_encryption_key", None),
        required=bool(getattr(settings, "demographics_encryption_required", False)),
    )
    findings += _check_workday_credentials_key(
        getattr(settings, "workday_credentials_encryption_key", None)
    )
    findings += _check_people_encryption_key(
        getattr(settings, "people_data_encryption_key", None),
        email_enabled=bool(getattr(settings, "people_email_discovery_enabled", False)),
    )
    findings += _check_people_email_configuration(settings)
    findings += _check_people_employment_verification_configuration(settings)
    findings += _check_people_discovery_configuration(settings)
    findings += _check_cors(
        getattr(settings, "cors_origins", None),
        allow_credentials=bool(getattr(settings, "cors_allow_credentials", True)),
    )
    findings += _check_database_url(getattr(settings, "database_url", None))
    findings += _check_debug(bool(getattr(settings, "debug", False)))
    return findings


def enforce(settings) -> None:
    """Refuse to start on unsafe production configuration.

    A warning would be ignored: the app works fine with a known signing key
    right up until someone forges a token, so this raises.
    """
    if not is_production(getattr(settings, "app_env", None)):
        logger.info(
            "Config validation skipped: APP_ENV=%s is not a production environment.",
            getattr(settings, "app_env", "unset"),
        )
        return

    findings = collect_findings(settings)
    if not findings:
        logger.info("Production configuration validated: no unsafe settings detected.")
        return

    # Setting names and problems only — never values.
    detail = "; ".join(str(f) for f in findings)
    raise ConfigurationError(
        f"Refusing to start with unsafe production configuration: {detail}. "
        "Set these via deployment secrets/environment variables."
    )
