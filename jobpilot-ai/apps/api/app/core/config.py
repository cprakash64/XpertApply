import json
import os
from functools import lru_cache

from pydantic import Field, ValidationInfo, field_validator

try:
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ModuleNotFoundError:
    from pydantic import BaseModel

    def SettingsConfigDict(**kwargs):
        return kwargs

    class BaseSettings(BaseModel):
        def __init__(self, **data):
            env_values = {
                name: os.environ[name.upper()]
                for name in self.__class__.model_fields
                if name.upper() in os.environ
            }
            env_values.update(data)
            super().__init__(**env_values)


# List settings this project documents as accepting a comma-separated value.
# pydantic-settings would otherwise JSON-decode them inside the environment
# source and raise an opaque SettingsError before any field validator could run.
_CSV_TOLERANT_LIST_FIELDS = frozenset(
    {
        "cors_origins",
        "job_source_companies",
        "job_discovery_source_packs",
        "people_internal_emails",
        "people_beta_user_ids",
        "people_provider_order",
    }
)


def _tolerate_csv(source):
    """Let documented CSV lists reach the field validator on an existing source.

    The source instances are wrapped rather than rebuilt so every option the
    caller configured — including a runtime ``_env_file`` override — is
    preserved. Only the fields listed above are affected, and only when the
    value is not already JSON, so ``["pdl","apollo"]`` keeps its exact meaning.
    """

    original = source.decode_complex_value

    def decode_complex_value(field_name, field, value, _original=original):
        if (
            field_name in _CSV_TOLERANT_LIST_FIELDS
            and isinstance(value, str)
            and not value.strip().startswith(("[", "{"))
        ):
            return value
        return _original(field_name, field, value)

    try:
        source.decode_complex_value = decode_complex_value
    except (AttributeError, TypeError):  # pragma: no cover - defensive
        pass
    return source


class Settings(BaseSettings):
    # How long an explicitly confirmed legal application answer stays
    # trustworthy before the user is asked to reconfirm it. Circumstances
    # change; a confirmation from years ago is not evidence about today.
    legal_answer_reconfirmation_days: int = 365
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls,
        init_settings,
        env_settings,
        dotenv_settings,
        file_secret_settings,
    ):
        return (
            init_settings,
            _tolerate_csv(env_settings),
            _tolerate_csv(dotenv_settings),
            file_secret_settings,
        )

    database_url: str = "sqlite:///./jobpilot.db"
    redis_url: str = "redis://localhost:6379/0"
    secret_key: str = Field(default="dev-only-change-me", min_length=12)
    jwt_expires_minutes: int = 60 * 24 * 7
    cors_origins: list[str] = ["http://localhost:3000"]
    app_env: str = "development"
    # Validated at startup by app.core.config_validation: when app_env names a
    # production environment, development defaults (the shipped SECRET_KEY, the
    # compose database password, wildcard CORS, DEBUG) are refused outright.
    debug: bool = False
    # Whether CORS responses may carry credentials — paired with cors_origins by
    # the wildcard check, since "*" plus credentials is both unsafe and broken.
    cors_allow_credentials: bool = True
    # Set true once demographics are stored encrypted; makes the encryption key
    # mandatory in production rather than optional.
    demographics_encryption_required: bool = False
    # None = follow app_env (docs served outside production only).
    docs_enabled: bool | None = None
    openai_api_key: str | None = None
    # Role-preserving GPT-5.6 defaults: Sol for quality-first document
    # generation, Terra for the lower-latency/price path. Environment overrides
    # remain supported for deployments with pinned models.
    openai_model_smart: str = "gpt-5.6-sol"
    openai_model_fast: str = "gpt-5.6-terra"
    openai_embedding_model: str = "text-embedding-3-small"
    demographics_encryption_key: str | None = None
    # Separate key for encrypted employer-account credentials. Development may
    # derive from SECRET_KEY; production validation requires this dedicated key.
    workday_credentials_encryption_key: str | None = None
    upload_dir: str = "uploads"
    run_migrations_on_startup: bool = False
    # Public ATS boards to query during discovery, as "provider:slug:Display Name"
    # entries (e.g. "greenhouse:stripe:Stripe"). Empty falls back to a curated
    # default registry. Only public/allowed endpoints are ever queried.
    job_source_companies: list[str] = []
    job_sources_file: str | None = None
    job_discovery_max_companies: int = 200
    job_discovery_max_jobs_per_source: int = 100
    job_discovery_concurrency: int = 10
    job_discovery_timeout_seconds: float = 12.0
    job_discovery_source_packs: list[str] = []
    job_discovery_include_unknown_dates: bool = False
    # Keep back-to-back searches efficient without hiding newly opened roles for
    # most of an hour after a user explicitly asks for fresh jobs.
    job_discovery_cache_ttl_minutes: int = 15

    # --- Daily automated ingestion (scheduler) ---
    job_ingestion_enabled: bool = True
    # Cron expression (m h dom mon dow). The default performs one authoritative
    # refresh every 24 hours; interactive discovery can still be run on demand.
    job_ingestion_schedule: str = "0 6 * * *"
    job_ingestion_timezone: str = "UTC"
    job_posted_within_days: int = 7
    job_ingestion_source_timeout_seconds: float = 60.0
    job_ingestion_max_retries: int = 3
    # Seconds a distributed ingestion lock is held before it is considered stale
    # and recoverable (must exceed a normal run's duration).
    job_ingestion_lock_ttl_seconds: int = 3600
    # A job unseen on its source for longer than this is marked inactive/expired.
    job_expiry_grace_days: int = 3

    # --- Background scoring ---
    job_scoring_batch_size: int = 100
    job_scoring_max_attempts: int = 3

    # --- People Who Can Help (all controls fail closed) ---
    people_recommendations_enabled: bool = False
    people_rollout_mode: str = "disabled"  # disabled|internal|beta|percentage|all
    people_rollout_percentage: int = 0
    people_internal_emails: list[str] = []
    people_beta_user_ids: list[str] = []
    people_primary_provider: str = "pdl"
    # --- Provider waterfall ---------------------------------------------------
    # Ordered discovery providers. The first entry is the primary; the rest are
    # tried only when the one before it leaves a category gap AND its failure is
    # fallback-eligible. Unknown names, duplicates and empty entries are rejected
    # when the setting is loaded.
    #
    # The default lists only PDL, because a provider in this list must also be
    # enabled and funded — a default that named Apollo would fail its own
    # startup validation on every deployment that had not bought Apollo credits.
    people_provider_order: list[str] = ["pdl"]
    people_provider_fallback_on_no_match: bool = True
    people_provider_fallback_on_budget_exhausted: bool = True
    # A hard ceiling on paid provider calls for one discovery, across every
    # provider in the chain. Cost control that does not depend on any single
    # provider's own accounting being correct.
    people_provider_max_calls_per_discovery: int = 12
    # Coverage that ends the waterfall. Reaching all three stops the chain, so a
    # good PDL answer never pays for an Apollo search.
    people_coverage_min_recruiters: int = 2
    people_coverage_min_managers: int = 1
    people_coverage_min_referrers: int = 2
    # Apollo is retained for explicit internal diagnostics only. Normal
    # discovery cannot select it unless both gates are enabled.
    people_apollo_discovery_enabled: bool = False
    people_apollo_diagnostic_enabled: bool = False
    people_pdl_discovery_enabled: bool = True
    people_email_discovery_enabled: bool = False
    people_pdl_fallback_enabled: bool = False
    people_outreach_drafting_enabled: bool = False
    # OpenAI refinement of an already-built deterministic draft. Off by
    # default, and gated on an explicit user action even when on: the card
    # prefetches drafts on hover/focus, so an unconditional model call here
    # would bill a request for pointing at a link.
    people_outreach_ai_enabled: bool = False
    people_outreach_ai_timeout_seconds: float = 20.0
    people_outreach_ai_per_user_daily_limit: int = 20
    people_outreach_ai_daily_budget: int = 200
    people_network_matching_enabled: bool = False
    people_employment_secondary_verification_enabled: bool = False
    people_employment_comparison_mode: bool = False
    people_employment_verification_daily_credit_budget: int = 0
    people_employment_verification_per_user_daily_limit: int = 0
    people_employment_verification_ttl_days: int = 30
    people_employment_verification_max_recruiters: int = 1
    people_employment_verification_max_managers: int = 1
    people_employment_verification_max_referrers: int = 1
    # Apollo carries its own budget so a spent PDL allowance never silently
    # spends Apollo's, and vice versa.
    people_apollo_daily_credit_budget: int = 0
    people_apollo_per_user_daily_limit: int = 0
    people_apollo_recruiter_results: int = 4
    people_apollo_manager_results: int = 4
    people_apollo_referral_results: int = 6
    people_apollo_max_enrichments_per_discovery: int = 6
    # --- Bright Data (professional-profile VERIFICATION) ----------------------
    # Off by default and non-billable until an operator supplies a token, a
    # dataset id, and a budget.
    #
    # Verification only. Bright Data confirms a LinkedIn profile that another
    # provider discovered; it does not search for people by company and title,
    # because that request shape is not published and will not be guessed. See
    # app/people/brightdata.py.
    people_brightdata_verification_enabled: bool = False
    brightdata_api_token: str | None = None
    # The documented LinkedIn people-profiles collect-by-URL dataset.
    people_brightdata_dataset_id: str | None = None
    people_brightdata_daily_record_budget: int = 0
    people_brightdata_per_user_daily_limit: int = 0
    people_brightdata_max_records_per_discovery: int = 12
    people_brightdata_timeout_seconds: float = 30.0
    people_brightdata_poll_interval_seconds: float = 3.0
    # A hard wall on an async snapshot. Bright Data collection is minutes-scale
    # in the worst case and a user request must never wait on it indefinitely.
    people_brightdata_max_poll_seconds: float = 45.0
    # --- OpenAI public-web fallback ------------------------------------------
    # Not a people database. A bounded, citation-required last resort that is
    # off by default and never treated as verified employment evidence.
    people_openai_web_discovery_enabled: bool = False
    people_openai_web_max_searches_per_discovery: int = 3
    # Public-web evidence carries a higher bar than a paid structured provider:
    # it is the only source whose "current employment" is inferred from pages
    # rather than asserted by a data contract.
    people_openai_web_min_confidence: float = 0.90
    people_openai_web_max_candidates: int = 4
    people_openai_web_daily_call_budget: int = 0
    people_openai_web_per_user_daily_limit: int = 0
    people_openai_web_model: str = "gpt-5.6-terra"
    people_openai_web_timeout_seconds: float = 30.0
    # Public-web evidence is cached briefly: it is the slowest and least
    # authoritative provider, so repeating its searches for the same company
    # buys nothing. A short TTL keeps a stale sighting from outliving its truth.
    people_openai_web_cache_ttl_seconds: int = 86_400
    apollo_api_key: str | None = None
    hunter_api_key: str | None = None
    pdl_api_key: str | None = None
    people_data_encryption_key: str | None = None
    people_result_ttl_days: int = 30
    people_pdl_result_ttl_days: int = 30
    people_pdl_results_per_query: int = 20
    # PDL Person Search bills one credit per profile *returned*, so these are
    # the direct cost of one uncached discovery — not the HTTP call count.
    #
    # Reduced from 4/4/8 (=16) to 2/4/4 (=10), chosen by benchmark rather than
    # by argument. See docs/people-quality-and-cost-benchmark.md.
    #
    # Measured over 9 job archetypes through the real gate chain:
    #
    #   4/4/8  144 records   recruiters 18  managers 17  referrals 24
    #   2/3/5   90 records   recruiters 18  managers 14  referrals 23
    #   2/3/4   81 records   recruiters 18  managers 14  referrals 23
    #   2/4/4   90 records   recruiters 18  managers 17  referrals 23
    #
    # Dropping the manager fetch to 3 cost three displayed managers across the
    # set; restoring it to 4 recovers all of them for one extra record per job.
    # The referral fetch stays at 4 because 5 measured identically — the fifth
    # ranked record was consistently unusable — though that is a property of the
    # fixture ordering, not an observation about live provider output.
    #
    # A single shared manager+referral pool was also measured and REJECTED: with
    # display precedence putting managers first, referral coverage collapsed
    # from 24 to 3 and seven category slots were left structurally unfillable.
    people_pdl_recruiter_results: int = 2
    people_pdl_manager_results: int = 4
    people_pdl_referral_results: int = 4
    # Hard per-discovery ceiling. Enforced independently of the per-category
    # numbers so that a future top-up or relaxation tier cannot quietly raise
    # the bill: _PDLStep decrements remaining_records against this.
    people_pdl_max_results_per_discovery: int = 10
    people_pdl_daily_credit_budget: int = 0
    people_pdl_per_user_daily_limit: int = 0
    people_employment_freshness_days: int = 180
    people_email_result_ttl_days: int = 30
    people_max_discovery_results_per_category: int = 20
    people_max_displayed_recruiters: int = 3
    people_max_displayed_managers: int = 3
    people_max_displayed_referrers: int = 5
    people_max_enrichments_per_job: int = 8
    people_daily_credit_budget: int = 0
    people_per_user_daily_limit: int = 0
    people_email_daily_credit_budget: int = 0
    people_email_per_user_daily_limit: int = 0
    people_provider_timeout_seconds: float = 8.0
    people_provider_response_max_bytes: int = 1_000_000
    people_provider_unknown_credit_budget_units: int = 1
    people_apollo_bulk_capability_enabled: bool = True
    people_apollo_bulk_rejection_threshold: int = 2
    people_apollo_bulk_capability_ttl_seconds: int = 3600
    # Whether a bulk enrichment Apollo rejected may be retried, once, as a
    # bounded number of single-person completions. Turning this off leaves the
    # search results intact without contact channels, which is the safe answer
    # for an account whose plan does not include the endpoint at all.
    people_apollo_single_enrichment_fallback_enabled: bool = True
    people_apollo_complete_person_max_recruiters: int = 1
    people_apollo_complete_person_max_managers: int = 1
    people_apollo_complete_person_max_referrers: int = 1
    people_apollo_complete_person_max_per_job: int = 3
    people_apollo_complete_person_cache_ttl_seconds: int = 2_592_000
    people_apollo_complete_person_not_found_ttl_seconds: int = 86_400
    people_apollo_complete_person_error_ttl_seconds: int = 300
    people_min_relevance_score: float = 60.0
    people_min_recruiter_relevance: float = 60.0
    people_min_manager_relevance: float = 60.0
    people_min_referrer_relevance: float = 60.0
    people_min_data_confidence: float = 0.5
    # The core product rule, as a switch. A contact with no validated LinkedIn
    # profile has no channel the user can actually open, so it is not a contact.
    # Turning this off is an internal-evaluation affordance, never a product
    # decision.
    people_require_linkedin_for_display: bool = True
    people_recruiter_enrichment_reserve: int = 3
    people_manager_enrichment_reserve: int = 3
    people_referrer_enrichment_reserve: int = 2
    people_discovery_rate_limit_per_hour: int = 10
    people_email_rate_limit_per_hour: int = 10
    # --- User discovery quota ------------------------------------------------
    # Counted in deliberate user actions. Distinct from the PDL/Apollo credit
    # budgets below, which are measured in provider credit units (one per
    # record a search returns) and exist to control operational cost.
    people_user_daily_discovery_limit: int = 20
    people_internal_user_daily_discovery_limit: int = 100
    # IANA name whose midnight resets the daily allowance.
    people_quota_reset_timezone: str = "UTC"
    # Circuit breakers. Separate cooldowns per circuit kind: a transient blip
    # should clear quickly, a bad credential should not be retried in a loop,
    # and an exhausted provider budget should wait for its window to roll.
    people_circuit_failure_threshold: int = 5
    people_circuit_failure_window_seconds: int = 120
    people_circuit_cooldown_seconds: int = 60
    people_circuit_max_cooldown_seconds: int = 600
    people_circuit_configuration_threshold: int = 2
    people_circuit_configuration_cooldown_seconds: int = 300
    people_circuit_budget_cooldown_seconds: int = 900
    people_circuit_rate_limit_threshold: int = 8
    # Bounded fan-out for paid people-provider calls per API instance.
    people_provider_max_concurrent_calls: int = 2
    people_provider_coalesce_wait_seconds: float = 20.0
    # Serve previously stored results while the provider is unavailable.
    people_stale_result_window_days: int = 14
    # Reject an inferred hiring-company domain below this confidence.
    people_domain_min_confidence: float = 0.6
    # --- PDL company identity and progressive search -------------------------
    # PDL Company Enrichment returns a 1-10 likelihood; below this we treat the
    # company as unresolved rather than guessing at a similarly-named one.
    people_pdl_company_min_likelihood: int = 6
    people_pdl_company_resolution_enabled: bool = True
    people_pdl_company_cache_ttl_seconds: int = 2_592_000
    # Bounded title-relaxation ladder. The company constraint never relaxes.
    people_pdl_progressive_search_enabled: bool = True
    people_pdl_max_query_strategies: int = 3
    people_pdl_location_required: bool = False
    people_pdl_search_result_limit: int = 25
    people_pdl_negative_cache_ttl_seconds: int = 21_600
    # Hard ceiling on provider calls for one discovery, across all categories
    # and strategies, so relaxation can never multiply spend without bound.
    people_pdl_max_provider_calls_per_discovery: int = 8

    @field_validator("people_provider_order", mode="before")
    @classmethod
    def parse_provider_order(cls, value: object, info: ValidationInfo) -> list[str]:
        """Accept a JSON array or a comma-separated list, normalized identically.

        Delegates to the waterfall's parser so the settings model, the startup
        checks, and the runtime chain share one definition of a valid order. A
        malformed order raises here, at load time, with a message naming the
        cause — the previous behaviour was an opaque Pydantic SettingsError.
        """

        from app.people.provider_registry import normalize_provider_order

        order = normalize_provider_order(value)
        # app_env is declared before this field, so the already-validated value
        # is available here; the environment is only a fallback.
        app_env = str(
            (info.data or {}).get("app_env") or os.getenv("APP_ENV", "development")
        ).strip().lower()
        if "mock" in order and app_env not in {"test", "development"}:
            raise ValueError(
                "PEOPLE_PROVIDER_ORDER may not include the mock provider outside "
                "test and development environments."
            )
        return order

    @field_validator(
        "cors_origins",
        "job_source_companies",
        "job_discovery_source_packs",
        "people_internal_emails",
        "people_beta_user_ids",
        mode="before",
    )
    @classmethod
    def parse_cors(cls, value: str | list[str]) -> list[str]:
        if isinstance(value, str):
            if value.strip().startswith("["):
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


    def docs_are_enabled(self) -> bool:
        """Serve /docs, /redoc and the OpenAPI schema?

        Explicit DOCS_ENABLED wins; otherwise docs are on everywhere except a
        production environment. The schema enumerates every endpoint and payload
        shape, which is free reconnaissance in production.
        """
        if self.docs_enabled is not None:
            return self.docs_enabled
        from app.core.config_validation import is_production

        return not is_production(self.app_env)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
