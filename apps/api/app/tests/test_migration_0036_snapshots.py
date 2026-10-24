"""Revision 0036 is additive and reversible, and matches the model.

Runs the revision's own upgrade() and downgrade() against a throwaway in-memory SQLite database that holds only the tables it
references. It never touches a real database. (The Postgres-backed migration tests skip when no scratch server is reachable; this
one always runs.)"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text

from app.db.base import Base
from app.models import entities as E

VERSIONS = Path(__file__).resolve().parents[2] / "alembic" / "versions"
PATH = VERSIONS / "0036_application_doc_snapshots.py"
PATH_0037 = VERSIONS / "0037_snapshot_association_basis.py"


def _revision(path: Path = PATH):
    spec = importlib.util.spec_from_file_location(f"rev_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_0036_as_deployed_then_0037_add_the_basis_column_and_both_reverse_cleanly() -> None:
    engine = create_engine("sqlite://")
    prerequisites = [E.User.__table__, E.JobSource.__table__, E.JobPosting.__table__, E.ApplicationTracker.__table__, E.GeneratedDocument.__table__]
    Base.metadata.create_all(engine, tables=prerequisites)
    r36, r37 = _revision(PATH), _revision(PATH_0037)
    assert r36.down_revision == "0035_extension_auth" and len(r36.revision) <= 32
    assert r37.down_revision == r36.revision and len(r37.revision) <= 32

    def run(fn) -> None:
        with engine.begin() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                fn()

    run(r36.upgrade)
    inspector = inspect(engine)
    assert "application_document_snapshots" in inspector.get_table_names()
    deployed = {c["name"] for c in inspector.get_columns("application_document_snapshots")}
    assert "association_basis" not in deployed                      # 0036 is exactly what staging already has
    with engine.begin() as connection:                               # a row that exists on staging before 0037
        connection.execute(E.User.__table__.insert().values(id=1, email="a@example.test", hashed_password="x"))


    run(r37.upgrade)
    after = {c["name"] for c in inspect(engine).get_columns("application_document_snapshots")}
    assert after == {c.name for c in E.ApplicationDocumentSnapshot.__table__.columns}      # the model and the migrations agree
    assert {u["name"] for u in inspect(engine).get_unique_constraints("application_document_snapshots")} == {"uq_doc_snapshot_tracker_kind"}

    run(r37.downgrade)
    assert {c["name"] for c in inspect(engine).get_columns("application_document_snapshots")} == deployed
    run(r36.downgrade)
    after_all = inspect(engine).get_table_names()
    assert "application_document_snapshots" not in after_all
    assert {"application_tracker", "generated_documents", "users"} <= set(after_all)
    engine.dispose()
