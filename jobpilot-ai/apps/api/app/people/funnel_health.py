"""Is the discovery funnel converting candidates into contacts, or silently eating them?

This module exists because of a specific failure. The PDL adapter dropped every
candidate's profile URL, the actionable gate rejected 100% of them as
``missing_linkedin_url``, and the product reported "no verified professional
profiles were found for this company yet." The counters that would have shown
this — ``people_contacts_evaluated_total``, ``people_contacts_accepted_total``,
``people_missing_linkedin_rejected_total`` — **already existed and were already
being emitted**. Nothing computed a ratio from them, and nothing alerted.

Raw counters do not catch this class of defect. A *ratio* does: a provider that
returns records while the funnel accepts none of them is an integration failure,
and it looks nothing like a company that genuinely has no matching employees.

Two ratios, derived here so they are unit-testable rather than living only in a
dashboard query:

``acceptance_ratio``          accepted / normalized
``missing_profile_url_ratio`` missing-URL rejections / normalized

Both are meaningless on small samples — one search of a five-person company can
legitimately accept nobody — so every verdict is gated on a minimum volume.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.people.observability import metric

__all__ = [
    "FUNNEL_HEALTH_VERSION",
    "FunnelCounts",
    "FunnelVerdict",
    "PROFILE_URL_REJECTION_REASONS",
    "evaluate_funnel_health",
    "emit_funnel_health",
]

FUNNEL_HEALTH_VERSION = "people-funnel-health-v1"

Severity = Literal["ok", "insufficient_data", "warning", "critical"]

# The rejection reasons that mean "we could not produce a usable profile link",
# which is the signature of an adapter/normalization defect rather than a
# judgement about the person.
PROFILE_URL_REJECTION_REASONS = frozenset(
    {"missing_linkedin_url", "invalid_linkedin_url"}
)

# Minimum normalized candidates before a ratio is allowed to mean anything.
# Below this a verdict is "insufficient_data", never "ok" — an absence of
# evidence must not read as evidence of health.
_WARNING_MIN_VOLUME = 20
_CRITICAL_MIN_VOLUME = 50

# Tuned to catch a total-loss integration defect, not ordinary strictness. The
# actionable gate legitimately rejects most candidates on many searches, so
# these sit far below normal operating range and must be re-tuned once beta
# traffic has been observed.
_WARNING_ACCEPTANCE_RATIO = 0.10
_CRITICAL_ACCEPTANCE_RATIO = 0.02
# A profile-URL rejection rate this high is an adapter contract mismatch. It is
# the exact shape of the incident this module was written for.
_PROFILE_URL_CRITICAL_RATIO = 0.90


@dataclass(frozen=True)
class FunnelCounts:
    """One provider's funnel over an evaluation window.

    A "window" is whatever the caller aggregates — a single discovery, or a
    time slice replayed from logs. The arithmetic is identical either way.
    """

    provider: str
    raw: int = 0
    normalized: int = 0
    accepted: int = 0
    rejections_by_reason: dict[str, int] = field(default_factory=dict)

    @property
    def acceptance_ratio(self) -> float | None:
        """``None`` when there is nothing to divide — never a misleading 0.0."""

        if self.normalized <= 0:
            return None
        return self.accepted / self.normalized

    @property
    def missing_profile_url_ratio(self) -> float | None:
        if self.normalized <= 0:
            return None
        missing = sum(
            count
            for reason, count in self.rejections_by_reason.items()
            if reason in PROFILE_URL_REJECTION_REASONS
        )
        return missing / self.normalized

    @property
    def normalization_loss_ratio(self) -> float | None:
        """Records the provider returned that the adapter could not normalize.

        A separate failure from the acceptance gate: this one means the adapter
        could not even build a candidate, which is a pure contract mismatch.
        """

        if self.raw <= 0:
            return None
        return max(0, self.raw - self.normalized) / self.raw


@dataclass(frozen=True)
class FunnelVerdict:
    severity: Severity
    reason: str
    acceptance_ratio: float | None = None
    missing_profile_url_ratio: float | None = None


def evaluate_funnel_health(counts: FunnelCounts) -> FunnelVerdict:
    """Classify one provider's funnel. Pure, so the thresholds are testable."""

    acceptance = counts.acceptance_ratio
    missing_url = counts.missing_profile_url_ratio

    if counts.normalized < _WARNING_MIN_VOLUME:
        # Explicitly not "ok". A quiet period must not look like a healthy one.
        return FunnelVerdict(
            severity="insufficient_data",
            reason="below_minimum_volume",
            acceptance_ratio=acceptance,
            missing_profile_url_ratio=missing_url,
        )

    # Checked before the generic acceptance ratio because it names the cause
    # precisely, and an operator paged at 3am should be told "the adapter is
    # dropping profile URLs", not "acceptance is low".
    if (
        missing_url is not None
        and missing_url >= _PROFILE_URL_CRITICAL_RATIO
        and counts.normalized >= _CRITICAL_MIN_VOLUME
    ):
        return FunnelVerdict(
            severity="critical",
            reason="profile_url_rejection_dominant",
            acceptance_ratio=acceptance,
            missing_profile_url_ratio=missing_url,
        )

    if acceptance is not None:
        if (
            acceptance < _CRITICAL_ACCEPTANCE_RATIO
            and counts.normalized >= _CRITICAL_MIN_VOLUME
        ):
            return FunnelVerdict(
                severity="critical",
                reason="acceptance_ratio_collapsed",
                acceptance_ratio=acceptance,
                missing_profile_url_ratio=missing_url,
            )
        if acceptance < _WARNING_ACCEPTANCE_RATIO:
            return FunnelVerdict(
                severity="warning",
                reason="acceptance_ratio_low",
                acceptance_ratio=acceptance,
                missing_profile_url_ratio=missing_url,
            )

    return FunnelVerdict(
        severity="ok",
        reason="within_expected_range",
        acceptance_ratio=acceptance,
        missing_profile_url_ratio=missing_url,
    )


def emit_funnel_health(counts: FunnelCounts) -> FunnelVerdict:
    """Evaluate and publish the ratios as structured metrics.

    Emitted as integer basis points because the metric transport carries a
    single numeric value and the log pipeline aggregates integers cleanly.
    """

    verdict = evaluate_funnel_health(counts)
    if verdict.acceptance_ratio is not None:
        metric(
            "people_funnel_acceptance_ratio_bp",
            int(round(verdict.acceptance_ratio * 10_000)),
            provider=counts.provider,
        )
    if verdict.missing_profile_url_ratio is not None:
        metric(
            "people_funnel_profile_url_rejection_ratio_bp",
            int(round(verdict.missing_profile_url_ratio * 10_000)),
            provider=counts.provider,
        )
    metric(
        "people_funnel_health_total",
        1,
        provider=counts.provider,
        status=verdict.severity,
        reason=verdict.reason,
    )
    return verdict
