"""Application Tracker lifecycle rules independent of HTTP and cleanup jobs."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.models.entities import ApplicationStatus, ApplicationTracker

APPLICATION_RETENTION_GRACE_PERIOD = timedelta(days=7)
DELETION_ELIGIBLE_STATUSES = frozenset({ApplicationStatus.rejected, ApplicationStatus.withdrawn})


def update_application_status(
    tracker: ApplicationTracker,
    new_status: ApplicationStatus,
    *,
    now: datetime | None = None,
) -> ApplicationTracker:
    """Apply status and retention state together in the caller's transaction.

    Entering a terminal state starts one clock. Repeating or switching between
    terminal outcomes preserves that clock. An explicit Undo is represented by
    ``deletion_cancelled_at``; ordinary same-status saves cannot reschedule it.
    Leaving terminal state clears both scheduling and cancellation state.
    """
    changed_at = _aware(now) or datetime.now(UTC)
    previous = tracker.status
    was_terminal = previous in DELETION_ELIGIBLE_STATUSES
    is_terminal = new_status in DELETION_ELIGIBLE_STATUSES

    tracker.status = new_status
    if is_terminal and not was_terminal:
        tracker.deletion_scheduled_at = changed_at + APPLICATION_RETENTION_GRACE_PERIOD
        tracker.deletion_cancelled_at = None
    elif not is_terminal:
        tracker.deletion_scheduled_at = None
        tracker.deletion_cancelled_at = None
    return tracker


def schedule_application_deletion(tracker: ApplicationTracker, *, now: datetime | None = None) -> ApplicationTracker:
    """Intentionally reschedule retention for an already-terminal Tracker."""
    if tracker.status not in DELETION_ELIGIBLE_STATUSES:
        raise ValueError("Only rejected or withdrawn applications can be scheduled for deletion")
    changed_at = _aware(now) or datetime.now(UTC)
    tracker.deletion_scheduled_at = changed_at + APPLICATION_RETENTION_GRACE_PERIOD
    tracker.deletion_cancelled_at = None
    return tracker


def cancel_application_deletion(tracker: ApplicationTracker, *, now: datetime | None = None) -> ApplicationTracker:
    """Idempotently retain a terminal outcome without changing its status."""
    if tracker.status not in DELETION_ELIGIBLE_STATUSES:
        return tracker
    if tracker.deletion_scheduled_at is not None:
        tracker.deletion_scheduled_at = None
        tracker.deletion_cancelled_at = _aware(now) or datetime.now(UTC)
    return tracker


def require_submission_confirmation(tracker: ApplicationTracker, *, now: datetime | None = None) -> ApplicationTracker:
    """Persist a new ambiguous-completion prompt without implying submission."""
    tracker.confirmation_required_at = _aware(now) or datetime.now(UTC)
    tracker.confirmation_prompt_dismissed_at = None
    return tracker


def dismiss_submission_confirmation(tracker: ApplicationTracker, *, now: datetime | None = None) -> ApplicationTracker:
    """Record Not-yet/dismissal while retaining when confirmation was required."""
    if tracker.confirmation_required_at is not None:
        tracker.confirmation_prompt_dismissed_at = _aware(now) or datetime.now(UTC)
    return tracker


def clear_lifecycle_after_confirmation(tracker: ApplicationTracker) -> None:
    """Clear provisional state only when confirmation actually yields Applied."""
    tracker.confirmation_required_at = None
    if tracker.status == ApplicationStatus.applied:
        tracker.deletion_scheduled_at = None
        tracker.deletion_cancelled_at = None


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
