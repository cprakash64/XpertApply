"""Add extension PKCE authorization codes and rotating refresh credentials.

Revision ID: 0035_extension_auth
Revises: 0033_prod_auth_identities
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0035_extension_auth"
down_revision = "0033_prod_auth_identities"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "extension_auth_codes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("code_challenge", sa.String(length=64), nullable=False),
        sa.Column("redirect_uri", sa.String(length=300), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_extension_auth_codes_user_id", "extension_auth_codes", ["user_id"])
    op.create_index("ix_extension_auth_codes_code_hash", "extension_auth_codes", ["code_hash"], unique=True)
    op.create_table(
        "extension_credentials",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("family_id", sa.String(length=32), nullable=False),
        sa.Column("refresh_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_extension_credentials_user_id", "extension_credentials", ["user_id"])
    op.create_index("ix_extension_credentials_family_id", "extension_credentials", ["family_id"])
    op.create_index("ix_extension_credentials_refresh_hash", "extension_credentials", ["refresh_hash"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_extension_credentials_refresh_hash", table_name="extension_credentials")
    op.drop_index("ix_extension_credentials_family_id", table_name="extension_credentials")
    op.drop_index("ix_extension_credentials_user_id", table_name="extension_credentials")
    op.drop_table("extension_credentials")
    op.drop_index("ix_extension_auth_codes_code_hash", table_name="extension_auth_codes")
    op.drop_index("ix_extension_auth_codes_user_id", table_name="extension_auth_codes")
    op.drop_table("extension_auth_codes")
