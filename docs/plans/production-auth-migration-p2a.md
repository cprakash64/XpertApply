# Production auth migration P2A

## Objective

Build and qualify a production-compatible external-identity migration on the
production lineage without importing the application-memory or snapshot
lineage. This stage is local-only and contains no Google-auth application code.

## Architecture and decisions

- The release branch starts exactly at production commit
  `6903b7a02b5512a666c8592f776638065c5b039b`.
- `0033_prod_auth_identities` descends directly from
  `0032_confirmation_contract`, leaving the two confirmation timestamp columns
  untouched.
- The migration only makes `users.hashed_password` nullable and creates the
  provider-neutral `external_identities` table, constraints, and user index.
- No application-memory, snapshot, retention, or generated-document provenance
  schema is introduced.
- Downgrade fails closed when any external identity or null-password user exists.
  It never deletes identity data or manufactures credentials.
- The release migration directory must retain one Alembic head because runtime
  readiness calls `ScriptDirectory.get_current_head()`.

## Progress

- [x] Verify the qualified auth reference SHA and clean worktree.
- [x] Verify the exact production base exists locally.
- [x] Create the dedicated release worktree and branch from that commit.
- [x] Verify the production lineage has one head at `0032_confirmation_contract`.
- [x] Implement the production-compatible migration.
- [x] Add focused PostgreSQL migration qualification tests.
- [x] Run PostgreSQL 16.14 upgrade, downgrade, refusal, uniqueness, cascade, lock,
      and schema-diff qualification.
- [x] Run repository validation appropriate to the migration-only change.
- [x] Record final validation evidence below.

## Validation plan

Use a dedicated `postgres:16.14` container with a unique Compose/project name
and no published port. Tests create and destroy UUID-named scratch databases
through `MIGRATION_TEST_DATABASE_URL`; no developer, acceptance, or production
database is used.

Required evidence:

- upgrade from `0032_confirmation_contract` on synthetic populated data;
- confirmation timestamps and password hashes byte-for-byte unchanged;
- exact auth table columns, PK, cascade FK, uniqueness, and index;
- no application-memory or provenance schema;
- safe empty-state downgrade and re-upgrade;
- refusal, with no partial DDL/data loss, for linked-password and provider-only users;
- uniqueness enforcement and delete cascade;
- one release head and clean Alembic graph;
- controlled lock observation and `users` relfilenode comparison;
- schema diff limited to password nullability and external identities;
- compile, Ruff, `git diff --check`, Compose config, and repository test gates.

## Rollout

P2A does not deploy. A later release stage must run this migration before any
Google-auth code is allowed to create provider-only users. OAuth remains disabled
until every old API replica has been replaced and schema/readiness checks pass.

## Rollback

Downgrade is permitted only while `external_identities` is empty and every user
has a password hash. Once either condition is false, downgrade intentionally
raises before DDL. A post-enable rollback requires a separately approved,
identity-preserving application and data plan.

## Validation evidence

Qualified locally against the exact `postgres:16.14` image in a disposable
container on a Docker-assigned loopback port:

- focused migration suite: 4 passed;
- full API suite: 1,877 passed, 4 skipped (the focused PostgreSQL tests are
  intentionally skipped without the isolated database URL);
- Web: lint, typecheck, production build, and 938 tests passed;
- Extension: typecheck/build passed; 809 tests passed and 10 skipped;
- Ruff and Python compilation passed for the new migration/test;
- `docker compose config`, `git diff --check`, and single-head Alembic graph passed;
- controlled lock test observed an ungranted `AccessExclusiveLock` on `users`;
- unblocked migration time on two synthetic users: 0.1030 seconds;
- `users` relfilenode was unchanged (`23252` before and after), so no heap rewrite
  was observed in this controlled PostgreSQL 16.14 run;
- catalog diff contained only `users.hashed_password` changing from `NOT NULL`
  to nullable and the new `external_identities` table/sequence and associated
  schema objects;
- confirmation values and password hashes remained unchanged;
- empty downgrade/re-upgrade, both downgrade-refusal cases, composite
  uniqueness, and user-delete cascade all passed.
