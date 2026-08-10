"""Application-scoped answer overrides.

Answers a user gives for ONE application — "for this application only" — need
somewhere to live that is not the reusable answer vault and not
``generated_answers`` (which session_refresh rebuilds from the profile and
would therefore discard).

A JSON column on the session row gives exactly the right lifetime: it is
scoped to the session, invisible to other sessions, and disappears when the
session does.

Revision ID: 0029_session_answer_overrides
Revises: 0028_explicit_legal_answers

The revision id is kept under 32 characters: ``alembic_version.version_num`` is
VARCHAR(32), and PostgreSQL rejects anything longer. SQLite silently accepts an
over-long id, so a longer name passes the test suite and then fails on deploy.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0029_session_answer_overrides"
down_revision = "0028_explicit_legal_answers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Server default so existing rows read as "no overrides" rather than NULL,
    # which keeps the application code from special-casing older sessions.
    op.add_column(
        "application_sessions",
        sa.Column("application_overrides", sa.JSON(), nullable=False, server_default="{}"),
    )
    # The default has done its job for the backfill; new rows get theirs from
    # the model, so drop it rather than leaving a second source of truth.
    with op.batch_alter_table("application_sessions") as batch:
        batch.alter_column("application_overrides", server_default=None)


def downgrade() -> None:
    op.drop_column("application_sessions", "application_overrides")
