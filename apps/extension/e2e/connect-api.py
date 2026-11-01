"""E2E launcher: the REAL XpertApply API (this checkout) on a throwaway SQLite database.

Environment: XA_API_PORT, XA_API_DB (file path). Everything else (SECRET_KEY, EXTENSION_ALLOWED_IDS,
CORS_ORIGINS, APP_ENV) comes from the spec's environment, so the real allowlist and CORS code run.
"""

import os
import sys

import uvicorn
from sqlalchemy import create_engine

sys.path.insert(0, os.environ["XA_API_ROOT"])
os.environ["DATABASE_URL"] = f"sqlite:///{os.environ['XA_API_DB']}"

from app.db.base import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.models import entities  # noqa: E402,F401

Base.metadata.create_all(create_engine(os.environ["DATABASE_URL"]))
uvicorn.run(app, host="127.0.0.1", port=int(os.environ["XA_API_PORT"]), log_level="warning")
