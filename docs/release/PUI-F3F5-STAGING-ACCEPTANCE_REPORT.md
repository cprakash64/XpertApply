# F3/F5 staging acceptance (deployed API e4797e4, web 1df25f5, database 0034)

Date 2026-10-30. No source change, no deployment, no production access, no SMTP/config change. Authorized scope: **one** synthetic staging account, bounded (about 100-120 requests), deleted afterwards (DELETE returned 204; its token was then rejected).
Credentials were generated in memory and never printed or stored.

## Verdict
- **F3 (failed list requests): NOT REPRODUCED. Supportive, not conclusive on its own.** 0 failures in 88 list requests (70 API-level, 18 browser), 0 cancellations, 0 non-200 responses, no user-visible error, no console error. Resource evidence (restart count, OOMKilled) is **UNVERIFIED**: no VPS observability available to me.
- **F5 (list latency): VERIFIED IMPROVED.** Browser list requests: p50 1592 to 920 ms, p95 4423 to 1433 ms, max 6486 to 1742 ms versus the original staging run.
- **GO for F3/F5, conditional** on an operator confirming from the VPS that `xpertapply-staging-api` has not restarted and was not OOM-killed during the test window (commands below). No regression was found. This does not make production approved (F2, F4, S1/S2, extension test remain open).

## 1. Exact method
`live_f3.cjs` (session scratchpad, not in Git), run from `apps/web` with `NODE_PATH=$PWD/node_modules node live_f3.cjs <outdir>`; Node `fetch` for API-level calls and one headless Chromium session (1440x900) against https://staging.xpertapply.com. Sequential API calls; the browser phase uses the UI's natural overlap only (no extra load).
Fixture type: one throwaway `@example.com` account created through `/auth/signup`, a minimal profile and career via the API, and one `POST /jobs/refresh-matches` (default 7-day window). Catalogue: the shared staging catalogue (not modified; no discovery run).
Requests: 74 logged API list calls (about 70 returning 200 plus negative cases), 18 browser list calls, and about 25 non-list calls (signup, profile, refresh, details, search counts, login, delete): about 115 in total.

## 2. Populated catalogue
99 jobs in the 30-day window, 15 in 7 days, per the synthetic profile's eligibility (65 remote, 34 hybrid, 0 onsite; highest fit score 56). NOT an empty-catalogue test. The staging active-catalogue size is unknown to me.

## 3. Pagination correctness (VERIFIED, real staging API)
- All three sorts, limits 10 and 25 (10 and 4 pages): every page 200; no duplicates; none skipped; `page.total` equals the items paged on every page; the last page has no next cursor.
- Stable: the limit-10 walk and the limit-25 walk return the identical order for each sort; a middle page and the last page re-requested by their cursors return the same jobs (previous/next navigation is stable; the API is cursor-forward-only by design). All three sorts contain the same job set.
- Ordering: `fit` scores non-increasing with unscored last; `newest` `posted_at` non-increasing; `best_recent` fit band never increases down the list.
- Filters: workplace remote 65 / hybrid 34 / onsite 0, each only its type; `min_fit_score` 40 (14 jobs) and 50 (4 jobs) all at or above the threshold; date windows monotonic; search "engineer" paged over 10 pages (97 results, none duplicated, every result contains the term, totals consistent); combined sort + workplace + min fit paginates cleanly.
- Authorization/input: no token 401, garbage token 401, a cursor from another sort 400, a tampered cursor 400 (never 5xx). List score equals detail score for 3 jobs.
- NOT TESTED: cross-account result isolation (one account only; covered earlier with two accounts, no re-test).

## 4. Bounded rapid interaction in the browser (VERIFIED)
| Scenario | Outcome |
|---|---|
| 8 quick filter/sort changes | list shown equals the last selection's first 25 (no stale result); 6 requests, 838-1256 ms, all 200 |
| Search changed while a request is pending (engineer, python, backend) | count shown equals the API total for the final term; 2 requests, 778 and 932 ms |
| Sort changed while pending (fit, newest, fit) | list shown equals Best Fit; 4 requests, 659-1742 ms |
| Deep scroll | all 99 jobs loaded, no duplicates, no error; 3 requests |
Totals: 18 list requests, 18 x 200, 0 cancelled (the app does not cancel requests), 0 FAILED, 0 non-200, no console errors.

## 5. Latency (ms)
| | n | p50 | p95 | max |
|---|---|---|---|---|
| BEFORE, original staging browser run (fb6475f API) | 30 | 1592 | 4423 | 6486 |
| AFTER, API-level sequential (this run) | 70 | 645 | 823 | 1087 |
| AFTER, browser (this run) | 18 | 920 | 1433 | 1742 |
Caveats: the before and after scenarios are similar, not identical (the original also included a scoring refresh and my own helper calls); latency includes the network path from this machine (an unauthenticated 401 takes about 50 ms). A sequential list request is still about 0.65 s, so the per-request CPU floor remains (not addressed, as documented).

## 6. Comparison with the original failure
Original: 2 failed of 56 browser list requests (3.6%), connection-level, no response. Now 0 of 18 in the browser and 0 of 70 API-level. **Honest limit:** a 0-of-18 browser sample would happen by chance about half the time at the original rate, so this alone does not prove F3 is gone; it is consistent with the reproduced root cause (OOM under overlapping whole-catalogue requests) having been removed, and with latencies no longer stacking.

## 7. Resource safety: UNVERIFIED
No VPS access. Operator commands (read-only), to be run once for the window of this test (about 2026-10-30 around the time of the run) and compared with the earlier baseline:
```bash
docker inspect -f 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}' xpertapply-staging-api
docker stats --no-stream xpertapply-staging-api
sudo journalctl -k --since "<test start>" | grep -iE 'out of memory|killed process'
sudo grep -E ' 50[234] ' /var/log/nginx/api-staging.xpertapply.com.access.log | tail
docker exec xpertapply-staging-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from job_postings where is_active"
```
Expected if fixed: unchanged `StartedAt` since the deployment, `oom=false`, no kernel OOM line, no 50x for the test window.

## 8. Authentication regression (VERIFIED for the normal case)
A fresh identity logged in through the real UI with the correct password and was not blocked by the new throttle. Not repeated: the wrong-password burst, and no throttled identity was reused. NOT TESTED: a normal login after some earlier failures (design says a correct login clears the counter; covered by unit tests only).

## 9. Failed checks in this run (3), explained
"scores within 0-100 and every job has a match state" failed once per sort. The cause is my fixture, not the product: I called `refresh-matches` without a window, so it scored only the default 7-day window (code: `posted_within_days` defaults to 7), and my check demanded a match on all 99 jobs of the 30-day window. The UI's Refresh matches sends the selected window (`posted_within_days=${query.postedWithin}`), so a user refreshing the 30-day view would score them. I did not record which half of the compound check failed, so this attribution comes from the code, not a captured value. It does mean a job outside the scored window shows no score ("Calculating fit…") until refreshed, an extension of finding F2.

## 10. Confirmed regressions
None found. Not tested: anything outside `/jobs`, auth and the Jobs UI.

## 11. Status summary
VERIFIED: pagination correctness, filters, search, authorization and input handling, rapid-interaction correctness, latency improvement, normal login. NOT REPRODUCED: F3 (supportive, not conclusive). UNVERIFIED: VPS resources. NOT TESTED: cross-account isolation re-check, login after prior failures.
