# Stage 2G-B — Retention Cleanup Production Kill Switch (NEW-01)

**Branch** `recovery/stage3-security`
**Base HEAD** `44c41338725bd7637828c908266c3adab922fcfc`
**Status** implemented, validated, not committed
**Closes** NEW-01 (P0)

---

## 1. The defect

Stage 2E added an hourly task that **deletes** terminal Tracker rows and cascades
to their snapshots. It was registered like this:

```python
celery_app.conf.beat_schedule = {
    "hourly-application-retention-cleanup": {
        "task": "cleanup_due_application_trackers",
        "schedule": crontab(minute=0),
    }
}

if settings.job_ingestion_enabled:          # ← ingestion was a decision
    celery_app.conf.beat_schedule["daily-job-ingestion"] = {...}
```

Every other periodic task was a choice. Deletion was not. The entry was
unconditional, `retention_cleanup.py` had no enable flag and no dry-run — only a
100-row batch bound — and `docs/deployment.md` starts `scheduler` as part of an
ordinary deploy:

```
scripts/production-compose.sh up -d api worker scheduler web
```

So **shipping the code was what armed the deletion.** Nobody had to decide. The
first `crontab(minute=0)` after the container came up would begin removing rows,
irreversibly, with no undo short of a database restore.

That is the whole of NEW-01. The deletion semantics were reviewed and accepted;
what was missing was a hand on the switch.

---

## 2. The contract

`RETENTION_CLEANUP_ENABLED`, default **false**.

| | false (default) | true |
|---|---|---|
| beat | entry **not registered** | exactly one hourly entry |
| task invoked anyway | refuses, returns `disabled: true` | Stage 2E behaviour |
| destructive service | never reached | reached |
| DB session | never opened | opened |
| `deletion_scheduled_at` | untouched | Stage 2E semantics |
| snapshots / documents / jobs / sessions / storage | untouched | Stage 2E semantics |

**Leaving it false is safe indefinitely.** Retention deadlines keep accruing in
the database; nothing is lost. Enabling later simply processes whatever became
overdue in the meantime — proven by
`test_re_enabling_processes_the_row_that_came_due_during_the_pause`.

Stage 2G-B does **not** authorise setting it true anywhere.

---

## 3. Two guards, and why one is not enough

### Guard 1 — registration (`build_beat_schedule`)

Disabled means genuinely **unscheduled**, not scheduled-and-inert. A schedule
that is present but always refuses is hourly log noise, and — worse — it reads
to an operator as though deletion is armed. The schedule is now derived from
settings by a function rather than written as a literal, which also makes the
decision directly testable in both states without re-importing the module or
standing up a broker.

### Guard 2 — runtime (`cleanup_due_application_trackers_task`)

Checked on **every** invocation, against the settings this process holds now.
The schedule governs what is *scheduled*; this governs what *executes*. It is
the guard that matters when something has already gone wrong:

- a message produced while enabled is still on the broker after an operator
  disables it;
- someone runs the task by hand;
- beat and worker hold different configuration;
- configuration drifts between processes.

The schedule cannot speak to any of those. `test_a_task_queued_while_enabled_
still_refuses_after_it_is_disabled` is the case that proves the point.

The refusal happens **before** `SessionLocal()`, so a disabled deployment holds
no connections and the guard stays correct even if the database is unreachable.

### Placement

The flag lives at the **Celery boundary**, not inside `retention_cleanup.py`.
The destructive service stays a deterministic, directly-testable function that
takes a `Session` and a `now` — which is exactly how the Stage 2E suites and the
PostgreSQL concurrency suite drive it. Pushing the flag down into it would have
made those tests configure a feature switch to test deletion semantics, for no
safety gain: nothing reaches that function except through the task.

---

## 4. Asymmetry between beat and worker

Two processes, two copies of the setting. Both orderings are safe:

| beat | worker | result |
|---|---|---|
| enabled | disabled | messages are emitted; the worker refuses each one. **No deletion.** |
| disabled | enabled | no periodic messages are produced. **No deletion.** |
| enabled | enabled | Stage 2E hourly cleanup runs |
| disabled | disabled | nothing scheduled, nothing executes |

The process that can actually delete is the worker, and it is the one carrying
the runtime guard — so a mismatch always fails closed. Both cases are tested.

---

## 5. Process boundary — restarts are required

Settings are read once per process: `app/core/config.py` builds `settings` at
import via an `lru_cache`'d `get_settings()`. Beat reads the flag when it builds
its schedule at startup; the worker reads it per task from that same
process-lifetime object.

**There is no hot reload.** Changing the environment variable has no effect on a
running process. Both the **worker** and the **scheduler** must be restarted:

- restarting only the scheduler changes what is emitted, not what executes;
- restarting only the worker changes what executes, not what is emitted.

Neither alone is wrong — both orderings fail closed (§4) — but only restarting
both makes the configuration actually take effect.

---

## 6. Environment propagation

`docker-compose.yml` declares the variable explicitly on **both** Celery
services, defaulting to false:

```yaml
RETENTION_CLEANUP_ENABLED: ${RETENTION_CLEANUP_ENABLED:-false}
```

Both services also carry `env_file: [.env]`, which would already supply it. The
explicit declaration is deliberate belt-and-braces: an omission or typo in
`.env` must fail closed rather than inherit whatever the image or a stale shell
happens to hold. `compose.production.yml` overrides only `restart:` for these
services, so the base wiring survives into production unchanged.

`api` deliberately does **not** receive the flag — the API never runs the task.

---

## 7. Activation runbook — NOT performed in Stage 2G-B

Production activation must never happen automatically, and did not happen here.
When it is separately authorised:

1. release qualification complete (every other release blocker closed)
2. **explicit written deletion-activation authorisation**
3. read-only inspection of what would be deleted:
   ```sql
   SELECT count(*) FROM application_trackers
   WHERE status IN ('rejected','withdrawn')
     AND deletion_scheduled_at IS NOT NULL
     AND deletion_scheduled_at <= now()
     AND deletion_cancelled_at IS NULL;
   ```
   A large count means a backlog accumulated while disabled. It will be worked
   off 100 rows per hour — confirm that is intended before proceeding.
4. verify a current database backup exists and restore has been rehearsed —
   this is the only rollback (`docs/deployment.md` §4)
5. set `RETENTION_CLEANUP_ENABLED=true`
6. restart **worker and scheduler**
7. verify exactly one entry:
   ```bash
   celery -A app.workers.tasks.celery_app inspect scheduled
   ```
8. watch the first execution at the next `:00`
9. verify `selected` / `deleted` / `skipped` / `failed` against the step-3 count

---

## 8. Emergency pause

1. set `RETENTION_CLEANUP_ENABLED=false`
2. restart worker and scheduler
3. verify the beat entry is absent
4. verify a direct invocation returns `disabled: true`
5. **leave `deletion_scheduled_at` alone** — the pause must not rewrite the
   retention schedule, and does not

Rows that came due during the pause are processed when cleanup is re-enabled.
Pausing loses nothing; it defers.

---

## 9. Monitoring

No new observability system. When **enabled**, operators should watch the task's
existing structured result — `selected`, `deleted`, `skipped`, `failed` — and
Celery task failures (the task retries up to 3 times, 30 s apart, `acks_late`).
A rising `failed` or a `deleted` far above the step-3 estimate is the signal to
pause.

When **disabled**, the expected observation is the **absence** of the periodic
task. The refusal log line (`retention cleanup disabled; task refused`) should
be rare — nothing is scheduled, so it fires only for a stale or hand-run
invocation, which is worth seeing. It carries a structural fact only: no user,
job, tracker or candidate-row detail.

---

## 10. What is deliberately unchanged

Stage 2E semantics are untouched — eligibility (`rejected`/`withdrawn`,
non-null deadline, `<=` cutoff, null cancellation, locked revalidation, fail
closed), `FOR UPDATE SKIP LOCKED`, batch 100, per-row savepoints, duplicate-run
safety, retry behaviour. No migration: this is an operational switch, not state.
No new routes, no admin endpoint, no Web or extension surface — activation is
environment-controlled and stays that way.

One existing test changed. `test_task_and_hourly_schedule_are_registered_once`
asserted the beat entry was present unconditionally, which is the defect itself
written down as an expectation. It is split: the task's retry contract is
asserted where it was, and the hourly cadence is asserted where scheduling is
now decided.

---

## 11. Files changed

| Path | Class |
|---|---|
| `apps/api/app/core/config.py` | canonical setting |
| `apps/api/app/workers/tasks.py` | both guards |
| `apps/api/app/tests/test_retention_cleanup_kill_switch.py` | **new** — 26 tests |
| `apps/api/app/tests/test_application_retention_cleanup.py` | registration test split |
| `docker-compose.yml` | worker + scheduler env |
| `.env.example` | documented, default false |
| `docs/plans/xpertapply-stage-2gb-retention-kill-switch.md` | this document |

---

## 12. Negative control

Both guards neutralised (`if True:` registration, `if False:` runtime), suite
re-run: **10 of 26 failed**, including
`test_direct_invocation_while_disabled_deletes_nothing` and
`test_a_task_queued_while_enabled_still_refuses_after_it_is_disabled` — whose
failure mode is an explicit assertion that *the destructive cleanup service was
reached while disabled*. The guards are load-bearing, not decorative.

---

## 13. Rollback

Revert `tasks.py` (restore the literal `beat_schedule`, drop the runtime guard),
`config.py`, the compose env lines, `.env.example`, and delete the new test
file plus this document; restore the original registration test.

**Rolling back re-arms hourly irreversible deletion on the next scheduler
start.** Do not roll this back independently of Stage 2E.
