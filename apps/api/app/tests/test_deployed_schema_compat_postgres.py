"""The corrected application against the schema that is ALREADY DEPLOYED (XA-RC-06-B-R3).

Staging is at ``0036_application_doc_snapshots`` and its table already has ``association_basis`` (VARCHAR(24) NOT NULL DEFAULT
'sole_session'), because the 0036 that was deployed (commit 959b994) creates it. These tests pin that: the revision file is
byte-identical to the deployed one, the graph has one head and needs no further migration, and the current code reads and writes that
exact schema. Real PostgreSQL only (MIGRATION_TEST_DATABASE_URL); nothing here uses SQLite.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DataError

from app.applications.document_association import ASSOCIATION_BASES
from app.tests.test_application_applied_migration import (  # noqa: F401  (fixtures and helpers)
    _ADMIN_URL,
    _alembic_config,
    _pin_database_url,
    requires_postgres,
    scratch_database,
)
from app.tests.test_tracker_provenance_postgres import (  # noqa: F401
    Live,
    _assert_downloads,
    _confirm_with_session,
    _docx_text,
    _tag_documents,
    live,
    spawn_api,
    stop_api,
)

pytestmark = [pytest.mark.migration, requires_postgres]

VERSIONS = Path(__file__).resolve().parents[2] / "alembic" / "versions"
API_DIR = Path(__file__).resolve().parents[2]
REVISION_0036 = VERSIONS / "0036_application_doc_snapshots.py"
#: SHA-256 of 0036 as deployed on staging (commit 959b994). The deployed revision is immutable.
DEPLOYED_0036_SHA256 = "b1a697c3247804c4e6a01dbc4bdc99a35598cfdd2a73ee743e56dd0c304b66cd"
HEAD = "0036_application_doc_snapshots"


def _alembic(url: str, *args: str, cwd: Path = API_DIR) -> str:
    env = {**os.environ, "DATABASE_URL": url, "PYTHONPATH": str(cwd)}
    done = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr[-1500:]
    return done.stdout + done.stderr


def test_the_deployed_revision_is_byte_identical_and_is_the_only_head() -> None:
    from alembic.script import ScriptDirectory

    assert hashlib.sha256(REVISION_0036.read_bytes()).hexdigest() == DEPLOYED_0036_SHA256
    script = ScriptDirectory(str(API_DIR / "alembic"))
    assert script.get_heads() == ["0034_password_reset"]   # one head: password reset sits on the deployed 0036
    assert script.get_revision("0034_password_reset").down_revision == HEAD
    known = {rev.revision for rev in script.walk_revisions()}
    for rev in script.walk_revisions():                                            # no unresolved or dangling revision
        for parent in ([rev.down_revision] if isinstance(rev.down_revision, str) else list(rev.down_revision or ())):
            assert parent in known, f"{rev.revision} points at unknown {parent}"
    assert not list(VERSIONS.glob("0037*"))


def test_fresh_upgrade_through_0036_yields_the_exact_deployed_column(scratch_database: str) -> None:
    _alembic(scratch_database, "upgrade", "0035_extension_auth")
    engine = create_engine(scratch_database)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('public.application_document_snapshots')")).scalar_one() is None
    _alembic(scratch_database, "upgrade", HEAD)
    with engine.connect() as conn:
        col = conn.execute(text(
            "SELECT data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_name = 'application_document_snapshots' AND column_name = 'association_basis'")).one()
        assert (col.data_type, col.character_maximum_length, col.is_nullable) == ("character varying", 24, "NO")
        assert col.column_default == "'sole_session'::character varying"           # exactly what the live inspection reported
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == HEAD
    engine.dispose()


def test_running_the_approved_upgrade_twice_is_non_destructive(scratch_database: str) -> None:
    _alembic(scratch_database, "upgrade", HEAD)
    engine = create_engine(scratch_database)
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO users (id, email, hashed_password) VALUES (1, 'a@example.test', 'x')"))
        conn.execute(text("INSERT INTO job_sources (id, name, type, base_url, enabled, supports_api) VALUES (1, 'Acme', 'greenhouse', 'https://x.test', true, true)"))
        conn.execute(text(
            "INSERT INTO job_postings (id, source_id, external_id, title, company, application_url, source_url, description_raw, description_clean, required_skills, "
            "preferred_skills, responsibilities, raw_json, hash_for_deduplication, is_active) VALUES (1, 1, 'e', 'T', 'Acme', 'https://x.test', 'https://x.test', '', '', '[]', '[]', '[]', '{}', 'h', true)"))
        conn.execute(text("INSERT INTO application_tracker (id, user_id, job_id, status) VALUES (1, 1, 1, 'applied')"))
        conn.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content, association_basis) VALUES (1, 1, 'resume', '{\"s\": 1}', 'confirming_session')"))
    before = _snapshot_rows(engine)
    output = _alembic(scratch_database, "upgrade", HEAD)
    assert "Running upgrade" not in output                                          # nothing left to run: no duplicate-column attempt
    assert _snapshot_rows(engine) == before
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == HEAD
    engine.dispose()


def _snapshot_rows(engine) -> list[tuple]:
    with engine.connect() as conn:
        return [tuple(r) for r in conn.execute(text(
            "SELECT id, user_id, tracker_id, kind, content::text, plain_text, attached_by_extension, association_basis, created_at "
            "FROM application_document_snapshots ORDER BY id"))]


def test_every_association_basis_fits_the_deployed_column(scratch_database: str) -> None:
    assert all(len(value) <= 24 for value in ASSOCIATION_BASES)
    assert set(ASSOCIATION_BASES) == {"confirming_session", "linked_session", "sole_session", "job_document"}
    _alembic(scratch_database, "upgrade", HEAD)
    engine = create_engine(scratch_database)
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO users (id, email, hashed_password) VALUES (1, 'a@example.test', 'x')"))
        conn.execute(text("INSERT INTO job_sources (id, name, type, base_url, enabled, supports_api) VALUES (1, 'Acme', 'greenhouse', 'https://x.test', true, true)"))
        for i in range(1, 6):
            conn.execute(text(
                "INSERT INTO job_postings (id, source_id, external_id, title, company, application_url, source_url, description_raw, description_clean, required_skills, "
                "preferred_skills, responsibilities, raw_json, hash_for_deduplication, is_active) VALUES (:i, 1, :e, 'T', 'Acme', 'https://x.test', 'https://x.test', '', '', '[]', '[]', '[]', '{}', :h, true)"),
                {"i": i, "e": f"e{i}", "h": f"h{i}"})
            conn.execute(text("INSERT INTO application_tracker (id, user_id, job_id, status) VALUES (:i, 1, :i, 'applied')"), {"i": i})
        for i, basis in enumerate(ASSOCIATION_BASES, start=1):
            conn.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content, association_basis) VALUES (1, :t, 'resume', '{}', :b)"), {"t": i, "b": basis})
        conn.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content) VALUES (1, 5, 'resume', '{}')"))   # the column default
    with engine.connect() as conn:
        assert [r[0] for r in conn.execute(text("SELECT association_basis FROM application_document_snapshots ORDER BY id"))] == [*ASSOCIATION_BASES, "sole_session"]
    with pytest.raises(DataError):                                                 # the column really is 24 wide
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO application_document_snapshots (user_id, tracker_id, kind, content, association_basis) VALUES (1, 1, 'cover_letter', '{}', :b)"), {"b": "x" * 25})
    engine.dispose()


def test_snapshots_written_over_http_use_only_declared_bases_and_survive_edits(live: Live) -> None:
    """The current API on the deployed schema: it writes values the column holds, serves them, and edits cannot change them."""
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    _tag_documents(live, session["id"], "DEPLOYED-SCHEMA-DOC")
    assert _confirm_with_session(live, session).status_code == 200
    bases = {r[0] for r in live.rows("SELECT DISTINCT association_basis FROM application_document_snapshots")}
    assert bases <= set(ASSOCIATION_BASES)
    entry = live.entry(user, job_id)
    before = _assert_downloads(live, user, entry["id"], "Plaid")
    assert "DEPLOYED-SCHEMA-DOC" in before["resume"]
    _tag_documents(live, session["id"], "EDITED-AFTER")
    assert _assert_downloads(live, user, entry["id"], "Plaid") == before


def test_rows_with_the_default_basis_stay_readable_and_claim_nothing_more_than_the_column_says(live: Live) -> None:
    """A snapshot row that carries only the column default (it never named a basis) is served as 'sole_session' and is not upgraded."""
    user, job_id = live.signup(), live.seed_job()
    session = live.website_session(user, job_id)
    _tag_documents(live, session["id"], "LEGACY-ROW-DOC")
    assert _confirm_with_session(live, session).status_code == 200
    with live.engine.begin() as conn:                                                # rewrite the rows as if inserted without a basis
        conn.execute(text("UPDATE application_document_snapshots SET association_basis = DEFAULT WHERE tracker_id IN (SELECT id FROM application_tracker WHERE job_id = :j)"), {"j": job_id})
    entry = live.entry(user, job_id)
    assert entry["documents_availability"] == "frozen" and entry["documents"]["resume"]["association"] == "sole_session"
    assert "LEGACY-ROW-DOC" in _assert_downloads(live, user, entry["id"], "Plaid")["resume"]


@pytest.mark.skipif(not os.environ.get("XA_DEPLOYED_API_DIR"), reason="needs XA_DEPLOYED_API_DIR: a checkout of the deployed commit 959b994 (apps/api)")
def test_a_database_built_and_populated_by_the_deployed_code_is_read_by_the_corrected_code_after_only_the_0034_migration(live: Live) -> None:
    """Deployed lineage end to end: the DEPLOYED code migrates, serves and snapshots; the CORRECTED code then reads the same database."""
    deployed_dir = Path(os.environ["XA_DEPLOYED_API_DIR"])
    name = f"xa_deployed_{uuid.uuid4().hex[:8]}"
    admin = create_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = str(make_url(_ADMIN_URL).set(database=name))
    old_proc = new_proc = None
    engine = create_engine(url)
    try:
        _alembic(url, "upgrade", "head", cwd=deployed_dir)                          # the deployed code's own migrations
        with engine.connect() as conn:
            assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == HEAD
        old_proc, old_base = spawn_api(deployed_dir, url)
        old = Live(old_base, engine)
        user, job_id = old.signup(), old.seed_job()
        session = old.website_session(user, job_id)
        _tag_documents(old, session["id"], "WRITTEN-BY-DEPLOYED-CODE")
        assert _confirm_with_session(old, session).status_code == 200
        rows_before = _snapshot_rows(engine)
        assert len(rows_before) == 2
        deployed_texts = _assert_downloads(old, user, old.entry(user, job_id)["id"], "Plaid")
        stop_api(old_proc)
        old_proc = None

        output = _alembic(url, "upgrade", "head")                                 # the corrected code's migrations: exactly 0034
        assert output.count("Running upgrade") == 1 and "0036_application_doc_snapshots -> 0034_password_reset" in output
        with engine.connect() as conn:
            assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0034_password_reset"
        new_proc, new_base = spawn_api(API_DIR, url)
        new = Live(new_base, engine)
        entry = new.entry(user, job_id)                                             # rows written by the deployed code, read by the corrected code
        assert entry["documents_availability"] == "frozen"
        assert _assert_downloads(new, user, entry["id"], "Plaid") == deployed_texts
        assert _snapshot_rows(engine) == rows_before                                # migrating and reading changed nothing
        _tag_documents(new, session["id"], "EDITED-AFTER-DEPLOY")
        assert _assert_downloads(new, user, entry["id"], "Plaid") == deployed_texts
        # and the corrected code can create new snapshots on the same database
        second_job = new.seed_job()
        second = new.website_session(user, second_job)
        assert _confirm_with_session(new, second).status_code == 200
        assert new.entry(user, second_job)["documents_availability"] == "frozen"
    finally:
        for proc in (old_proc, new_proc):
            if proc is not None:
                stop_api(proc)
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()
