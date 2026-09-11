"""Bounded, database-authoritative cleanup for expired Tracker retention."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.applications.tracker_lifecycle import DELETION_ELIGIBLE_STATUSES
from app.models.entities import ApplicationTracker

logger = logging.getLogger("jobpilot.worker")

DEFAULT_RETENTION_CLEANUP_BATCH_SIZE = 100


@dataclass(frozen=True)
class RetentionCleanupResult:
    selected: int = 0
    deleted: int = 0
    skipped: int = 0
    failed: int = 0

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def cleanup_due_application_trackers(
    db: Session,
    *,
    now: datetime | None = None,
    batch_size: int = DEFAULT_RETENTION_CLEANUP_BATCH_SIZE,
) -> RetentionCleanupResult:
    """Delete one bounded batch of due terminal Tracker rows.

    PostgreSQL locks the selected rows and skips rows owned by another worker.
    Eligibility is repeated immediately before each delete so a cancellation or
    status change that committed before this transaction won cannot be deleted.
    Tracker-owned snapshots cascade in the database; sessions are retained with
    a NULL tracker reference, and documents/jobs are untouched.
    """
    if batch_size < 1:
        raise ValueError("batch_size must be positive")

    cutoff = _aware(now) or datetime.now(UTC)
    query = (
        select(ApplicationTracker)
        .where(
            ApplicationTracker.status.in_(DELETION_ELIGIBLE_STATUSES),
            ApplicationTracker.deletion_scheduled_at.is_not(None),
            ApplicationTracker.deletion_scheduled_at <= cutoff,
            ApplicationTracker.deletion_cancelled_at.is_(None),
        )
        .order_by(ApplicationTracker.deletion_scheduled_at, ApplicationTracker.id)
        .limit(batch_size)
        .with_for_update(skip_locked=True)
    )
    candidates = list(db.scalars(query))
    deleted = skipped = failed = 0

    for tracker in candidates:
        if not _eligible(tracker, cutoff):
            skipped += 1
            continue
        try:
            with db.begin_nested():
                db.delete(tracker)
                db.flush()
            deleted += 1
        except Exception:  # noqa: BLE001 - isolate a malformed row from the batch
            failed += 1
            logger.exception("retention cleanup failed", extra={"tracker_id": tracker.id})

    db.commit()
    result = RetentionCleanupResult(
        selected=len(candidates), deleted=deleted, skipped=skipped, failed=failed
    )
    logger.info("retention cleanup completed", extra=result.as_dict())
    return result


def _eligible(tracker: ApplicationTracker, cutoff: datetime) -> bool:
    deadline = _aware(tracker.deletion_scheduled_at)
    return (
        tracker.status in DELETION_ELIGIBLE_STATUSES
        and deadline is not None
        and deadline <= cutoff
        and tracker.deletion_cancelled_at is None
    )


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
