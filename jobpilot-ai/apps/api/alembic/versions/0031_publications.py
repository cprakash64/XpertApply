"""Add the publications career table.

Publications were the one career section with no model: the profile could store
education, experience, projects, certifications and awards, but a candidate's
papers had nowhere to live.

The table mirrors the other career tables exactly — integer PK, ``user_id`` FK
with ``ON DELETE CASCADE`` and an index, and no timestamps, because these rows
are replaced wholesale by ``PUT /profile/career`` rather than edited in place.
Only ``title`` is required; everything else is nullable, since a preprint may
have no DOI and an in-press paper may have no date.

Creating a new table cannot affect existing rows, so this is safe against a
populated database: no backfill, no rewrite of any other table, and nothing
reads the table until a user saves a publication. Downgrade drops only this
table.

Revision ID: 0031_publications
Revises: 0030_profile_additional_links
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0031_publications"
down_revision = "0030_profile_additional_links"
branch_labels = None
depends_on = None

#: Mirrors app.models.entities.JsonType so SQLite (tests) and PostgreSQL
#: (production) each get an appropriate column type.
json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "publications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("venue", sa.String(length=200), nullable=True),
        sa.Column("authors", json_type, nullable=True),
        sa.Column("publication_date", sa.Date(), nullable=True),
        sa.Column("url", sa.String(length=500), nullable=True),
        sa.Column("doi", sa.String(length=120), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # Every read is "this user's publications", which is exactly this index.
    op.create_index("ix_publications_user_id", "publications", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_publications_user_id", table_name="publications")
    op.drop_table("publications")
