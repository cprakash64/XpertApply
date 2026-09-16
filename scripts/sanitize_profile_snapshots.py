"""One-time sanitizer for credential material in historical profile snapshots.

NEW-07 background
-----------------
``profile_payload`` used to serialize every ``UserProfile`` column, so
``workday_password_ciphertext`` — the encrypted employer-portal password — was
copied into ``generated_documents.source_profile_snapshot`` on every generation.
The code path is fixed by the accompanying hotfix: new writes go through an
allow-list projection. Rows written *before* the fix still hold it, and this
script retires them.

Why SQLAlchemy Core and not the ORM
-----------------------------------
The first version of this script imported ``app.models.entities.GeneratedDocument``.
That coupled it to whatever columns the *checked-out branch* declares, and it
could not run against production at all: the security branch's model declares
``content_hash``, ``immutable_at`` and ``source_document_id`` (added by
migrations 0032/0033, unapplied in production), so every SELECT named columns
the production table does not have and failed before reading a single row.

This version declares a **minimal table of its own** — ``id`` and
``source_profile_snapshot``, the only two columns this job needs and the only
two guaranteed present in every schema version. It therefore runs against
production *and* against a migrated database, and it will keep running after
future migrations add columns. No ORM model is imported, so no model change can
break it.

Why a script and not an Alembic migration
-----------------------------------------
This edits JSON data, not schema. Binding it to Alembic would run destructive
row rewrites automatically during ordinary ``alembic upgrade head`` deploys,
with no dry-run, no batch bound, and no opportunity to review candidate counts
first. ``scripts/`` is where this repository already keeps operational one-shots
(``check_env.py``, ``seed_demo_data.py``), invoked deliberately.

Safety properties
-----------------
* **Dry-run by default.** Mutating requires ``--apply``.
* **Counts only.** Snapshot values are never read into the output. Reporting is
  by key *path*, so running this can never print a credential.
* **Bounded and batched.** ``--batch-size`` rows per statement batch,
  ``--max-rows`` caps a single invocation.
* **Keyset paging**, so a bounded run resumes with ``--start-after-id`` instead
  of rescanning an already-clean prefix and reporting a false "0 candidates".
* **Idempotent.** Sanitized rows stop matching, so a second run reports zero.
* **Transactional per batch.** A failure rolls back that batch only; completed
  batches stand and the run can simply be repeated.
* **Malformed rows are skipped, never blanked.** A snapshot that is not a JSON
  object is counted as ``skipped`` and left exactly as it was.
* **Targets one column.** Only ``source_profile_snapshot`` is ever written.

Usage
-----
    # inspect only — changes nothing
    .venv/bin/python scripts/sanitize_profile_snapshots.py

    # rewrite the affected rows
    .venv/bin/python scripts/sanitize_profile_snapshots.py --apply

    # walk a large table in bounded chunks, resuming each time
    ... --apply --max-rows 500                       # note "last id scanned"
    ... --apply --max-rows 500 --start-after-id 500  # continue from there

``--database-url`` targets a specific database; without it the configured
``DATABASE_URL`` is used. Read-only inspection should additionally be run with
``PGOPTIONS='-c default_transaction_read_only=on'`` so the server itself
refuses any write, independently of this script's own dry-run default.

``--max-rows`` bounds a single invocation and does **not** by itself resume:
pair it with ``--start-after-id`` using the ``last id scanned`` the previous run
reported. An unbounded run walks the whole table in batches and converges on
its own.

Production runs require separate written authorization.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from app.services.profile_projection import (
    find_credential_key_paths,
    scrub_credential_keys,
)

#: A deliberately minimal view of the table: the primary key and the one JSON
#: column this job reads and writes. Declaring it here rather than importing the
#: ORM model is what makes the script schema-version independent — see the
#: module docstring.
_METADATA = sa.MetaData()
GENERATED_DOCUMENTS = sa.Table(
    "generated_documents",
    _METADATA,
    sa.Column("id", sa.Integer, primary_key=True),
    sa.Column("source_profile_snapshot", sa.JSON().with_variant(JSONB, "postgresql")),
)

#: (label, table, column) pairs to sanitize. ``application_sessions.profile
#: _snapshot`` is deliberately absent: that snapshot has always been built from
#: an explicit hand-written field list and never carried the credential.
TARGETS: list[tuple[str, sa.Table, str]] = [
    ("generated_documents.source_profile_snapshot", GENERATED_DOCUMENTS, "source_profile_snapshot"),
]


class Report:
    def __init__(self) -> None:
        self.scanned = 0
        self.candidates = 0
        self.safe = 0
        self.sanitized = 0
        self.keys_removed = 0
        self.keys_would_remove = 0
        self.skipped_malformed = 0
        self.skipped_null = 0
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
            f"safe rows observed  : {self.safe}",
            f"rows sanitized      : {self.sanitized}",
            f"{keys_label}: {self.keys_removed if applied else self.keys_would_remove}",
            f"malformed skipped   : {self.skipped_malformed}",
            f"null snapshots      : {self.skipped_null}",
            f"failed batches      : {self.failed_batches}",
            f"last id scanned     : {self.last_id}",
        ]
        if self.key_paths:
            lines.append("key paths found (path -> row count):")
            for path, count in sorted(self.key_paths.items()):
                lines.append(f"  {path} -> {count}")
        return "\n".join(lines)


def sanitize_target(
    connection: sa.Connection,
    table: sa.Table,
    column: str,
    *,
    apply_changes: bool,
    batch_size: int,
    max_rows: int | None,
    report: Report,
    start_after_id: int | None = None,
) -> None:
    id_column = table.c.id
    json_column = table.c[column]
    cursor = start_after_id
    processed = 0

    while True:
        if max_rows is not None and processed >= max_rows:
            return
        limit = batch_size if max_rows is None else min(batch_size, max_rows - processed)

        statement = sa.select(id_column, json_column).order_by(id_column).limit(limit)
        if cursor is not None:
            statement = statement.where(id_column > cursor)
        rows = connection.execute(statement).all()
        if not rows:
            return

        pending: list[tuple[int, Any, int]] = []
        for row_id, snapshot in rows:
            report.scanned += 1
            processed += 1
            if snapshot is None:
                report.skipped_null += 1
                continue
            if not isinstance(snapshot, dict):
                # Never blank a snapshot we do not understand.
                report.skipped_malformed += 1
                continue
            paths = find_credential_key_paths(snapshot)
            if not paths:
                report.safe += 1
                continue
            report.candidates += 1
            report.note_paths(paths)
            cleaned, removed = scrub_credential_keys(snapshot)
            pending.append((row_id, cleaned, removed))

        if apply_changes and pending:
            # Commit-as-you-go: SQLAlchemy 2.0 autobegins a transaction on the
            # SELECT above, so this batch's reads and writes already share one
            # transaction. Committing here closes it and the next batch's SELECT
            # opens a fresh one — per-batch atomicity without an explicit
            # begin(), which would raise against the autobegun transaction.
            try:
                batch_sanitized = 0
                batch_keys_removed = 0
                for row_id, cleaned, removed in pending:
                    connection.execute(
                        sa.update(table)
                        .where(id_column == row_id)
                        .values({column: cleaned})
                    )
                    batch_sanitized += 1
                    batch_keys_removed += removed
                connection.commit()
                # Mutation counters describe committed database effects only.
                # Do not expose attempted work globally until commit succeeds.
                report.sanitized += batch_sanitized
                report.keys_removed += batch_keys_removed
            except Exception:  # noqa: BLE001 - reported as a failed batch, never re-raised
                connection.rollback()
                report.failed_batches += 1
        elif pending:
            # Preserve dry-run visibility without claiming committed removals.
            report.keys_would_remove += sum(removed for _, _, removed in pending)

        # The cursor advances past every row examined — sanitized, skipped or
        # untouched — so the walk always terminates and a malformed row can
        # neither stall it nor be re-selected.
        cursor = rows[-1][0]
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

    engine = sa.create_engine(url)
    report = Report()
    try:
        with engine.connect() as connection:
            for label, table, column in TARGETS:
                print(f"scanning {label} ...")
                sanitize_target(
                    connection,
                    table,
                    column,
                    apply_changes=args.apply,
                    batch_size=args.batch_size,
                    max_rows=args.max_rows,
                    report=report,
                    start_after_id=args.start_after_id,
                )
    finally:
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
