"""Conservative operator reconciliation for historical generated-file orphans.

Run as `python -m app.maintenance.reconcile_generated_documents`.
Dry-run is the default. --apply is required for deletion. This tool does not
run from app startup, Celery, or deployment scripts.
"""

from __future__ import annotations

import argparse
import re
import stat
from dataclasses import asdict, dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.documents.materialized_files import (
    FORMATS,
    MaterializedFileError,
    generated_root,
    referenced_paths,
    remove_owned_file,
)
from app.models.entities import GeneratedDocument

OWNED_NAME = re.compile(r"^document-([1-9][0-9]*)\.(" + "|".join(FORMATS) + r")$")


@dataclass
class Accounting:
    files_scanned: int = 0
    referenced_files: int = 0
    orphan_candidates: int = 0
    unsafe_unknown: int = 0
    files_deleted: int = 0
    delete_failures: int = 0
    bytes_reclaimable: int = 0
    bytes_deleted: int = 0


def reconcile(
    db: Session, *, root: Path, apply: bool = False, max_files: int = 1000
) -> Accounting:
    if max_files < 1:
        raise ValueError("max_files must be positive")
    result = Accounting()
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise MaterializedFileError("Generated document root is unsafe")
    if not root.exists():
        return result
    actual_root = root.resolve(strict=True)
    references = referenced_paths(db, root=actual_root)
    # No recursion: the generated root also contains unrelated maintenance data.
    for entry in sorted(actual_root.iterdir(), key=lambda item: item.name)[:max_files]:
        result.files_scanned += 1
        match = OWNED_NAME.fullmatch(entry.name)
        try:
            mode = entry.lstat().st_mode
        except OSError:
            result.unsafe_unknown += 1
            continue
        if not match or not stat.S_ISREG(mode):
            result.unsafe_unknown += 1
            continue
        if entry in references:
            result.referenced_files += 1
            continue
        document_id = int(match.group(1))
        # A live row may have an unreferenced export from the download route.
        # Its file could still be serving a response, so absence of a path
        # column alone is not enough authority for historical cleanup.
        if db.scalar(select(GeneratedDocument.id).where(GeneratedDocument.id == document_id)):
            result.unsafe_unknown += 1
            continue
        result.orphan_candidates += 1
        size = entry.stat().st_size
        result.bytes_reclaimable += size
        if not apply:
            continue
        # Re-read authority immediately before each unlink, not merely from
        # the initial dry-run snapshot. A new reference or changed file fails
        # closed. The deterministic document ID is revalidated by the helper.
        try:
            if entry in referenced_paths(db, root=actual_root):
                result.referenced_files += 1
                result.orphan_candidates -= 1
                result.bytes_reclaimable -= size
                continue
            if db.scalar(select(GeneratedDocument.id).where(GeneratedDocument.id == document_id)):
                result.unsafe_unknown += 1
                result.orphan_candidates -= 1
                result.bytes_reclaimable -= size
                continue
            if not stat.S_ISREG(entry.lstat().st_mode):
                raise MaterializedFileError("Candidate entry changed type")
            if remove_owned_file(entry, document_id, root=actual_root):
                result.files_deleted += 1
                result.bytes_deleted += size
        except (MaterializedFileError, OSError):
            result.delete_failures += 1
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="delete validated orphan candidates")
    parser.add_argument("--max-files", type=int, default=1000, help="maximum root entries to scan")
    args = parser.parse_args(argv)
    try:
        with SessionLocal() as db:
            result = reconcile(
                db, root=generated_root(), apply=args.apply, max_files=args.max_files
            )
    except (MaterializedFileError, ValueError, OSError) as exc:
        print(f"reconciliation failed: {type(exc).__name__}")
        return 2
    print(asdict(result))
    return 1 if result.delete_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
