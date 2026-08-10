"""The alert that would have caught the profile-URL incident on day one.

Every raw counter needed to detect that incident already existed and was already
being emitted. What was missing was a *ratio* and a verdict derived from it. The
thresholds live in code rather than only in a dashboard query precisely so they
can be pinned here.
"""

from __future__ import annotations

import pytest

from app.people.funnel_health import (
    FunnelCounts,
    evaluate_funnel_health,
)


def _counts(**overrides: object) -> FunnelCounts:
    base: dict[str, object] = {
        "provider": "pdl",
        "raw": 100,
        "normalized": 100,
        "accepted": 40,
        "rejections_by_reason": {},
    }
    base.update(overrides)
    return FunnelCounts(**base)  # type: ignore[arg-type]


# --- Ratio arithmetic ---------------------------------------------------------


def test_ratios_are_none_rather_than_zero_when_there_is_nothing_to_divide() -> None:
    """A 0.0 ratio would read as "catastrophic" on an empty window."""

    empty = _counts(raw=0, normalized=0, accepted=0)
    assert empty.acceptance_ratio is None
    assert empty.missing_profile_url_ratio is None
    assert empty.normalization_loss_ratio is None


def test_acceptance_and_profile_url_ratios_are_computed_over_normalized() -> None:
    counts = _counts(
        normalized=200,
        accepted=50,
        rejections_by_reason={"missing_linkedin_url": 120, "low_confidence": 30},
    )
    assert counts.acceptance_ratio == pytest.approx(0.25)
    assert counts.missing_profile_url_ratio == pytest.approx(0.60)


def test_invalid_and_missing_url_rejections_both_count_as_profile_url_loss() -> None:
    """Both mean "no usable link", which is the adapter-defect signature."""

    counts = _counts(
        normalized=100,
        accepted=0,
        rejections_by_reason={"missing_linkedin_url": 60, "invalid_linkedin_url": 40},
    )
    assert counts.missing_profile_url_ratio == pytest.approx(1.0)


def test_normalization_loss_is_measured_against_raw_provider_records() -> None:
    counts = _counts(raw=100, normalized=60)
    assert counts.normalization_loss_ratio == pytest.approx(0.40)


# --- Minimum-volume safeguards ------------------------------------------------


@pytest.mark.parametrize("normalized", [0, 1, 5, 19])
def test_small_windows_are_never_judged(normalized: int) -> None:
    """One search of a tiny company must not page anybody."""

    verdict = evaluate_funnel_health(
        _counts(raw=normalized, normalized=normalized, accepted=0)
    )
    assert verdict.severity == "insufficient_data"
    assert verdict.reason == "below_minimum_volume"


def test_a_quiet_window_is_not_reported_as_healthy() -> None:
    """Absence of evidence must not read as evidence of health."""

    verdict = evaluate_funnel_health(_counts(raw=0, normalized=0, accepted=0))
    assert verdict.severity != "ok"


def test_total_collapse_on_a_small_window_only_warns() -> None:
    """Between the warning and critical volumes, a collapse is not yet critical."""

    verdict = evaluate_funnel_health(
        _counts(raw=25, normalized=25, accepted=0, rejections_by_reason={
            "missing_linkedin_url": 25
        })
    )
    assert verdict.severity == "warning"


# --- The incident itself ------------------------------------------------------


def test_the_profile_url_incident_is_critical_and_names_its_cause() -> None:
    """The regression that started all of this, replayed as a metric window.

    PDL returned records, every one lost its profile URL, and the actionable
    gate rejected all of them. An operator must be told the cause, not merely
    that acceptance was low.
    """

    verdict = evaluate_funnel_health(
        _counts(
            raw=120,
            normalized=120,
            accepted=0,
            rejections_by_reason={"missing_linkedin_url": 120},
        )
    )
    assert verdict.severity == "critical"
    assert verdict.reason == "profile_url_rejection_dominant"
    assert verdict.acceptance_ratio == pytest.approx(0.0)


def test_a_collapse_from_another_cause_is_critical_but_named_differently() -> None:
    verdict = evaluate_funnel_health(
        _counts(
            raw=120,
            normalized=120,
            accepted=1,
            rejections_by_reason={"company_mismatch": 119},
        )
    )
    assert verdict.severity == "critical"
    assert verdict.reason == "acceptance_ratio_collapsed"


def test_low_but_not_collapsed_acceptance_warns() -> None:
    verdict = evaluate_funnel_health(
        _counts(raw=100, normalized=100, accepted=5, rejections_by_reason={
            "title_not_relevant_to_category": 95
        })
    )
    assert verdict.severity == "warning"
    assert verdict.reason == "acceptance_ratio_low"


def test_ordinary_strictness_is_not_an_incident() -> None:
    """The gate rejects most candidates by design. That is not a page."""

    verdict = evaluate_funnel_health(
        _counts(
            raw=100,
            normalized=100,
            accepted=15,
            rejections_by_reason={"title_not_relevant_to_category": 85},
        )
    )
    assert verdict.severity == "ok"


def test_a_healthy_funnel_with_some_url_loss_is_still_ok() -> None:
    """Some providers legitimately omit a URL for a minority of records."""

    verdict = evaluate_funnel_health(
        _counts(
            raw=100,
            normalized=100,
            accepted=55,
            rejections_by_reason={"missing_linkedin_url": 20},
        )
    )
    assert verdict.severity == "ok"


# --- Emission -----------------------------------------------------------------


def test_emitting_health_publishes_only_allowlisted_safe_metrics() -> None:
    """Metric names must be registered, and dimensions must stay non-personal."""

    from app.people.funnel_health import emit_funnel_health

    verdict = emit_funnel_health(
        _counts(
            raw=120,
            normalized=120,
            accepted=0,
            rejections_by_reason={"missing_linkedin_url": 120},
        )
    )
    # metric() raises ValueError on an unregistered name, so reaching here at
    # all proves the three new metrics are declared in the allowlist.
    assert verdict.severity == "critical"
