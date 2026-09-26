"""Add external identities after the production confirmation contract.

Revision ID: 0033_prod_auth_identities
Revises: 0032_confirmation_contract
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0033_prod_auth_identities"
down_revision = "0032_confirmation_contract"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column(
            "hashed_password",
            existing_type=sa.String(length=255),
            nullable=True,
        )
    op.create_table(
        "external_identities",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("provider_email", sa.String(length=320), nullable=True),
        sa.Column("email_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "subject", name="uq_external_identity_provider_subject"),
        sa.UniqueConstraint("user_id", "provider", name="uq_external_identity_user_provider"),
    )
    op.create_index("ix_external_identities_user_id", "external_identities", ["user_id"])


def downgrade() -> None:
    bind = op.get_bind()
    identity_rows = bind.scalar(sa.text("SELECT count(*) FROM external_identities"))
    null_password_users = bind.scalar(
        sa.text("SELECT count(*) FROM users WHERE hashed_password IS NULL")
    )
    if identity_rows or null_password_users:
        raise RuntimeError(
            "Refusing production auth downgrade: external identities or "
            "provider-only users still exist."
        )
    op.drop_index("ix_external_identities_user_id", table_name="external_identities")
    op.drop_table("external_identities")
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column(
            "hashed_password",
            existing_type=sa.String(length=255),
            nullable=False,
        )
