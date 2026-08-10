"""Explicit legal application answers.

Two changes, both about telling "unanswered" apart from "No":

1. ``user_profiles.requires_sponsorship`` becomes nullable. It was
   ``NOT NULL DEFAULT false``, so every user who never answered looked exactly
   like a user who explicitly answered "No".

2. Legal answers in ``application_answers`` that were created by the old
   derivation path are marked unverified, so they must be reconfirmed before
   they can be auto-filled again.

Data-loss limitation, stated honestly: existing ``false`` values are ambiguous
and CANNOT be recovered. The schema never recorded whether the user chose False
or simply never answered. This migration therefore does NOT backfill them into
verified answers — it leaves the legacy column alone and requires an explicit
answer before anything is auto-filled. Some users who really did answer "No"
will be asked once more. That is the safe direction of the trade.

Revision ID: 0028_explicit_legal_answers
Revises: 0027_applied_lifecycle
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0028_explicit_legal_answers"
down_revision = "0027_applied_lifecycle"
branch_labels = None
depends_on = None

LEGAL_KEYS = ("work_authorization_us", "sponsorship_required_now", "sponsorship_required_future")


def upgrade() -> None:
    # 1. Unanswered becomes representable.
    with op.batch_alter_table("user_profiles") as batch:
        batch.alter_column(
            "requires_sponsorship",
            existing_type=sa.Boolean(),
            nullable=True,
            server_default=None,
        )

    # 2. Any legal answer that cannot PROVE explicit confirmation is demoted.
    #
    # The old path wrote these rows with source="profile" (derived) and no
    # confirmation timestamp. We cannot reliably distinguish a genuinely
    # confirmed row from a derived one, so we fail safe: everything that is not
    # already both user-verified AND timestamped is marked unverified and
    # excluded from autofill. Values are preserved, never printed, and the user
    # can reconfirm in one click.
    answers = sa.table(
        "application_answers",
        sa.column("canonical_key", sa.String),
        sa.column("source", sa.String),
        sa.column("is_user_verified", sa.Boolean),
        sa.column("allow_auto_fill", sa.Boolean),
        sa.column("verification_required", sa.Boolean),
        sa.column("last_verified_at", sa.DateTime(timezone=True)),
    )
    trusted = (
        "explicit_profile",
        "user_confirmed_application",
        "user_confirmed_saved",
        "verified_answer_vault",
    )
    op.execute(
        answers.update()
        .where(answers.c.canonical_key.in_(LEGAL_KEYS))
        .where(
            sa.or_(
                answers.c.is_user_verified.is_(False),
                answers.c.last_verified_at.is_(None),
                answers.c.source.notin_(trusted),
            )
        )
        .values(is_user_verified=False, allow_auto_fill=False, verification_required=True)
    )


def downgrade() -> None:
    # Restore NOT NULL. Rows that are NULL (genuinely unanswered) have to become
    # something; false is the only legal value the old schema allowed, which is
    # precisely the ambiguity this migration removed — so downgrading
    # re-introduces it. Documented rather than hidden.
    op.execute(
        "UPDATE user_profiles SET requires_sponsorship = false "
        "WHERE requires_sponsorship IS NULL"
    )
    with op.batch_alter_table("user_profiles") as batch:
        batch.alter_column(
            "requires_sponsorship",
            existing_type=sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        )
