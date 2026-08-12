"""Make the application record the source of truth for "applied".

Adds the provenance an application record needs so a confirmed submission can be
told apart from a page that was merely opened:

* ``applied_source``        which confirmation moved the row to ``applied``
* ``submission_reference``  the ATS/auto-apply receipt for that submission
* ``opened_at``             when the user opened the employer application
* ``last_application_url``  the employer URL that was opened

``opened_at`` exists precisely so opening an application can be recorded without
touching ``applied_at``. Clicking "Apply on official site" writes the first two
of those and never the status.

Also adds ``withdrawn`` to the ``applicationstatus`` enum (a withdrawn
application has still left discovery — the user dealt with this job) and an
index on ``(user_id, status)``, which is the exact predicate the Jobs discovery
query uses to exclude a user's own applied jobs on every page load.

All four columns are nullable with no server default: every existing row is a
record whose provenance we genuinely do not know, and inventing one (for example
back-filling ``applied_source='user_confirmed'``) would put a false audit claim
in the database. NULL reads as "confirmed before this was tracked", which is
true. Nullable adds are metadata-only on PostgreSQL 11+, so this migration does
not rewrite the table and is safe against a populated database.

Revision ID: 0027_applied_lifecycle
Revises: 0026_people_user_discovery_quota

The revision id is kept short deliberately: ``alembic_version.version_num`` is
VARCHAR(32) in this database, and a longer id fails the version bookkeeping
UPDATE at the very end of the migration — after the schema changes have already
been made.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0027_applied_lifecycle"
down_revision = "0026_people_user_discovery_quota"
branch_labels = None
depends_on = None


_NEW_COLUMNS = ("applied_source", "submission_reference", "opened_at", "last_application_url")


def _existing_columns(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {column["name"] for column in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()

    # ``ALTER TYPE ... ADD VALUE`` is PostgreSQL-only. On SQLite (unit tests)
    # SQLAlchemy renders Enum as VARCHAR + a CHECK derived from the Python enum,
    # so the new label is already accepted there. Mirrors 0008.
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE applicationstatus ADD VALUE IF NOT EXISTS 'withdrawn'")

    # Idempotent: re-running against a database that already has the columns
    # (for example a environment restored mid-rollout) must not abort.
    present = _existing_columns("application_tracker")
    if "applied_source" not in present:
        op.add_column(
            "application_tracker", sa.Column("applied_source", sa.String(length=40), nullable=True)
        )
    if "submission_reference" not in present:
        op.add_column(
            "application_tracker",
            sa.Column("submission_reference", sa.String(length=200), nullable=True),
        )
    if "opened_at" not in present:
        op.add_column(
            "application_tracker", sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True)
        )
    if "last_application_url" not in present:
        op.add_column(
            "application_tracker", sa.Column("last_application_url", sa.Text(), nullable=True)
        )

    inspector = sa.inspect(bind)
    indexes = {index["name"] for index in inspector.get_indexes("application_tracker")}
    if "ix_tracker_user_status" not in indexes:
        op.create_index("ix_tracker_user_status", "application_tracker", ["user_id", "status"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    indexes = {index["name"] for index in inspector.get_indexes("application_tracker")}
    if "ix_tracker_user_status" in indexes:
        op.drop_index("ix_tracker_user_status", table_name="application_tracker")

    present = _existing_columns("application_tracker")
    for column in reversed(_NEW_COLUMNS):
        if column in present:
            op.drop_column("application_tracker", column)

    # PostgreSQL cannot drop one label from an enum without recreating the type
    # and rewriting every dependent column, and the drop would fail outright if
    # any row still used it. Leaving the unused label behind is harmless — same
    # decision as 0008.
