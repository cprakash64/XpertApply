"""Keep, per application, the exact documents prepared for it.

Additive and reversible: one new table, no change to existing rows. Applications confirmed before this revision simply have no
snapshot; the Tracker falls back to the documents of the session that prepared them and says so.

Revision ID: 0036_application_doc_snapshots
Revises: 0035_extension_auth
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0036_application_doc_snapshots"
down_revision = "0035_extension_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "application_document_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("tracker_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("source_document_id", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=True),
        sa.Column("content", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("plain_text", sa.Text(), nullable=True),
        sa.Column("format_version", sa.String(length=20), nullable=False, server_default="v1"),
        sa.Column("attached_by_extension", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("association_basis", sa.String(length=24), nullable=False, server_default="sole_session"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tracker_id"], ["application_tracker.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_document_id"], ["generated_documents.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tracker_id", "kind", name="uq_doc_snapshot_tracker_kind"),
    )
    op.create_index("ix_application_document_snapshots_user_id", "application_document_snapshots", ["user_id"])
    op.create_index("ix_application_document_snapshots_tracker_id", "application_document_snapshots", ["tracker_id"])


def downgrade() -> None:
    op.drop_index("ix_application_document_snapshots_tracker_id", table_name="application_document_snapshots")
    op.drop_index("ix_application_document_snapshots_user_id", table_name="application_document_snapshots")
    op.drop_table("application_document_snapshots")
