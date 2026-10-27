"""Celery worker tasks + beat schedule for XpertApply.

Runs in dedicated ``worker`` and ``scheduler`` (beat) containers, never inside
the API replicas, so multiple API instances can never trigger duplicate daily
ingestion (the beat scheduler is a single service and the run itself is guarded
by a distributed lock).
"""

from __future__ import annotations

import logging
import uuid

from celery import Celery
from celery.schedules import crontab
from celery.signals import task_postrun

from app.core import resource_controls as controls
from app.core.config import settings
from app.db.session import SessionLocal
from app.jobs.scoring_service import active_user_ids, score_users_for_job

logger = logging.getLogger("jobpilot.worker")


class BoundedCelery(Celery):
    def send_task(self, name, args=None, kwargs=None, **options):
        # A publisher mutex makes the physical LLEN check and publish serialized
        # across API replicas and beat. Network timeouts bound lock ownership.
        # Known tasks have at most 20000 IDs per batch; fail explicitly, never trim.
        if args and any(isinstance(a, list) and len(a) > 20000 for a in args):
            raise controls.limit_error("TASK_INPUT_LIMIT_EXCEEDED", 413)
        store = controls.store
        if not isinstance(store, controls.RedisStore):
            # Explicit injected test store, not an environment-based bypass.
            return super().send_task(name, args, kwargs, **options)
        client = store.client
        from redis.exceptions import RedisError

        lease = None
        lock = None
        try:
            lock = client.lock(controls.NAMESPACE + "publish-lock", timeout=30, blocking_timeout=0)
            if not lock.acquire(blocking=False):
                raise controls.limit_error("QUEUE_CAPACITY_UNAVAILABLE", 503)
            keys = ["celery", *["celery" + chr(6) + chr(22) + str(i) for i in (3, 6, 9)]]
            if sum(client.llen(k) for k in keys) >= settings.task_queue_max_depth:
                raise controls.limit_error("QUEUE_CAPACITY_UNAVAILABLE", 503)
            b = controls.budget.get()
            identity = b.principal if b and b.principal else "scheduler"
            lease = store.admit(controls.Policy("enqueue", 10, aggregate=60), identity)
            headers = options.pop("headers", None) or {}
            token = controls.opaque(identity + ":" + name)
            original = headers.get("xa-dedup")
            duplicate = (
                original
                if isinstance(original, str)
                and original.startswith(controls.NAMESPACE + "queued:")
                and len(original) == len(controls.NAMESPACE + "queued:") + 64
                else controls.NAMESPACE + "queued:" + token
            )
            # Celery retries preserve task_id. Allow a transfer by the same task,
            # while rejecting a distinct API task for the same user/work class.
            task_id = options.get("task_id") or str(uuid.uuid4())
            options["task_id"] = task_id
            previous = client.get(duplicate)
            if previous and not previous.decode().startswith(task_id + ":"):
                raise controls.limit_error("DUPLICATE_TASK_PENDING", 503)
            ownership = task_id + ":" + uuid.uuid4().hex
            client.set(duplicate, ownership, ex=360)
            try:
                headers.update({"xa-dedup": duplicate, "xa-dedup-value": ownership})
                options.update(headers=headers, expires=60, retry=False)
                return super().send_task(name, args, kwargs, **options)
            except BaseException:
                if previous:
                    client.set(duplicate, previous, ex=360)
                else:
                    client.delete(duplicate)
                raise
        except RedisError:
            raise controls.limit_error("LIMIT_STORE_UNAVAILABLE", 503) from None
        finally:
            if lease:
                store.release(*lease)
            if lock:
                try:
                    if lock.owned():
                        lock.release()
                except RedisError:
                    pass


# The Celery app name is part of how tasks are addressed on the broker, so it
# keeps its pre-rebrand spelling: renaming it would orphan every task already
# queued under the old name at the moment of deploy.
celery_app = BoundedCelery("jobpilot", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(
    task_soft_time_limit=280,
    task_time_limit=300,
    worker_prefetch_multiplier=1,
    task_publish_retry=False,
    task_reject_on_worker_lost=False,
    task_acks_on_failure_or_timeout=True,
)
celery_app.conf.timezone = settings.job_ingestion_timezone
celery_app.conf.task_default_retry_delay = 30
# Keep the worker resilient (it reconnects on startup), but BOUND publish attempts
# from the API request path so a broker outage falls back to inline scoring in a
# few seconds. NOTE: in Celery, broker_connection_max_retries=0 means "retry
# forever" — so we use a small positive bound plus short socket timeouts.
celery_app.conf.broker_connection_retry_on_startup = True
celery_app.conf.broker_transport_options = {
    "socket_connect_timeout": 2,
    "socket_timeout": 2,
}
celery_app.conf.broker_connection_max_retries = 2
celery_app.conf.broker_connection_timeout = 2


def _crontab_from_expr(expr: str) -> crontab:
    """Parse a 5-field cron expression ``m h dom mon dow`` into a Celery crontab.
    Falls back to a daily 06:00 schedule if the expression is malformed."""
    parts = (expr or "").split()
    if len(parts) != 5:
        logger.warning("Invalid JOB_INGESTION_SCHEDULE %r; defaulting to '0 6 * * *'.", expr)
        parts = ["0", "6", "*", "*", "*"]
    minute, hour, dom, month, dow = parts
    return crontab(minute=minute, hour=hour, day_of_month=dom, month_of_year=month, day_of_week=dow)


if settings.job_ingestion_enabled:
    celery_app.conf.beat_schedule = {
        "daily-job-ingestion": {
            "task": "run_daily_ingestion",
            "schedule": _crontab_from_expr(settings.job_ingestion_schedule),
        }
    }


@celery_app.task(name="match_jobs_for_user")
def match_jobs_for_user_task(user_id: int) -> int:
    """On-demand rescore for one user (kept for backward compatibility)."""
    from app.jobs.job_ingestion_service import rematch_user

    db = SessionLocal()
    try:
        return rematch_user(db, user_id)
    finally:
        db.close()


@celery_app.task(
    name="score_jobs_for_users",
    bind=True,
    max_retries=3,
    acks_late=True,
)
def score_jobs_for_users_task(self, job_ids: list[int], exclude_user_ids: list[int] | None = None) -> dict:
    """Score a batch of newly ingested/changed jobs for all active users.

    Idempotent: the scoring service only writes when something changed, so a
    retry after a partial failure never double-writes or clobbers newer scores.
    A failure on one (user, job) pair is captured on the row and never aborts the
    batch."""
    exclude = set(exclude_user_ids or [])
    db = SessionLocal()
    totals = {"scored": 0, "skipped": 0, "failed": 0, "profile_incomplete": 0}
    try:
        targets = [uid for uid in active_user_ids(db) if uid not in exclude]
        for job_id in job_ids:
            stats = score_users_for_job(db, job_id, targets)
            for key in totals:
                totals[key] += getattr(stats, key)
        return totals
    except Exception as exc:  # noqa: BLE001 - retry transient infra errors
        logger.exception("score_jobs_for_users failed; retrying")
        raise self.retry(exc=exc, countdown=30) from exc
    finally:
        db.close()


@celery_app.task(name="run_daily_ingestion", bind=True, max_retries=0)
def run_daily_ingestion_task(self, trigger: str = "scheduled") -> dict:
    """Beat-triggered daily ingestion across all sources."""
    from app.jobs.scheduled_ingestion import run_daily_ingestion

    db = SessionLocal()
    try:
        outcome = run_daily_ingestion(db, trigger=trigger)
        return {
            "run_id": outcome.run_id,
            "status": outcome.status,
            "jobs_inserted": outcome.jobs_inserted,
            "jobs_updated": outcome.jobs_updated,
            "jobs_expired": outcome.jobs_expired,
            "scoring_tasks_queued": outcome.scoring_tasks_queued,
        }
    finally:
        db.close()


@task_postrun.connect
def release_task_dedup(task=None, **kwargs):
    headers = getattr(getattr(task, "request", None), "headers", None) or {}
    key = headers.get("xa-dedup")
    # Header is generated by our publisher, and must never name arbitrary keys.
    if (
        isinstance(key, str)
        and key.startswith(controls.NAMESPACE + "queued:")
        and len(key) == len(controls.NAMESPACE + "queued:") + 64
    ):
        store = controls.store
        if isinstance(store, controls.RedisStore):
            try:
                value = headers.get("xa-dedup-value")
                if isinstance(value, str) and len(value) <= 128:
                    store.client.eval(
                        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
                        1,
                        key,
                        value,
                    )
            except Exception:
                logger.warning("queue_release_deferred code=STORE_UNAVAILABLE")
