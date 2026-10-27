"""Caller-owned acceptance and canonical writer integration; no transport/fallback."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.jobs.scoring_intents import ACTIVE, DurableScoring, Limits, Receipt, identity
from app.jobs.scoring_service import CanonicalInputInvalid, build_profile_view, job_view
from app.models.entities import DURABLE_TERMINAL, JobMatch, JobPosting, ScoringIntent, ScoringJob, User, UserProfile


def service(db: Session) -> DurableScoring:
    return DurableScoring(
        None,
        session=db,
        limits=Limits(
            intents=settings.durable_scoring_max_intents,
            children=settings.durable_scoring_max_children,
            units=settings.durable_scoring_max_units,
            daily_roots=settings.durable_scoring_daily_roots,
            daily_units=settings.durable_scoring_daily_units,
        ),
    )


def _user_input(db, uid, now):
    built = build_profile_view(db, uid, reference_date=now.date())
    value = None if built is None else {"profile": asdict(built[0]), "criteria": built[1].model_dump(mode="json")}
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    if len(encoded) > 262144:
        raise CanonicalInputInvalid("INPUT_TOO_LARGE")
    return identity({"input": value})


def _job_input(job):
    if len(json.dumps(asdict(job_view(job))).encode()) > 262144:
        raise CanonicalInputInvalid("INPUT_TOO_LARGE")
    return identity(
        {
            "view": asdict(job_view(job)),
            "active": job.is_active,
            "posted_at": job.posted_at.astimezone(UTC).isoformat() if job.posted_at else None,
        }
    )


@dataclass
class Update:
    db: Session
    durable: DurableScoring
    now: datetime
    row: User | JobPosting
    before: str
    roots: tuple[int, ...]
    kind: str


def begin_user_update(db: Session, uid: int) -> Update | None:
    if not settings.durable_scoring_enabled:
        return None
    durable = service(db)
    now = durable.lock_intake()
    roots = tuple(
        db.scalars(
            select(ScoringIntent.id)
            .where(ScoringIntent.user_id == uid, ScoringIntent.status.not_in(DURABLE_TERMINAL))
            .order_by(ScoringIntent.id)
            .limit(3)
            .with_for_update()
        )
    )
    if len(roots) > 2:
        raise RuntimeError("User root invariant violated")
    row = db.scalar(select(User).where(User.id == uid).with_for_update().execution_options(populate_existing=True))
    if row is None:
        raise ValueError("INPUT_MISSING")
    return Update(db, durable, now, row, _user_input(db, uid, now), roots, "user")


def finish_user_update(update: Update | None) -> Receipt | None:
    if update is None:
        return None
    db, durable, row = update.db, update.durable, update.row
    db.flush()
    if _user_input(db, row.id, update.now) == update.before:
        root = db.scalar(
            select(ScoringIntent)
            .where(ScoringIntent.user_id == row.id, ScoringIntent.user_generation == row.scoring_generation)
            .order_by(ScoringIntent.id.desc())
            .limit(1)
        )
        return Receipt(root.id, True, root.status) if root else None
    row.scoring_generation += 1
    db.flush()
    for rid in update.roots:
        durable.invalidate(rid, state="SUPERSEDED")
    return durable.accept("USER_REFRESH", user_id=row.id, actor_user_id=row.id)


def begin_job_update(db: Session, job: JobPosting | None):
    if not settings.durable_scoring_enabled:
        return None
    durable = service(db)
    now = durable.lock_intake()
    if job is None:
        return durable, now, None, ()
    roots = tuple(
        db.scalars(
            select(ScoringIntent.id)
            .where(ScoringIntent.job_id == job.id, ScoringIntent.status.not_in(DURABLE_TERMINAL))
            .order_by(ScoringIntent.id)
            .limit(1001)
            .with_for_update()
        )
    )
    if len(roots) > 1000:
        raise RuntimeError("Global root invariant violated")
    db.refresh(job, with_for_update=True)
    return durable, now, _job_input(job), roots


def finish_job_update(update, job: JobPosting) -> Receipt | None:
    if update is None:
        return None
    durable, _now, before, roots = update
    durable.session.flush()
    if before == _job_input(job):
        return None
    job.scoring_generation += 1
    durable.session.flush()
    for rid in roots:
        durable.invalidate(rid, state="SUPERSEDED", batch_size=100)
    # Inactive postings invalidate old work, but do not require a new score.
    return durable.accept("JOB_FANOUT", job_id=job.id) if job.is_active else None


def accept_user(db, uid, *, days=7, include_unknown=False):
    return service(db).accept(
        "USER_REFRESH", user_id=uid, actor_user_id=uid, days=days, include_unknown=include_unknown
    )


def receipt_payload(receipt: Receipt | None):
    if receipt is None:
        return None
    return {
        "enabled": True,
        "accepted": True,
        "status": public_state(receipt.status),
        "intent_id": receipt.id,
        "status_url": "/jobs/scoring-status",
    }


def public_state(state):
    return {
        "PENDING": "pending",
        "RETRY_WAIT": "pending",
        "WAITING": "pending",
        "EXPANDING": "processing",
        "CLAIMED": "processing",
        "SUCCEEDED": "complete",
        "TERMINAL_FAILED": "failed",
        "SUPERSEDED": "superseded",
        "CANCELED": "canceled",
    }[state]


def user_status(db, uid, *, intent_id=None, after_id=0, page_size=100):
    """Only actor-owned IDs/states. Active projection remains honest before expansion."""
    if after_id < 0 or not 1 <= page_size <= 100:
        raise ValueError("Invalid status page")
    if intent_id is not None:
        root = db.scalar(select(ScoringIntent).where(ScoringIntent.id == intent_id, ScoringIntent.user_id == uid))
        if root is None:
            raise PermissionError("Status unavailable")
        root_state = public_state(root.status)
    else:
        root = db.scalar(
            select(ScoringIntent).where(ScoringIntent.user_id == uid).order_by(ScoringIntent.id.desc()).limit(1)
        )
        root_state = public_state(root.status) if root else "complete"
    if intent_id is None:
        live_root = db.scalar(
            select(ScoringIntent)
            .where(ScoringIntent.user_id == uid, ScoringIntent.status.not_in(DURABLE_TERMINAL))
            .order_by(ScoringIntent.id)
            .limit(1)
        )
        if live_root is not None:
            root_state = public_state(live_root.status)
    query = select(ScoringJob.id, ScoringJob.job_id, ScoringJob.status).where(ScoringJob.user_id == uid)
    if intent_id is not None:
        query = query.where(ScoringJob.intent_id == intent_id)
    rows = db.execute(query.where(ScoringJob.id > after_id).order_by(ScoringJob.id).limit(page_size + 1)).all()
    # A bounded actor-local active query avoids confusing old terminal history with current work.
    active = (
        db.execute(
            select(ScoringJob.status)
            .where(
                ScoringJob.user_id == uid,
                ScoringJob.status.in_(ACTIVE),
                *([ScoringJob.intent_id == intent_id] if intent_id is not None else []),
            )
            .limit(101)
        )
        .scalars()
        .all()
    )
    if len(active) > 100:
        raise RuntimeError("User child invariant violated")
    state = "processing" if "CLAIMED" in active else "pending" if active else root_state
    if intent_id is None and state not in ("pending", "processing"):
        # JOB_FANOUT is not owned by this actor; expose only the existence of their pending disposition.
        pending = db.scalar(
            select(ScoringIntent.id)
            .join(JobPosting, JobPosting.id == ScoringIntent.job_id)
            .where(
                ScoringIntent.scope == "JOB_FANOUT",
                ScoringIntent.status.in_(("PENDING", "EXPANDING")),
                ScoringIntent.cursor_id < uid,
                ScoringIntent.target_upper_id >= uid,
                ScoringIntent.job_generation == JobPosting.scoring_generation,
                JobPosting.is_active.is_(True),
            )
            .limit(1)
        )
        if pending and db.scalar(select(UserProfile.id).where(UserProfile.user_id == uid)) is not None:
            state = "pending"
        else:
            actor = db.get(User, uid)
            latest = db.scalar(
                select(ScoringJob)
                .join(JobPosting, JobPosting.id == ScoringJob.job_id)
                .where(
                    ScoringJob.user_id == uid,
                    ScoringJob.user_generation == actor.scoring_generation,
                    ScoringJob.job_generation == JobPosting.scoring_generation,
                    JobPosting.is_active.is_(True),
                )
                .order_by(ScoringJob.id.desc())
                .limit(1)
            )
            if latest is not None and (root is None or latest.created_at >= root.created_at):
                state = public_state(latest.status)
    page = rows[:page_size]
    return {
        "enabled": True,
        "status": state,
        "jobs": [{"job_id": r.job_id, "status": public_state(r.status)} for r in page],
        "next_cursor": page[-1].id if len(rows) > page_size else None,
    }


INTERNAL_EXPORT_COLUMNS = frozenset(
    {
        "scoring_generation",
        "scoring_admission_day",
        "scoring_roots_today",
        "scoring_job_id",
        "completed_user_generation",
        "completed_job_generation",
        "completed_input_digest",
        "digest_schema",
        "current_operation_digest",
        "current_user_generation",
        "current_job_generation",
        "current_score_version",
        "operation_attempt_count",
        "recovery_cycle_used",
        "operation_error_category",
        "scoring_error_code",
        "scoring_attempts",
        "job_content_hash",
        "profile_version",
    }
)


def current_score_state(match: JobMatch | None, *, user_generation: int, job_generation: int):
    if match is None:
        return "not_scored"
    # Legacy results remain valid at untouched generation zero; migration never enqueues history.
    if (
        user_generation == job_generation == 0
        and match.completed_user_generation is None
        and match.completed_job_generation is None
        and match.current_operation_digest is None
    ):
        return match.score_state
    if (
        match.current_user_generation == user_generation
        and match.current_job_generation == job_generation
        and match.operation_error_category
        and (
            match.operation_attempt_count >= 3
            or match.operation_error_category not in {"DB_UNAVAILABLE", "WORKER_TIMEOUT", "WORKER_LOST"}
        )
    ):
        return "terminal_failed"
    if match.completed_user_generation == user_generation and match.completed_job_generation == job_generation:
        return match.score_state
    return "pending"


def score_projections(db, user, jobs, matches):
    """One bounded actor-local work read plus bounded unexpanded roots; no per-card queries."""
    active = db.execute(
        select(ScoringJob.job_id, ScoringJob.status)
        .where(
            ScoringJob.user_id == user.id,
            ScoringJob.user_generation == user.scoring_generation,
            ScoringJob.status.in_(ACTIVE),
        )
        .limit(101)
    ).all()
    if len(active) > 100:
        raise RuntimeError("User child invariant violated")
    children = {r.job_id: "scoring" if r.status == "CLAIMED" else "pending" for r in active}
    roots = db.scalars(
        select(ScoringIntent)
        .where(
            ScoringIntent.status.in_(("PENDING", "EXPANDING")),
            or_(
                ScoringIntent.user_id == user.id,
                (ScoringIntent.scope == "JOB_FANOUT")
                & (ScoringIntent.cursor_id < user.id)
                & (ScoringIntent.target_upper_id >= user.id),
            ),
        )
        .order_by(ScoringIntent.id)
        .limit(1001)
    ).all()
    if len(roots) > 1000:
        raise RuntimeError("Global root invariant violated")
    recent = db.execute(
        select(ScoringJob.job_id, ScoringJob.status, ScoringJob.job_generation)
        .where(
            ScoringJob.user_id == user.id,
            ScoringJob.user_generation == user.scoring_generation,
            ScoringJob.status.in_(DURABLE_TERMINAL),
        )
        .order_by(ScoringJob.id.desc())
        .limit(100)
    ).all()
    terminal = {}
    for row in recent:
        terminal.setdefault(row.job_id, row)
    own_terminal = db.scalar(
        select(ScoringIntent)
        .where(
            ScoringIntent.user_id == user.id,
            ScoringIntent.user_generation == user.scoring_generation,
            ScoringIntent.status.in_(DURABLE_TERMINAL),
        )
        .order_by(ScoringIntent.id.desc())
        .limit(1)
    )
    result = {}
    for job in jobs:
        value = current_score_state(
            matches.get(job.id), user_generation=user.scoring_generation, job_generation=job.scoring_generation
        )
        recent_pair = terminal.get(job.id)
        if recent_pair and recent_pair.job_generation == job.scoring_generation:
            if recent_pair.status == "TERMINAL_FAILED":
                value = "terminal_failed"
            elif recent_pair.status in ("CANCELED", "SUPERSEDED") and value != "scored":
                value = "not_scored"
        if (
            own_terminal
            and own_terminal.status == "TERMINAL_FAILED"
            and value == "not_scored"
            and (
                own_terminal.scope == "USER_REFRESH"
                and job.id <= own_terminal.target_upper_id
                or own_terminal.scope == "PAIR_REFRESH"
                and own_terminal.job_id == job.id
            )
        ):
            value = "terminal_failed"
        if job.id in children:
            value = children[job.id]
        else:
            for root in roots:
                if root.scope == "JOB_FANOUT":
                    selected = root.job_id == job.id and root.job_generation == job.scoring_generation
                else:
                    selected = root.user_generation == user.scoring_generation and (
                        root.scope == "PAIR_REFRESH"
                        and root.job_id == job.id
                        and root.cursor_id == 0
                        or root.scope == "USER_REFRESH"
                        and root.cursor_id < job.id <= root.target_upper_id
                    )
                    posted = job.posted_at
                    if posted is not None and posted.tzinfo is None:
                        posted = posted.replace(tzinfo=UTC)
                    selected = selected and (
                        posted is None and root.include_unknown_dates or posted is not None and posted >= root.cutoff_at
                    )
                if selected:
                    value = "pending"
                    break
        result[job.id] = value
    return result
