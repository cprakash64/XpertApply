"""Submission-confirmation lifecycle rules independent of HTTP routes."""

from __future__ import annotations

from datetime import UTC, datetime

from app.models.entities import ApplicationTracker


def require_submission_confirmation(
    tracker: ApplicationTracker, *, now: datetime | None = None
) -> ApplicationTracker:
    """Persist a new ambiguous-completion prompt without implying submission."""
    tracker.confirmation_required_at = _aware(now) or datetime.now(UTC)
    tracker.confirmation_prompt_dismissed_at = None
    return tracker


def dismiss_submission_confirmation(
    tracker: ApplicationTracker, *, now: datetime | None = None
) -> ApplicationTracker:
    """Record dismissal while retaining when confirmation was required."""
    if tracker.confirmation_required_at is not None:
        tracker.confirmation_prompt_dismissed_at = _aware(now) or datetime.now(UTC)
    return tracker


def clear_submission_confirmation(tracker: ApplicationTracker) -> None:
    """Clear a pending prompt only after submission is actually confirmed."""
    tracker.confirmation_required_at = None


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
