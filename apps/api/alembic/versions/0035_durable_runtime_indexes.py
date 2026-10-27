"""Bounded runtime discovery; no historical enqueue or canonical mutation."""

from alembic import op

revision = "0035_durable_runtime_indexes"
down_revision = "0034_durable_scoring"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL lock_timeout = '2s'")
    op.execute("SET LOCAL statement_timeout = '15s'")
    op.execute(
        "CREATE INDEX ix_scoring_recovery_active ON scoring_jobs(id) WHERE status IN ('PENDING','RETRY_WAIT','CLAIMED')"
    )
    op.execute("CREATE INDEX ix_scoring_user_generation_recent ON scoring_jobs(user_id,user_generation,id)")
    op.execute("CREATE INDEX ix_scoring_user_recent ON scoring_jobs(user_id,id)")
    op.execute("CREATE INDEX ix_intent_user_recent ON scoring_intents(user_id,id)")
    op.execute(
        "CREATE INDEX ix_intent_reconcile ON scoring_intents(id) WHERE "
        "status NOT IN ('SUCCEEDED','TERMINAL_FAILED','SUPERSEDED','CANCELED') OR unfinished_children > 0"
    )
    op.execute("CREATE INDEX ix_intent_retention ON scoring_intents(completed_at,id) WHERE completed_at IS NOT NULL")


def downgrade():
    op.execute("SET LOCAL lock_timeout = '2s'")
    op.execute("SET LOCAL statement_timeout = '15s'")
    for name in (
        "ix_scoring_user_generation_recent",
        "ix_intent_reconcile",
        "ix_intent_retention",
        "ix_intent_user_recent",
        "ix_scoring_user_recent",
        "ix_scoring_recovery_active",
    ):
        op.execute("DROP INDEX " + name)
