# XpertApply Application Memory — Stage 2E

## Objective and deletion contract

Execute the seven-day Tracker retention policy on the server. A row is deleted only when one locked database transaction positively proves that its status is `rejected` or `withdrawn`, its `deletion_scheduled_at` is non-null and at or before one authoritative UTC cutoff, and `deletion_cancelled_at` is null. Any uncertainty retains the row.

## Existing architecture and production wiring

Stage 2E reuses `app.workers.tasks.celery_app`, the existing dedicated Celery worker, and the single Compose beat service. One stable task named `cleanup_due_application_trackers` is registered once at `crontab(minute=0)`, approximately hourly. The task invokes one directly testable service batch and never loops. There is no HTTP cleanup endpoint and no per-Tracker delayed task.

The default batch is 100 rows, ordered by deadline and then Tracker ID. The indexed `deletion_scheduled_at` column supports the bounded candidate scan, so no migration is required. Scheduler downtime does not lose deadlines: a later scan finds every still-eligible overdue row, and subsequent hourly invocations drain further batches.

The initial throughput ceiling is therefore 100 eligible Trackers per hour (2,400/day). That bounded rate is accepted for the current product scale because it limits destructive blast radius. Operators must monitor selected/deleted/failed counts during activation; a sustained sequence of full 100-row batches means retention is accumulating and requires an explicit cadence/batch design review rather than an unbounded self-enqueue loop. A pathological row is isolated by a savepoint and consumes at most one slot per run, so other selected rows continue; repeated failures remain visible for operator remediation.

## Transactions, locking, and races

The service selects a bounded batch with PostgreSQL `FOR UPDATE SKIP LOCKED`. Eligibility is repeated immediately before each destructive operation. Concurrent workers therefore own disjoint locked rows; duplicate delivery is an idempotent no-op after a row is gone.

If Undo or a nonterminal status change commits first, cleanup observes the cleared schedule/status and retains the row. If cleanup locks the eligible row first, the lifecycle request waits; cleanup commits the authorized deletion and the later owner-scoped request observes the established absent-resource response. This is deterministic PostgreSQL lock ordering, without an in-memory or distributed lock.

One transaction owns the bounded batch. Each row deletion uses a savepoint so an isolated row failure is counted and rolled back without corrupting other candidates. Initial query, connection, transaction, or commit failures escape to the Celery wrapper, which rolls back and retries at most three times with a 30-second delay. A worker crash commits either none of the transaction or the completed batch; later delivery safely resumes from database state.

## Deletion graph and artifact policy

- `ApplicationTracker` is the only explicitly deleted row.
- `ApplicationSnapshot.application_tracker_id` is non-null with `ON DELETE CASCADE`; snapshots are exclusively Tracker-owned and are deleted transactionally.
- `ApplicationSession.tracker_id` uses `ON DELETE SET NULL`; sessions and their audit rows remain.
- Snapshot document references use `ON DELETE RESTRICT`; Stage 2E never deletes `GeneratedDocument` rows.
- Generated-document source lineage uses `ON DELETE SET NULL`; because documents are retained, source/descendant lineage remains intact.
- User, `JobPosting`, and other users' Trackers/snapshots are never deletion targets.
- Document file paths may address local or object storage, but Stage 2E performs no filesystem, S3, or other storage deletion.

Unique documents are retained just like shared, current, frozen, session-referenced, and lineage documents. This conservative choice can leave orphan candidates; a separately authorized reference-aware document garbage collector may address them later.

A completed session whose Tracker was removed becomes a fail-closed retention tombstone: both subsequent completion/strong-confirmation retries and stale ambiguous-confirmation messages are rejected when the completed session has no `tracker_id`. They cannot recreate either the Tracker or its snapshot. The retained session remains useful as historical workflow state without becoming resurrection authority.

## Time, lifecycle, and idempotency

The task takes one timezone-aware UTC server timestamp per batch. Tests inject deterministic UTC cutoffs; equality is due. Undo clears the deadline and records cancellation. Ordinary same-terminal updates do not reschedule. Leaving terminal state clears retention state. The existing explicit service reschedule creates a new seven-day deadline and clears cancellation; cleanup honors that new schedule.

## Observability and privacy

The service returns `selected`, `deleted`, `skipped`, and `failed` counts. Logs contain only aggregate counts and, for an isolated failure, the numeric Tracker ID through structured metadata. No tokens, answers, document contents, job descriptions, profile fields, or provider payloads are logged. The repository has no applicable metrics framework, so Stage 2E adds no new one.

## Validation

Focused SQLite service tests cover exact-boundary and overdue rejected/withdrawn deletion, future/null/wrong-status/cancelled retention, Undo, status restoration, same-terminal-after-Undo, explicit reschedule, duplicate invocation, batching/order, snapshot cascade, and retained sessions/documents/jobs/lineage.

Disposable PostgreSQL tests cover concurrent workers, locked Undo, committed Undo/status-change races, actual FK cascade/`SET NULL` behavior, document retention/lineage, and the deadline index. Scheduler tests verify one hourly entry and bounded retry/task registration. Final qualification also includes Stage 2A/2C lifecycle/API regression, full API, Ruff, Alembic head, and Compose configuration.

Final results (2026-09-11): direct Stage 2E service/API tests passed 22/22; disposable PostgreSQL Stage 2E tests passed 6/6; focused Stage 2A–2E lifecycle regression passed 93/93; all PostgreSQL migration/integration tests passed 9/9 with no skips. The complete Python 3.12.13 API suite passed 1,897/1,897 with zero failures and zero skips. Repository-wide Ruff passed, current Alembic head upgraded cleanly in disposable PostgreSQL databases, and `docker compose config --no-env-resolution --quiet` passed. Web and extension source remained untouched.

## Rollout and rollback

Source registration does not authorize production activation. Deployment is coupled to scheduler restart: once this code is deployed and the existing beat service restarts, the source-defined entry will begin publishing cleanup automatically. Safe rollout therefore requires (1) checkpoint and push, (2) release qualification, (3) explicit production-activation authorization, (4) inspect due-candidate counts in a non-destructive operational check where available, (5) deploy/start the scheduler, and (6) monitor the first run and subsequent full-batch/failure counts. There is no separate runtime feature flag in this stage, so operators must not restart production beat with this build before activation is authorized.

Immediate rollback is to disable/remove only the beat entry and restart beat; leave every persisted deadline intact. In-flight worker shutdown uses the existing graceful termination behavior. Re-enabling later resumes from authoritative deadlines.

Stage 2E does not change Web or extension source, Stage 2D submission behavior, public API authorization, database schema, or object storage.

## Deferred release prerequisites

`DEPENDENCY-01`, `PROXY-01`, `B-01`, `B-02`, `B-03`, `S-02`, `S-03`, `B-05`, `B-04`, and `B-06` remain open. `ASYNC-01` remains resolved. Potential orphan GeneratedDocument/storage garbage collection is a separate future consideration.
