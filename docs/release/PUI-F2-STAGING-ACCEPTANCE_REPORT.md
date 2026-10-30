# F2 live staging acceptance (deployed API and web `aa5bc2fa`, database 0034)

Run 2026-10-30 06:24:11-06:25:36 UTC. Authorized: up to two disposable synthetic accounts on staging only. No source change, no deployment, no production access, no migration, no email, no external paid call, no existing account touched. Credentials were generated in memory and never printed or stored.
Script `live_f2.cjs` (session scratchpad, not in Git); results `result.json`, `net.json`, two screenshots in `scratchpad/f2live/`. Two accounts were used, so no re-run was possible.

## 1. F2: PASS (core behaviour verified live), with the gaps listed in section 9
Before preflight of the run: staging hosts verified isolated (`staging.` / `api-staging.`, `X-Robots-Tag: noindex`), the deployed API refuses an unauthenticated `POST /jobs/scoring/advance` with 401 (route exists), and the deployed web bundle contains "Scoring your matches".

## 2. Automatic scoring evidence (account A, complete profile)
- Before the page opened, the API reported `{"state":"scoring","total":76,"scored":0,"pending":76}`: the F2 state (no scores, scoring pending).
- Logged in through the UI and opened `/jobs` at 06:24:15. **No Refresh click was ever made.** The page itself called `POST /jobs/scoring/advance` once (06:24:17, 200, 1139 ms), then reloaded the list once (06:24:18, 813 ms). Everything finished 3.6 s after opening.
- Afterwards the API reported `{"state":"complete","total":76,"scored":76,"pending":0,"failed":0}`; every card showed a real score, none "Calculating fit…".
- The list on screen equalled the API's `best_recent` order, and the fit band never increased down the list (ranking is score-based, final).
- Exactly two real first-page loads (initial and the single final reload); in the following 13 s there were **no further `/jobs` requests** (no endless polling).
- After a page reload: same order, no scoring banner, zero scoring calls: scores persisted.
- Widening the window to 30 days scored the newly visible jobs automatically: 1 advance call (06:24:40, 1504 ms), then `{"state":"complete","total":159,"scored":159}`.
- Two simultaneous advance calls on a complete account: both 200, `advanced: 0` (harmless duplicate event).

## 3. Total jobs scored and time
76 jobs (7-day window), then 83 more for 30 days = **159 jobs**, in two single batches. Time: **3.6 s** from opening the page to finished (7-day), about 3.5 s for the 30-day widening.

## 4. Incomplete profile (account B)
API: `{"state":"profile_incomplete","total":2773,"pending":0}`; every card carried `score_state: "profile_incomplete"` and a null score. In the UI the 25 cards showed "No fit score", no "Calculating fit…", no "/ 100". **Zero scoring calls**, no banner, and no repeated list request over 16 s (the page made one real list request). Honest state confirmed, nothing fabricated.

## 5. Latency and failures
- Advance calls (2): 1139 ms and 1504 ms (p50 about 1.1 s, p95 about 1.5 s). List requests (7): p50 1023 ms, p95 1474 ms, max 1474 ms.
- **HTTP failures: 0** (no 4xx/5xx, no connection failures) on `/jobs` and the scoring endpoint for both accounts; no console errors.
- Requests: A 7 list + 2 advance; B 2 list + 0 advance (the "list" tally also counts the `/jobs/tracker/all` decoration call).

## 6. Memory, restarts, OOM: NOT VERIFIED BY ME
I have no VPS access, so I could not watch memory during the run and could not stop on it; the safeguards used were a bounded script (about 25 API calls in total) and a stop on any 5xx or connection failure (none occurred, and latencies stayed about 1 s).
Baseline you supplied: 124.8 MiB / 768 MiB, 0 restarts, OOMKilled false. The test ran 06:24:11-06:25:36 UTC; to close this, an operator can run (read-only) and compare with the baseline:
```bash
docker inspect -f 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}' xpertapply-staging-api
docker stats --no-stream xpertapply-staging-api
sudo journalctl -k --since "2026-10-30 06:20" | grep -iE 'out of memory|killed process'
```
Expected: `StartedAt` unchanged since the deployment, `restarts=0`, `oom=false`, no kernel line, memory well below 768 MiB. The new path measured +15 MiB per call locally; the 2,773-job list for account B and the 159-job scoring are the largest requests in this run.

## 7. Pagination regression
- 30-day window, account A, after scoring: `newest` limit 25 and `best_recent` limit 25 walked completely (7 pages): no duplicates, none skipped, total equals items. PASS.
- `fit` limit 10: **partial**: my walk was capped at 12 pages (120 of 159 jobs); those 120 were unique, but the full walk was not completed. NOT FULLY TESTED.
- **Not exercised while scoring was in progress:** staging scored each batch in about 1-1.5 s, too short to interleave a walk, and I did not hold scoring open. By design the page pauses "Show more" during scoring and reloads when done (covered by the local tests); a server-side walk during partial scoring is not guaranteed stable for score-based sorts.

## 8. Cleanup (VERIFIED at the API level)
Both accounts were removed through the application's own `DELETE /privacy/account` (204 each); afterwards each token returns 401 and each login returns 401. Only the two accounts created in this run were touched. Their derived rows (`job_matches` etc.) are removed by the schema's `ON DELETE CASCADE` on `user_id`, which I inferred from the models and could not confirm without database access. To confirm (read-only, operator):
```bash
docker exec xpertapply-staging-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from users where email like 'xa-gate-f2%@example.com'"
docker exec xpertapply-staging-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from job_matches m left join users u on u.id=m.user_id where u.id is null"
```
Both should print 0.

## 9. Gaps and caveats (not claimed as passing)
- The exact "Scoring your matches… X of Y" text was **not captured**: the in-page observer recorded nothing; my polling loop saw the banner element at least once (that check passed on presence), but the progress numbers were not read. With a 1.1-1.5 s batch the banner is on screen for about a second. Covered by the local tests; not shown live.
- Multi-batch progress (several advance calls) cannot occur on staging data with the default batch of 200 (76 and 159 visible jobs fit in one batch each); covered locally only.
- Memory/OOM/restart observations are unverified from my side (section 6).
- `fit` limit 10 walk partial; no walk during scoring (section 7).
- Account B's thin-profile list contained 2,773 visible jobs, so a thin profile is shown the whole catalogue unscored; that is existing behaviour, not changed by F2.

## 10. Remaining production risks
Scoring starts only when the Jobs page opens (Dashboard top matches stay empty until then); each advance repeats the eligibility scan (about 1 s here); the process cap is per API process; the worker is not started on staging; the 768 MiB headroom and the unoptimised `refresh-matches` / `/dashboard/summary` remain; F4 (Escape on the Apply dialog), S1/S2 (edge headers, CSP) and the extension 0.3.0 test are still open.

## 11. GO / NO-GO
**GO for F2** on the live evidence: automatic scoring works end to end on staging, finishes in about 3.5 s, produces final ranking and persisting scores, an incomplete profile gets an honest state with no calls or polling, and there were no HTTP failures. Conditional on the operator confirming no restart or OOM during 06:24-06:26 UTC. Not production approval.
