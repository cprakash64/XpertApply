"""Safe structured metric events for the application lifecycle.

Same log-based shape as ``app.people.observability``: one ``metric=`` line per
event, with an allow-list for both names and dimensions so a caller cannot
accidentally emit an unbounded label.

Nothing identifying is ever a metric label. User id, job title, company,
application URL, email, and document contents are all excluded by construction —
``_DIMENSIONS`` simply has no key for them, so passing one is dropped rather
than trusted. The internal canonical job id and user id belong in the audit
trail (``AuditLog``), which is access-controlled; a metrics backend is not.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("jobpilot.applications.metrics")

METRICS = frozenset(
    {
        "application_mark_applied_requested",
        "application_mark_applied_completed",
        "application_mark_applied_duplicate",
        "application_mark_applied_failed",
        "application_transition_total",
        "applied_job_filtered_from_discovery",
        "extension_submission_confirmation_total",
    }
)

_DIMENSIONS = frozenset(
    {
        # Which confirmation path asked for the transition. Fixed vocabulary:
        # see AppliedSource in app.applications.mark_applied.
        "source",
        # Status transition. Both come from the ApplicationStatus enum, so the
        # cardinality is bounded by the enum, not by traffic.
        "from_status",
        "to_status",
        # Applicant tracking system id (greenhouse/lever/ashby/workday/generic).
        "ats",
        # How the extension proved the submission succeeded — one of the
        # EvidenceType values.
        "evidence_type",
        # Machine outcome of the operation (confirmed/duplicate/rejected/...).
        "outcome",
        # Stable machine reason code for a failure. Never a raw exception
        # message, which could carry a URL or a database value.
        "reason",
    }
)


def metric(name: str, value: int | float = 1, **dimensions: str) -> None:
    if name not in METRICS:
        raise ValueError("Unknown application metric")
    safe = {
        key: str(dimension)[:64]
        for key, dimension in dimensions.items()
        if key in _DIMENSIONS and dimension
    }
    labels = " ".join(f"{key}={safe[key]}" for key in sorted(safe))
    logger.info("metric=%s value=%s %s", name, value, labels)
