"""The one authoritative way an application becomes ``applied``.

Every path that can legitimately claim "this was submitted" — the browser
extension observing an ATS success page, the assisted auto-apply orchestrator
reporting a confirmed submission, and the user explicitly saying so — funnels
through :func:`mark_application_applied`. Nothing else in the codebase may set
``ApplicationTracker.status = applied``.

Why one function
----------------
"Applied" drives two irreversible-feeling user outcomes: the job leaves the Jobs
page and it appears in the Tracker. Deciding that in three places produces three
subtly different rules, and the failure mode is silent — a job the user never
applied to disappears from discovery forever. So the transition rules live here,
once, next to the tests that pin them.

What is NOT evidence of a submission
------------------------------------
None of the following may reach this function. They are all states that occur
constantly on applications the user abandons half-way:

* opening the application URL (this records ``opened_at`` — see
  :func:`record_application_opened` — and nothing else);
* switching tabs, or closing the application page;
* the extension activating, or filling some fields;
* uploading a resume;
* clicking the ATS submit button *before* the ATS confirms success.

Callers are responsible for establishing the evidence; this module is
responsible for applying it exactly once, atomically.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.applications.observability import metric
from app.models.entities import (
    ApplicationStatus,
    ApplicationTracker,
    AuditLog,
    JobPosting,
)

logger = logging.getLogger("jobpilot.applications")


class AppliedSource(StrEnum):
    """Who established that the application was actually submitted.

    Ordered from strongest to weakest evidence. Recorded on the application
    record so a support question ("why is this in my Tracker?") has a truthful
    answer, and so an audit can tell a machine-confirmed submission from a
    user's own assertion."""

    #: The extension observed a deterministic ATS success signal.
    extension_confirmed = "extension_confirmed"
    #: An internal auto-apply run returned a confirmed submitted state.
    auto_apply_confirmed = "auto_apply_confirmed"
    #: The user explicitly answered "yes, I submitted this".
    user_confirmed = "user_confirmed"


#: Statuses that mean the user has submitted this application, or has otherwise
#: finished dealing with this job. Jobs discovery excludes these for that user.
SUBMITTED_LIFECYCLE_STATUSES: frozenset[ApplicationStatus] = frozenset(
    {
        ApplicationStatus.applied,
        ApplicationStatus.interview,
        ApplicationStatus.offer,
        ApplicationStatus.rejected,
        ApplicationStatus.withdrawn,
    }
)

#: Everything hidden from the Jobs discovery page for the owning user.
#:
#: ``applying`` is included on top of the submitted set because an assisted
#: apply run that is mid-flight already has its own surface (the Tracker and the
#: extension side panel); showing the same job as an undiscovered opportunity at
#: the same time is what the existing product decided against, and this
#: preserves that. It is NOT treated as submitted anywhere else — an ``applying``
#: record has no ``applied_at`` and never appears under Tracker → Applied.
#:
#: Deliberately absent, so they stay actionable in discovery:
#:   ``saved``          — the user bookmarked it; still an open opportunity.
#:   ``ready_to_apply`` — documents are prepared but nothing was submitted.
#: A *failed* apply run is also absent by construction: failure is recorded on
#: ``ApplicationSession.status``, never on the application record, so the job
#: stays in discovery and remains retryable.
DISCOVERY_HIDDEN_STATUSES: frozenset[ApplicationStatus] = SUBMITTED_LIFECYCLE_STATUSES | {
    ApplicationStatus.applying
}

#: Statuses a confirmation is allowed to promote to ``applied``. A record that is
#: already further along (``interview``/``offer``/``rejected``) is NOT dragged
#: back to ``applied`` by a late duplicate event.
PROMOTABLE_TO_APPLIED: frozenset[ApplicationStatus] = frozenset(
    {
        ApplicationStatus.saved,
        ApplicationStatus.ready_to_apply,
        ApplicationStatus.applying,
        ApplicationStatus.withdrawn,
    }
)


class ApplicationJobNotFound(LookupError):
    """The job does not exist (or is not reachable by this user)."""


@dataclass(frozen=True)
class MarkAppliedResult:
    """Outcome of a confirmation, including whether it actually changed anything."""

    tracker: ApplicationTracker
    #: True when this call created the application record.
    created: bool
    #: True when the record was already in a submitted state before this call —
    #: i.e. this was a duplicate/retried confirmation.
    already_applied: bool
    previous_status: ApplicationStatus | None
    status: ApplicationStatus


def record_application_opened(
    db: Session,
    *,
    user_id: int,
    job_id: int,
    application_url: str | None = None,
    when: datetime | None = None,
) -> ApplicationTracker | None:
    """Record that the user OPENED an employer application.

    Explicitly not a submission. It stamps ``opened_at`` and
    ``last_application_url`` and leaves ``status`` and ``applied_at`` untouched,
    so "I clicked Apply" can be observed in the audit trail without ever being
    mistaken for "I applied".

    Returns ``None`` when there is no application record yet and none should be
    invented — opening an application is not, by itself, a reason to put a job
    in the user's ledger.
    """
    tracker = _load_tracker(db, user_id=user_id, job_id=job_id)
    if tracker is None:
        return None
    tracker.opened_at = _aware(when) or datetime.now(UTC)
    if application_url:
        tracker.last_application_url = application_url[:2000]
    return tracker


def mark_application_applied(
    db: Session,
    *,
    user_id: int,
    job_id: int,
    source: AppliedSource,
    submitted_at: datetime | None = None,
    submission_reference: str | None = None,
    application_url: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> MarkAppliedResult:
    """Create or update the user's application record for ``job_id`` as applied.

    Atomic and idempotent. The caller owns the surrounding transaction and must
    ``commit`` — that lets a route bundle this with its own writes (for example
    closing the apply session) so a partial success is impossible.

    Idempotency is enforced by the database, not by a read: two concurrent
    confirmations both miss on the initial SELECT, both INSERT, and exactly one
    wins ``uq_tracker_user_job``. The loser catches the ``IntegrityError``,
    re-reads the winner's row inside the same outer transaction, and updates it.
    That is why the INSERT runs in a SAVEPOINT — rolling back a failed INSERT
    must not discard the caller's other work.

    ``applied_at`` records the FIRST confirmed submission and is not moved by a
    later duplicate event, because it is the date the user shows an employer.
    It is refreshed only when the record was not in a submitted state
    beforehand, which means this genuinely is a new submission (a re-application
    after ``withdrawn``).
    """
    metric("application_mark_applied_requested", source=source.value)

    job = db.get(JobPosting, job_id)
    if job is None:
        metric("application_mark_applied_failed", source=source.value, reason="job_not_found")
        raise ApplicationJobNotFound(f"Job {job_id} not found")

    now = datetime.now(UTC)
    submitted = _aware(submitted_at) or now
    # A clock-skewed client must not be able to backdate or post-date a
    # submission beyond the present; the server's clock bounds it.
    if submitted > now:
        submitted = now

    tracker = _load_tracker(db, user_id=user_id, job_id=job_id)
    created = False
    if tracker is None:
        tracker, created = _insert_or_reload(db, user_id=user_id, job_id=job_id)

    previous_status = tracker.status if not created else None
    already_applied = previous_status in SUBMITTED_LIFECYCLE_STATUSES if previous_status else False

    # Never drag a record backwards. A duplicate extension retry arriving after
    # the user has already recorded an interview must not reset them to applied.
    if previous_status is None or previous_status in PROMOTABLE_TO_APPLIED:
        tracker.status = ApplicationStatus.applied

    if tracker.applied_at is None or not already_applied:
        tracker.applied_at = submitted
    # else: keep the original submission date.

    # Provenance describes the confirmation that first made this an application.
    # A duplicate event does not rewrite it — the first confirmation is the one
    # that actually happened.
    if not already_applied:
        tracker.applied_source = source.value
        if submission_reference:
            tracker.submission_reference = submission_reference[:200]
    elif submission_reference and not tracker.submission_reference:
        # Fill a genuinely missing receipt without overwriting an existing one.
        tracker.submission_reference = submission_reference[:200]

    if application_url:
        tracker.last_application_url = application_url[:2000]

    # Everything below is deliberately NOT touched, so a confirmation can never
    # destroy work the user or the apply pipeline already did:
    #   notes, follow_up_date, opened_at, created_at
    # The tailored resume and cover letter are separate records keyed by
    # (user_id, job_id) — GeneratedDocument and ApplicationSession — so they are
    # preserved by never being written here at all.

    db.flush()

    _write_audit(
        db,
        user_id=user_id,
        job_id=job_id,
        source=source,
        previous_status=previous_status,
        new_status=tracker.status,
        submitted_at=tracker.applied_at,
        created=created,
        already_applied=already_applied,
        metadata=metadata,
    )

    if already_applied:
        metric("application_mark_applied_duplicate", source=source.value)
    else:
        metric("application_mark_applied_completed", source=source.value)
        metric(
            "application_transition_total",
            from_status=(previous_status.value if previous_status else "none"),
            to_status=tracker.status.value,
            source=source.value,
        )

    logger.info(
        "application.mark_applied user=%s job=%s source=%s created=%s duplicate=%s from=%s to=%s",
        user_id,
        job_id,
        source.value,
        created,
        already_applied,
        previous_status.value if previous_status else "none",
        tracker.status.value,
    )

    return MarkAppliedResult(
        tracker=tracker,
        created=created,
        already_applied=already_applied,
        previous_status=previous_status,
        status=tracker.status,
    )


def serialize_application(tracker: ApplicationTracker) -> dict[str, Any]:
    """The normalized application/tracker representation returned by every
    confirmation path, so the web app has one shape to reconcile against."""
    return {
        "id": tracker.id,
        "job_id": tracker.job_id,
        "status": tracker.status.value,
        "applied_at": tracker.applied_at,
        "applied_source": tracker.applied_source,
        "submission_reference": tracker.submission_reference,
        "opened_at": tracker.opened_at,
        "application_url": tracker.last_application_url,
        "notes": tracker.notes,
        "follow_up_date": tracker.follow_up_date,
        "created_at": tracker.created_at,
        "updated_at": tracker.updated_at,
    }


# --------------------------------------------------------------------------- #
# Internals
# --------------------------------------------------------------------------- #
def _load_tracker(db: Session, *, user_id: int, job_id: int) -> ApplicationTracker | None:
    return db.scalar(
        select(ApplicationTracker).where(
            (ApplicationTracker.user_id == user_id) & (ApplicationTracker.job_id == job_id)
        )
    )


def _insert_or_reload(
    db: Session, *, user_id: int, job_id: int
) -> tuple[ApplicationTracker, bool]:
    """Insert the application record, tolerating a concurrent winner.

    Returns ``(tracker, created)``. ``created`` is False when another
    transaction inserted the row between our SELECT and our INSERT — the caller
    then updates the existing row, which is exactly the desired outcome for two
    simultaneous confirmations.
    """
    savepoint = db.begin_nested()
    tracker = ApplicationTracker(
        user_id=user_id,
        job_id=job_id,
        status=ApplicationStatus.applied,
    )
    db.add(tracker)
    try:
        savepoint.commit()
    except IntegrityError:
        # uq_tracker_user_job: someone else got there first. Undo only our
        # INSERT (the SAVEPOINT), never the caller's outer transaction.
        savepoint.rollback()
        db.expunge(tracker)
        existing = _load_tracker(db, user_id=user_id, job_id=job_id)
        if existing is None:
            # The constraint fired but the row is not visible — the database is
            # in a state we cannot reason about, so fail loudly rather than
            # silently creating a duplicate application.
            metric("application_mark_applied_failed", reason="insert_conflict_unresolved")
            raise
        return existing, False
    return tracker, True


def _write_audit(
    db: Session,
    *,
    user_id: int,
    job_id: int,
    source: AppliedSource,
    previous_status: ApplicationStatus | None,
    new_status: ApplicationStatus,
    submitted_at: datetime | None,
    created: bool,
    already_applied: bool,
    metadata: dict[str, Any] | None,
) -> None:
    """Append the transition to the user-scoped audit trail.

    Carries the canonical job id (internal, and this table is already
    user-scoped and access-controlled), the source, the timestamp, and the
    before/after status. Never resume or cover-letter contents, and never the
    free-text notes the user wrote."""
    payload: dict[str, Any] = {
        "job_id": job_id,
        "source": source.value,
        "previous_status": previous_status.value if previous_status else None,
        "new_status": new_status.value,
        "applied_at": submitted_at.isoformat() if submitted_at else None,
        "created": created,
        "duplicate": already_applied,
    }
    if metadata:
        # Only known-safe, low-risk keys from the confirmation event.
        for key in ("ats", "evidence_type", "submission_reference"):
            if metadata.get(key):
                payload[key] = str(metadata[key])[:200]
    db.add(AuditLog(user_id=user_id, action="application.marked_applied", metadata_json=payload))


def _aware(value: datetime | None) -> datetime | None:
    """Treat a naive timestamp as UTC. SQLite round-trips drop tzinfo, so a
    value read back from the database would otherwise be uncomparable with
    ``datetime.now(UTC)``."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
