"""Record how each archived document was tied to its application.

Additive and reversible. ``0036_application_doc_snapshots`` is already applied on staging, so the new column lives in its own revision
rather than in an edit to 0036. Existing rows (none were created with a recorded basis) read as ``sole_session``, which is how
0036-era snapshots were associated.

Revision ID: 0037_snapshot_association_basis
Revises: 0036_application_doc_snapshots
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0037_snapshot_association_basis"
down_revision = "0036_application_doc_snapshots"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "application_document_snapshots",
        sa.Column("association_basis", sa.String(length=24), nullable=False, server_default="sole_session"),
    )


def downgrade() -> None:
    op.drop_column("application_document_snapshots", "association_basis")
