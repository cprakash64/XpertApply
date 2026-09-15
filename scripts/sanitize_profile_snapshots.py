"""One-time sanitizer for credential material in historical profile snapshots.

NEW-07 background
-----------------
``profile_payload`` used to serialize every ``UserProfile`` column, so
``workday_password_ciphertext`` — the encrypted employer-portal password — was
copied into ``generated_documents.source_profile_snapshot`` on every generation.
The code path is fixed: new writes use an allow-list projection and the
document-copy path scrubs on the way across, so nothing new can acquire it.
Rows written *before* the fix still hold it, and this script retires them.

Why a script and not an Alembic migration
-----------------------------------------
This edits JSON data, not schema. Binding it to Alembic would run destructive
row rewrites automatically during ordinary ``make migrate`` deploys, with no
dry-run, no batch bound, and no opportunity to review candidate counts first.
``scripts/`` is where this repository already keeps operational one-shots
(``check_env.py``, ``seed_demo_data.py``), invoked deliberately.

Safety properties
-----------------
* **Dry-run by default.** Mutating requires ``--apply``.
* **Counts only.** Snapshot values are never read into the output. Reporting is
  by key *path*, so running this can never print a credential.
* **Bounded and batched.** ``--batch-size`` rows per transaction,
  ``--max-rows`` caps a single invocation.
* **Idempotent.** Sanitized rows stop matching, so a second run reports zero.
* **Transactional per batch.** A failure rolls back that batch only; completed
  batches stand and the run can simply be repeated.
* **Malformed rows are skipped, never blanked.** A snapshot that is not a JSON
  object is counted as ``skipped`` and left exactly as it was.

Usage
-----
    # inspect only — changes nothing
    .venv/bin/python scripts/sanitize_profile_snapshots.py

    # rewrite the affected rows
    .venv/bin/python scripts/sanitize_profile_snapshots.py --apply

    # walk a large table in bounded chunks, resuming each time
    ... --apply --max-rows 500                      # note "last id scanned"
    ... --apply --max-rows 500 --start-after-id 500  # continue from there

``--database-url`` targets a specific database; without it the configured
``DATABASE_URL`` is used. Production runs require separate written
authorization and are out of scope for the stage that introduced this file.

``--max-rows`` bounds a single invocation and does **not** by itself resume:
pair it with ``--start-after-id`` using the ``last id scanned`` the previous run
reported. An unbounded run (no ``--max-rows``) walks the whole table in batches
and converges on its own.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.entities import GeneratedDocument
from app.services.profile_projection import (
    find_credential_key_paths,
    scrub_credential_keys,
)

#: (label, model, attribute) for every column known to have received the
#: unfiltered profile payload. `application_sessions.profile_snapshot` is
#: deliberately absent: `session_service._profile_snapshot` has always been an
#: explicit allow-list and never carried the credential.
TARGETS: list[tuple[str, type, str]] = [
    ("generated_documents.source_profile_snapshot", GeneratedDocument, "source_profile_snapshot"),
]


class Report:
    def __init__(self) -> None:
        self.scanned = 0
        self.candidates = 0
        self.sanitized = 0
        self.keys_removed = 0
        self.skipped_malformed = 0
        self.failed_batches = 0
        self.last_id: int | None = None
        self.key_paths: dict[str, int] = {}

    def note_paths(self, paths: list[str]) -> None:
        for path in paths:
            self.key_paths[path] = self.key_paths.get(path, 0) + 1

    def render(self, *, applied: bool) -> str:
        mode = "APPLY" if applied else "DRY-RUN"
        keys_label = "keys removed        " if applied else "keys that would go  "
        lines = [
            f"mode                : {mode}",
            f"rows scanned        : {self.scanned}",
            f"rows with credential: {self.candidates}",
            f"rows sanitized      : {self.sanitized}",
            f"{keys_label}: {self.keys_removed}",
            f"malformed skipped   : {self.skipped_malformed}",
            f"failed batches      : {self.failed_batches}",
            f"last id scanned     : {self.last_id}",
        ]
        if self.key_paths:
            lines.append("key paths found (path -> row count):")
            for path, count in sorted(self.key_paths.items()):
                lines.append(f"  {path} -> {count}")
        return "\n".join(lines)


def _snapshot_of(row: Any, attribute: str) -> Any:
    return getattr(row, attribute, None)


def sanitize_target(
    db: Session,
    model: type,
    attribute: str,
    *,
    apply_changes: bool,
    batch_size: int,
    max_rows: int | None,
    report: Report,
    start_after_id: int | None = None,
) -> None:
    cursor = start_after_id
    processed = 0
    while True:
        if max_rows is not None and processed >= max_rows:
            return
        limit = batch_size
        if max_rows is not None:
            limit = min(batch_size, max_rows - processed)
        # Keyset paging on the primary key, not OFFSET. With OFFSET, a run
        # bounded by --max-rows always restarted at row 0, so repeated bounded
        # invocations rescanned the same already-clean prefix, reported "0
        # candidates", and never reached the rest of the table — a false
        # completion signal. A cursor makes each invocation resume where the
        # last one stopped, and makes progress independent of whether a row was
        # sanitized, skipped or left alone.
        statement = select(model).order_by(model.id).limit(limit)
        if cursor is not None:
            statement = statement.where(model.id > cursor)
        rows = list(db.scalars(statement))
        if not rows:
            return

        pending: list[tuple[Any, Any, int]] = []
        for row in rows:
            report.scanned += 1
            processed += 1
            snapshot = _snapshot_of(row, attribute)
            if snapshot is None:
                continue
            if not isinstance(snapshot, dict):
                # Never blank a snapshot we do not understand.
                report.skipped_malformed += 1
                continue
            paths = find_credential_key_paths(snapshot)
            if not paths:
                continue
            report.candidates += 1
            report.note_paths(paths)
            cleaned, removed = scrub_credential_keys(snapshot)
            pending.append((row, cleaned, removed))

        if apply_changes and pending:
            try:
                for row, cleaned, removed in pending:
                    setattr(row, attribute, cleaned)
                    report.sanitized += 1
                    report.keys_removed += removed
                db.commit()
            except Exception:  # noqa: BLE001 - reported as a failed batch, never re-raised
                db.rollback()
                report.failed_batches += 1
                report.sanitized -= len(pending)
                report.keys_removed -= sum(removed for _, _, removed in pending)
        elif pending:
            report.keys_removed += sum(removed for _, _, removed in pending)

        # The cursor advances past every row examined, sanitized or not, so the
        # loop always terminates and a malformed row can never be re-selected.
        cursor = rows[-1].id
        report.last_id = cursor


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Remove credential-shaped keys from historical profile snapshots (NEW-07).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Rewrite affected rows. Without this flag nothing is modified.",
    )
    parser.add_argument("--batch-size", type=int, default=200, help="Rows per transaction.")
    parser.add_argument(
        "--max-rows", type=int, default=None, help="Stop after scanning this many rows."
    )
    parser.add_argument(
        "--start-after-id",
        type=int,
        default=None,
        help=(
            "Resume after this row id. Use with --max-rows to walk a large table "
            "across several invocations: pass the previous run's 'last id scanned'."
        ),
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="Target database. Defaults to the configured DATABASE_URL.",
    )
    args = parser.parse_args(argv)

    if args.batch_size < 1:
        print("--batch-size must be at least 1")
        return 2

    if args.database_url:
        url = args.database_url
    else:
        from app.core.config import settings

        url = settings.database_url

    engine = create_engine(url)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    report = Report()
    db = factory()
    try:
        for label, model, attribute in TARGETS:
            print(f"scanning {label} ...")
            sanitize_target(
                db,
                model,
                attribute,
                apply_changes=args.apply,
                batch_size=args.batch_size,
                max_rows=args.max_rows,
                report=report,
                start_after_id=args.start_after_id,
            )
    finally:
        db.close()
        engine.dispose()

    print(report.render(applied=args.apply))
    if not args.apply and report.candidates:
        print(
            "\nDry run only — nothing was modified. "
            "Re-run with --apply to sanitize these rows."
        )
    if report.failed_batches:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
