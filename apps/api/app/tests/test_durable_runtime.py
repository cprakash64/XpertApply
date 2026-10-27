"""Pure execution policy and failure classification contracts; no Linux skips."""

import pytest
from sqlalchemy.exc import OperationalError

from app.core.config import Settings
from app.jobs.durable_runner import Supervisor, error_category, validated_result


@pytest.mark.parametrize(
    "exception,category",
    [
        (OperationalError(None, None, Exception("private")), "DB_UNAVAILABLE"),
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
