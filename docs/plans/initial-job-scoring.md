# F2: automatic initial job scoring

Status: IMPLEMENTED LOCALLY, NOT DEPLOYED. Source: finding F2 of `docs/release/PUI-LIVE-ACCEPTANCE_REPORT.md`; follows the accepted F3/F5 work (`docs/plans/jobs-list-efficiency.md`).

## Confirmed root cause
A new user (or any user with missing scores) sees "Calculating fit…" until they press **Refresh matches**. Nothing in the product ever starts the initial scoring unless a Celery worker happens to be consuming:
1. Signup creates the user and an empty profile. Nothing is scored (no `JobMatch` rows).
2. A profile or career save calls `_enqueue_profile_rescore`, which publishes the Celery task `match_jobs_for_user` **only if Redis is reachable**, and otherwise relies on a fallback that does not exist ("the next page load rescores", but `GET /jobs` never scores).
3. **Staging:** Redis is up, but the `worker` and `scheduler` services are in the optional `workers` Compose profile ("not started by default", `--with-workers`). The task is published and no process consumes it. Development/production base compose does run a worker (concurrency 2).
4. `GET /jobs` only reads. For an unscored job the API returns `match: null`; the page shows "Calculating fit…" and re-requests the list every 4 s **forever** (`hasPendingScores` poll in `JobDiscovery.tsx`). It never starts scoring, and a user whose profile is not scorable polls forever too.
5. Scores do exist after Refresh matches, so this is not a display bug. Even then the on-screen order stays the pre-score order (scores are patched in place) until a reload.
6. Refresh matches defaults to a 7-day window (the UI sends the selected window), so jobs 8-30 days old stay unscored unless refreshed for that window.

## Why the manual path cannot simply be called automatically (measured locally, 4,485 jobs seeded as a new user, API container 768 MB / 1 CPU)
| Step | Time | Peak memory |
|---|---|---|
| `POST /jobs/refresh-matches` (7 or 30 days) | about 10 s, blocking the single-process API | peak 448 MiB (idle 191), 432 MiB retained, 8.6-14.7 MB response |
| `_fresh_active_job_ids` (full ORM scan of all jobs) | 1.6 s | 148 MB |
| `_stale_count` (ORM scan of ALL job rows) | 1.3 s | 148 MB |
| `score_jobs_for_user(force=True)`, all 3,741 fresh jobs | 16.5 s | 148 MB |
| scoring maths per job pair | **1.5 ms** | negligible |
The maths is cheap. The cost is scanning and force-rescoring jobs the user cannot even see: 3,741 fresh jobs were scored but only 1,415 are eligible. Scoring is deterministic (`explanation_source = "deterministic"`): **no model or provider calls, no provider cost.**

## Selected solution: bounded, incremental, eligible-only scoring driven by the Jobs page
No new queue, scheduler, table, migration or service, and no new process competing for the API's memory.
- **`GET /jobs` reports truthful progress** (read-only): a `scoring` block `{state, total, scored, pending, failed}` over the user's eligible jobs in the requested window: `complete`, `scoring`, `failed` or `profile_incomplete`. A pair is *pending* when it has no row, is not `scored`, or was scored for an older profile or `SCORE_VERSION`; *failed* once it has used its 3 attempts.
- **`POST /jobs/scoring/advance`** scores the next bounded batch for the caller only: the user's eligible, pending jobs (newest first), at most `SCORING_ADVANCE_BATCH_SIZE` (200) jobs and `SCORING_ADVANCE_TIME_BUDGET_SECONDS` (4 s) per call, committed in chunks of 50, using the existing idempotent `score_pair`. Returns the new progress. It scores only jobs the list can show (same eligibility, freshness and exclusions: one shared candidate iterator), never the ineligible ones.
- **Concurrency control:** one advance per user at a time and at most `SCORING_ADVANCE_MAX_CONCURRENT` (2) advances in the process; otherwise the call returns `busy: true` with the current progress and does no work. A unique-constraint race (another process) rolls back and reports busy. Duplicate events, many tabs, or many new users therefore cannot launch uncontrolled parallel or duplicate scoring.
- **The page drives it:** when the first page reports `scoring`, the page calls advance (one at a time, bounded to 60 calls and about 2 minutes), shows "Scoring your matches… X of Y", pauses "Show more" (partial scores would make page boundaries unreliable), and **reloads the list once when scoring completes** so ranking is final. A failure shows a recoverable message with a retry button (`retry_failed=true`). Users with an incomplete profile get an honest "No fit score yet, complete your profile" state, no polling and no number. A response without `scoring` (older API) keeps the previous behaviour.
- **Existing worker path stays** (`_enqueue_profile_rescore`, ingestion fan-out). If a worker is running it simply does the work first; advance then finds nothing pending. Both are idempotent.
- **Profile changes:** a changed profile hash makes every score stale, so progress flips back to `scoring` and advance rescored them: the existing hash semantics, no new rule. Unchanged pairs are never recomputed.
- **Memory fix on the manual path (measured, low risk):** `_fresh_active_job_ids` and `_stale_count` select only the columns they need (about 148 MB peak each avoided). Refresh matches' behaviour and response are otherwise unchanged.

## Rejected
- Calling refresh-matches (or the worker's `rematch_user`) from signup: unbounded, 10 s and 450 MiB per call.
- A request-path write inside `GET /jobs`: it would change ranks between page requests and break keyset pagination.
- A new thread/process pool, queue or table: no evidence it is needed; the work is about 1.5 ms per pair.
- Auto-starting staging workers: an infrastructure decision (memory, ingestion flags), flagged for the founder, not assumed.

## Results (local, 4,485 seeded jobs, API container 768 MB / 1 CPU, new user with a scorable profile)
| Scenario | Result |
|---|---|
| New user, window 7 days (824 eligible) | 5 advance calls, **4.0 s in total**, slowest call 0.9 s, peak 141 MiB |
| Same user, window 30 days (1,415 eligible, 591 still pending) | 3 calls, 2.9 s |
| Account already fully scored | advance is a no-op (0 writes, about 0.5 s of scan); list 0.6 s |
| **Six new users onboarding at once** | all complete in 29 s, **peak 216 MiB, 0 OOM, 0 failures**; the 2-at-a-time cap answered 18 `busy` calls, absorbed by the page's wait |
| Old manual path for comparison | about 10 s per call, peak 448 MiB, blocks the API |
- **Equivalence on Postgres:** the 1,415 scores written by advance are identical (score and label) to what the old forced path computes; the old path also scored 2,326 ineligible jobs nobody can see. No duplicate `(user, job)` rows; every user has only their own rows.
- **First list for a brand-new account** costs the same as any list (about 0.55 s warm); the first request after a cold start was 2.9 s.
- Limits: the catalogue was synthetic (realistic text sizes, 4,485 jobs, one profile shape), the host was a laptop, and Redis/Celery were not in the loop (the design does not use them).

## Tests
- API: `app/tests/test_initial_scoring.py` (19 tests): new account, bounded batches and persistence; equality with the manual path; only visible jobs scored; tracked jobs excluded; incomplete profile (no rows, no numbers); already-scored no-op with no writes; missing scores filled without touching valid ones; crashed `scoring` rows recovered; profile change makes scores stale and refreshes; interrupted run resumes without duplicates; failure retry cap, `failed` state and user retry; duplicate initialisation and the process cap (including 60 parallel attempts across 5 users); account isolation; sorting, search and pagination after scoring; scan and chunk query shapes; the refresh-path helpers; HTTP auth and validation. Mutation checks (guard removed, staleness ignored, valid scores recomputed) each fail the suite.
- Web: `__tests__/jobs-scoring.test.tsx` (10 tests): automatic start, real progress, single reload at the end, one call in flight, Show more held, incomplete profile (no polling, no number), failure and retry, advance error, busy wait, window change, older API fallback, and no background polling while scoring (mutation-checked).
- Existing suites unchanged and green; the list equivalence tests now exclude the new `scoring` key.

## Behaviour for a new account
Sign up, complete the profile, open Jobs: the cards show "Calculating fit…" with a status line "Scoring your matches… X of Y jobs scored" (a few seconds for the default window), "Show more" is disabled ("Waiting for fit scores…"), then the list reloads once, ranked by score, and the line disappears. With a thin profile: "No fit score" on each card (plus the existing "complete your profile" prompt) and no scoring or polling. If scoring fails: "We couldn’t score N jobs." with a Retry scoring button.

## Security and concurrency
Only the caller's rows are read or written (every query is keyed by the authenticated user id); endpoint is authenticated and its parameters validated; no model/provider/network calls; the response carries only counts. One advance per user, two per process, a batch and time cap per call, a unique-constraint race rolls back and reports busy, a retry cap stops endless failures, the client makes at most 60 calls per list and one at a time. Throttling for `/auth/*` is untouched. The list and its F3/F5 efficiency are unchanged (equivalence tests still pass).

## Not done / remaining
- Scoring starts when the user opens the Jobs page, not at signup; the Dashboard's top matches are empty until then.
- The window follows the page's selected window; jobs outside it are scored when the user selects it.
- `refresh-matches` still returns an unpaged payload and force-rescores all fresh jobs (including ineligible); only its two avoidable full-row scans were removed.
- Each advance repeats the eligibility scan (about 0.5-0.9 s at 4,500 jobs); a catalogue far larger than staging's would make a first scoring run slower (more calls) but not larger in memory per call.
- The process cap is per API process: several API replicas could each run two at a time (the work is idempotent, a race only costs a rolled-back batch).
- The scheduled/worker path is unchanged and still needs a running worker for post-ingestion fan-out and profile-change rescoring in the background; staging does not start one by default.

## Deployment requirements (flagged before release preparation)
API image rebuild and a web image rebuild. **No migration, no new infrastructure.** Three optional settings with safe defaults (`SCORING_ADVANCE_BATCH_SIZE`, `SCORING_ADVANCE_TIME_BUDGET_SECONDS`, `SCORING_ADVANCE_MAX_CONCURRENT`): no environment change is required.
