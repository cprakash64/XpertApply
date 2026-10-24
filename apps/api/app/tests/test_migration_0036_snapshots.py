"""Revision 0036 is additive and reversible, and matches the model.

Runs the revision's own upgrade() and downgrade() against a throwaway in-memory SQLite database that holds only the tables it
references. It never touches a real database. (The Postgres-backed migration tests skip when no scratch server is reachable; this
one always runs.)"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect

from app.db.base import Base
from app.models import entities as E

PATH = Path(__file__).resolve().parents[2] / "alembic" / "versions" / "0036_application_doc_snapshots.py"


def _revision():
    spec = importlib.util.spec_from_file_location("rev0036", PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_adds_the_table_and_downgrade_removes_it_without_touching_others() -> None:
    engine = create_engine("sqlite://")
    prerequisites = [E.User.__table__, E.JobSource.__table__, E.JobPosting.__table__, E.ApplicationTracker.__table__, E.GeneratedDocument.__table__]
    Base.metadata.create_all(engine, tables=prerequisites)
    revision = _revision()
    assert revision.down_revision == "0035_extension_auth" and len(revision.revision) <= 32
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            revision.upgrade()
    inspector = inspect(engine)
    assert "application_document_snapshots" in inspector.get_table_names()
    migrated = {c["name"] for c in inspector.get_columns("application_document_snapshots")}
    assert migrated == {c.name for c in E.ApplicationDocumentSnapshot.__table__.columns}      # the model and the migration agree
    assert {u["name"] for u in inspector.get_unique_constraints("application_document_snapshots")} == {"uq_doc_snapshot_tracker_kind"}
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            revision.downgrade()
    after = inspect(engine).get_table_names()
    assert "application_document_snapshots" not in after
    assert {"application_tracker", "generated_documents", "users"} <= set(after)
    engine.dispose()
