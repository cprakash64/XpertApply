"""Alembic revision ids must fit the version table.

``alembic_version.version_num`` is VARCHAR(32). SQLite ignores VARCHAR limits,
so an over-long revision id passes the whole test suite and then fails on the
first PostgreSQL deploy — which is exactly what happened to 0029 before it was
renamed. This keeps that from recurring silently.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

VERSIONS = Path(__file__).resolve().parents[2] / "alembic" / "versions"
#: Alembic's own default column width.
MAX_REVISION_LENGTH = 32


def _revision_ids() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for path in sorted(VERSIONS.glob("*.py")):
        # Both styles appear in this repo: `revision = "..."` and the typed
        # `revision: str = "..."`.
        pattern = r'^revision(?::\s*str)?\s*=\s*["\']([^"\']+)["\']'
        match = re.search(pattern, path.read_text(), re.M)
        if match:
            found.append((path.name, match.group(1)))
    return found


def test_migrations_were_discovered() -> None:
    assert len(_revision_ids()) > 20


@pytest.mark.parametrize("filename,revision", _revision_ids())
def test_revision_id_fits_the_version_column(filename: str, revision: str) -> None:
    assert len(revision) <= MAX_REVISION_LENGTH, (
        f"{filename}: revision id is {len(revision)} chars; PostgreSQL will reject "
        f"anything over {MAX_REVISION_LENGTH}"
    )
