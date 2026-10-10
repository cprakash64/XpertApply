# Dormant durable scoring foundation (PROD-READY-04B-R2)

## Status and scope

Foundation verified from 87c3259; local checkpoint only. Activation is OFF and structurally dormant:
no route, task, scheduler, dispatcher or startup calls the new service. Existing
Celery and inline scoring remain unchanged. RB02/RB07 remain UNRESOLVED; release
NO_GO and historical qualification BLOCKED. No push or production deployment.

R1 evidence: external artifact set `prod-ready-04b-r1` (42-file verified manifest,
SHA256 `2cd406f4d124deb7fb44574c65eea8ac190c9903accb1962c05225724c4ca081`). Exact R2
scope: entities, migration0034, scoring_intents, additive digest/reference-date
helpers, config, three test files and this plan. The original22-file proposal is
preserved separately and is not a foundation dependency.

## Architecture and decisions

PostgreSQL owns intents, pair work, leases, attempts and capacity. Intake is NOT
connected in R2; R3 must commit intake and intent together. Metadata contains only
canonical IDs/generations/digests/selection/cursor/state/time/error enums.

Short transactions lock capacity first, then parent/canonical user/job/pair/match.
Pair lease90s, unexpired iff expires_at > database now; equality is expired.
The lease clock refreshes after all result/retry lookups; lookup-time expiry is
fenced before writes. Conditional completion checks token, parent, canonical generations, exact digest
and algorithm version, writing JobMatch and terminal state/counters together.
No score engine or provider is called by this service.

Exact ordered ProfileView/JobView/SearchCriteria JSON is SHA256 format1. Criteria
can use an explicit frozen reference date; defaults retain current behavior.
JobMatch holds shared operation attempts across overlapping roots: ordinary3;
recovery_cycle_used reserves a future audited extra cycle, total maximum6. R2
exposes no grant/reset/operator retry API. Terminal states cannot reopen normally.
Retries persist30/120s plus deterministic0..10s jitter. Invalidation is immediate;
child cleanup is bounded100 per call. Result/cleanup CAS prevents double release.

Capacity serializes live roots, live pair rows, reserved numeric target-ID range,
running claims and global/user daily admission. Numeric gaps release credits with
cursor progression. Defaults are R1 conservative ceilings, not qualified production
thresholds. Tests inject small internal policies. Sparse-ID sizing, physical process
bounds,202/save rejection/retention contracts remain pre-activation owner decisions.

Account FKs RESTRICT unattended deletion. A dormant explicit cleanup primitive
releases live reservations and removes owned metadata before canonical deletion;
R3 must connect privacy route/export and coordinate file cleanup. No new privacy
route behavior in R2. Terminal metadata30d and bounded retention loops are R3+;
current JobMatch identity/attempt metadata must survive cleanup.

## Validation

Focused: MIGRATION_TEST_DATABASE_URL=<scratch admin> python -m pytest
app/tests/test_durable_scoring.py app/tests/test_durable_scoring_postgres.py
app/tests/test_durable_scoring_migration.py. Real PostgreSQL required; no Redis
service is used. Then make test-api, make test-web, make test-extension; Ruff and
compile; Compose preflight; clean API/worker/scheduler image builds; disposable
DB migration/API startup; R13 R6/archives/known-failure replay.
Focused53/53 final cases pass (24 pure,27 real PostgreSQL,2 migration), including
lease lookup boundaries, independent-session races and transactional failures.
Web1033 pass with lint/typecheck/build; extension809 pass/10 baseline skips with
typecheck/build. Final entire backend:2009 passed,0 failed/skipped (1955 baseline +53 durability
cases +1 migration revision parameter),1170 baseline warnings. Ruff/compile pass.
Compose exact production preflight passes; clean API/worker/scheduler builds pass.
All72 Python and109 OS package versions match reviewed04A production image.
Disposable migration/API readiness and existing worker/scheduler startup pass;
flag OFF, new service absent from existing app imports, durable rows/counters0.
R13 R6 25/25 and archives27/27 parity;14 known-failure controls,0 false negatives;
1022 gate replays,1536 predicate comparisons,25 label units and4 mock integrations
pass. Classifier bytes unchanged; live qualification remains BLOCKED.

## Rollout and rollback

0034 adds empty tables/nullable match identity and constant canonical defaults,
without historical UPDATE/enqueue. Frozen SQL never imports future live models.
PostgreSQL lock/statement timeouts abort long release waits. Existing table checks
and the nullable JobMatch foreign key
are NOT VALID to avoid full-table validation scans; new writes enforce them.
Any accepted intent prevents downgrade; retain durable receipts rather than silently
dropping them. Empty downgrade is reversible and tested.

R2 local checkpoint only after every required gate passes. Do not activate or
continue R3 without a new owner instruction. R3 integrates all producers, runner,
status/UI/privacy and migration recovery. R4 upload/parser; R5 abuse/paid AI; R6
combined runtime/security/qualification. Rollback after future activation must
preserve intents and use compatible producers/consumers; baseline inline code is
not a safe rollback for already accepted durable work.


## Pre-activation owner review

This passes R2 with notes, not a release approval. Before activation: qualify the
numeric-ID reservation ceilings against real sparse IDs and query plans; prove
supervised physical process bounds; define the audited actor/cooldown for the
single extra3 lifetime cycle; integrate every canonical writer and producer in
one acceptance transaction; wire current-result/status/privacy projections; and
implement bounded retention/reconciliation preserving JobMatch identity/attempt
metadata. R3 must validate NOT VALID constraints in a suitable later release
window without rewriting this migration once applied outside disposable tests.
The dispatcher must discover pending parent rows as well as pair recovery work.
No R3 code, upload parser, abuse control, paid-call behavior or release activation
is included. Owner review/new authorization is required to begin R3.
