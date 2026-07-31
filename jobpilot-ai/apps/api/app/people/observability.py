"""Safe structured metric events for the repository's log-based monitoring.

The project has no Prometheus/OpenTelemetry dependency. These one-line events are
deliberately backend-only and contain allowlisted, low-cardinality dimensions so
the deployment log pipeline can turn them into counters/histograms without PII.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("jobpilot.people.metrics")

METRICS = frozenset(
    {
        "people_discovery_requests_total",
        "people_discovery_cache_hits_total",
        "people_discovery_provider_errors_total",
        "people_discovery_duration_ms",
        "people_discovery_candidates_found",
        "people_discovery_candidates_displayed",
        "people_enrichment_requests_total",
        "people_email_find_requests_total",
        "people_email_verified_total",
        "people_email_not_found_total",
        "people_provider_credits_used",
        "people_recommendation_feedback_total",
        "people_recommendation_reported_incorrect_total",
        # People-search orchestration health. These are what tell an operator
        # whether a failure was one company's problem or the provider's.
        "people_search_requests_total",
        "people_provider_requests_total",
        "people_provider_latency",
        "people_cache_hits_total",
        "people_cache_stale_served_total",
        "people_request_coalesced_total",
        "people_domain_resolution_total",
        "people_circuit_state_transitions_total",
        "people_budget_rejections_total",
        "people_results_total",
        "people_company_resolution_total",
        "people_search_strategy_total",
        "people_no_match_total",
        "people_legacy_cache_invalidations_total",
        "people_outreach_draft_requests_total",
        "people_outreach_draft_success_total",
        "people_outreach_draft_failures_total",
        "people_outreach_draft_cache_hits_total",
        "people_outreach_grounding_rejections_total",
        "people_channel_handoff_total",
        "people_user_discoveries_total",
        "people_user_quota_charged_total",
        "people_user_quota_refunded_total",
        "people_user_quota_rejections_total",
        "people_provider_calls_total",
        "people_discovery_provider_calls_per_user_action",
        "people_discovery_cache_hit_total",
        "people_discovery_coalesced_waiter_total",
        "people_quota_remaining",
        # Provider waterfall. These are what tell an operator that a fallback
        # carried a discovery, and which provider actually answered.
        "people_provider_attempts_total",
        "people_provider_fallbacks_total",
        "people_provider_success_total",
        "people_provider_no_match_total",
        "people_provider_budget_exhausted_total",
        "people_candidates_by_provider_total",
        "people_candidates_deduplicated_total",
        "people_discovery_coverage",
        "people_openai_web_candidates_rejected_total",
        # Bright Data. Records, not requests, are the unit of cost.
        "people_brightdata_records_returned",
        # The actionable-contact gate. These are the numbers that answer
        # "why does this company show one contact instead of six?".
        "people_contacts_evaluated_total",
        "people_contacts_accepted_total",
        "people_contacts_rejected_total",
        "people_masked_name_rejected_total",
        "people_missing_linkedin_rejected_total",
        "people_ambiguous_identity_rejected_total",
        "people_legacy_record_suppressed_total",
    }
)
_DIMENSIONS = frozenset(
    {
        "provider",
        "category",
        "status",
        "scoring_version",
        "source",
        "result",
        "circuit",
        "error_code",
        "channel",
        "stage",
        "generation_path",
        # Waterfall dimensions. All low-cardinality and free of personal data:
        # a provider name, an outcome, a reason code, and coverage counts.
        "outcome",
        "reason",
        "recruiters",
        "managers",
        "referrers",
        # Where in the pipeline a decision was taken. Low-cardinality by
        # construction: a fixed set of stage names, never a company or a person.
        "policy_version",
    }
)


def metric(name: str, value: int | float = 1, **dimensions: str) -> None:
    if name not in METRICS:
        raise ValueError("Unknown people metric")
    safe = {
        key: str(value)[:64]
        for key, value in dimensions.items()
        if key in _DIMENSIONS and value
    }
    labels = " ".join(f"{key}={safe[key]}" for key in sorted(safe))
    logger.info("metric=%s value=%s %s", name, value, labels)
