# F3/F5 staging acceptance: BLOCKED (no authorized test identity)

Date 2026-10-30. Deployed per the request: web `1df25f5`, API `e4797e4`, database `0034_password_reset`. No source change, no deployment, no production access, no account created, no credential used or stored.

## Result: F3 BLOCKED, F5 BLOCKED. The fix is NOT yet shown to resolve either on staging. GO/NO-GO for F3/F5: NO-GO (unproven), not FAILED.
Every F3/F5 measurement needs an authenticated call to `/jobs` on a populated catalogue. None of the following exists as an authorized identity:
- no staging test credential or token in this session's environment (no `XA_*`, staging, e2e or synthetic-identity variables);
- no documented standing synthetic account (the repo's `scripts/staging-tracker-acceptance/setup.py` and the specs create new users; every account from my earlier gates was deleted);
- creating one needs explicit approval, which this task withholds.
I did not work around this (no reuse of a deleted identity, no token minting, no signup).

## 1. Original evidence (from `docs/release/PUI-LIVE-ACCEPTANCE_REPORT.md` and `docs/plans/jobs-list-efficiency.md`)
- **F3:** 2 of 126 browser-side `GET /jobs` requests failed (`net::ERR_FAILED`, no response, console CORS error) during rapid filter changes and a deep scroll over the 99-job 30-day window, shortly after list pages of 4.4-6.5 s; the UI showed its error state. Everything else was 200.
- **F5:** list pages up to 6.5 s versus 0.1-0.4 s typical when requests overlapped.
- **Root cause (reproduced locally, not on staging):** each request materialised the whole active catalogue; four overlapping requests OOM-killed a 768 MB / 1 CPU / single-process container.
- **Expected improvement (local, 3,000 jobs, same limits):** sequential p50 952 to 428 ms; 4 clients OOM to 1.08 s; 24 clients 0 failures; browser burst 22 failures to 0; responses byte-identical.
- **Existing reproduction tools:** `live_gate2.py` (API correctness and paging) and `live_ui2.cjs` (browser burst with request logging) in the session scratchpad (not in Git); local load harness `scratchpad/f3/*`.

## 2. What I could verify without authentication (all VERIFIED, none proves F3/F5)
| Check | Result |
|---|---|
| `GET /healthz` x5 | 200, 42-131 ms |
| `GET /jobs?limit=25` unauthenticated x3 | 401, 46-129 ms (refused before any list work) |
| CORS preflight from the staging origin | 200 with the correct `Access-Control-Allow-Origin` |
| Web serves the 1df25f5 UI | match-score chunk present |
| `/auth/login` reachable | `OPTIONS` 200 only; no credentials sent, no burst repeated |
These show the services are up and responsive. They say nothing about list latency, memory or pagination under load, and **do not confirm** that API `e4797e4` is the running image (there is no version endpoint; that rests on your deployment record).

## 3. Status of each requested area
| Area | Status | Why |
|---|---|---|
| Populated job count on staging | NOT TESTED | needs an authenticated count (the earlier live run saw 99 jobs in the 30-day window for a synthetic profile, 15 in 7 days) |
| Pagination correctness (3 sorts, limits 10/25, first/middle/last, filters, search) | NOT TESTED on the deployed build | locally proven byte-identical to the old code; unproven live |
| Bounded rapid-paging test, p50/p95/max, cancellations vs failures, stale results | BLOCKED | needs an authenticated browser session |
| F3 (no failed list requests) | **BLOCKED** | |
| F5 (latency under overlap) | **BLOCKED** | |
| Resource safety: restart count, OOMKilled, memory, logs | BLOCKED / UNVERIFIED | no VPS observability available to me; do not assume success |
| Authentication regression (one normal login with a separate identity) | NOT TESTED | needs a second authorized identity; the throttle's design (per-account counter cleared by a correct password; defaults 10 per 15 min) predicts a normal login is unaffected, locally tested, not verified live |
| Confirmed regressions | none found; nothing authenticated was exercised | |

## 4. What unblocks it (choose one)
1. **Approve one throwaway synthetic account** (and a second for the login check, or reuse it for both since a correct login clears its counter). I would run the existing harness once, bounded: paging for all sorts and limits 10 and 25, filters and search, 6-8 quick filter changes, one deep scroll, search and sort changed while a request is pending, about 100 requests in total, no repeated bursts; log status codes, cancellations separately from failures, p50/p95/max and any UI error; delete the account(s) afterwards.
2. **Or provide an existing authorized identity** through environment variables (for example `XA_STAGING_EMAIL` and `XA_STAGING_PASSWORD` in the session, never in chat), confirming it has a populated profile.
3. **For resources:** an operator can run the read-only commands at the end of `docs/plans/jobs-list-efficiency.md` before and after the test (`docker inspect` restart count and OOM flag, `docker stats`, kernel OOM lines, nginx 50x lines, active-job count) and paste the output.

## 5. Recommendation
**Do not close F3/F5 yet.** The local evidence is strong, but the gate requires live proof. NO-GO for treating F3/F5 as resolved until option 1 or 2 is done; nothing observed so far contradicts the fix.
