"""Generated-file ownership and account/document lifecycle regression tests."""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.db.base import Base
from app.documents.materialized_files import (
    MaterializedFileError,
    owned_path,
    remove_document_exports,
    remove_owned_file,
    validate_owned_path,
)
from app.main import app
from app.maintenance.reconcile_generated_documents import reconcile
from app.models import entities as E


@pytest.fixture()
def setup(tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch) -> Generator[tuple[TestClient, sessionmaker, Path], None, None]:
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    root = tmp_path / "generated"
    root.mkdir()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    event.listen(engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override() -> Generator[Session, None, None]:
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = override
    try:
        yield TestClient(app), factory, root
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def _user(client: TestClient, name: str) -> tuple[int, dict[str, str]]:
    resp = client.post("/auth/signup", json={"email": f"{name}@example.com", "password": "password123"})
    assert resp.status_code in (200, 201)
    headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    return client.get("/auth/me", headers=headers).json()["id"], headers


def _document(factory: sessionmaker, user_id: int, *, fmt: E.DocumentFormat = E.DocumentFormat.pdf) -> int:
    with factory() as db:
        job = E.JobPosting(
            external_id=f"retention-{user_id}", title="Engineer", company="Example",
            application_url="https://example.test/apply", source_url="https://example.test/job",
            hash_for_deduplication=f"retention-hash-{user_id}",
        )
        db.add(job)
        db.flush()
        document = E.GeneratedDocument(
            user_id=user_id, job_id=job.id, type=E.DocumentType.resume,
            format=fmt, content={}, plain_text="private resume",
        )
        db.add(document)
        db.commit()
        return document.id


def _file(root: Path, document_id: int, fmt: str = "pdf") -> Path:
    path = root / f"document-{document_id}.{fmt}"
    path.write_text("private document", encoding="utf-8")
    return path


def test_owned_file_deletion_and_missing_idempotence(setup: tuple[TestClient, sessionmaker, Path]) -> None:
    _, _, root = setup
    path = _file(root, 41)
    assert remove_owned_file(path, 41, root=root)
    assert not path.exists()
    assert not remove_owned_file(path, 41, root=root)


@pytest.mark.parametrize("raw", [
    "../generated/document-41.pdf",
    "/tmp/document-41.pdf",
    "generated-evil/document-41.pdf",
])
def test_escape_rejected(setup: tuple[TestClient, sessionmaker, Path], raw: str) -> None:
    _, _, root = setup
    with pytest.raises(MaterializedFileError):
        validate_owned_path(raw, 41, root=root)


def test_symlink_entry_unlinked_without_external_target(setup: tuple[TestClient, sessionmaker, Path],
    tmp_path: Path) -> None:
    _, _, root = setup
    target = tmp_path / "outside"
    target.write_text("untouched")
    link = root / "document-41.pdf"
    link.symlink_to(target)
    assert remove_owned_file(link, 41, root=root)
    assert target.read_text() == "untouched"


def test_directory_rejected(setup: tuple[TestClient, sessionmaker, Path]) -> None:
    _, _, root = setup
    (root / "document-41.pdf").mkdir()
    with pytest.raises(MaterializedFileError):
        remove_owned_file(root / "document-41.pdf", 41, root=root)


def test_shared_reference_blocks_deletion(setup: tuple[TestClient, sessionmaker, Path]) -> None:
    client, factory, root = setup
    a, _ = _user(client, "shared-a")
    b, _ = _user(client, "shared-b")
    first, second = _document(factory, a), _document(factory, b)
    path = _file(root, first)
    with factory() as db:
        other = db.get(E.GeneratedDocument, second)
        other.file_path = str(path)
        db.commit()
    with factory() as db:
        with pytest.raises(MaterializedFileError):
            remove_document_exports(db, db.get(E.GeneratedDocument, first), root=root)
    assert path.exists()


def test_shared_alias_reference_blocks_deletion(setup: tuple[TestClient, sessionmaker, Path]) -> None:
    client, factory, root = setup
    a, _ = _user(client, "alias-a")
    b, _ = _user(client, "alias-b")
    first, second = _document(factory, a), _document(factory, b)
    path = _file(root, first)
    with factory() as db:
        db.get(E.GeneratedDocument, second).file_path = str(root / ".." / root.name / path.name)
        db.commit()
    with factory() as db:
        with pytest.raises(MaterializedFileError):
            remove_document_exports(db, db.get(E.GeneratedDocument, first), root=root)
    assert path.exists()


def test_io_failure_propagates(setup: tuple[TestClient, sessionmaker, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    _, _, root = setup
    path = _file(root, 41)
    original = Path.unlink

    def denied(self: Path, *args: object, **kwargs: object) -> None:
        if self == path:
            raise PermissionError("denied")
        original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", denied)
    with pytest.raises(MaterializedFileError):
        remove_owned_file(path, 41, root=root)
    assert path.exists()


def test_account_deletion_removes_all_formats_and_preserves_other_user(
    setup: tuple[TestClient, sessionmaker, Path]
) -> None:
    client, factory, root = setup
    a, auth_a = _user(client, "delete-a")
    b, auth_b = _user(client, "delete-b")
    first, second = _document(factory, a), _document(factory, b)
    owned = [_file(root, first, fmt) for fmt in ("pdf", "docx", "markdown", "json")]
    with factory() as db:
        original = db.get(E.GeneratedDocument, first)
        another = E.GeneratedDocument(
            user_id=a, job_id=original.job_id, type=E.DocumentType.cover_letter,
            format=E.DocumentFormat.docx, content={}, plain_text="private letter",
        )
        db.add(another)
        db.commit()
        third = another.id
    owned.append(_file(root, third, "docx"))
    foreign = _file(root, second)
    with factory() as db:
        doc = db.get(E.GeneratedDocument, first)
        doc.file_path = str(owned[0])
        doc.pdf_file_path = str(owned[0])
        doc.docx_file_path = str(owned[1])
        db.commit()
    assert client.get("/privacy/export").status_code == 401
    assert client.request("DELETE", "/privacy/account").status_code == 401
    assert client.request("DELETE", "/privacy/account", headers=auth_a).status_code == 204
    assert all(not path.exists() for path in owned)
    assert foreign.exists()
    with factory() as db:
        assert db.get(E.User, a) is None
        assert db.get(E.GeneratedDocument, first) is None
        assert db.get(E.GeneratedDocument, third) is None
        assert db.get(E.User, b) is not None
    assert client.get("/privacy/export", headers=auth_b).status_code == 200


def test_account_deletion_missing_file_succeeds(setup: tuple[TestClient, sessionmaker, Path]) -> None:
    client, factory, _ = setup
    user_id, headers = _user(client, "missing")
    _document(factory, user_id)
    assert client.request("DELETE", "/privacy/account", headers=headers).status_code == 204


def test_account_deletion_io_failure_is_not_success(setup: tuple[TestClient, sessionmaker, Path],
    monkeypatch: pytest.MonkeyPatch) -> None:
    client, factory, root = setup
    user_id, headers = _user(client, "failure")
    document_id = _document(factory, user_id)
    path = _file(root, document_id)
    original = Path.unlink

    def denied(self: Path, *args: object, **kwargs: object) -> None:
        if self == path:
            raise PermissionError("denied")
        original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", denied)
    assert client.request("DELETE", "/privacy/account", headers=headers).status_code == 503
    assert path.exists()
    with factory() as db:
        assert db.get(E.User, user_id) is not None


def test_edit_removes_exports_and_new_export_survives(setup: tuple[TestClient, sessionmaker, Path]) -> None:
    client, factory, root = setup
    user_id, headers = _user(client, "edit")
    document_id = _document(factory, user_id)
    pdf, docx = _file(root, document_id), _file(root, document_id, "docx")
    with factory() as db:
        doc = db.get(E.GeneratedDocument, document_id)
        doc.pdf_file_path, doc.docx_file_path = str(pdf), str(docx)
        db.commit()
    resp = client.put(f"/jobs/documents/{document_id}", headers=headers, json={"title": "Updated"})
    assert resp.status_code == 200, resp.text
    assert not pdf.exists() and not docx.exists()
    with factory() as db:
        doc = db.get(E.GeneratedDocument, document_id)
        assert doc.pdf_file_path is None and doc.docx_file_path is None
    exported = client.post(f"/jobs/documents/{document_id}/export/markdown", headers=headers)
    assert exported.status_code == 200, exported.text
    new_path = owned_path(document_id, "markdown", root=root)
    assert new_path.exists()
    again = client.post(f"/jobs/documents/{document_id}/export/markdown", headers=headers)
    assert again.status_code == 200
    assert new_path.exists()
    assert len(list(root.glob(f"document-{document_id}.*"))) == 1
    replaced = client.post(f"/jobs/documents/{document_id}/export/json", headers=headers)
    assert replaced.status_code == 200
    assert not new_path.exists()
    assert owned_path(document_id, "json", root=root).exists()


def test_edit_failure_keeps_references(setup: tuple[TestClient, sessionmaker, Path],
    monkeypatch: pytest.MonkeyPatch) -> None:
    client, factory, root = setup
    user_id, headers = _user(client, "edit-failure")
    document_id = _document(factory, user_id)
    path = _file(root, document_id)
    with factory() as db:
        db.get(E.GeneratedDocument, document_id).pdf_file_path = str(path)
        db.commit()
    original = Path.unlink

    def denied(self: Path, *args: object, **kwargs: object) -> None:
        if self == path:
            raise PermissionError("denied")
        original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", denied)
    assert client.put(f"/jobs/documents/{document_id}", headers=headers, json={"title": "No"}).status_code == 503
    with factory() as db:
        doc = db.get(E.GeneratedDocument, document_id)
        assert doc.pdf_file_path == str(path)
        assert doc.title != "No"


def test_reconcile_dry_run_apply_and_rerun(setup: tuple[TestClient, sessionmaker, Path]) -> None:
    client, factory, root = setup
    user_id, _ = _user(client, "reconcile")
    document_id = _document(factory, user_id)
    referenced = _file(root, document_id)
    orphan = _file(root, document_id + 100)
    unsafe = root / "maintenance"
    unsafe.mkdir()
    with factory() as db:
        db.get(E.GeneratedDocument, document_id).pdf_file_path = str(referenced)
        db.commit()
    with factory() as db:
        dry = reconcile(db, root=root)
        assert (dry.referenced_files, dry.orphan_candidates, dry.unsafe_unknown, dry.files_deleted) == (1, 1, 1, 0)
        assert orphan.exists()
        applied = reconcile(db, root=root, apply=True)
        assert applied.files_deleted == 1
        assert referenced.exists() and not orphan.exists()
        assert reconcile(db, root=root, apply=True).files_deleted == 0
        assert reconcile(db, root=root, max_files=1).files_scanned == 1


def test_reconcile_symlink_is_unsafe(setup: tuple[TestClient, sessionmaker, Path], tmp_path: Path) -> None:
    _, factory, root = setup
    target = tmp_path / "external"
    target.write_text("keep")
    (root / "document-999.pdf").symlink_to(target)
    with factory() as db:
        result = reconcile(db, root=root, apply=True)
    assert result.unsafe_unknown == 1 and result.files_deleted == 0
    assert target.read_text() == "keep"


def test_reconcile_live_document_without_path_is_ambiguous(
    setup: tuple[TestClient, sessionmaker, Path]
) -> None:
    client, factory, root = setup
    user_id, _ = _user(client, "live-unreferenced")
    document_id = _document(factory, user_id)
    candidate = _file(root, document_id)
    with factory() as db:
        result = reconcile(db, root=root, apply=True)
    assert result.unsafe_unknown == 1
    assert result.orphan_candidates == 0
    assert result.files_deleted == 0
    assert candidate.exists()


def test_reconcile_partial_failure_counted(setup: tuple[TestClient, sessionmaker, Path],
    monkeypatch: pytest.MonkeyPatch) -> None:
    _, factory, root = setup
    path = _file(root, 999)
    original = Path.unlink

    def denied(self: Path, *args: object, **kwargs: object) -> None:
        if self == path:
            raise PermissionError("denied")
        original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", denied)
    with factory() as db:
        result = reconcile(db, root=root, apply=True)
    assert result.delete_failures == 1 and result.files_deleted == 0
    assert path.exists()


def test_reexport_replaces_symlink_without_following_target(
    setup: tuple[TestClient, sessionmaker, Path], tmp_path: Path
) -> None:
    client, factory, root = setup
    user_id, headers = _user(client, "symlink-export")
    document_id = _document(factory, user_id)
    outside = tmp_path / "outside"
    outside.write_text("must stay")
    link = root / f"document-{document_id}.markdown"
    link.symlink_to(outside)
    response = client.post(f"/jobs/documents/{document_id}/export/markdown", headers=headers)
    assert response.status_code == 200
    assert outside.read_text() == "must stay"
    assert link.is_file() and not link.is_symlink()


def test_reconcile_main_returns_nonzero_on_partial_failure(
    setup: tuple[TestClient, sessionmaker, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.maintenance import reconcile_generated_documents as module

    _, factory, root = setup
    path = _file(root, 999)
    original = Path.unlink

    def denied(self: Path, *args: object, **kwargs: object) -> None:
        if self == path:
            raise PermissionError("denied")
        original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", denied)
    monkeypatch.setattr(module, "SessionLocal", factory)
    monkeypatch.setattr(module, "generated_root", lambda: root)
    assert module.main(["--apply"]) == 1
    assert path.exists()
