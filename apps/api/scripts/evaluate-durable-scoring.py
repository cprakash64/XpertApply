"""Disposable Linux/real-PostgreSQL fault evaluation; no existing application DB is opened.

python scripts/evaluate-durable-scoring.py --synthetic-only --admin-url "$MIGRATION_TEST_DATABASE_URL"
Only synthetic scratch databases are created and dropped. No paid provider is called.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def wait_for(check, seconds=45):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("Bounded validation wait exceeded")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--synthetic-only", action="store_true", required=True)
    parser.add_argument("--admin-url", required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise RuntimeError("Linux is required to verify physical process bounds")
    url = make_url(args.admin_url)
    if url.get_backend_name() != "postgresql" or url.database != "postgres":
        raise RuntimeError("An explicitly designated disposable PostgreSQL admin database is required")
    name = "durable_runtime_" + uuid.uuid4().hex[:12]
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    target = url.set(database=name).render_as_string(hide_password=False)
    os.environ.update(
        DATABASE_URL=target,
        DURABLE_SCORING_ENABLED="true",
        APP_ENV="test",
        DEBUG="false",
        REDIS_URL="redis://127.0.0.1:1/0",
        JOB_INGESTION_ENABLED="false",
    )
    with admin.connect() as db:
        db.execute(text('CREATE DATABASE "' + name + '"'))
    processes = []
    engine = None
    results = {}
    try:
        from app.db.base import Base
        from app.jobs.durable_compute import compute
        from app.jobs.durable_runner import Supervisor, validated_result
        from app.jobs.scoring_intents import DurableScoring, SyntheticResult
        from app.models.entities import (
            JobMatch,
            JobPosting,
            ScoringCapacity,
            ScoringIntent,
            ScoringJob,
            User,
            UserProfile,
        )

        engine = create_engine(target)
        Base.metadata.create_all(engine)
        sessions = sessionmaker(engine, autoflush=False, expire_on_commit=False)
        durable = DurableScoring(sessions)
        with sessions.begin() as db:
            db.add(ScoringCapacity(id=1))
            db.add_all([User(id=i, email=f"synthetic-{i}@example.test", hashed_password="synthetic") for i in (1, 2)])
            db.flush()
            for i in (1, 2):
                db.add(UserProfile(user_id=i, target_roles=["Engineer"], skills=["Python"]))
                db.add(
                    JobPosting(
                        id=i,
                        external_id=f"synthetic-{i}",
                        title="Engineer",
                        company="Synthetic",
                        description_clean="Python",
                        required_skills=["Python"],
                        posted_at=datetime.now(UTC),
                        is_active=True,
                        application_url="https://example.test/apply",
                        source_url="https://example.test/job",
                        hash_for_deduplication=f"synthetic-{i}",
                    )
                )
        producer = (
            "import os; from sqlalchemy import event; from app.db.session import SessionLocal; "
            "from app.models.entities import User; from app.schemas.profile import UserProfilePatch; "
            "from app.routes.profile import patch_profile; db=SessionLocal(); "
            "event.listen(db,'after_commit',lambda session:os._exit(73)); "
            "patch_profile(UserProfilePatch(skills=['Python','SQL']),db.get(User,1),db)"
        )
        crash = subprocess.run([sys.executable, "-c", producer], capture_output=True, timeout=60)
        assert crash.returncode == 73, "Actual producer did not crash at after_commit"
        with sessions() as db:
            assert db.get(User, 1).scoring_generation == 1
            assert db.scalar(select(func.count()).select_from(ScoringIntent)) == 1
            assert db.scalar(select(func.count()).select_from(JobMatch)) == 0
        results["actual_producer_crash_immediately_after_commit"] = True
        runner = subprocess.Popen(
            [sys.executable, "-m", "app.jobs.durable_runner"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        processes.append(runner)

        def complete():
            with sessions() as db:
                return (
                    db.scalar(
                        select(func.count())
                        .select_from(JobMatch)
                        .where(JobMatch.user_id == 1, JobMatch.score_state == "scored")
                    )
                    == 2
                )

        wait_for(complete)
        duplicate = subprocess.run([sys.executable, "-m", "app.jobs.durable_runner"], capture_output=True, timeout=10)
        assert duplicate.returncode == 75
        runner.send_signal(signal.SIGTERM)
        assert runner.wait(timeout=35) == 0
        with sessions() as db:
            matches = db.scalars(select(JobMatch).where(JobMatch.user_id == 1)).all()
            assert len(matches) == 2 and all(m.scoring_attempts == 1 for m in matches)
            assert all(m.scoring_job_id is not None and m.completed_user_generation == 1 for m in matches)
        results.update(
            crash_after_commit_restarted_actual_runner=True,
            redis_down_actual_runner=True,
            exactly_one_result_effect_per_pair=True,
            duplicate_supervisor_denied=True,
            graceful_stop=True,
        )
        # Two actual isolated compute children, with logical caps independent of physical slots.
        receipt = durable.accept("USER_REFRESH", user_id=2, actor_user_id=2)
        token = durable.claim_expansion(receipt.id)
        durable.expand(receipt.id, token)
        supervisor = Supervisor(durable)
        start = time.monotonic()
        try:
            wait_for(lambda: (supervisor.step() or supervisor.metrics["success"] == 2), seconds=30)
            assert supervisor.metrics["max_physical"] <= 2
        finally:
            supervisor.close()
        results["representative_two_pair_seconds"] = round(time.monotonic() - start, 4)
        results["max_physical"] = supervisor.metrics["max_physical"]
        # Same generation/date operation is immutable and never creates retry fanout.
        duplicate_receipt = durable.accept("USER_REFRESH", user_id=2, actor_user_id=2)
        assert duplicate_receipt.id == receipt.id and duplicate_receipt.existing
        results["duplicate_acceptance"] = True
        # Resource fault injection is local dependency injection, never an environment/HTTP switch.
        with sessions.begin() as db:
            db.get(User, 2).scoring_generation += 1
        root = durable.accept("PAIR_REFRESH", user_id=2, job_id=1, actor_user_id=2)
        pair = durable.expand(root.id, durable.claim_expansion(root.id))[0]
        hanging = Supervisor(durable, command=[sys.executable, "-c", "import time; time.sleep(60)"], wall_seconds=0.4)
        try:
            wait_for(lambda: (hanging.step() or hanging.metrics["retry"] == 1), seconds=10)
            assert not hanging.children
            with sessions() as db:
                row = db.get(ScoringJob, pair)
                assert row.status == "RETRY_WAIT" and row.attempt_count == 1 and row.error_category == "WORKER_TIMEOUT"
        finally:
            hanging.close()
        results["wall_timeout_kill_reap_before_retry"] = True
        with sessions.begin() as db:
            db.get(ScoringJob, pair).next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
        dying = Supervisor(durable, command=[sys.executable, "-c", "import os; os._exit(7)"])
        try:
            wait_for(lambda: (dying.step() or dying.metrics["retry"] == 1), seconds=10)
            with sessions() as db:
                assert db.get(ScoringJob, pair).attempt_count == 2
                assert db.get(ScoringJob, pair).error_category == "WORKER_LOST"
        finally:
            dying.close()
        results["worker_crash_shared_retry_budget"] = True
        with sessions.begin() as db:
            db.get(ScoringJob, pair).next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
        claim = durable.claim(pair)
        expected = validated_result(compute(durable.load_claim(claim)))
        assert durable.complete(claim, expected) == "SUCCEEDED"
        assert durable.complete(claim, SyntheticResult(99)) == "STALE_WORKER"
        results["third_attempt_succeeds_stale_duplicate_fenced"] = True
        with sessions() as db:
            cap = db.get(ScoringCapacity, 1)
            assert (cap.live_intents, cap.live_children, cap.reserved_units, cap.running_pairs) == (0, 0, 0, 0)
        results["all_capacity_released_once"] = True
        # Observe the production compute module's applied bounds before releasing stdin.
        bounded = subprocess.Popen(
            [sys.executable, "-m", "app.jobs.durable_compute", str(os.getpid())],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"PATH": os.environ["PATH"], "PYTHONHASHSEED": "0"},
        )
        processes.append(bounded)
        limits_path = Path(f"/proc/{bounded.pid}/limits")
        wait_for(lambda: "268435456" in limits_path.read_text(), seconds=5)
        limits = limits_path.read_text()
        cpu_line = next(line for line in limits.splitlines() if line.startswith("Max cpu time"))
        assert "20" in cpu_line
        child_env = Path(f"/proc/{bounded.pid}/environ").read_bytes()
        assert not any(
            key in child_env for key in (b"DATABASE_URL=", b"SECRET_KEY=", b"OPENAI_API_KEY=", b"REDIS_URL=")
        )
        out, _ = bounded.communicate(b"{}", timeout=10)
        assert json.loads(out) == {"error": "INPUT_INVALID"}
        results.update(
            production_child_cpu_seconds=20,
            production_child_address_bytes=268435456,
            production_child_credentials_absent=True,
        )
        # Two different actors can occupy both physical slots; a single actor cannot.
        with sessions.begin() as db:
            for uid in (1, 2):
                db.get(User, uid).scoring_generation += 1
        roots = [durable.accept("PAIR_REFRESH", user_id=uid, job_id=2, actor_user_id=uid) for uid in (1, 2)]
        for root in roots:
            durable.expand(root.id, durable.claim_expansion(root.id))
        both = Supervisor(durable)
        try:
            wait_for(lambda: (both.step() or both.metrics["success"] == 2), seconds=30)
            assert both.metrics["max_physical"] == 2
        finally:
            both.close()
        results["two_actor_physical_max"] = 2
        # Kill an actual supervisor while production children are active. PDEATHSIG
        # terminates descendants; persisted leases remain for bounded PG recovery.
        with sessions.begin() as db:
            for uid in (1, 2):
                db.get(User, uid).scoring_generation += 1
        forced_roots = [durable.accept("PAIR_REFRESH", user_id=uid, job_id=2, actor_user_id=uid) for uid in (1, 2)]
        forced = subprocess.Popen(
            [sys.executable, "-m", "app.jobs.durable_runner"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        processes.append(forced)

        def active_descendants():
            health = Path("/tmp/xpertapply-durable-health.json")
            if not health.exists():
                return None
            state = json.loads(health.read_text())
            if state["pid"] != forced.pid or state["physical_active"] < 1:
                return None
            return [int(pid) for pid in Path(f"/proc/{forced.pid}/task/{forced.pid}/children").read_text().split()]

        descendants = wait_for(active_descendants, seconds=20)
        forced.kill()
        forced.wait(timeout=5)

        def all_dead():
            for pid in descendants:
                stat = Path(f"/proc/{pid}/stat")
                if stat.exists() and stat.read_text().split()[2] != "Z":
                    return False
            return True

        wait_for(all_dead, seconds=5)
        with sessions.begin() as db:
            for row in db.scalars(select(ScoringJob).where(ScoringJob.status == "CLAIMED")):
                row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        assert durable.recover_expired() >= 1
        with sessions.begin() as db:
            for row in db.scalars(select(ScoringJob).where(ScoringJob.status == "RETRY_WAIT")):
                row.next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
        resumed = Supervisor(durable)
        try:

            def recovered_results():
                resumed.step()
                with sessions() as db:
                    return all(db.get(ScoringIntent, root.id).status == "SUCCEEDED" for root in forced_roots)

            wait_for(recovered_results, seconds=30)
        finally:
            resumed.close()
        results.update(forced_supervisor_children_die=True, forced_restart_recovers_pg_leases=True)
        print(json.dumps({"pass": True, "synthetic_only": True, "results": results}, sort_keys=True))
        return 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
        if engine is not None:
            engine.dispose()
        with admin.connect() as db:
            db.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname=:name AND pid<>pg_backend_pid()"
                ),
                {"name": name},
            )
            db.execute(text('DROP DATABASE IF EXISTS "' + name + '"'))
        admin.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
