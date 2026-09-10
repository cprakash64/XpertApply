# XpertApply application memory — Stage 2A

## Scope

Stage 2A establishes the database and domain foundation only: immutable
application-snapshot records, Tracker retention/confirmation timestamps,
central status scheduling, ownership-safe read boundaries, additive schemas,
and a reversible migration. Snapshot population, artifact freezing, UI,
extension behavior, and cleanup execution remain deferred.

## Architecture and decisions

`ApplicationTracker` remains the mutable `(user_id, job_id)` aggregate.
`ApplicationSnapshot` is append-only history for one actual submission attempt.
There is no public create/update endpoint in this stage. A unique source session
identifier makes later confirmation retries idempotent; a unique tracker/attempt
pair supports genuine reapplications.

The source session identifier is durable data rather than an FK. Session expiry
therefore cannot erase snapshot provenance. The snapshot's direct Job FK uses
`SET NULL`, but the existing Job-to-Tracker contract cascades intentional job
cleanup; because Tracker-to-Snapshot also cascades, such cleanup removes the
whole application aggregate. Stage 2A does not rewrite that established global
contract. Tracker and account deletion cascade to their snapshots. Generated-document references use `RESTRICT`; document
immutability and copy-on-write arrive in Stage 2B.

Evidence metadata and answer arrays are schema foundations, not telemetry
dumps. Later writers must enforce bounded entry counts/string sizes and must
exclude tokens, cookies, headers, DOM/HTML, browser authority, filesystem paths,
and unrelated reusable profile answers.

No `latest_snapshot_id` is added: ordering by `(attempt_number, applied_at)` is
cheap and avoids a circular, stale denormalized pointer.

## Retention lifecycle

Only `rejected` and `withdrawn` schedule deletion. Entry from a nonterminal
status sets a server-generated UTC deadline seven days ahead. Repeats and
terminal-to-terminal changes preserve the original deadline. Leaving terminal
state clears retention state atomically.

Undo leaves the terminal outcome intact, clears the deadline, and records
`deletion_cancelled_at`. A same-status save cannot reschedule it. A future
explicit “schedule deletion” action uses the separate domain operation and
clears the cancellation marker. Existing terminal rows remain unscheduled.

`confirmation_required_at` records unresolved completion. Prompt dismissal has
its own timestamp and does not imply submission. Definitive confirmation clears
`confirmation_required_at`; an actual Applied state also clears deletion state.

## Authorization and privacy

Every snapshot lookup includes authenticated `user_id`. The cancellation route
queries by both Tracker ID and owner and returns the repository-standard 404 for
missing or foreign records. Later B-01 validation must cover snapshot IDs,
Tracker IDs, and artifact document IDs.

Snapshots never store credentials, launch/session tokens, cookies, host grants,
tab/frame IDs, authorization headers, raw DOM, or private storage paths.

## Migration, rollout, and rollback

Migration `0032_application_memory` adds four nullable Tracker columns and the
snapshot table. It creates no snapshots and schedules no existing rows. Upgrade
is additive. Downgrade drops only the new table, indexes, columns, and PostgreSQL
enum types; pre-existing Tracker data remains.

Roll out the migration before code that reads the new columns. Roll back code
first, then downgrade. Do not downgrade after Stage 2B has created snapshots
unless loss of that newly created snapshot data is explicitly accepted.

## Validation

Run focused model/lifecycle/authorization tests, existing applied-lifecycle
tests, migration revision tests, API static compilation, Alembic upgrade and
downgrade against an isolated database where supported, then the repository API
suite required by `AGENTS.md`.

## Deferred stages

- Stage 2B: trusted snapshot population, exact artifact provenance, document freezing.
- Stage 2C: protected Tracker UI integration.
- Stage 2D: stronger submission evidence and persistent fallback prompt.
- Stage 2E: Celery cleanup execution and deletion cascade acceptance.
- Stage 2F: browser interaction hardening after the B-03 safety boundary.
