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

## R3 partial integration checkpoint (blocked; no commit)

R3 began from exact clean 2267bbc8d0ee6ae52b35d4d4e65c47dcc5e2d1df. All88
R2 evidence artifacts and42 R1 artifacts verify; original22-file proposal hashes,
HEAD and dirty status remain preserved. Fresh real PostgreSQL foundation preflight:
53 passed, no failures/skips. Temporary native Python package metadata repaired
from existing pinned requirements, without repository dependency changes.

Preimplementation scope34 files was frozen externally in prod-ready-04b-r3.
Synthetic scale:10000 users,200 postings,20000 durable children. R2 combined
recovery scanned19000 terminal rows; proposed explicit active predicate/index
scanned100 active rows and no terminal rows. Other queue/expiry/user queries use
indexes; expansion uses primary key. Production capacity remains PROVISIONAL.
Single supervised worker-container/two compute-child contract remains required;
30s wall/20s CPU/256MiB compute,90s lease,5s polling, no horizontal scaling claim.
These are design decisions, not implemented/qualified runner behavior.

Partial uncommitted code adds caller-owned transactions, canonical comparison/
generation helpers, selected producer/save/import/backfill/task routing and
privacy cleanup, plus unapplied reversible0035 indexes. Migration0034 unchanged.
Default flag remains OFF. This partial candidate MUST NOT be treated as ready:
runner, route status integration, Web UI, focused fault tests, full suites, Docker
runtime and postcommit gates remain unfinished. No R3 commit was created.

BLOCKED — R3 REQUIRES SCOPE EXPANSION. The existing authenticated
GET /debug/scoring-status reader in apps/api/app/routes/debug.py exposes global
JobMatch state counts and oldest-pending time without an actor ownership filter.
The scope omitted this reader. A two-user synthetic route-function reproduction
shows user1 (no matches) observing pending_backlog change0->1 when only user2
receives a pending match. This proves aggregate other-user counts, not disclosure
of individual row IDs/content. R3 status privacy requires reviewing this reader
and adding that exact file to authorized scope; OFF behavior must be preserved.
The explicit user scope-expansion STOP rule prevents adding it silently. No
further runtime implementation/qualification proceeded after discovery.

External evidence records partial source diff, hashes, scope, query plans and
blocker. Owned PostgreSQL container/scratch DBs removed. No push/deploy/production
mutation, qualification execution, dependency edits, classifier edits, upload or
general abuse-control work. RB01/RB03 retained; RB02/RB07 UNRESOLVED; release
NO_GO, historical qualification BLOCKED; fresh qualification remains required.

Resume requires owner authorization to add apps/api/app/routes/debug.py to R3
scope and continue the existing partial patch from verified2267 base. Do not
commit until all R3 gates pass; do not advance to R4 while R3 is incomplete.


## R3-R1 authorized integration (in progress; no checkpoint yet)

Owner amendment adds only `apps/api/app/routes/debug.py` to the recorded 34-file
scope. All 42 preserved R3 artifacts, 13 source hashes, saved diff, detached HEAD,
clean index and unchanged refs were verified before editing. Evidence lives in
`prod-ready-04b-r3-r1`; preserved R3/R2/R1 evidence and the original 22-file 04B
proposal remain untouched. The debug endpoint has no privileged-role authorization
or client caller. Its contract is now authenticated actor-owned diagnostics in
both modes: at most 100 own match rows, with no global backlog or internal fields.

Architecture: default `durable_scoring_enabled=False`. ON-mode profile, career,
import, job canonical writers and refresh/discovery/task/backfill producers use
caller-owned transactions with capacity locked before roots/canonical rows. A
relevant mutation, generation and accepted intent commit together; capacity or
input validation errors roll the whole transaction back. Unchanged input recovers
an own existing receipt without bumping generation, admitting another root or
resetting retry budgets. Generations cover exact deterministic ProfileView plus
SearchCriteria and JobView plus active/freshness selection. Criteria use a frozen
PostgreSQL UTC reference date. No scoring algorithm or paid-provider behavior is
changed. All legacy score entry points refuse execution under ON mode; OFF retains
its Celery publication and inline fallback. Notifications are unnecessary for
correctness. Scheduled outcome tallies and canonical job roots share the final
transaction; a separately committed running marker is recovered as failed after
one hour only while the ingestion advisory lock is unowned. No success is inferred.

Process contract: exactly one Linux worker container with init enabled and 40s
stop grace. Supervisor uses a local flock and PostgreSQL advisory leader lock;
logical leases permit two claimed pairs globally and one per actor. Independent
physical slots stay occupied through kill and reap. Two compute children maximum,
30s wall limit, 20s CPU and 256 MiB address-space limits. Pure compute children have
no DB/broker/provider credentials and invoke the existing deterministic scorer.
PDEATHSIG also terminates compute and ingestion consumers after supervisor death.
The ingestion-only Celery consumer retains recurring ingestion; it never executes
fit computation in ON mode. This is a one-container drain-and-replace contract,
not a claim of physical fencing across arbitrary network partitions or overlapping
hosts. SQL byte preflight covers scoring-consumed fields before materialization;
career queries defer unrelated text and document fields. Upload/parser bounding
remains R4 work and RB02 remains UNRESOLVED.

Each expansion page is at most 100 pairs with persisted numeric cursor and frozen
upper bound. One actor's invalid scoring input terminalizes only their pair, so it
cannot cancel another actor's shared fanout. Pair leases remain 90s with no renewal;
compute starts only with at least 35s remaining. Resource bounds constrain even
pathological input independently of representative runtime. Ordinary retries are
allowlisted, share the existing three-attempt operation ledger and never grant a
new recovery cycle. Nonretryable errors and exhausted budgets are terminal.

User GET `/jobs/scoring-status` is authenticated, actor-owned, bounded to 100 rows
per page, and returns identical 404s for absent and foreign intent IDs. No public
retry/cancel/operator endpoint exists. Pending parents are visible before children
exist; list projections hide stale scores and internal error categories. Historical
legacy results at untouched generation zero remain valid without automatic enqueue.
Never-admitted jobs show Not scored. UI separates saved/accepted from scoring;
status polling uses actor-local GETs, 5s interval plus bounded jitter, exponential
network backoff capped at 30s, hidden-tab pause, terminal/auth stop and abort on
unmount. It never repeats mutation POSTs or depends on visible-card count. Legacy
responses without the additive processing field retain existing behavior.

Privacy deletion locks capacity first, fences/releases work before deleting the
user in the same caller transaction, and works after rollback to OFF. File-cleanup
failure rolls back metadata/counters. Exports omit durable metadata, leases,
digests, generations, attempt ledgers and internal errors; existing own result
fields remain exported. Manual terminal retention is 30 days, at most 100 total
child/root deletions per call; active rows are excluded. FK SET NULL removes only
the terminal child pointer, preserving current result identity and shared budget.
Manual demo cleanup refuses durable-referenced postings and explains operator
cancel/retention prerequisites. Host-authorized internal CLI supports only inspect,
recover, cancel and retire. It cannot reset attempts or grant retry cycles.

Health is internal PID/DB/loop freshness plus bounded aggregate backlog age and
process-local transition counters. No actor/job/intent/email metric labels. API
readiness does not depend on the runner. Admission defaults remain provisional:
1000 live roots, 10000 live children, 100000 reserved units, 2 roots/100 children
per actor, 1000 global roots and 100000 units/day, 20 actor roots/day. Config may
lower approved global ceilings; no automatic production activation occurs.

0035 is additive only: active recovery ID, actor recent history, actor current
 generation recent history, actor root recent history, terminal retention age,
and reconciliation eligibility indexes. Nonconcurrent CREATE INDEX takes write
locks; lock timeout 2s and statement timeout 15s bound release-window attempts.
This is not zero-downtime migration. No historical mutation/enqueue; downgrade
removes only new indexes. Accepted work still prevents 0034 removal. Mixed ON/OFF
scoring workers are unsafe: drain and stop all old workers before isolated ON
activation, stop/reap the old supervisor before replacement, and drain accepted
intents before returning the worker flag OFF. Keep schema/receipts on rollback;
never remove accepted durable work to force an empty downgrade.

Validation progress: first full backend run 2019 passed / 0 failed. Expanded
security/privacy/retention tests and final full suite remain required. Disposable
Linux evaluation passed actual profile after_commit process exit, restarted actual
runner with Redis unavailable, one result effect per pair, duplicate supervisor
rejection, graceful stop, timeout kill/reap, crash retry budget, both physical slots,
production child limits/credential isolation, forced supervisor descendant death,
and persisted-lease recovery. Nine polling tests and Web typecheck passed. Full Web,
extension, four clean images, six-service OFF/ON stacks, scale plans, fresh advisory
checks, R13 replay, complete source review and final checkpoint remain pending.

RB01/RB03 resolved posture must be reverified. RB02/RB07 remain UNRESOLVED. R13
classifier must remain byte-identical, qualification BLOCKED, fresh qualification
required YES. No actual qualification, production mutation, deployment or push.
Only after every gate passes: one local commit from 2267bbc8d0ee6ae52b35d4d4e65c47dcc5e2d1df,
then required postcommit gates and clean worktree. Do not proceed to R4 in this stage.
