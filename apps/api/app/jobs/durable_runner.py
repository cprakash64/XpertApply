"""PG-authoritative runner. R1 physical contract: one supervised worker container."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import logging
import os
import selectors
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError, ProgrammingError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app.core.config import settings
from app.db.session import SessionLocal
from app.jobs.durable_producer import service as attached_service
from app.jobs.scoring_intents import Claim, DurableScoring, SyntheticResult

logger = logging.getLogger("jobpilot.durable")
HEALTH = Path("/tmp/xpertapply-durable-health.json")
LOCK = "/tmp/xpertapply-durable-supervisor.lock"
LEADER = 0x585045525453434F


# SQLSTATE/driver signals only; deterministic DB defects never enter pair retries.
TRANSIENT_SQLSTATES = frozenset(
    {"40001", "40P01", "08000", "08001", "08003", "08006", "08007", "57P01", "57P02", "57P03", "53300", "55P03"}
)


def error_category(exc):
    if isinstance(exc, IntegrityError | ProgrammingError | DataError):
        return "INTERNAL_SCORING_ERROR"
    if isinstance(exc, PoolTimeoutError):
        return "DB_UNAVAILABLE"
    if isinstance(exc, DBAPIError):
        state = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
        if state in TRANSIENT_SQLSTATES or (state is None and exc.connection_invalidated):
            return "DB_UNAVAILABLE"
        return "INTERNAL_SCORING_ERROR"
    if isinstance(exc, TimeoutError):
        return "WORKER_TIMEOUT"
    if isinstance(exc, ValueError):
        return "INPUT_TOO_LARGE" if str(exc) == "INPUT_TOO_LARGE" else "INPUT_INVALID"
    return "INTERNAL_SCORING_ERROR"


def validated_result(payload):
    values = dict(payload)
    for name in ("reasons", "gaps", "risks"):
        values[name] = tuple(values.get(name, ()))
    return SyntheticResult(**values)


def runtime_service(sessions=SessionLocal):
    with sessions() as db:
        limits = attached_service(db).limits
    return DurableScoring(sessions, limits=limits)


@dataclass
class Child:
    process: subprocess.Popen
    claim: Claim
    payload: bytes
    deadline: float
    written: int = 0
    output: bytearray = field(default_factory=bytearray)


class Supervisor:
    def __init__(self, durable, *, concurrency=None, command=None, wall_seconds=30):
        self.durable = durable
        self.concurrency = concurrency or settings.durable_scoring_concurrency
        if not 1 <= self.concurrency <= 2 or not 0 < wall_seconds <= 30:
            raise ValueError("Invalid physical execution policy")
        self.command = command  # Test injection only; never sourced from env/HTTP.
        self.wall_seconds = wall_seconds
        self.children = {}
        self.pending_results = {}
        self.io = selectors.DefaultSelector()
        self.stop = threading.Event()
        self.metrics = {
            "claims": 0,
            "success": 0,
            "retry": 0,
            "terminal": 0,
            "stale_commit_rejection": 0,
            "lease_expiry": 0,
            "result_transaction_retries": 0,
            "max_physical": 0,
        }
        self.last_maintenance = 0.0
        self.ingestion = None
        self.next_ingestion_start = 0.0

    def _kill_reap(self, child):
        if child.process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.process.pid, signal.SIGKILL)
        child.process.wait(timeout=5)

    def _dispose(self, child):
        # Retain the physical slot through kill and reap, independent of DB counters.
        self._kill_reap(child)
        for stream in (child.process.stdin, child.process.stdout):
            if stream:
                with contextlib.suppress(KeyError, ValueError):
                    self.io.unregister(stream)
                stream.close()
        self.children.pop(child.process.pid, None)

    def _outcome(self, state):
        key = {
            "SUCCEEDED": "success",
            "RETRY_WAIT": "retry",
            "TERMINAL_FAILED": "terminal",
            "STALE_WORKER": "stale_commit_rejection",
        }.get(state)
        if key:
            self.metrics[key] += 1

    def _fail(self, claim, category):
        try:
            self._outcome(self.durable.fail(claim, category))
        except (DBAPIError, PoolTimeoutError) as exc:
            logger.error("durable_transition_failed category=%s", error_category(exc))
            # Claim stays durable for bounded expiry recovery; no side transport.

    def _start(self, claim):
        child = None
        try:
            payload = self.durable.load_claim(claim)
            if payload is None:
                return
            blob = json.dumps(payload, allow_nan=False).encode()
            command = self.command or [sys.executable, "-m", "app.jobs.durable_compute", str(os.getpid())]
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONHASHSEED": "0"}
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=env,
                start_new_session=True,
                bufsize=0,
            )
            child = Child(process, claim, blob, time.monotonic() + self.wall_seconds)
            self.children[process.pid] = child
            for stream in (process.stdin, process.stdout):
                os.set_blocking(stream.fileno(), False)
            self.io.register(process.stdin, selectors.EVENT_WRITE, child)
            self.io.register(process.stdout, selectors.EVENT_READ, child)
            self.metrics["claims"] += 1
            self.metrics["max_physical"] = max(self.metrics["max_physical"], len(self.children))
        except Exception as exc:
            if child is not None:
                self._dispose(child)
            category = error_category(exc)
            if category == "INTERNAL_SCORING_ERROR":
                logger.error("durable_precompute_failed category=%s", category)
            self._fail(claim, category)

    def _pipes(self, timeout):
        for key, _event in self.io.select(timeout):
            child = key.data
            if child.process.pid not in self.children:
                continue
            if key.fileobj is child.process.stdin:
                try:
                    n = os.write(key.fd, child.payload[child.written : child.written + 8192])
                    child.written += n
                except BrokenPipeError:
                    child.written = len(child.payload)
                if child.written == len(child.payload):
                    self.io.unregister(key.fileobj)
                    key.fileobj.close()
            else:
                chunk = os.read(key.fd, 8192)
                if not chunk:
                    self.io.unregister(key.fileobj)
                child.output.extend(chunk)
                if len(child.output) > 65536:
                    self._dispose(child)
                    self._fail(child.claim, "INPUT_INVALID")

    def _finish(self):
        now = time.monotonic()
        for child in tuple(self.children.values()):
            code = child.process.poll()
            if code is None and now < child.deadline:
                continue
            if code is None:
                self._dispose(child)
                self._fail(child.claim, "WORKER_TIMEOUT")
                continue
            # Drain bounded stdout even if process exit was observed before selector readiness.
            while True:
                try:
                    chunk = os.read(child.process.stdout.fileno(), 8192)
                except BlockingIOError:
                    break
                if not chunk:
                    break
                child.output.extend(chunk)
                if len(child.output) > 65536:
                    break
            output = bytes(child.output)
            self._dispose(child)
            try:
                if code != 0:
                    self._fail(child.claim, "WORKER_TIMEOUT" if code in (-9, -24) else "WORKER_LOST")
                elif len(output) > 65536:
                    self._fail(child.claim, "INPUT_INVALID")
                else:
                    response = json.loads(output)
                    if "error" in response:
                        category = response["error"]
                        if category not in ("INPUT_INVALID", "INPUT_TOO_LARGE", "INTERNAL_SCORING_ERROR"):
                            category = "INTERNAL_SCORING_ERROR"
                        self._fail(child.claim, category)
                    else:
                        self._persist_result(child.claim, validated_result(response["result"]))
            except Exception as exc:
                self._fail(child.claim, error_category(exc))

    def _persist_result(self, claim, result, attempts=0):
        # Retry only the transaction/effect, retaining the computed result in memory.
        # The domain completion checks DB lease/token/identity on every attempt.
        try:
            self._outcome(self.durable.complete(claim, result))
            self.pending_results.pop(claim.id, None)
        except (DBAPIError, PoolTimeoutError) as exc:
            category = error_category(exc)
            if category == "DB_UNAVAILABLE" and attempts < 3:
                self.metrics["result_transaction_retries"] += 1
                self.pending_results[claim.id] = (claim, result, attempts + 1, time.monotonic() + 1)
            else:
                self.pending_results.pop(claim.id, None)
                logger.error("durable_result_transition_failed category=%s", category)
                self._fail(claim, category)

    def _retry_results(self):
        for claim, result, attempts, due in tuple(self.pending_results.values()):
            if time.monotonic() >= due:
                self._persist_result(claim, result, attempts)

    def maintenance(self):
        self.metrics["lease_expiry"] += self.durable.recover_expired(batch_size=100)
        self.durable.reconcile(batch_size=100)
        for rid in self.durable.pending_roots(batch_size=100):
            if self.stop.is_set():
                break
            token = self.durable.claim_expansion(rid)
            if token:
                self.durable.expand(rid, token, batch_size=100)
        for child in tuple(self.children.values()):
            if not self.durable.current_claim(child.claim):
                self._dispose(child)
                self.metrics["stale_commit_rejection"] += 1

    def step(self, *, claim_new=True):
        self._pipes(0.1 if self.children else 0)
        self._finish()
        self._retry_results()
        if time.monotonic() - self.last_maintenance >= settings.durable_scoring_poll_seconds:
            self.maintenance()
            self.last_maintenance = time.monotonic()
        if claim_new and not self.stop.is_set():
            for _ in range(self.concurrency - len(self.children)):
                claim = self.durable.claim()
                if claim is None:
                    break
                self._start(claim)

    def _ingestion_tick(self):
        # Existing beat ingestion remains consumable; this consumer never computes fit in ON mode.
        if self.ingestion and self.ingestion.poll() is not None:
            self.ingestion.wait()
            self.ingestion = None
        if self.ingestion is None and time.monotonic() >= self.next_ingestion_start and not self.stop.is_set():
            wrapper = (
                "import ctypes,os,signal,sys; "
                "r=ctypes.CDLL(None).prctl(1,signal.SIGKILL,0,0,0); "
                "sys.exit(2) if r or os.getppid()!=int(sys.argv[1]) else None; "
                "os.execvp('celery',['celery','-A','app.workers.tasks.celery_app','worker',"
                "'--pool=solo','--concurrency=1','--loglevel=warning'])"
            )
            self.ingestion = subprocess.Popen([sys.executable, "-c", wrapper, str(os.getpid())], start_new_session=True)
            self.next_ingestion_start = time.monotonic() + 30

    def close(self):
        self.stop.set()
        for child in tuple(self.children.values()):
            self._dispose(child)
        if self.ingestion:
            if self.ingestion.poll() is None:
                os.killpg(self.ingestion.pid, signal.SIGTERM)
                try:
                    self.ingestion.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(self.ingestion.pid, signal.SIGKILL)
                    self.ingestion.wait(timeout=5)
            self.ingestion = None
        self.io.close()


def health():
    try:
        body = json.loads(HEALTH.read_text())
        os.kill(body["pid"], 0)
        if time.time() - body["loop_at"] > 2 * settings.durable_scoring_poll_seconds + 5:
            return False
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        return bool(body["db_reachable"])
    except (OSError, ValueError, KeyError, DBAPIError):
        return False


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--health", action="store_true")
    args = parser.parse_args(argv)
    if args.health:
        return 0 if health() else 1
    if not settings.durable_scoring_enabled or sys.platform != "linux":
        raise RuntimeError("Durable runner requires explicit activation and Linux process bounds")
    lock_fd = os.open(LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        return 75
    runner = Supervisor(runtime_service())
    signal.signal(signal.SIGTERM, lambda _s, _f: runner.stop.set())
    signal.signal(signal.SIGINT, lambda _s, _f: runner.stop.set())
    from app.jobs.scheduled_ingestion import recover_abandoned_runs

    telemetry = {}
    telemetry_at = 0.0
    try:
        with SessionLocal.kw["bind"].connect().execution_options(isolation_level="AUTOCOMMIT") as leader:
            if not leader.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": LEADER}):
                return 75
            recover_abandoned_runs(SessionLocal, batch_size=100)
            while not runner.stop.is_set() or runner.children or runner.pending_results:
                try:
                    leader.execute(text("SELECT 1"))
                    runner.step(claim_new=not runner.stop.is_set())
                    if not runner.stop.is_set():
                        runner._ingestion_tick()
                    if time.monotonic() - telemetry_at >= settings.durable_scoring_poll_seconds:
                        telemetry = runner.durable.telemetry()
                        telemetry_at = time.monotonic()
                    body = {
                        "pid": os.getpid(),
                        "loop_at": time.time(),
                        "db_reachable": True,
                        "physical_active": len(runner.children),
                        **runner.metrics,
                        **telemetry,
                    }
                    temporary = HEALTH.with_suffix(".tmp")
                    temporary.write_text(json.dumps(body))
                    temporary.chmod(0o600)
                    temporary.replace(HEALTH)
                    if not runner.children:
                        if runner.pending_results:
                            time.sleep(1)
                        else:
                            runner.stop.wait(settings.durable_scoring_poll_seconds)
                except DBAPIError as exc:
                    # Fail closed on loss of PostgreSQL/leadership; reap before restart.
                    logger.error("durable_runner_stopped category=%s", error_category(exc))
                    return 1
    except DBAPIError as exc:
        logger.error("durable_runner_stopped category=%s", error_category(exc))
        return 1
    finally:
        runner.close()
        HEALTH.unlink(missing_ok=True)
        os.close(lock_fd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
