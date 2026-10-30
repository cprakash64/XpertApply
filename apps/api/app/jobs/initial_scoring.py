"""Bounded, incremental, eligible-only fit scoring for one user (finding F2).

Why: a new user's jobs stayed unscored ("Calculating fit…") until they pressed Refresh matches, because the only
automatic trigger was a Celery task that needs a running worker (staging does not start one) and ``GET /jobs`` only
reads. The manual path cannot simply be called automatically: it blocks the API for about 10 s and peaks at about 450
MiB on a 4,500-job catalogue (docs/plans/initial-job-scoring.md). The scoring maths itself is cheap (about 1.5 ms per
job pair), so this module scores only what the user can see, a bounded batch at a time.

* **Progress** is computed from the same candidate set the list shows (eligible, fresh, not already in the tracker)
  and is read-only (:func:`progress_of`).
* **Advance** scores the next batch of pending pairs for ONE user (:func:`advance`), newest postings first, capped by
  a job count and a time budget, through the existing idempotent :func:`score_pair`. A correct score is never
  recomputed.
* **Concurrency:** one advance per user at a time and a small process-wide cap; anything else gets ``busy`` and does
  no work, so duplicate events, several tabs or many new users cannot start uncontrolled or duplicate scoring.
* **Failure:** a pair that fails is retried up to :data:`MAX_ATTEMPTS` times, then reported as ``failed`` (a
  recoverable state the user can retry) instead of leaving the page in "Calculating" forever.
* No model or provider is called: scoring is deterministic. """

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.jobs.job_matching_service import ProfileView
from app.jobs.job_search_criteria_service import SearchCriteria
from app.jobs.scoring_service import SCORE_VERSION, score_pair
from app.models.entities import JobMatch, JobPosting, ScoreState

logger = logging.getLogger("jobpilot.scoring")

#: A pair that has failed this many times stops being retried automatically (a user retry resets the allowance).
MAX_ATTEMPTS = 3
#: Rows committed per chunk inside one advance: bounds memory (full job rows are loaded per chunk only) and lock time.
CHUNK_SIZE = 50

ScoringState = Literal["complete", "scoring", "failed", "profile_incomplete"]


@dataclass(frozen=True)
class MatchInfo:
    """The few ``JobMatch`` columns that decide whether a pair needs scoring (never the explanation text)."""

    state: str | None
    score_version: int | None
    profile_version: str | None
    attempts: int
    fit_score: float | None = None


def classify(
    info: MatchInfo | None, profile_hash: str, *, retry_failed: bool = False
) -> Literal["current", "pending", "failed"]:
    """``current`` is up to date, ``pending`` needs scoring now, ``failed`` has used its automatic attempts."""
    if info is None:
        return "pending"
    if info.state == ScoreState.failed.value:
        return "pending" if retry_failed or info.attempts < MAX_ATTEMPTS else "failed"
    if info.state != ScoreState.scored.value:
        return "pending"  # no score yet: pending, scoring (a crashed worker left it), profile_incomplete placeholder
    if info.score_version != SCORE_VERSION or info.profile_version != profile_hash:
        return "pending"  # scored for an older profile or algorithm: refreshed, not trusted
    return "current"


def progress_of(
    *,
    scorable: bool,
    total: int,
    pending: int,
    failed: int,
) -> dict[str, Any]:
    """The ``scoring`` block returned with a list and after an advance."""
    if not scorable:
        state: ScoringState = "profile_incomplete"
    elif pending > 0:
        state = "scoring"
    elif failed > 0:
        state = "failed"
    else:
        state = "complete"
    return {
        "state": state,
        "total": total,
        "scored": max(0, total - pending - failed),
        "pending": pending if scorable else 0,
        "failed": failed if scorable else 0,
    }


# --------------------------------------------------------------------------- #
# Concurrency: one advance per user, a small cap for the whole process
# --------------------------------------------------------------------------- #
_GUARD = threading.Lock()
_ACTIVE_USERS: set[int] = set()
_SLOTS: threading.BoundedSemaphore | None = None
_SLOTS_SIZE = 0


def reset_for_tests() -> None:
    global _SLOTS, _SLOTS_SIZE
    with _GUARD:
        _ACTIVE_USERS.clear()
        _SLOTS = None
        _SLOTS_SIZE = 0


@contextmanager
def advance_slot(user_id: int):
    """Yields True when this caller may score for ``user_id`` now, False when another advance holds the user or the
    process is at its cap. Never blocks."""
    global _SLOTS, _SLOTS_SIZE
    with _GUARD:
        size = max(1, settings.scoring_advance_max_concurrent)
        if _SLOTS is None or _SLOTS_SIZE != size:
            _SLOTS, _SLOTS_SIZE = threading.BoundedSemaphore(size), size
        slots = _SLOTS
        if user_id in _ACTIVE_USERS:
            granted = False
        elif not slots.acquire(blocking=False):
            granted = False
        else:
            _ACTIVE_USERS.add(user_id)
            granted = True
    try:
        yield granted
    finally:
        if granted:
            with _GUARD:
                _ACTIVE_USERS.discard(user_id)
            slots.release()


# --------------------------------------------------------------------------- #
# Advance
# --------------------------------------------------------------------------- #
@dataclass
class AdvanceResult:
    scored: int = 0
    failed: int = 0
    attempted: int = 0
    busy: bool = False


def advance(
    db: Session,
    user_id: int,
    *,
    candidates: Iterable[tuple[int, Any]],
    infos: dict[int, MatchInfo],
    profile_view: ProfileView,
    criteria: SearchCriteria,
    profile_hash: str,
    retry_failed: bool = False,
    batch_size: int | None = None,
    time_budget: float | None = None,
) -> AdvanceResult:
    """Score the next bounded batch of this user's pending pairs.

    ``candidates`` are ``(job_id, posted_at)`` pairs of the jobs the list would show (eligible, fresh); ``infos`` maps
    job id to its current :class:`MatchInfo`. Returns what happened; the caller recomputes progress."""
    result = AdvanceResult()
    limit = batch_size if batch_size is not None else settings.scoring_advance_batch_size
    budget = time_budget if time_budget is not None else settings.scoring_advance_time_budget_seconds
    pending = [
        (job_id, posted_at)
        for job_id, posted_at in candidates
        if classify(infos.get(job_id), profile_hash, retry_failed=retry_failed) == "pending"
    ]
    # Newest postings first (undated last), so what is seen first is scored first; the job id makes the order total.
    pending.sort(key=lambda item: (item[1] is None, -item[1].timestamp() if item[1] is not None else 0, item[0]))
    todo = [job_id for job_id, _ in pending[:limit]]
    started = time.monotonic()
    for start in range(0, len(todo), CHUNK_SIZE):
        # Always make some progress per call (the first chunk), then stop once the time budget is spent.
        if start > 0 and time.monotonic() - started > budget:
            break
        chunk = todo[start : start + CHUNK_SIZE]
        try:
            jobs = {job.id: job for job in db.scalars(select(JobPosting).where(JobPosting.id.in_(chunk)))}
            for job_id in chunk:
                job = jobs.get(job_id)
                if job is None:
                    continue  # removed since the scan
                # Classified pending above, so score it unconditionally (idempotent; the version guard still holds).
                outcome = score_pair(db, user_id, job, profile_view, profile_hash, criteria, force=True)
                result.attempted += 1
                if outcome.state == ScoreState.scored:
                    result.scored += 1
                elif outcome.state == ScoreState.failed:
                    result.failed += 1
            db.commit()
        except IntegrityError:
            # Another process created the same (user, job) row first: harmless, it will be counted as scored next time.
            db.rollback()
            result.busy = True
            break
    if result.attempted:
        logger.info(
            "initial_scoring batch attempted=%s scored=%s failed=%s ms=%s",
            result.attempted,
            result.scored,
            result.failed,
            round((time.monotonic() - started) * 1000),
        )
    return result


def match_infos(db: Session, user_id: int, job_ids: Iterable[int] | None = None) -> dict[int, MatchInfo]:
    """The decision columns of the user's match rows (optionally only for some jobs)."""
    stmt = select(
        JobMatch.job_id,
        JobMatch.score_state,
        JobMatch.score_version,
        JobMatch.profile_version,
        JobMatch.scoring_attempts,
        JobMatch.fit_score,
    ).where(JobMatch.user_id == user_id)
    if job_ids is not None:
        stmt = stmt.where(JobMatch.job_id.in_(list(job_ids)))
    return {
        job_id: MatchInfo(state, version, profile_version, attempts or 0, fit_score)
        for job_id, state, version, profile_version, attempts, fit_score in db.execute(stmt)
    }
