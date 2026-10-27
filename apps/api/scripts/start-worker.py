"""Explicit mutually exclusive worker routing; default keeps the existing command."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings

if "--health" in sys.argv:
    if settings.durable_scoring_enabled:
        from app.jobs.durable_runner import health

        raise SystemExit(0 if health() else 1)
    os.execvp(
        "celery",
        ["celery", "-A", "app.workers.tasks.celery_app", "inspect", "ping", "-d", "celery@" + os.environ["HOSTNAME"]],
    )
elif settings.durable_scoring_enabled:
    os.execv(sys.executable, [sys.executable, "-m", "app.jobs.durable_runner"])
else:
    os.execvp(
        "celery", ["celery", "-A", "app.workers.tasks.celery_app", "worker", "--loglevel=info", "--concurrency=2"]
    )
