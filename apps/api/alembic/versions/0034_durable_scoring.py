"""Add dormant durable scoring metadata; never backfill or enqueue historic work.

Frozen PostgreSQL DDL. Constant defaults avoid table rewrites on PostgreSQL16;
short local timeouts abort rather than wait indefinitely for release locks.
"""

import sqlalchemy as sa

from alembic import op

revision = "0034_durable_scoring"
down_revision = "0033_prod_auth_identities"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL lock_timeout = '2s'")
    op.execute("SET LOCAL statement_timeout = '15s'")
    op.add_column(
        "users", sa.Column("scoring_generation", sa.BigInteger(), nullable=False, server_default=sa.text("0"))
    )
    op.add_column("users", sa.Column("scoring_admission_day", sa.Date(), nullable=True))
    op.add_column("users", sa.Column("scoring_roots_today", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.add_column(
        "job_postings", sa.Column("scoring_generation", sa.BigInteger(), nullable=False, server_default=sa.text("0"))
    )
    op.add_column("job_matches", sa.Column("scoring_job_id", sa.BigInteger(), nullable=True))
    op.add_column("job_matches", sa.Column("completed_user_generation", sa.BigInteger(), nullable=True))
    op.add_column("job_matches", sa.Column("completed_job_generation", sa.BigInteger(), nullable=True))
    op.add_column("job_matches", sa.Column("completed_input_digest", sa.String(64), nullable=True))
    op.add_column("job_matches", sa.Column("digest_schema", sa.Integer(), nullable=True))
    op.add_column("job_matches", sa.Column("current_operation_digest", sa.String(64), nullable=True))
    op.add_column("job_matches", sa.Column("current_user_generation", sa.BigInteger(), nullable=True))
    op.add_column("job_matches", sa.Column("current_job_generation", sa.BigInteger(), nullable=True))
    op.add_column("job_matches", sa.Column("current_score_version", sa.Integer(), nullable=True))
    op.add_column(
        "job_matches", sa.Column("operation_attempt_count", sa.Integer(), nullable=False, server_default=sa.text("0"))
    )
    op.add_column(
        "job_matches", sa.Column("recovery_cycle_used", sa.Boolean(), nullable=False, server_default=sa.text("false"))
    )
    op.add_column("job_matches", sa.Column("operation_error_category", sa.String(40), nullable=True))
    op.execute(
        "\nCREATE TABLE scoring_capacity (\n\tid SERIAL NOT NULL, \n\tlive_intents INTEGER DEF"
        "AULT '0' NOT NULL, \n\tlive_children INTEGER DEFAULT '0' NOT NULL, \n\treserved_unit"
        "s BIGINT DEFAULT '0' NOT NULL, \n\trunning_pairs INTEGER DEFAULT '0' NOT NULL, \n\ta"
        "dmission_day DATE, \n\tadmitted_roots_today INTEGER DEFAULT '0' NOT NULL, \n\tadmitt"
        "ed_units_today BIGINT DEFAULT '0' NOT NULL, \n\tupdated_at TIMESTAMP WITH TIME ZON"
        "E DEFAULT now() NOT NULL, \n\tPRIMARY KEY (id), \n\tCONSTRAINT ck_capacity_singleton"
        " CHECK (id = 1), \n\tCONSTRAINT ck_capacity_intents CHECK (live_intents BETWEEN 0 "
        "AND 1000), \n\tCONSTRAINT ck_capacity_children CHECK (live_children BETWEEN 0 AND "
        "10000), \n\tCONSTRAINT ck_capacity_units CHECK (reserved_units BETWEEN 0 AND 10000"
        "0), \n\tCONSTRAINT ck_capacity_running CHECK (running_pairs BETWEEN 0 AND 2), \n\tCO"
        "NSTRAINT ck_capacity_daily_roots CHECK (admitted_roots_today BETWEEN 0 AND 1000)"
        ", \n\tCONSTRAINT ck_capacity_daily_units CHECK (admitted_units_today BETWEEN 0 AND"
        " 100000)\n)\n\n"
    )
    op.execute(
        "\nCREATE TABLE scoring_intents (\n\tid BIGSERIAL NOT NULL, \n\tscope VARCHAR(20) NOT "
        "NULL, \n\toperation_key VARCHAR(64) NOT NULL, \n\tuser_id INTEGER, \n\tjob_id INTEGER,"
        " \n\tuser_generation BIGINT, \n\tjob_generation BIGINT, \n\tscore_version INTEGER NOT "
        "NULL, \n\treference_date DATE NOT NULL, \n\tselection_days INTEGER NOT NULL, \n\tinclu"
        "de_unknown_dates BOOLEAN NOT NULL, \n\tcutoff_at TIMESTAMP WITH TIME ZONE NOT NULL"
        ", \n\ttarget_upper_id BIGINT NOT NULL, \n\tcursor_id BIGINT NOT NULL, \n\tremaining_un"
        "its BIGINT NOT NULL, \n\tunfinished_children INTEGER NOT NULL, \n\tfailed_children I"
        "NTEGER NOT NULL, \n\texpansion_complete BOOLEAN NOT NULL, \n\texpansion_attempts INT"
        "EGER NOT NULL, \n\tstatus VARCHAR(30) NOT NULL, \n\tlease_token VARCHAR(36), \n\tlease"
        "_expires_at TIMESTAMP WITH TIME ZONE, \n\tnext_attempt_at TIMESTAMP WITH TIME ZONE"
        " NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tupdat"
        "ed_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tdeadline_at TIMESTAMP W"
        "ITH TIME ZONE NOT NULL, \n\tcompleted_at TIMESTAMP WITH TIME ZONE, \n\terror_categor"
        "y VARCHAR(40), \n\tPRIMARY KEY (id), \n\tCONSTRAINT ck_intent_state CHECK (status IN"
        " ('PENDING','EXPANDING','WAITING','SUCCEEDED','TERMINAL_FAILED','SUPERSEDED','CA"
        "NCELED')), \n\tCONSTRAINT ck_intent_lease CHECK ((status = 'EXPANDING' AND lease_t"
        "oken IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status <> 'EXPANDING' AND"
        " lease_token IS NULL AND lease_expires_at IS NULL)), \n\tCONSTRAINT ck_intent_term"
        "inal CHECK ((status IN ('SUCCEEDED','TERMINAL_FAILED','SUPERSEDED','CANCELED') A"
        "ND completed_at IS NOT NULL) OR (status NOT IN ('SUCCEEDED','TERMINAL_FAILED','S"
        "UPERSEDED','CANCELED') AND completed_at IS NULL)), \n\tCONSTRAINT ck_intent_error "
        "CHECK (error_category IS NULL OR error_category IN ('DB_UNAVAILABLE','WORKER_TIM"
        "EOUT','WORKER_LOST','INPUT_TOO_LARGE','INPUT_INVALID','INPUT_MISSING','OWNERSHIP"
        "_INVALID','ALGORITHM_UNSUPPORTED','INTERNAL_SCORING_ERROR','ATTEMPTS_EXHAUSTED',"
        "'DEADLINE_EXCEEDED')), \n\tCONSTRAINT ck_intent_scope CHECK ((scope = 'JOB_FANOUT'"
        " AND job_id IS NOT NULL AND job_generation IS NOT NULL AND user_id IS NULL) OR ("
        "scope = 'USER_REFRESH' AND user_id IS NOT NULL AND user_generation IS NOT NULL A"
        "ND job_id IS NULL) OR (scope = 'PAIR_REFRESH' AND user_id IS NOT NULL AND user_g"
        "eneration IS NOT NULL AND job_id IS NOT NULL AND job_generation IS NOT NULL)), \n"
        "\tCONSTRAINT ck_intent_cursor CHECK (cursor_id >= 0 AND cursor_id <= target_upper"
        "_id), \n\tCONSTRAINT ck_intent_units CHECK (remaining_units >= 0 AND unfinished_ch"
        "ildren >= 0 AND failed_children >= 0), \n\tCONSTRAINT ck_intent_bounds CHECK (expa"
        "nsion_attempts BETWEEN 0 AND 3 AND selection_days BETWEEN 1 AND 60), \n\tCONSTRAIN"
        "T ck_intent_version CHECK (score_version >= 0), \n\tUNIQUE (operation_key), \n\tFORE"
        "IGN KEY(user_id) REFERENCES users (id) ON DELETE RESTRICT, \n\tFOREIGN KEY(job_id)"
        " REFERENCES job_postings (id) ON DELETE RESTRICT, \n\tCONSTRAINT ck_intent_identit"
        "y CHECK (length(operation_key) = 64 AND (user_generation IS NULL OR user_generat"
        "ion >= 0) AND (job_generation IS NULL OR job_generation >= 0))\n)\n\n"
    )
    op.execute(
        "\nCREATE TABLE scoring_jobs (\n\tid BIGSERIAL NOT NULL, \n\tintent_id BIGINT NOT NULL"
        ", \n\tuser_id INTEGER NOT NULL, \n\tjob_id INTEGER NOT NULL, \n\tuser_generation BIGIN"
        "T NOT NULL, \n\tjob_generation BIGINT NOT NULL, \n\tscore_version INTEGER NOT NULL, "
        "\n\tinput_digest VARCHAR(64) NOT NULL, \n\toperation_digest VARCHAR(64) NOT NULL, \n\t"
        "digest_schema INTEGER NOT NULL, \n\treference_date DATE NOT NULL, \n\tstatus VARCHAR"
        "(30) NOT NULL, \n\tattempt_count INTEGER NOT NULL, \n\tnext_attempt_at TIMESTAMP WIT"
        "H TIME ZONE NOT NULL, \n\tlease_token VARCHAR(36), \n\tlease_expires_at TIMESTAMP WI"
        "TH TIME ZONE, \n\tclaimed_at TIMESTAMP WITH TIME ZONE, \n\tcreated_at TIMESTAMP WITH"
        " TIME ZONE DEFAULT now() NOT NULL, \n\tupdated_at TIMESTAMP WITH TIME ZONE DEFAULT"
        " now() NOT NULL, \n\tdeadline_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tcompleted_at"
        " TIMESTAMP WITH TIME ZONE, \n\terror_category VARCHAR(40), \n\toutcome VARCHAR(30), "
        "\n\tPRIMARY KEY (id), \n\tCONSTRAINT ck_scoring_job_state CHECK (status IN ('PENDING"
        "','CLAIMED','RETRY_WAIT','SUCCEEDED','TERMINAL_FAILED','SUPERSEDED','CANCELED'))"
        ", \n\tCONSTRAINT ck_scoring_job_lease CHECK ((status = 'CLAIMED' AND lease_token I"
        "S NOT NULL AND lease_expires_at IS NOT NULL) OR (status <> 'CLAIMED' AND lease_t"
        "oken IS NULL AND lease_expires_at IS NULL)), \n\tCONSTRAINT ck_scoring_job_termina"
        "l CHECK ((status IN ('SUCCEEDED','TERMINAL_FAILED','SUPERSEDED','CANCELED') AND "
        "completed_at IS NOT NULL) OR (status NOT IN ('SUCCEEDED','TERMINAL_FAILED','SUPE"
        "RSEDED','CANCELED') AND completed_at IS NULL)), \n\tCONSTRAINT ck_scoring_job_erro"
        "r CHECK (error_category IS NULL OR error_category IN ('DB_UNAVAILABLE','WORKER_T"
        "IMEOUT','WORKER_LOST','INPUT_TOO_LARGE','INPUT_INVALID','INPUT_MISSING','OWNERSH"
        "IP_INVALID','ALGORITHM_UNSUPPORTED','INTERNAL_SCORING_ERROR','ATTEMPTS_EXHAUSTED"
        "','DEADLINE_EXCEEDED')), \n\tCONSTRAINT uq_scoring_intent_pair UNIQUE (intent_id, "
        "user_id, job_id), \n\tCONSTRAINT ck_scoring_job_attempts CHECK (attempt_count BETW"
        "EEN 0 AND 6), \n\tCONSTRAINT ck_scoring_job_generations CHECK (user_generation >= "
        "0 AND job_generation >= 0 AND score_version >= 0), \n\tCONSTRAINT ck_scoring_diges"
        "t_schema CHECK (digest_schema = 1), \n\tCONSTRAINT ck_scoring_outcome CHECK (outco"
        "me IS NULL OR outcome IN ('SCORE','PROFILE_INCOMPLETE','REUSED_EXISTING')), \n\tFO"
        "REIGN KEY(intent_id) REFERENCES scoring_intents (id) ON DELETE RESTRICT, \n\tFOREI"
        "GN KEY(user_id) REFERENCES users (id) ON DELETE RESTRICT, \n\tFOREIGN KEY(job_id) "
        "REFERENCES job_postings (id) ON DELETE RESTRICT, \n\tCONSTRAINT ck_scoring_hashes "
        "CHECK (length(input_digest) = 64 AND length(operation_digest) = 64), \n\tCONSTRAIN"
        "T ck_scoring_success_outcome CHECK (status <> 'SUCCEEDED' OR outcome IS NOT NULL"
        ")\n)\n\n"
    )
    op.execute("CREATE INDEX ix_intent_deadline ON scoring_intents (status, deadline_at)")
    op.execute("CREATE INDEX ix_intent_due ON scoring_intents (next_attempt_at, id) WHERE status = 'PENDING'")
    op.execute("CREATE INDEX ix_intent_expiry ON scoring_intents (lease_expires_at, id) WHERE status = 'EXPANDING'")
    op.execute("CREATE INDEX ix_intent_job ON scoring_intents (job_id, job_generation)")
    op.execute("CREATE INDEX ix_intent_user ON scoring_intents (user_id, user_generation)")
    op.execute(
        "CREATE INDEX ix_scoring_due ON scoring_jobs (next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT')"
    )
    op.execute("CREATE INDEX ix_scoring_expired ON scoring_jobs (lease_expires_at, id) WHERE status = 'CLAIMED'")
    op.execute("CREATE INDEX ix_scoring_operation ON scoring_jobs (operation_digest)")
    op.execute("CREATE INDEX ix_scoring_parent ON scoring_jobs (intent_id, status)")
    op.execute("CREATE INDEX ix_scoring_user ON scoring_jobs (user_id, status)")
    # Avoid validating/scanning historical JobMatch rows during this additive release.
    # Existing rows have NULL in the new column; new writes still enforce the FK.
    op.execute(
        "ALTER TABLE job_matches ADD CONSTRAINT fk_match_scoring_job "
        "FOREIGN KEY (scoring_job_id) REFERENCES scoring_jobs(id) ON DELETE SET NULL NOT VALID"
    )
    op.execute("ALTER TABLE users ADD CONSTRAINT ck_user_scoring_generation CHECK (scoring_generation >= 0) NOT VALID")
    op.execute("ALTER TABLE users ADD CONSTRAINT ck_user_scoring_roots CHECK (scoring_roots_today >= 0) NOT VALID")
    op.execute(
        "ALTER TABLE job_postings ADD CONSTRAINT ck_posting_scoring_generation CHECK (sco"
        "ring_generation >= 0) NOT VALID"
    )
    op.execute(
        "ALTER TABLE job_matches ADD CONSTRAINT ck_match_operation_attempts CHECK (operat"
        "ion_attempt_count BETWEEN 0 AND 6) NOT VALID"
    )
    op.execute(
        "ALTER TABLE job_matches ADD CONSTRAINT ck_match_ordinary_attempts CHECK (recover"
        "y_cycle_used OR operation_attempt_count <= 3) NOT VALID"
    )
    op.execute("INSERT INTO scoring_capacity (id) VALUES (1)")


def downgrade():
    op.execute("SET LOCAL lock_timeout = '2s'")
    op.execute("SET LOCAL statement_timeout = '15s'")
    # A rollback cannot erase an accepted generation, even a terminal receipt.
    # Until a separate retention/archive operation exists, any intent refuses drop.
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM scoring_intents)")).scalar():
        raise RuntimeError("Durable scoring records must be preserved before downgrade")
    op.drop_constraint("fk_match_scoring_job", "job_matches", type_="foreignkey")
    op.drop_table("scoring_jobs")
    op.drop_table("scoring_intents")
    op.drop_table("scoring_capacity")
    op.drop_constraint("ck_user_scoring_generation", "users", type_="check")
    op.drop_constraint("ck_user_scoring_roots", "users", type_="check")
    op.drop_constraint("ck_posting_scoring_generation", "job_postings", type_="check")
    op.drop_constraint("ck_match_operation_attempts", "job_matches", type_="check")
    op.drop_constraint("ck_match_ordinary_attempts", "job_matches", type_="check")
    op.drop_column("users", "scoring_roots_today")
    op.drop_column("users", "scoring_admission_day")
    op.drop_column("users", "scoring_generation")
    op.drop_column("job_postings", "scoring_generation")
    op.drop_column("job_matches", "operation_error_category")
    op.drop_column("job_matches", "recovery_cycle_used")
    op.drop_column("job_matches", "operation_attempt_count")
    op.drop_column("job_matches", "current_score_version")
    op.drop_column("job_matches", "current_job_generation")
    op.drop_column("job_matches", "current_user_generation")
    op.drop_column("job_matches", "current_operation_digest")
    op.drop_column("job_matches", "digest_schema")
    op.drop_column("job_matches", "completed_input_digest")
    op.drop_column("job_matches", "completed_job_generation")
    op.drop_column("job_matches", "completed_user_generation")
    op.drop_column("job_matches", "scoring_job_id")
