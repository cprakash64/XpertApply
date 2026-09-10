"""Add the application-memory and Tracker retention foundation.

Revision ID: 0032_application_memory
Revises: 0031_publications
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0032_application_memory"
down_revision = "0031_publications"
branch_labels = None
depends_on = None

json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.add_column(
        "application_tracker",
        sa.Column("deletion_scheduled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "application_tracker",
        sa.Column("deletion_cancelled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "application_tracker",
        sa.Column("confirmation_required_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "application_tracker",
        sa.Column("confirmation_prompt_dismissed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_application_tracker_deletion_scheduled_at",
        "application_tracker",
        ["deletion_scheduled_at"],
    )

    op.create_table(
        "application_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("application_tracker_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=True),
        sa.Column("source_session_id", sa.Integer(), nullable=True),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column(
            "confirmation_source",
            sa.Enum(
                "extension_confirmed",
                "auto_apply_confirmed",
                "user_confirmed",
                name="snapshotconfirmationsource",
            ),
            nullable=False,
        ),
        sa.Column(
            "submission_evidence_type",
            sa.Enum(
                "success_page",
                "success_response",
                "success_message",
                name="submissionevidencetype",
            ),
            nullable=True,
        ),
        sa.Column("submission_evidence_metadata", json_type, nullable=False),
        sa.Column("ats_provider", sa.String(length=40), nullable=True),
        sa.Column("job_external_id", sa.String(length=300), nullable=True),
        sa.Column("job_title", sa.String(length=500), nullable=False),
        sa.Column("company_name", sa.String(length=300), nullable=False),
        sa.Column("job_url", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("job_description_snapshot", sa.Text(), nullable=True),
        sa.Column("resume_document_id", sa.Integer(), nullable=True),
        sa.Column("resume_filename", sa.String(length=500), nullable=True),
        sa.Column("resume_content_hash", sa.String(length=64), nullable=True),
        sa.Column("cover_letter_used", sa.Boolean(), nullable=False),
        sa.Column("cover_letter_document_id", sa.Integer(), nullable=True),
        sa.Column("cover_letter_filename", sa.String(length=500), nullable=True),
        sa.Column("cover_letter_content_hash", sa.String(length=64), nullable=True),
        sa.Column("cover_letter_text_snapshot", sa.Text(), nullable=True),
        sa.Column("answers_snapshot", json_type, nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["application_tracker_id"], ["application_tracker.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["job_id"], ["job_postings.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["resume_document_id"], ["generated_documents.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["cover_letter_document_id"], ["generated_documents.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("application_tracker_id", "attempt_number", name="uq_snapshot_tracker_attempt"),
        sa.UniqueConstraint("source_session_id", name="uq_snapshot_source_session"),
    )
    op.create_index("ix_snapshot_user_created", "application_snapshots", ["user_id", "created_at"])
    op.create_index(
        "ix_snapshot_tracker_applied",
        "application_snapshots",
        ["application_tracker_id", "applied_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_snapshot_tracker_applied", table_name="application_snapshots")
    op.drop_index("ix_snapshot_user_created", table_name="application_snapshots")
    op.drop_table("application_snapshots")
    op.drop_index("ix_application_tracker_deletion_scheduled_at", table_name="application_tracker")
    op.drop_column("application_tracker", "confirmation_prompt_dismissed_at")
    op.drop_column("application_tracker", "confirmation_required_at")
    op.drop_column("application_tracker", "deletion_cancelled_at")
    op.drop_column("application_tracker", "deletion_scheduled_at")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        sa.Enum(name="submissionevidencetype").drop(bind, checkfirst=True)
        sa.Enum(name="snapshotconfirmationsource").drop(bind, checkfirst=True)
