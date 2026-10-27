"""Pure execution policy and failure classification contracts; no Linux skips."""

import pytest
from sqlalchemy.exc import OperationalError

from app.core.config import Settings
from app.jobs.durable_runner import Supervisor, error_category, validated_result


@pytest.mark.parametrize(
    "exception,category",
    [
        (OperationalError(None, None, Exception("private"), connection_invalidated=True), "DB_UNAVAILABLE"),
        (TimeoutError("private"), "WORKER_TIMEOUT"),
        (ValueError("INPUT_TOO_LARGE"), "INPUT_TOO_LARGE"),
        (ValueError("private"), "INPUT_INVALID"),
        (RuntimeError("private"), "INTERNAL_SCORING_ERROR"),
    ],
)
def test_only_fixed_allowlisted_error_categories(exception, category):
    assert error_category(exception) == category


@pytest.mark.parametrize("concurrency,wall", [(3, 30), (1, 31), (1, 0)])
def test_physical_policy_cannot_exceed_contract(concurrency, wall):
    with pytest.raises(ValueError):
        Supervisor(None, concurrency=concurrency, wall_seconds=wall)


def test_default_off_and_result_validation():
    assert Settings(_env_file=None).durable_scoring_enabled is False
    with pytest.raises(ValueError):
        validated_result({"fit_score": 101})
    with pytest.raises(ValueError):
        validated_result({"fit_score": 80, "risks": ["private"] * 21})


class DriverFailure(Exception):
    def __init__(self, sqlstate=None):
        self.sqlstate = sqlstate


@pytest.mark.parametrize("state", ["40001", "40P01", "08006", "57P03", "53300", "55P03"])
def test_allowlisted_transient_sqlstates(state):
    assert error_category(OperationalError(None, None, DriverFailure(state))) == "DB_UNAVAILABLE"


@pytest.mark.parametrize("state", [None, "23514", "42501", "42P01", "22000", "0A000", "XX000"])
def test_unknown_and_nontransient_database_errors_are_terminal(state):
    from sqlalchemy.exc import DBAPIError

    assert error_category(DBAPIError(None, None, DriverFailure(state))) == "INTERNAL_SCORING_ERROR"


@pytest.mark.parametrize("name", ["IntegrityError", "ProgrammingError", "DataError"])
def test_database_defects_never_become_transient_even_if_invalidated(name):
    import sqlalchemy.exc

    exception = getattr(sqlalchemy.exc, name)(None, None, DriverFailure("23514"), connection_invalidated=True)
    assert error_category(exception) == "INTERNAL_SCORING_ERROR"


def test_connection_invalidation_and_pool_timeout_are_transient():
    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.exc import TimeoutError as PoolTimeoutError

    assert error_category(DBAPIError(None, None, DriverFailure(), connection_invalidated=True)) == "DB_UNAVAILABLE"
    assert error_category(PoolTimeoutError("private")) == "DB_UNAVAILABLE"


def test_result_transaction_retries_retain_compute_output_without_reclaim(monkeypatch):
    from app.jobs.scoring_intents import SyntheticResult

    class Service:
        count = 0

        def complete(self, claim, result):
            self.count += 1
            if self.count < 3:
                raise OperationalError(None, None, DriverFailure("40001"))
            return "SUCCEEDED"

        def fail(self, *_):
            raise AssertionError("Logical computation retry was used")

    service = Service()
    runner = Supervisor(service)
    claim = type("Claim", (), {"id": 1})()
    result = SyntheticResult(80)
    try:
        runner._persist_result(claim, result)
        assert runner.pending_results[1][1] is result
        monkeypatch.setattr("app.jobs.durable_runner.time.monotonic", lambda: 10**12)
        runner._retry_results()
        monkeypatch.setattr("app.jobs.durable_runner.time.monotonic", lambda: 10**12 + 2)
        runner._retry_results()
        assert runner.metrics["success"] == 1 and not runner.pending_results
        assert service.count == 3
    finally:
        runner.close()


def test_result_nontransient_failure_terminalizes_without_transaction_retry():
    from sqlalchemy.exc import IntegrityError

    from app.jobs.scoring_intents import SyntheticResult

    class Service:
        failures = []

        def complete(self, *_):
            raise IntegrityError(None, None, DriverFailure("23514"))

        def fail(self, claim, category):
            self.failures.append(category)
            return "TERMINAL_FAILED"

    service = Service()
    runner = Supervisor(service)
    try:
        runner._persist_result(type("Claim", (), {"id": 1})(), SyntheticResult(80))
        assert service.failures == ["INTERNAL_SCORING_ERROR"]
        assert not runner.pending_results
    finally:
        runner.close()


def test_durable_compatibility_deterministic_error_does_not_celery_retry(monkeypatch):
    from app.core.config import settings
    from app.jobs import job_ingestion_service
    from app.workers import tasks

    class DB:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

    monkeypatch.setattr(settings, "durable_scoring_enabled", True)
    monkeypatch.setattr(tasks, "SessionLocal", DB)

    def failure(*_):
        raise ValueError("synthetic deterministic failure")

    def forbidden(*_, **__):
        raise AssertionError("Celery retry called")

    monkeypatch.setattr(job_ingestion_service, "enqueue_scoring_for_jobs", failure)
    monkeypatch.setattr(tasks.score_jobs_for_users_task, "retry", forbidden)
    with pytest.raises(ValueError):
        tasks.score_jobs_for_users_task.run([1])


def test_legacy_compatibility_transient_error_keeps_celery_retry(monkeypatch):
    from app.core.config import settings
    from app.workers import tasks

    class DB:
        def close(self):
            pass

    monkeypatch.setattr(settings, "durable_scoring_enabled", False)
    monkeypatch.setattr(tasks, "SessionLocal", DB)

    def failure(*_):
        raise TimeoutError("synthetic legacy outage")

    monkeypatch.setattr(tasks, "active_user_ids", failure)
    observed = []

    def retry(**kwargs):
        observed.append(kwargs)
        return RuntimeError("legacy retry sentinel")

    monkeypatch.setattr(tasks.score_jobs_for_users_task, "retry", retry)
    with pytest.raises(RuntimeError, match="legacy retry sentinel"):
        tasks.score_jobs_for_users_task.run([1])
    assert observed[0]["countdown"] == 30


@pytest.mark.parametrize("enabled", [None, "false", "true"])
def test_activation_requires_explicit_true(monkeypatch, enabled):
    monkeypatch.delenv("DURABLE_SCORING_ENABLED", raising=False)
    if enabled is not None:
        monkeypatch.setenv("DURABLE_SCORING_ENABLED", enabled)
    assert Settings(_env_file=None).durable_scoring_enabled is (enabled == "true")


def test_transient_result_transaction_retries_are_bounded():
    from app.jobs.scoring_intents import SyntheticResult

    class Service:
        count = 0
        failures = []

        def complete(self, *_):
            self.count += 1
            raise OperationalError(None, None, DriverFailure("40P01"))

        def fail(self, claim, category):
            self.failures.append(category)
            return "RETRY_WAIT"

    service = Service()
    runner = Supervisor(service)
    claim = type("Claim", (), {"id": 1})()
    result = SyntheticResult(80)
    try:
        for attempt in range(4):
            runner._persist_result(claim, result, attempt)
        assert service.count == 4 and not runner.pending_results
        assert service.failures == ["DB_UNAVAILABLE"]
        assert runner.metrics["retry"] == 1
    finally:
        runner.close()


def test_transient_precompute_failure_never_starts_compute_child():
    class Service:
        def load_claim(self, *_):
            raise OperationalError(None, None, DriverFailure("40001"))

        def fail(self, claim, category):
            assert category == "DB_UNAVAILABLE"
            return "RETRY_WAIT"

    runner = Supervisor(Service())
    try:
        runner._start(object())
        assert not runner.children and runner.metrics["claims"] == 0
        assert runner.metrics["retry"] == 1
    finally:
        runner.close()
