"""Add submission-confirmation timestamps to application trackers.

Revision ID: 0032_confirmation_contract
Revises: 0031_publications
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0032_confirmation_contract"
down_revision = "0031_publications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "application_tracker",
        sa.Column("confirmation_required_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "application_tracker",
        sa.Column("confirmation_prompt_dismissed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("application_tracker", "confirmation_prompt_dismissed_at")
    op.drop_column("application_tracker", "confirmation_required_at")
