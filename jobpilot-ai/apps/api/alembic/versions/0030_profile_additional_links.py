"""Add X and arbitrary professional links to the profile.

The profile had exactly three link columns — ``linkedin_url``, ``github_url``
and ``portfolio_url`` — so a candidate whose work lives on Google Scholar,
Kaggle, Hugging Face or their own blog had nowhere to put it, and X had no home
at all.

Two additive columns:

* ``x_url``            first-class, matching the other three named networks. It
                       is a *named* column rather than a row in the JSON list
                       because the extension's link resolution treats the known
                       networks as distinct fields, and burying X in a free-form
                       list would make it the only major network that is not
                       addressable by name.
* ``additional_links`` a JSON list of ``{"label", "url"}`` objects for
                       everything else. A list rather than more columns because
                       the set is genuinely open-ended — the next user will want
                       ResearchGate, then Devpost, then something that does not
                       exist yet — and adding a column per network does not
                       scale.

Both are nullable with no server default, so this is metadata-only on
PostgreSQL 11+: no table rewrite, no lock held while rows are scanned, and every
existing profile keeps working unchanged. NULL reads as "the user has not
supplied this", which is exactly true — nothing is back-filled and no existing
link column is touched, renamed or migrated into the new list.

Downgrade drops only the two columns this migration added, so a rollback loses
the newly captured links and nothing else.

Revision ID: 0030_profile_additional_links
Revises: 0029_session_answer_overrides
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0030_profile_additional_links"
down_revision = "0029_session_answer_overrides"
branch_labels = None
depends_on = None

#: Mirrors app.models.entities.JsonType so SQLite (tests) and PostgreSQL
#: (production) both get an appropriate column type.
json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.add_column("user_profiles", sa.Column("x_url", sa.String(length=500), nullable=True))
    op.add_column(
        "user_profiles",
        sa.Column("additional_links", json_type, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user_profiles", "additional_links")
    op.drop_column("user_profiles", "x_url")
