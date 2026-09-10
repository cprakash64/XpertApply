"""Add immutable document and truthful artifact provenance fields.

Revision ID: 0033_snapshot_provenance
Revises: 0032_application_memory
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0033_snapshot_provenance"
down_revision = "0032_application_memory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("generated_documents", sa.Column("content_hash", sa.String(length=64), nullable=True))
    op.add_column("generated_documents", sa.Column("immutable_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("generated_documents", sa.Column("source_document_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_generated_documents_source_document",
        "generated_documents",
        "generated_documents",
        ["source_document_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_generated_documents_content_hash", "generated_documents", ["content_hash"])
    op.add_column(
        "application_snapshots",
        sa.Column("resume_used", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column("application_snapshots", sa.Column("resume_provenance", sa.String(length=40), nullable=True))
    op.add_column(
        "application_snapshots",
        sa.Column("cover_letter_mode", sa.String(length=20), server_default="unused", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("application_snapshots", "cover_letter_mode")
    op.drop_column("application_snapshots", "resume_provenance")
    op.drop_column("application_snapshots", "resume_used")
    op.drop_index("ix_generated_documents_content_hash", table_name="generated_documents")
    op.drop_constraint("fk_generated_documents_source_document", "generated_documents", type_="foreignkey")
    op.drop_column("generated_documents", "source_document_id")
    op.drop_column("generated_documents", "immutable_at")
    op.drop_column("generated_documents", "content_hash")
