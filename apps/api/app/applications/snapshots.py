"""Ownership-safe, read-only domain boundaries for application snapshots.

Snapshot construction is intentionally deferred to Stage 2B so Stage 2A cannot
create incomplete historical records.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import ApplicationSnapshot


def get_owned_snapshot(db: Session, *, user_id: int, snapshot_id: int) -> ApplicationSnapshot | None:
    return db.scalar(
        select(ApplicationSnapshot).where(
            (ApplicationSnapshot.id == snapshot_id) & (ApplicationSnapshot.user_id == user_id)
        )
    )


def list_owned_snapshots(db: Session, *, user_id: int, tracker_id: int) -> list[ApplicationSnapshot]:
    return list(
        db.scalars(
            select(ApplicationSnapshot)
            .where(
                (ApplicationSnapshot.user_id == user_id) & (ApplicationSnapshot.application_tracker_id == tracker_id)
            )
            .order_by(ApplicationSnapshot.attempt_number.asc())
        ).all()
    )
