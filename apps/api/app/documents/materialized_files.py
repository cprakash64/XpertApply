"""Ownership and deletion of generated document exports on local server storage.

Only deterministic document-{database id}.{format} entries immediately beneath
the generated root belong to this service. Database paths are untrusted hints,
not authority to remove arbitrary files.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import DocumentFormat, GeneratedDocument

FORMATS = tuple(item.value for item in DocumentFormat)
PATH_FIELDS = ("file_path", "docx_file_path", "pdf_file_path")


class MaterializedFileError(RuntimeError):
    """Cleanup could not safely finish. Never expose its detail to API clients."""


def generated_root() -> Path:
    return Path(os.getenv("UPLOAD_DIR", "uploads")).parent / "generated"


def _root(root: Path | None) -> Path:
    chosen = root if root is not None else generated_root()
    if chosen.is_symlink() or (chosen.exists() and not chosen.is_dir()):
        raise MaterializedFileError("Generated document root is unsafe")
    return chosen.resolve(strict=False)


def owned_path(document_id: int, fmt: str, *, root: Path | None = None) -> Path:
    if document_id < 1 or fmt not in FORMATS:
        raise MaterializedFileError("Invalid generated document identity")
    return _root(root) / f"document-{document_id}.{fmt}"


def validate_owned_path(
    raw: str | Path, document_id: int, *, root: Path | None = None
) -> Path:
    candidate = Path(raw)
    if ".." in candidate.parts:
        raise MaterializedFileError("Generated document path traversal rejected")
    filename = candidate.name
    if filename not in {f"document-{document_id}.{fmt}" for fmt in FORMATS}:
        raise MaterializedFileError("Generated document filename does not match its owner")
    actual_root = _root(root)
    try:
        parent = candidate.parent.resolve(strict=False)
    except OSError as exc:
        raise MaterializedFileError("Generated document parent is unavailable") from exc
    if parent != actual_root:
        raise MaterializedFileError("Generated document path escapes its root")
    return actual_root / filename


def referenced_paths(db: Session, *, root: Path | None = None) -> dict[Path, set[int]]:
    """Index all live DB references, including cross-document aliases.

    Invalid paths do not grant deletion authority. They are ignored here and
    rejected when their owning document is cleaned; a malformed alias that
    points at a controlled entry still counts as a reference via its resolved
    parent/name.
    """
    actual_root = _root(root)
    references: dict[Path, set[int]] = {}
    rows = db.execute(
        select(
            GeneratedDocument.id,
            GeneratedDocument.file_path,
            GeneratedDocument.docx_file_path,
            GeneratedDocument.pdf_file_path,
        )
    )
    for document_id, *paths in rows:
        for raw in paths:
            if not raw:
                continue
            candidate = Path(raw)
            # Count even malformed aliases as references. Cleanup of the
            # malformed owner's own path will reject it, but another user's
            # deletion must not overlook a reference such as root/../root/file.
            try:
                if candidate.parent.resolve(strict=False) != actual_root:
                    continue
            except OSError:
                continue
            path = actual_root / candidate.name
            references.setdefault(path, set()).add(document_id)
    return references


def remove_owned_file(path: Path, document_id: int, *, root: Path | None = None) -> bool:
    """Unlink one controlled entry; a symlink is unlinked, never followed."""
    target = validate_owned_path(path, document_id, root=root)
    try:
        mode = target.lstat().st_mode
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise MaterializedFileError("Could not inspect generated document file") from exc
    if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
        raise MaterializedFileError("Generated document entry is not a file")
    try:
        target.unlink()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise MaterializedFileError("Could not remove generated document file") from exc
    return True


def remove_document_exports(
    db: Session, record: GeneratedDocument, *, root: Path | None = None
) -> int:
    """Remove every known format, including legacy exports whose DB paths were lost.

    The caller must retain the document row until this succeeds. Filesystem
    deletion precedes the DB commit: if a later DB operation fails, files are
    regenerable from the still-retained document; the inverse order would
    permanently lose the references needed for cleanup.
    """
    actual_root = _root(root)
    for field in PATH_FIELDS:
        raw = getattr(record, field)
        if raw:
            validate_owned_path(raw, record.id, root=actual_root)
    references = referenced_paths(db, root=actual_root)
    candidates = [owned_path(record.id, fmt, root=actual_root) for fmt in FORMATS]
    for path in candidates:
        if references.get(path, set()) - {record.id}:
            raise MaterializedFileError("Generated document is referenced by another record")
    return sum(remove_owned_file(path, record.id, root=actual_root) for path in candidates)


def remove_replaced_export(
    db: Session, record: GeneratedDocument, new_format: DocumentFormat, *, root: Path | None = None
) -> bool:
    """Remove an obsolete generic export before its DB path is overwritten.

    PDF/DOCX may retain a separate format-specific reference. Re-export of the
    same deterministic path is an atomic replacement and needs no deletion.
    """
    if not record.file_path:
        return False
    actual_root = _root(root)
    old = validate_owned_path(record.file_path, record.id, root=actual_root)
    new = owned_path(record.id, new_format.value, root=actual_root)
    if old == new:
        return False
    for field in ("docx_file_path", "pdf_file_path"):
        raw = getattr(record, field)
        if raw and validate_owned_path(raw, record.id, root=actual_root) == old:
            return False
    if referenced_paths(db, root=actual_root).get(old, set()) - {record.id}:
        raise MaterializedFileError("Generated document is referenced by another record")
    return remove_owned_file(old, record.id, root=actual_root)
