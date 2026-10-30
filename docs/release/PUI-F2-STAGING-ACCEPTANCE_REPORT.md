# F2 live staging acceptance (deployed API and web `aa5bc2fa`, database 0034)

Run 2026-10-30 06:24:11-06:25:36 UTC. **Finalized with operator VPS evidence (container started 06:13:55 UTC, so the whole test ran inside this container's lifetime).** Authorized: up to two disposable synthetic accounts on staging only. No source change, no deployment, no production access, no migration, no email, no external paid call, no existing account touched. Credentials were generated in memory and never printed or stored.
Script `live_f2.cjs` (session scratchpad, not in Git); results `result.json`, `net.json`, two screenshots in `scratchpad/f2live/`. Two accounts were used, so no re-run was possible.

## 1. F2: PASS. Final verdict: GO for the F2 acceptance gate (gaps in section 9 are non-blocking)
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

## 6. Memory, restarts, OOM (VERIFIED from operator VPS observations after the test)
| Observation | Value |
|---|---|
| API container | `fada453e9e69c873f7fcda68b3aed77d001bc3b4df9cc9f5e564ded528c8ef54`, status running |
| Started | 2026-10-30T06:13:55Z (the deployment; **before** the test window 06:24:11-06:25:36 UTC) |
| Restarts | **0** |
| OOMKilled | **false** |
| Kernel OOM events since deployment | **none found** |
| Baseline memory (before, supplied earlier) | 124.8 MiB / 768 MiB |
| **Current** memory (one reading taken after the test) | **206.4 MiB / 768 MiB (26.88%)**, +81.6 MiB over the baseline |
- **Current is not peak.** No peak was measured: `docker stats` was a single snapshot taken after the run and I could not sample during it. The true peak during the 3.6 s scoring runs and the 2,773-job list is unknown; all that is established is that the container never restarted or was OOM-killed, so it never reached the 768 MiB limit, and that memory was 206.4 MiB (26.9% of the limit) afterwards.
- **Interpretation (inference, not measured):** the +81.6 MiB is most likely the process's retained high-water memory after serving the test's requests (Python does not return freed memory to the operating system), not a leak: a leak would need repeated measurements to show. The local model for the new path predicted about +15 MiB per scoring call. A later reading after idle time, and a reading after further use, would confirm whether it stays flat.
- **Remaining memory risk:** headroom is large now (561.6 MiB free). The earlier concern is unchanged for other heavy paths (`refresh-matches`, `/dashboard/summary`) and for much larger catalogues or many simultaneous new users; the new scoring path itself is bounded (one advance per user, two per process).

## 7. Pagination regression
- 30-day window, account A, after scoring: `newest` limit 25 and `best_recent` limit 25 walked completely (7 pages): no duplicates, none skipped, total equals items. PASS.
- `fit` limit 10: **partial**: my walk was capped at 12 pages (120 of 159 jobs); those 120 were unique, but the full walk was not completed. NOT FULLY TESTED.
- **Not exercised while scoring was in progress:** staging scored each batch in about 1-1.5 s, too short to interleave a walk, and I did not hold scoring open. By design the page pauses "Show more" during scoring and reloads when done (covered by the local tests); a server-side walk during partial scoring is not guaranteed stable for score-based sorts.

## 8. Cleanup: VERIFIED (API level and database level)
- **API level:** both accounts were removed through the application's own `DELETE /privacy/account` (204 each); afterwards each token returned 401 and each login returned 401. Only the two accounts created in this run were touched.
- **Database level (operator, read-only):** `f2_test_accounts=0` (no user matching `xa-gate-f2%@example.com`) and `orphan_job_matches=0` (no `job_matches` row without a user).
- **Scope and limitations:** the database checks cover those users and orphaned match rows only. Other tables owned by the accounts (profile, experience, education and so on) were not queried; they are covered by the same user-keyed cascade design and by the absence of the users, but were not individually counted. The earlier accounts from previous test runs (named differently) were not part of this check. No row was deleted by SQL; nothing remains that needs manual removal on this evidence.

## 9. Gaps and caveats (not claimed as passing)
- The exact "Scoring your matches… X of Y" text was **not captured**: the in-page observer recorded nothing; my polling loop saw the banner element at least once (that check passed on presence), but the progress numbers were not read. With a 1.1-1.5 s batch the banner is on screen for about a second. Covered by the local tests; not shown live.
- Multi-batch progress (several advance calls) cannot occur on staging data with the default batch of 200 (76 and 159 visible jobs fit in one batch each); covered locally only.
- **Peak** memory during the run was not measured (only a post-test reading, section 6).
- `fit` limit 10 walk partial; no walk during scoring (section 7).
- Account B's thin-profile list contained 2,773 visible jobs, so a thin profile is shown the whole catalogue unscored; that is existing behaviour, not changed by F2.

## 10. Remaining production risks
Scoring starts only when the Jobs page opens (Dashboard top matches stay empty until then); each advance repeats the eligibility scan (about 1 s here); the process cap is per API process; the worker is not started on staging; the 768 MiB headroom and the unoptimised `refresh-matches` / `/dashboard/summary` remain; F4 (Escape on the Apply dialog), S1/S2 (edge headers, CSP) and the extension 0.3.0 test are still open.

## 11. Final verdict
**GO for the F2 acceptance gate.** Evidence: (1) automatic scoring started without pressing Refresh matches (one advance call fired by the page itself); (2) it ran to completion (76 then 159 visible jobs, 3.6 s and about 3.5 s) with the final list reloaded once in score order; (3) scores persisted after a reload with zero further scoring calls; (4) the incomplete-profile account got an honest "No fit score" state with zero scoring calls and no polling; (5) paginated walks (newest and best_recent, 7 pages each) were correct; (6) 0 HTTP failures; (7) the API container was not restarted and was not OOM-killed (0 restarts, OOMKilled false, no kernel OOM event), and used 206.4 MiB of 768 MiB afterwards; (8) both test accounts are gone and the database checks are 0 and 0.
**Not blockers, recorded as gaps:** the exact "X of Y" banner text was not captured; multi-batch progress was only tested locally; one fit walk (10 per page) stopped at 120 of 159 by my script's cap; no walk during scoring; peak memory unknown.
**Not a production approval:** F4 (Escape on the Apply dialog), S1/S2 (edge headers, CSP), the extension 0.3.0 test, the unoptimised `refresh-matches` and `/dashboard/summary`, and a recommended memory re-check after more use remain.
