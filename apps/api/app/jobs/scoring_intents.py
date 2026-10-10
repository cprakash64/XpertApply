"""Dormant PostgreSQL durability primitives. No routes, tasks or startup callers.

Each public mutation owns a short transaction, serializing capacity first. There
is deliberately no runner, Redis transport, scoring call or operator retry grant.
"""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.jobs.scoring_service import (
    SCORE_VERSION,
    build_profile_view,
    compute_scoring_input_digest,
    has_scorable_profile,
    job_view,
)
from app.models.entities import (
    DURABLE_TERMINAL,
    SCORING_ERRORS,
    JobMatch,
    JobPosting,
    ScoringCapacity,
    ScoringIntent,
    ScoringJob,
    User,
    UserProfile,
)

ACTIVE = ("PENDING", "CLAIMED", "RETRY_WAIT")
TRANSITIONS = {
    "PENDING": {"CLAIMED", "SUPERSEDED", "CANCELED", "TERMINAL_FAILED"},
    "CLAIMED": {"SUCCEEDED", "RETRY_WAIT", "TERMINAL_FAILED", "SUPERSEDED", "CANCELED"},
    "RETRY_WAIT": {"CLAIMED", "SUPERSEDED", "CANCELED", "TERMINAL_FAILED"},
    **{state: set() for state in DURABLE_TERMINAL},
}
RETRYABLE = {"DB_UNAVAILABLE", "WORKER_TIMEOUT", "WORKER_LOST"}


class CapacityUnavailable(Exception):
    """Intake did not commit. No partial reservation or intent is retained."""


class StaleGeneration(Exception):
    pass


@dataclass(frozen=True)
class Limits:
    intents: int = 1000
    children: int = 10000
    units: int = 100000
    user_roots: int = 2
    user_children: int = 100
    running: int = 2
    daily_roots: int = 1000
    daily_units: int = 100000
    user_daily_roots: int = 20

    def __post_init__(self):
        ceilings = (1000, 10000, 100000, 2, 100, 2, 1000, 100000, 20)
        for value, ceiling in zip(self.__dict__.values(), ceilings, strict=True):
            if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= ceiling:
                raise ValueError("Invalid internal capacity policy")


@dataclass(frozen=True)
class Receipt:
    id: int
    existing: bool
    status: str


@dataclass(frozen=True)
class Claim:
    id: int
    token: str
    input_digest: str
    user_generation: int
    job_generation: int
    expires_at: datetime


@dataclass(frozen=True)
class SyntheticResult:
    """Validated fixed payload. The foundation does not compute this result."""

    fit_score: float | None
    fit_summary: str = "Reviewed against your profile."
    fit_label: str = "Fit"
    reasons: tuple[str, ...] = ()
    gaps: tuple[str, ...] = ()
    risks: tuple[str, ...] = ()
    resume_angle: str = ""
    confidence: float = 0.0
    profile_incomplete: bool = False

    def __post_init__(self):
        if not isinstance(self.profile_incomplete, bool):
            raise ValueError("Invalid result")
        if self.profile_incomplete:
            if self.fit_score is not None:
                raise ValueError("Incomplete profile cannot carry a score")
        elif (
            not isinstance(self.fit_score, int | float)
            or not math.isfinite(self.fit_score)
            or not 0 <= self.fit_score <= 100
        ):
            raise ValueError("Invalid score")
        if (
            not isinstance(self.confidence, int | float)
            or not math.isfinite(self.confidence)
            or not 0 <= self.confidence <= 1
        ):
            raise ValueError("Invalid confidence")
        for value in (self.fit_summary, self.fit_label, self.resume_angle):
            if not isinstance(value, str) or len(value) > 2000:
                raise ValueError("Invalid result text")
        if len(self.fit_label) > 40:
            raise ValueError("Invalid label")
        for values in (self.reasons, self.gaps, self.risks):
            if (
                not isinstance(values, tuple)
                or len(values) > 20
                or any(not isinstance(v, str) or len(v) > 2000 for v in values)
            ):
                raise ValueError("Invalid result list")
        if len(json.dumps(self.__dict__).encode()) > 65536:
            raise ValueError("Invalid result size")


def identity(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def transition(job: ScoringJob, state: str, now: datetime) -> None:
    if state not in TRANSITIONS[job.status]:
        raise ValueError("Illegal durable state transition")
    job.status = state
    job.updated_at = now
    if state != "CLAIMED":
        job.lease_token = job.lease_expires_at = None
    job.completed_at = now if state in DURABLE_TERMINAL else None


class DurableScoring:
    def __init__(
        self,
        sessions: sessionmaker,
        *,
        limits: Limits | None = None,
        clock: Callable[[Session], datetime] | None = None,
    ):
        self.sessions = sessions
        self.limits = limits or Limits()
        self.clock = clock

    def _now(self, db):
        now = self.clock(db) if self.clock else db.scalar(select(func.clock_timestamp()))
        if now.tzinfo is None:
            raise ValueError("Clock must be timezone-aware")
        return now.astimezone(UTC)

    @contextmanager
    def _tx(self):
        with self.sessions() as db, db.begin():
            if db.bind.dialect.name != "postgresql":
                raise RuntimeError("Durable scoring requires PostgreSQL")
            db.execute(text("SET LOCAL lock_timeout = '250ms'"))
            db.execute(text("SET LOCAL statement_timeout = '2s'"))
            cap = db.scalar(select(ScoringCapacity).where(ScoringCapacity.id == 1).with_for_update())
            if cap is None:
                raise RuntimeError("Missing migrated capacity singleton")
            yield db, cap, self._now(db)
            db.flush()

    def _root(self, db, intent_id):
        return db.scalar(select(ScoringIntent).where(ScoringIntent.id == intent_id).with_for_update())

    def _canonical(self, db, user_id, job_id):
        user = db.scalar(select(User).where(User.id == user_id).with_for_update()) if user_id else None
        job = db.scalar(select(JobPosting).where(JobPosting.id == job_id).with_for_update()) if job_id else None
        return user, job

    def _reserve(self, db, cap, now, user, units):
        if cap.admission_day != now.date():
            cap.admission_day = now.date()
            cap.admitted_roots_today = cap.admitted_units_today = 0
        limits = self.limits
        if (
            cap.live_intents >= limits.intents
            or cap.reserved_units + units > limits.units
            or cap.admitted_roots_today >= limits.daily_roots
            or cap.admitted_units_today + units > limits.daily_units
        ):
            raise CapacityUnavailable("SCORING_BACKLOG_FULL")
        if user:
            if user.scoring_admission_day != now.date():
                user.scoring_admission_day = now.date()
                user.scoring_roots_today = 0
            count = db.scalar(
                select(func.count())
                .select_from(ScoringIntent)
                .where(ScoringIntent.user_id == user.id, ScoringIntent.status.not_in(DURABLE_TERMINAL))
            )
            if count >= limits.user_roots or user.scoring_roots_today >= limits.user_daily_roots:
                raise CapacityUnavailable("USER_SCORING_CAPACITY")
            user.scoring_roots_today += 1
        cap.live_intents += 1
        cap.reserved_units += units
        cap.admitted_roots_today += 1
        cap.admitted_units_today += units

    def accept(
        self,
        scope: str,
        *,
        user_id: int | None = None,
        job_id: int | None = None,
        actor_user_id: int | None = None,
        days: int = 7,
        include_unknown: bool = False,
        expected_user_generation: int | None = None,
        expected_job_generation: int | None = None,
    ) -> Receipt:
        """Internal atomic acceptance. No runtime route calls this method in R2."""
        if (
            scope not in {"JOB_FANOUT", "USER_REFRESH", "PAIR_REFRESH"}
            or not isinstance(days, int)
            or not 1 <= days <= 60
        ):
            raise ValueError("Invalid intent selection")
        if not isinstance(include_unknown, bool):
            raise ValueError("Invalid selection")
        if (
            (scope == "JOB_FANOUT" and (job_id is None or user_id is not None))
            or (scope == "USER_REFRESH" and (user_id is None or job_id is not None))
            or (scope == "PAIR_REFRESH" and (user_id is None or job_id is None))
        ):
            raise ValueError("Invalid intent ownership")
        if actor_user_id is not None and actor_user_id != user_id:
            raise PermissionError("Intent ownership mismatch")
        with self._tx() as (db, cap, now):
            user, job = self._canonical(db, user_id, job_id)
            if (user_id is not None and user is None) or (job_id is not None and job is None):
                raise ValueError("INPUT_MISSING")
            if (expected_user_generation is not None and user.scoring_generation != expected_user_generation) or (
                expected_job_generation is not None and job.scoring_generation != expected_job_generation
            ):
                raise StaleGeneration()
            target = User if scope == "JOB_FANOUT" else JobPosting
            upper = 1 if scope == "PAIR_REFRESH" else (db.scalar(select(func.max(target.id))) or 0)
            key = identity(
                {
                    "scope": scope,
                    "user": user_id,
                    "job": job_id,
                    "ug": user.scoring_generation if user else None,
                    "jg": job.scoring_generation if job else None,
                    "score": SCORE_VERSION,
                    **(
                        {}
                        if scope == "JOB_FANOUT"
                        else {"date": now.date().isoformat(), "days": days, "unknown": include_unknown, "upper": upper}
                    ),
                }
            )
            existing = db.scalar(select(ScoringIntent).where(ScoringIntent.operation_key == key))
            if existing:
                return Receipt(existing.id, True, existing.status)
            self._reserve(db, cap, now, user, upper)
            root = ScoringIntent(
                scope=scope,
                operation_key=key,
                user_id=user_id,
                job_id=job_id,
                user_generation=user.scoring_generation if user else None,
                job_generation=job.scoring_generation if job else None,
                score_version=SCORE_VERSION,
                reference_date=now.date(),
                selection_days=days,
                include_unknown_dates=include_unknown,
                cutoff_at=now - timedelta(days=days),
                target_upper_id=upper,
                cursor_id=0,
                remaining_units=upper,
                unfinished_children=0,
                failed_children=0,
                expansion_complete=False,
                expansion_attempts=0,
                status="PENDING",
                next_attempt_at=now,
                deadline_at=now + timedelta(days=7),
            )
            db.add(root)
            db.flush()
            if upper == 0:
                root.expansion_complete = True
                self._close_parent(cap, root, now)
            return Receipt(root.id, False, root.status)

    def advance_generation(self, *, user_id=None, job_id=None, expected: int):
        if (user_id is None) == (job_id is None):
            raise ValueError("One canonical resource required")
        with self._tx() as (db, _cap, _now):
            user, job = self._canonical(db, user_id, job_id)
            row = user or job
            if row is None or row.scoring_generation != expected:
                raise StaleGeneration()
            row.scoring_generation += 1
            return row.scoring_generation

    def _valid(self, root, user, job):
        return (
            root.status not in DURABLE_TERMINAL
            and root.score_version == SCORE_VERSION
            and (root.user_id is None or user is not None and root.user_generation == user.scoring_generation)
            and (root.job_id is None or job is not None and root.job_generation == job.scoring_generation)
        )

    def claim_expansion(self, intent_id: int) -> str | None:
        with self._tx() as (db, cap, now):
            root = self._root(db, intent_id)
            if root is None or root.status != "PENDING" or root.next_attempt_at > now:
                return None
            user, job = self._canonical(db, root.user_id, root.job_id)
            if not self._valid(root, user, job) or root.deadline_at <= now or root.expansion_attempts >= 3:
                self._invalidate_root(
                    cap, root, now, "SUPERSEDED" if not self._valid(root, user, job) else "TERMINAL_FAILED"
                )
                return None
            root.status = "EXPANDING"
            root.lease_token = str(uuid.uuid4())
            root.lease_expires_at = now + timedelta(seconds=90)
            root.expansion_attempts += 1
            return root.lease_token

    def _inputs(self, db, uid, posting, root):
        built = build_profile_view(db, uid, reference_date=root.reference_date)
        view, criteria = built if built else (None, None)
        digest = compute_scoring_input_digest(
            view, job_view(posting), criteria, reference_date=root.reference_date, score_version=root.score_version
        )
        return digest

    def expand(self, intent_id: int, token: str, *, batch_size: int = 100) -> tuple[int, ...] | None:
        if not 1 <= batch_size <= 100:
            raise ValueError("Bounded expansion required")
        with self._tx() as (db, cap, now):
            root = self._root(db, intent_id)
            if root is None or root.status != "EXPANDING" or root.lease_token != token or root.lease_expires_at <= now:
                return None
            owner, posting = self._canonical(db, root.user_id, root.job_id)
            if not self._valid(root, owner, posting) or root.deadline_at <= now:
                self._invalidate_root(
                    cap, root, now, "SUPERSEDED" if not self._valid(root, owner, posting) else "TERMINAL_FAILED"
                )
                return None
            target = User if root.scope == "JOB_FANOUT" else JobPosting
            ids = (
                [1]
                if root.scope == "PAIR_REFRESH"
                else list(
                    db.scalars(
                        select(target.id)
                        .where(target.id > root.cursor_id, target.id <= root.target_upper_id)
                        .order_by(target.id)
                        .limit(batch_size)
                    )
                )
            )
            created = []
            cursor = root.cursor_id
            previous_cursor = cursor
            blocked = False
            for target_id in ids:
                uid = target_id if root.scope == "JOB_FANOUT" else root.user_id
                jid = root.job_id if root.scope in {"PAIR_REFRESH", "JOB_FANOUT"} else target_id
                user, job = self._canonical(db, uid, jid)
                profile = db.scalar(select(UserProfile).where(UserProfile.user_id == uid))
                eligible = user is not None and job is not None and job.is_active
                if root.scope == "JOB_FANOUT" and profile is None:
                    eligible = False
                if root.scope != "JOB_FANOUT" and job is not None:
                    posted = job.posted_at
                    eligible = eligible and (
                        posted is not None and posted >= root.cutoff_at or posted is None and root.include_unknown_dates
                    )
                if eligible:
                    count = db.scalar(
                        select(func.count())
                        .select_from(ScoringJob)
                        .where(ScoringJob.user_id == uid, ScoringJob.status.in_(ACTIVE))
                    )
                    if cap.live_children >= self.limits.children or count >= self.limits.user_children:
                        blocked = True
                        break
                    digest = self._inputs(db, uid, job, root)
                    op = identity(
                        {
                            "user": uid,
                            "job": jid,
                            "ug": user.scoring_generation,
                            "jg": job.scoring_generation,
                            "score": root.score_version,
                            "schema": 1,
                            "digest": digest,
                        }
                    )
                    pair = ScoringJob(
                        intent_id=root.id,
                        user_id=uid,
                        job_id=jid,
                        user_generation=user.scoring_generation,
                        job_generation=job.scoring_generation,
                        score_version=root.score_version,
                        input_digest=digest,
                        operation_digest=op,
                        digest_schema=1,
                        reference_date=root.reference_date,
                        status="PENDING",
                        attempt_count=0,
                        next_attempt_at=now,
                        deadline_at=root.deadline_at,
                    )
                    db.add(pair)
                    db.flush()
                    created.append(pair.id)
                    cap.live_children += 1
                    root.unfinished_children += 1
                width = target_id - cursor
                released = width - (1 if eligible else 0)
                root.remaining_units -= released
                cap.reserved_units -= released
                cursor = target_id
            if not blocked and len(ids) < batch_size or root.scope == "PAIR_REFRESH" and not blocked:
                released = root.target_upper_id - cursor
                root.remaining_units -= released
                cap.reserved_units -= released
                cursor = root.target_upper_id
            root.cursor_id = cursor
            root.expansion_complete = cursor == root.target_upper_id
            root.status = "WAITING" if root.expansion_complete else "PENDING"
            root.lease_token = root.lease_expires_at = None
            root.expansion_attempts = 0 if cursor > previous_cursor else root.expansion_attempts
            root.next_attempt_at = now + timedelta(seconds=1) if blocked else now
            self._close_parent(cap, root, now)
            return tuple(created)

    def _close_parent(self, cap, root, now):
        if root.status not in DURABLE_TERMINAL and root.expansion_complete and root.unfinished_children == 0:
            root.status = "TERMINAL_FAILED" if root.failed_children else "SUCCEEDED"
            root.completed_at = now
            root.lease_token = root.lease_expires_at = None
            cap.live_intents -= 1

    def _invalidate_root(self, cap, root, now, state):
        if root.status in DURABLE_TERMINAL:
            return
        unexpanded = root.remaining_units - root.unfinished_children
        cap.reserved_units -= unexpanded
        root.remaining_units -= unexpanded
        root.status = state
        root.completed_at = now
        root.lease_token = root.lease_expires_at = None
        root.expansion_complete = True
        root.cursor_id = root.target_upper_id
        cap.live_intents -= 1
        if state == "TERMINAL_FAILED":
            root.error_category = "DEADLINE_EXCEEDED"

    def _terminal(self, cap, root, pair, now, state, *, error=None, outcome=None):
        if pair.status in DURABLE_TERMINAL:
            return False
        if state == "SUCCEEDED" and pair.status != "CLAIMED":
            if outcome != "REUSED_EXISTING":
                raise ValueError("Unclaimed success requires completed-result reuse")
            # No durable compute claim is issued: both R1 transitions commit together.
            transition(pair, "CLAIMED", now)
            cap.running_pairs += 1
        if pair.status == "CLAIMED":
            cap.running_pairs -= 1
        transition(pair, state, now)
        pair.error_category = error
        pair.outcome = outcome
        cap.live_children -= 1
        cap.reserved_units -= 1
        root.remaining_units -= 1
        root.unfinished_children -= 1
        if state == "TERMINAL_FAILED":
            root.failed_children += 1
        self._close_parent(cap, root, now)
        return True

    def _locked_pair(self, db, pair_id, *, skip_locked=False):
        locator = db.execute(
            select(ScoringJob.intent_id, ScoringJob.user_id, ScoringJob.job_id).where(ScoringJob.id == pair_id)
        ).first()
        if locator is None:
            return None
        root = self._root(db, locator.intent_id)
        user, job = self._canonical(db, locator.user_id, locator.job_id)
        pair = db.scalar(select(ScoringJob).where(ScoringJob.id == pair_id).with_for_update(skip_locked=skip_locked))
        return (root, user, job, pair) if pair is not None else None

    def _match(self, db, pair):
        match = db.scalar(
            select(JobMatch).where(JobMatch.user_id == pair.user_id, JobMatch.job_id == pair.job_id).with_for_update()
        )
        if match is None:
            match = JobMatch(
                user_id=pair.user_id,
                job_id=pair.job_id,
                fit_score=None,
                fit_summary=None,
                score_state="pending",
                operation_attempt_count=0,
                recovery_cycle_used=False,
            )
            db.add(match)
            db.flush()
        return match

    def _pair_valid(self, root, user, job, pair):
        return (
            self._valid(root, user, job)
            and user is not None
            and job is not None
            and job.is_active
            and pair.user_generation == user.scoring_generation
            and pair.job_generation == job.scoring_generation
            and pair.score_version == SCORE_VERSION
        )

    def claim(self, pair_id: int | None = None) -> Claim | None:
        with self._tx() as (db, cap, now):
            if cap.running_pairs >= self.limits.running:
                return None
            query = (
                select(ScoringJob.id)
                .where(ScoringJob.status.in_(("PENDING", "RETRY_WAIT")), ScoringJob.next_attempt_at <= now)
                .order_by(ScoringJob.next_attempt_at, ScoringJob.id)
                .limit(100)
            )
            if pair_id is not None:
                query = query.where(ScoringJob.id == pair_id)
            # Capacity lock serializes decisions; skip independently locked queue rows.
            candidates = list(db.scalars(query))
            for candidate in candidates:
                rows = self._locked_pair(db, candidate, skip_locked=True)
                if rows is None:
                    continue
                root, user, job, pair = rows
                if not self._pair_valid(root, user, job, pair):
                    self._terminal(cap, root, pair, now, "SUPERSEDED")
                    continue
                if pair.deadline_at <= now:
                    self._terminal(cap, root, pair, now, "TERMINAL_FAILED", error="DEADLINE_EXCEEDED")
                    continue
                if db.scalar(
                    select(ScoringJob.id)
                    .where(ScoringJob.user_id == pair.user_id, ScoringJob.status == "CLAIMED")
                    .limit(1)
                ):
                    continue
                actual = self._inputs(db, user.id, job, root)
                if actual != pair.input_digest:
                    self._terminal(cap, root, pair, now, "SUPERSEDED")
                    continue
                if db.scalar(
                    select(ScoringJob.id)
                    .where(
                        ScoringJob.operation_digest == pair.operation_digest,
                        ScoringJob.status == "RETRY_WAIT",
                        ScoringJob.next_attempt_at > now,
                    )
                    .limit(1)
                ):
                    continue
                match = self._match(db, pair)
                if match.score_version > pair.score_version:
                    self._terminal(cap, root, pair, now, "SUPERSEDED")
                    continue
                same = match.current_operation_digest == pair.operation_digest
                completed = (
                    match.completed_input_digest == pair.input_digest
                    and match.completed_user_generation == pair.user_generation
                    and match.completed_job_generation == pair.job_generation
                    and match.score_version == pair.score_version
                )
                if completed:
                    self._terminal(cap, root, pair, now, "SUCCEEDED", outcome="REUSED_EXISTING")
                    continue
                if not same:
                    match.current_operation_digest = pair.operation_digest
                    match.current_user_generation = pair.user_generation
                    match.current_job_generation = pair.job_generation
                    match.current_score_version = pair.score_version
                    match.operation_attempt_count = 0
                    match.recovery_cycle_used = False
                    match.operation_error_category = None
                if (
                    match.operation_attempt_count >= 3
                    or match.operation_error_category
                    and match.operation_error_category not in RETRYABLE
                ):
                    self._terminal(cap, root, pair, now, "TERMINAL_FAILED", error="ATTEMPTS_EXHAUSTED")
                    continue
                now = self._now(db)
                if pair.deadline_at <= now or root.deadline_at <= now:
                    self._terminal(cap, root, pair, now, "TERMINAL_FAILED", error="DEADLINE_EXCEEDED")
                    continue
                match.operation_attempt_count += 1
                pair.attempt_count += 1
                transition(pair, "CLAIMED", now)
                pair.lease_token = str(uuid.uuid4())
                pair.lease_expires_at = now + timedelta(seconds=90)
                pair.claimed_at = now
                pair.error_category = None
                cap.running_pairs += 1
                return Claim(
                    pair.id,
                    pair.lease_token,
                    pair.input_digest,
                    pair.user_generation,
                    pair.job_generation,
                    pair.lease_expires_at,
                )
            return None

    def _owned(self, root, user, job, pair, claim, now):
        return (
            pair.status == "CLAIMED"
            and pair.lease_token == claim.token
            and pair.lease_expires_at > now
            and pair.input_digest == claim.input_digest
            and pair.user_generation == claim.user_generation
            and pair.job_generation == claim.job_generation
            and pair.deadline_at > now
            and root.deadline_at > now
            and self._pair_valid(root, user, job, pair)
        )

    def complete(self, claim: Claim, result: SyntheticResult) -> str:
        if not isinstance(result, SyntheticResult):
            raise ValueError("Validated result required")
        with self._tx() as (db, cap, now):
            rows = self._locked_pair(db, claim.id)
            if rows is None:
                return "STALE_WORKER"
            root, user, job, pair = rows
            if not self._owned(root, user, job, pair, claim, self._now(db)):
                return "STALE_WORKER"
            actual_digest = self._inputs(db, user.id, job, root)
            profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id)) if user else None
            match = self._match(db, pair)
            # Refresh database time after every input/row lookup, immediately before the write decision.
            now = self._now(db)
            if (
                not self._owned(root, user, job, pair, claim, now)
                or actual_digest != pair.input_digest
                or match.current_operation_digest != pair.operation_digest
                or match.score_version > pair.score_version
            ):
                return "STALE_WORKER"
            if result.profile_incomplete == has_scorable_profile(profile):
                raise ValueError("Result/profile outcome mismatch")
            match.fit_score = result.fit_score
            match.fit_summary = None if result.profile_incomplete else result.fit_summary
            match.fit_label = None if result.profile_incomplete else result.fit_label
            match.strengths, match.gaps, match.risks = list(result.reasons), list(result.gaps), list(result.risks)
            match.recommended_resume_angle = result.resume_angle
            match.confidence = result.confidence
            match.explanation_source = "deterministic"
            match.score_state = "profile_incomplete" if result.profile_incomplete else "scored"
            match.score_version = pair.score_version
            match.scoring_error_code = None
            match.scored_at = now
            match.scoring_job_id = pair.id
            match.completed_user_generation = pair.user_generation
            match.completed_job_generation = pair.job_generation
            match.completed_input_digest = pair.input_digest
            match.digest_schema = 1
            match.operation_error_category = None
            self._terminal(
                cap,
                root,
                pair,
                now,
                "SUCCEEDED",
                outcome="PROFILE_INCOMPLETE" if result.profile_incomplete else "SCORE",
            )
            return "SUCCEEDED"

    def _fail(self, db, cap, root, pair, now, category, *, owned_token=None):
        match = self._match(db, pair)
        now = self._now(db)
        if owned_token is not None and (pair.lease_token != owned_token or pair.lease_expires_at <= now):
            return False
        budget = (
            match.operation_attempt_count
            if match.current_operation_digest == pair.operation_digest
            else pair.attempt_count
        )
        if category in RETRYABLE and budget < 3 and pair.deadline_at > now:
            cap.running_pairs -= 1
            transition(pair, "RETRY_WAIT", now)
            delay = 30 if budget == 1 else 120
            jitter = int(identity({"pair": pair.id, "attempt": budget})[:8], 16) % 11
            pair.next_attempt_at = now + timedelta(seconds=delay + jitter)
            pair.error_category = category
        else:
            self._terminal(
                cap,
                root,
                pair,
                now,
                "TERMINAL_FAILED",
                error="ATTEMPTS_EXHAUSTED" if category in RETRYABLE else category,
            )
        if match.current_operation_digest == pair.operation_digest:
            match.operation_error_category = pair.error_category
        return True

    def fail(self, claim: Claim, category: str) -> str:
        if category not in SCORING_ERRORS:
            raise ValueError("Sanitized error category required")
        with self._tx() as (db, cap, now):
            rows = self._locked_pair(db, claim.id)
            if rows is None:
                return "STALE_WORKER"
            root, user, job, pair = rows
            if not self._owned(root, user, job, pair, claim, now):
                return "STALE_WORKER"
            if not self._fail(db, cap, root, pair, now, category, owned_token=claim.token):
                return "STALE_WORKER"
            return pair.status

    def invalidate(self, intent_id: int, *, state: str = "CANCELED", batch_size: int = 100) -> int:
        if state not in {"CANCELED", "SUPERSEDED"} or not 1 <= batch_size <= 100:
            raise ValueError("Invalid bounded invalidation")
        with self._tx() as (db, cap, now):
            root = self._root(db, intent_id)
            if root is None or root.status in DURABLE_TERMINAL and root.status != state:
                return 0
            self._invalidate_root(cap, root, now, state)
            ids = list(
                db.scalars(
                    select(ScoringJob.id)
                    .where(ScoringJob.intent_id == root.id, ScoringJob.status.in_(ACTIVE))
                    .order_by(ScoringJob.id)
                    .limit(batch_size)
                )
            )
            for jid in ids:
                _, _, _, pair = self._locked_pair(db, jid)
                self._terminal(cap, root, pair, now, state)
            return len(ids)

    def recovery(self, *, after_id: int = 0, batch_size: int = 100) -> tuple[int, ...]:
        if after_id < 0 or not 1 <= batch_size <= 100:
            raise ValueError("Bounded recovery required")
        with self.sessions() as db:
            now = self.clock(db) if self.clock else db.scalar(select(func.clock_timestamp()))
            return tuple(
                db.scalars(
                    select(ScoringJob.id)
                    .where(
                        ScoringJob.id > after_id,
                        ((ScoringJob.status.in_(("PENDING", "RETRY_WAIT"))) & (ScoringJob.next_attempt_at <= now))
                        | ((ScoringJob.status == "CLAIMED") & (ScoringJob.lease_expires_at <= now)),
                    )
                    .order_by(ScoringJob.id)
                    .limit(batch_size)
                )
            )

    def recover_expired(self, *, batch_size: int = 100) -> int:
        if not 1 <= batch_size <= 100:
            raise ValueError("Bounded reaper required")
        with self._tx() as (db, cap, now):
            ids = list(
                db.scalars(
                    select(ScoringJob.id)
                    .where(ScoringJob.status == "CLAIMED", ScoringJob.lease_expires_at <= now)
                    .order_by(ScoringJob.lease_expires_at, ScoringJob.id)
                    .limit(batch_size)
                )
            )
            for jid in ids:
                root, user, job, pair = self._locked_pair(db, jid)
                if not self._pair_valid(root, user, job, pair):
                    self._terminal(cap, root, pair, now, "SUPERSEDED")
                else:
                    self._fail(db, cap, root, pair, now, "WORKER_LOST")
            roots = list(
                db.scalars(
                    select(ScoringIntent)
                    .where(ScoringIntent.status == "EXPANDING", ScoringIntent.lease_expires_at <= now)
                    .order_by(ScoringIntent.id)
                    .limit(batch_size - len(ids))
                    .with_for_update()
                )
            )
            for root in roots:
                if root.expansion_attempts >= 3 or root.deadline_at <= now:
                    self._invalidate_root(cap, root, now, "TERMINAL_FAILED")
                else:
                    root.status = "PENDING"
                    root.lease_token = root.lease_expires_at = None
                    root.next_attempt_at = now + timedelta(seconds=30)
            return len(ids) + len(roots)

    def status_for_user(self, user_id: int, *, actor_user_id: int, batch_size: int = 100):
        if user_id != actor_user_id:
            raise PermissionError("Status ownership mismatch")
        if not 1 <= batch_size <= 100:
            raise ValueError("Bounded status required")
        with self.sessions() as db:
            return tuple(
                db.execute(
                    select(ScoringJob.id, ScoringJob.status)
                    .where(ScoringJob.user_id == actor_user_id)
                    .order_by(ScoringJob.id)
                    .limit(batch_size)
                )
            )

    def delete_user_work(self, user_id: int) -> None:
        """Dormant explicit privacy cleanup; RESTRICT FKs prevent silent leaks.

        Canonical account deletion remains the existing R3 route's responsibility.
        """
        with self._tx() as (db, cap, now):
            owned = list(
                db.scalars(
                    select(ScoringIntent)
                    .where(ScoringIntent.user_id == user_id, ScoringIntent.status.not_in(DURABLE_TERMINAL))
                    .order_by(ScoringIntent.id)
                    .limit(3)
                    .with_for_update()
                )
            )
            if len(owned) > 2:
                raise RuntimeError("User root bound violated")
            for root in owned:
                self._invalidate_root(cap, root, now, "CANCELED")
            ids = list(
                db.scalars(
                    select(ScoringJob.id)
                    .where(ScoringJob.user_id == user_id, ScoringJob.status.in_(ACTIVE))
                    .order_by(ScoringJob.id)
                    .limit(101)
                )
            )
            if len(ids) > 100:
                raise RuntimeError("User pair bound violated")
            for jid in ids:
                root, _, _, pair = self._locked_pair(db, jid)
                self._terminal(cap, root, pair, now, "CANCELED")
            db.flush()
            db.execute(delete(ScoringJob).where(ScoringJob.user_id == user_id))
            db.execute(delete(ScoringIntent).where(ScoringIntent.user_id == user_id))
