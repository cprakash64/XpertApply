# Jobs list: reliability and latency (findings F3 and F5)

Status: IMPLEMENTED LOCALLY, NOT DEPLOYED. Source: the live staging acceptance report (`docs/release/PUI-LIVE-ACCEPTANCE_REPORT.md`, section 6b, findings F3 and F5).

## The reports
- **F3:** during rapid filter changes and infinite scrolling in the browser, 2 of 126 `GET /jobs` requests failed with `net::ERR_FAILED`, no response, and a console message that the reply had no `Access-Control-Allow-Origin` header. The UI then showed its error state.
- **F5:** list pages took 4.4 to 6.5 s (typically 0.1 to 0.4 s) while several requests overlapped.

## Root cause (reproduced locally; not directly observed on staging)
`GET /jobs` did O(whole catalogue) work and held O(whole catalogue) memory on every request, however small the page:
it loaded **every column of every active job** (including the full source text `description_raw`, the raw provider JSON and the responsibilities) as ORM objects, built a **complete card for every eligible job** (including logo resolution), ranked them, and only then sliced 25.
The staging API is one `uvicorn` process (`start-api.sh`, no `--workers`) in a container with `mem_limit: 768m`, `cpus: 1.0`, `restart: unless-stopped`. Work runs in the thread pool but shares one GIL and one CPU, so overlapping requests queue (F5), and each holds its own copy of the catalogue.
Reproduction (local Postgres 16, 3,000 jobs with realistic text, API container with the same limits):

| Concurrent clients | Old implementation |
|---|---|
| 1 (sequential) | p50 952 ms, about 180 MiB per request |
| 2 | p50 2.1 s, peak about 640 MiB |
| 4 | **container OOM-killed**: 15 of 16 requests got connection resets, then connection refused until restart |

A killed container drops in-flight connections and the proxy answers the next ones with its own error page, none of which carries the app's CORS headers. A browser reports exactly that as a CORS failure, i.e. F3. After the restart (about 10 s) requests succeed again, matching the gap and recovery seen on staging.
The UI makes it worse without being the cause: a changed filter starts a new first-page request and the superseded one is **ignored but not cancelled** (no `AbortController`), and the server cannot cancel a running synchronous handler anyway, so every quick filter change leaves a full catalogue computation running.
The same UI burst against the old API locally: 22 failed requests (`net::ERR_EMPTY_RESPONSE`), container OOM-killed, UI in its error state.

**Not confirmed on staging:** no access to its Docker state or logs. Staging's active catalogue size is unknown (the earlier live run saw 99 jobs in a 30-day window after eligibility, but the endpoint loads every active job). Confirmation commands for the operator are at the end.

## Not the cause (checked)
- **Rate limiting / 429:** the list route has no limiter, and the throttling commit `6d3a8e7` changes only `/auth/login` and `/auth/signup`. No 429 was observed. The throttling candidate neither causes nor fixes F3/F5.
- **401 / token expiry:** none observed (all failures were connection-level; successful calls were 200).
- **Frontend races:** the first-page effect drops stale responses (`active` flag) and `loadMore` is single-flight. Tests now prove both, including a slow first page arriving after a newer one (with a negative control).
- **Database latency / missing indexes:** the profile shows the time in fetching the needed columns (about 0.19 s of 0.53 s profiled) and per-job eligibility evaluation (about 0.28 s), not a slow query. Query count is constant.

## Change
`apps/api/app/routes/jobs.py`, `_list_payload` (same signature, filters, counts, response shape):
1. **Phase 1:** stream (`yield_per=500`) only the 14 columns that eligibility, the demo guard, the filters and the ranking read (not `description_raw`, `raw_json`, `responsibilities`, etc.), and the user's `(job_id, fit_score)` pairs instead of full match rows. Keep one small rank item per surviving job.
2. **Rank and page** exactly as before (`rank_cards`, `page_of`: same keys, same cursor, same total).
3. **Phase 2:** load full rows and full matches **for the page's ids only** (chunked), and build cards for those.
Edge: a job deactivated between the two phases makes that page one shorter (`returned` is kept truthful); the cursor still holds.
No schema change, migration, API contract change or frontend change. Access control is unchanged: matches are still filtered by `user_id`, and the same per-user exclusions apply.

## Results
Local, 3,000 jobs, container limited to 768 MB and 1 CPU:

| Clients | Old: p50 / result | Fixed: p50 / peak mem |
|---|---|---|
| sequential | 952 ms | **428 ms** |
| 2 | 2.1 s | 0.69 s / 252 MiB |
| 4 | **OOM-killed** | 1.08 s / 289 MiB |
| 8 | n/a (dead) | 2.2 s / 347 MiB |
| 12 | n/a | 3.5 s / 417 MiB |
| 24 | n/a | 7.9 s (max 11.3 s) / 599 MiB, **0 failures, no OOM** |

- Equivalence: 27 query shapes (every sort, workplace, min fit, role, company, location, ineligible, unknown dates, windows 1/7/30/60 days, page sizes 25/100 and unpaged) returned **byte-identical JSON** from the old and new API on the same database.
- Browser burst (21 rapid filter changes, then deep scroll), old vs fixed: 22 failures and OOM vs 59 requests, **0 failures**, 925 unique cards, no duplicates, no console errors.
- Latency under concurrency is still linear because it is one CPU: about 0.3 to 0.4 s of CPU per request at 3,000 jobs. That floor is the per-job eligibility evaluation and is **not** addressed here.

## Tests
`apps/api/app/tests/test_jobs_list_efficiency.py` (41 cases): equivalence with a verbatim copy of the old implementation (11 query shapes x 3 page modes), walking every page equals the old walk with nothing repeated or skipped, tracked/demo jobs and bad cursor, **phase 1 never selects the heavy columns**, **cards are built only for the page**, query count constant as the catalogue grows, a job vanishing between phases, and **peak memory at most one third of the old implementation**.
With the old code restored the three discriminating tests fail. Frontend: three new tests in `__tests__/jobs-feed.test.tsx` (out-of-order first page, several quick filter changes, double-click on Show more), with a negative control on the stale-response guard.

## Not done, deliberately (no evidence yet)
- Per-job eligibility caching or precomputation, a result cache, or more uvicorn workers: they would lower the CPU floor but need design and measurement on the real catalogue.
- Client-side `AbortController`: it would not stop the server's work.
- Admission control (cap on concurrent list computations): after this fix memory is about 15 MiB per concurrent request and nothing failed at 24 clients. Revisit if the catalogue grows by an order of magnitude.
- `/dashboard/summary` and `/jobs/refresh-matches` were not profiled.

## Rollout and rollback
Ship with the API image (no migration). Verify on staging with one throwaway account: page through every sort with limits 10 and 25 (no duplicates, none skipped, `total` equals items), then a bounded burst of 6 to 8 quick filter changes and a deep scroll, expecting 0 failures and the same container (`RestartCount` unchanged). Rollback: redeploy the previous API image; no data is involved.

## Confirming F3 on staging (read-only, operator)
```bash
docker inspect -f 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}' xpertapply-staging-api
sudo journalctl -k --since "<evening of the live run>" | grep -iE 'out of memory|killed process'
sudo grep -E ' 50[234] ' /var/log/nginx/api-staging.xpertapply.com.access.log | tail     # around 02:05 UTC on the night of the run
docker exec xpertapply-staging-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from job_postings where is_active"
```
A `StartedAt` of about 02:05 UTC that night, `RestartCount` above 0 or a kernel OOM line would confirm it; the active-job count shows how close staging is to the local 3,000.
