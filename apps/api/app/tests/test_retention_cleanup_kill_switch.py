"""NEW-01 — the Stage 2E retention cleanup must be OFF unless deliberately armed.

The defect this closes
----------------------
``hourly-application-retention-cleanup`` was registered in ``beat_schedule``
unconditionally, unlike every other periodic task. Starting the ``scheduler``
service — which ``docs/deployment.md`` does as part of an ordinary deploy — was
therefore enough to begin deleting Tracker rows and cascading their snapshots,
hourly, with no separate decision. Deletion is irreversible; nothing about
shipping the code should have been what armed it.

Two guards, tested independently
--------------------------------
1. registration — disabled means genuinely UNSCHEDULED, not scheduled-and-inert
2. runtime      — the task refuses on every invocation while disabled

The second is not redundant. A message queued while cleanup was enabled can
still be on the broker after an operator disables it, and a task can always be
run by hand; the schedule cannot speak to either.

What is deliberately NOT re-tested here: the Stage 2E eligibility, locking,
batching and cascade semantics. Those are unchanged and are covered by
test_application_retention_cleanup*.py. These tests only prove the switch.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app.core.config import Settings, settings
from app.db.base import Base
from app.models import entities as E
from app.workers import tasks as worker_tasks

NOW = datetime(2026, 9, 11, 12, tzinfo=UTC)
RETENTION_ENTRY = "hourly-application-retention-cleanup"


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    event.listen(engine, "connect", lambda conn, _: conn.execute("PRAGMA foreign_keys=ON"))
    Base.metadata.create_all(engine)
    session = Session(engine)
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def overdue_tracker(db: Session, suffix: str) -> E.ApplicationTracker:
    """One tracker that Stage 2E would delete: terminal, deadline in the past."""
    user = E.User(email=f"killswitch-{suffix}@example.test", hashed_password="x")
    source = E.JobSource(name=f"src-{suffix}", type="api", base_url="https://example.test")
    db.add_all([user, source])
    db.flush()
    job = E.JobPosting(
        source_id=source.id,
        external_id=f"job-{suffix}",
        title="Engineer",
        company="Acme",
        application_url="https://example.test/apply",
        source_url="https://example.test/job",
        description_raw="Engineer",
        description_clean="Engineer",
        hash_for_deduplication=f"hash-{suffix}",
    )
    db.add(job)
    db.flush()
    row = E.ApplicationTracker(
        user_id=user.id,
        job_id=job.id,
        status=E.ApplicationStatus.rejected,
        deletion_scheduled_at=NOW - timedelta(days=1),
    )
    db.add(row)
    db.commit()
    return row


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
def test_the_setting_defaults_to_disabled_when_the_variable_is_absent(monkeypatch) -> None:
    monkeypatch.delenv("RETENTION_CLEANUP_ENABLED", raising=False)
    assert Settings().retention_cleanup_enabled is False


@pytest.mark.parametrize("raw", ["false", "False", "FALSE", "0", "no", "off"])
def test_falsey_spellings_all_disable(monkeypatch, raw) -> None:
    # The value arrives as a STRING from the environment. `bool("false")` is
    # True in Python, which is exactly the trap this asserts we did not fall in.
    monkeypatch.setenv("RETENTION_CLEANUP_ENABLED", raw)
    assert Settings().retention_cleanup_enabled is False


@pytest.mark.parametrize("raw", ["true", "True", "1", "yes", "on"])
def test_truthy_spellings_all_enable(monkeypatch, raw) -> None:
    monkeypatch.setenv("RETENTION_CLEANUP_ENABLED", raw)
    assert Settings().retention_cleanup_enabled is True


def test_production_does_not_require_the_flag_to_be_true(monkeypatch) -> None:
    # False is the correct production value until deletion is separately
    # authorised, so production validation must not object to it.
    from app.core.config_validation import collect_findings

    monkeypatch.setattr(settings, "app_env", "production", raising=False)
    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    findings = collect_findings(settings)
    assert not [f for f in findings if "retention" in str(f).lower()]


# --------------------------------------------------------------------------- #
# Guard 1 — beat registration
# --------------------------------------------------------------------------- #
def test_disabled_leaves_the_retention_entry_unscheduled(monkeypatch) -> None:
    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    assert RETENTION_ENTRY not in worker_tasks.build_beat_schedule()


def test_enabled_registers_exactly_one_hourly_entry(monkeypatch) -> None:
    monkeypatch.setattr(settings, "retention_cleanup_enabled", True, raising=False)
    schedule = worker_tasks.build_beat_schedule()

    assert [k for k in schedule if k == RETENTION_ENTRY] == [RETENTION_ENTRY]
    entry = schedule[RETENTION_ENTRY]
    assert entry["task"] == "cleanup_due_application_trackers"
    # 0 * * * * — the top of every hour, unchanged from Stage 2E.
    cron = entry["schedule"]
    assert cron.minute == {0}
    assert len(cron.hour) == 24


def test_toggling_never_duplicates_or_strands_the_entry(monkeypatch) -> None:
    # Phase A enabled -> B disabled -> C enabled. Registration is derived from
    # settings each time, so it cannot accumulate stale entries.
    monkeypatch.setattr(settings, "retention_cleanup_enabled", True, raising=False)
    assert RETENTION_ENTRY in worker_tasks.build_beat_schedule()

    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    assert RETENTION_ENTRY not in worker_tasks.build_beat_schedule()

    monkeypatch.setattr(settings, "retention_cleanup_enabled", True, raising=False)
    again = worker_tasks.build_beat_schedule()
    assert sum(1 for k in again if k == RETENTION_ENTRY) == 1


@pytest.mark.parametrize("retention", [True, False])
def test_the_switch_does_not_disturb_other_periodic_tasks(monkeypatch, retention) -> None:
    monkeypatch.setattr(settings, "retention_cleanup_enabled", retention, raising=False)
    monkeypatch.setattr(settings, "job_ingestion_enabled", True, raising=False)
    schedule = worker_tasks.build_beat_schedule()
    assert schedule["daily-job-ingestion"]["task"] == "run_daily_ingestion"

    monkeypatch.setattr(settings, "job_ingestion_enabled", False, raising=False)
    assert "daily-job-ingestion" not in worker_tasks.build_beat_schedule()


# --------------------------------------------------------------------------- #
# Guard 2 — runtime refusal
# --------------------------------------------------------------------------- #
def _run_task() -> dict:
    """Invoke the task body directly, as a stale broker message or a hand-run
    would — bypassing beat entirely, which is the point."""
    return worker_tasks.cleanup_due_application_trackers_task.run()


def test_direct_invocation_while_disabled_deletes_nothing(monkeypatch, db) -> None:
    row = overdue_tracker(db, "direct")
    row_id, deadline = row.id, row.deletion_scheduled_at

    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)

    def explode(*_args, **_kwargs):  # pragma: no cover - must never run
        raise AssertionError("destructive cleanup service was reached while disabled")

    monkeypatch.setattr(
        "app.applications.retention_cleanup.cleanup_due_application_trackers", explode
    )

    result = _run_task()

    assert result == {"selected": 0, "deleted": 0, "skipped": 0, "failed": 0, "disabled": True}
    db.expire_all()
    survivor = db.get(E.ApplicationTracker, row_id)
    assert survivor is not None
    assert survivor.deletion_scheduled_at == deadline


def test_a_task_queued_while_enabled_still_refuses_after_it_is_disabled(monkeypatch, db) -> None:
    # THE case beat registration cannot cover: the message was produced while
    # cleanup was armed and is executed after an operator pulled the switch.
    row = overdue_tracker(db, "stale")
    row_id = row.id

    monkeypatch.setattr(settings, "retention_cleanup_enabled", True, raising=False)
    assert RETENTION_ENTRY in worker_tasks.build_beat_schedule()  # message legitimately produced

    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)

    def explode(*_args, **_kwargs):  # pragma: no cover - must never run
        raise AssertionError("stale queued task reached the destructive service")

    monkeypatch.setattr(
        "app.applications.retention_cleanup.cleanup_due_application_trackers", explode
    )

    assert _run_task()["disabled"] is True
    db.expire_all()
    assert db.get(E.ApplicationTracker, row_id) is not None


def test_the_disabled_path_opens_no_database_session(monkeypatch) -> None:
    # Refusing before SessionLocal() keeps a disabled deployment from holding
    # connections, and keeps the guard correct even if the database is down.
    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)

    def explode(*_args, **_kwargs):  # pragma: no cover - must never run
        raise AssertionError("a database session was opened while disabled")

    monkeypatch.setattr("app.workers.tasks.SessionLocal", explode)
    assert _run_task()["disabled"] is True


def test_the_refusal_log_carries_no_row_or_user_detail(monkeypatch, caplog) -> None:
    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    with caplog.at_level("INFO", logger="jobpilot.worker"):
        _run_task()
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert "retention cleanup disabled" in messages
    for leak in ("@", "user_id", "tracker_id", "job_id", "SELECT"):
        assert leak not in messages


# --------------------------------------------------------------------------- #
# Pause semantics — the deadline must survive
# --------------------------------------------------------------------------- #
def test_pausing_does_not_rewrite_the_retention_schedule(monkeypatch, db) -> None:
    row = overdue_tracker(db, "pause")
    row_id, original_deadline = row.id, row.deletion_scheduled_at

    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    for _ in range(3):  # several missed hours
        _run_task()

    db.expire_all()
    paused = db.get(E.ApplicationTracker, row_id)
    assert paused is not None
    assert paused.deletion_scheduled_at == original_deadline
    assert paused.deletion_cancelled_at is None
    assert paused.status == E.ApplicationStatus.rejected


def test_re_enabling_processes_the_row_that_came_due_during_the_pause(monkeypatch, db) -> None:
    from app.applications.retention_cleanup import cleanup_due_application_trackers

    row = overdue_tracker(db, "resume")
    row_id = row.id

    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    _run_task()
    db.expire_all()
    assert db.get(E.ApplicationTracker, row_id) is not None

    # Re-armed: the same overdue row is eligible immediately, with the Stage 2E
    # contract untouched. Called against the test session rather than through
    # the task, whose SessionLocal points at a different database.
    monkeypatch.setattr(settings, "retention_cleanup_enabled", True, raising=False)
    result = cleanup_due_application_trackers(db, now=NOW)

    assert result.as_dict() == {"selected": 1, "deleted": 1, "skipped": 0, "failed": 0}
    assert db.get(E.ApplicationTracker, row_id) is None


# --------------------------------------------------------------------------- #
# Worker / beat disagreement
# --------------------------------------------------------------------------- #
def test_beat_enabled_but_worker_disabled_is_safe(monkeypatch, db) -> None:
    # Two processes, two copies of the setting. The one that can delete is the
    # worker, and it refuses — so the asymmetry fails closed.
    row = overdue_tracker(db, "asymmetric")
    row_id = row.id

    monkeypatch.setattr(settings, "retention_cleanup_enabled", True, raising=False)
    assert RETENTION_ENTRY in worker_tasks.build_beat_schedule()  # beat still emits

    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    assert _run_task()["disabled"] is True  # worker refuses
    db.expire_all()
    assert db.get(E.ApplicationTracker, row_id) is not None


def test_beat_disabled_but_worker_enabled_emits_nothing(monkeypatch) -> None:
    monkeypatch.setattr(settings, "retention_cleanup_enabled", False, raising=False)
    assert RETENTION_ENTRY not in worker_tasks.build_beat_schedule()
